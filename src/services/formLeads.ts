import type { Connection } from "mongoose";
import { zohoCredentialModel } from "../models/ZohoCredential";
import type { ErpOutcome } from "../models/ChatConversation";
import { isPaidUrl, type TrafficSource } from "../domain/trafficSource";

/**
 * Website quote-form leads, for the funnel beside chat leads.
 *
 * Read from the Zoho connector's `leads` collection, which belongs to another
 * system and is only read here. A quote form on the storefront files its lead
 * with source "Ecommerce" and writes the enquiry into the description as JSON,
 * including `trafficSource` ("PPC" / "Organic"), `isCampaignPage` and the page.
 * The other brands' quote forms ("Print247 - Ecommerce", "ColorWing Quote")
 * carry no such JSON, so their source is "unknown".
 *
 * Leads the Lead Desk sheet marked Duplicate or Suspicious are left out, as on
 * the TV dashboard. What the ERP says about each lead is kept in this app's own
 * `form_lead_outcomes`, never on the connector's records.
 */

export interface FormLead {
  _id: unknown;
  /** The funnel's handle for the lead, distinct from any chat's id. */
  conversationId: string;
  kind: "form";
  zohoLeadId: string;
  createdAt: Date;
  name: string;
  email: string;
  phone: string;
  repEmail: string;
  repName: string;
  /** What the form asked for, from the storefront's JSON. */
  product: string;
  landingPageTitle: string;
  /** The page the form was sent from, as a full address. */
  pageUrl: string;
  source: TrafficSource;
  erpOutcome?: ErpOutcome;
}

const OUTCOMES = "form_lead_outcomes";

/** Lead sources that are a quote form on one of the sites. Calls and visits are not. */
export function isFormSource(source: unknown): boolean {
  const value = String(source || "").trim().toLowerCase();
  if (!value || /call|visit|newsletter/.test(value)) return false;
  return /(^|\s|-)ecommerce$/.test(value) || /\bquotee?\b/.test(value);
}

/**
 * The storefront records the page as a path ("/deals/custom-boxes?gclid=…") on
 * print247.us forms; a full address is kept as it is.
 */
export function absolutePage(page: unknown): string {
  const value = String(page || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  return "https://print247.us" + (value.startsWith("/") ? value : "/" + value);
}

function enquiryOf(description: unknown): Record<string, any> | null {
  try {
    const parsed = JSON.parse(String(description || ""));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * The other quote forms write plain text, not JSON, but still say where the
 * visitor came from on a line of its own: "Source: PPC", "Source: Org",
 * "Source: Campaign Page". 48 "Print247 - Ecommerce" and 11 "ColorWing Quote"
 * leads in October showed as "Source not recorded" because only the JSON
 * shape was read.
 */
function sourceFromText(description: unknown): TrafficSource {
  const line = /^\s*Source\s*:\s*(.+)$/im.exec(String(description || ""))?.[1]?.trim().toLowerCase() || "";
  if (!line) return "unknown";
  if (/ppc|paid|cpc|google ads|campaign/.test(line)) return "ppc";
  if (/social|smm|facebook|instagram|meta|tiktok|linkedin|pinterest/.test(line)) return "social";
  if (/whatsapp|messag/.test(line)) return "messaging";
  // An AI assistant sending the visitor is a referral, not paid: counted with organic.
  if (/^org|organic|seo|direct|website|chatgpt|gemini|perplexity|copilot/.test(line)) return "organic";
  return "unknown";
}

/** The storefront's own verdict first, then the page it was sent from. */
function sourceOfForm(enquiry: Record<string, any> | null, description?: unknown): TrafficSource {
  if (!enquiry) return sourceFromText(description);
  const stated = String(enquiry.trafficSource || "").toLowerCase();
  if (/ppc|paid|cpc|ads?\b/.test(stated)) return "ppc";
  if (/social|facebook|instagram/.test(stated)) return "social";
  if (enquiry.isCampaignPage === true) return "ppc";
  if ([enquiry.pageUrl, enquiry.landingPage].some((url) => isPaidUrl(String(url || "")))) return "ppc";
  if (stated) return "organic";
  return "unknown";
}

/** Form leads created in the range, oldest first, with any stored ERP outcome. */
export async function loadFormLeads(
  leadsDb: Connection,
  connectorDb: Connection,
  range: { start: Date; end: Date },
  repEmail: string
): Promise<FormLead[]> {
  const between = { $gte: range.start, $lt: range.end };
  const [docs, credentials] = await Promise.all([
    connectorDb
      .collection("leads")
      .find(
        {
          // The Lead Desk sync recorded the real Zoho created time; newer leads only have the insert time.
          $or: [{ "leadDesk.createdAt": between }, { leadDesk: { $exists: false }, createdAt: between }],
          "leadDesk.cleanup": { $nin: ["Duplicate", "Suspicious"] },
        },
        { projection: { zohoLeadId: 1, source: 1, description: 1, email: 1, phone: 1, firstName: 1, lastName: 1, ownerId: 1, createdAt: 1, "leadDesk.createdAt": 1 } }
      )
      .toArray(),
    zohoCredentialModel(leadsDb).find({}, { zohoUserId: 1, email: 1, fullName: 1 }).lean(),
  ]);

  // A lead carries its owner's Zoho user id; the reps' sign-ins say who that is.
  const reps = new Map(credentials.map((c: any) => [String(c.zohoUserId), { email: String(c.email || "").toLowerCase(), name: String(c.fullName || c.email || "") }]));

  const leads: FormLead[] = docs
    .filter((doc) => isFormSource(doc.source) && doc.zohoLeadId)
    .map((doc) => {
      const enquiry = enquiryOf(doc.description);
      const rep = reps.get(String(doc.ownerId || ""));
      return {
        _id: doc._id,
        conversationId: `form-${doc.zohoLeadId}`,
        kind: "form" as const,
        zohoLeadId: String(doc.zohoLeadId),
        createdAt: (doc.leadDesk?.createdAt ?? doc.createdAt) as Date,
        name: [doc.firstName, doc.lastName].filter(Boolean).join(" ").trim(),
        email: String(doc.email || enquiry?.email || ""),
        phone: String(doc.phone || enquiry?.phone || ""),
        repEmail: rep?.email || "",
        repName: rep?.name || "",
        product: String(enquiry?.product || ""),
        landingPageTitle: String(enquiry?.landingPage || ""),
        pageUrl: absolutePage(enquiry?.pageUrl || enquiry?.landingPage),
        source: sourceOfForm(enquiry, doc.description),
      };
    })
    .filter((lead) => !repEmail || lead.repEmail === repEmail)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  if (leads.length) {
    const stored = await leadsDb
      .collection(OUTCOMES)
      .find({ _id: { $in: leads.map((lead) => lead.zohoLeadId) as any[] } })
      .toArray();
    const byId = new Map(stored.map((row) => [String(row._id), row.outcome as ErpOutcome]));
    for (const lead of leads) lead.erpOutcome = byId.get(lead.zohoLeadId);
  }
  return leads;
}

/** Keeps freshly looked-up ERP outcomes for form leads in this app's own collection. */
export async function saveFormOutcomes(leadsDb: Connection, leads: { zohoLeadId?: string; erpOutcome?: ErpOutcome }[]): Promise<void> {
  const writes = leads
    .filter((lead) => lead.zohoLeadId && lead.erpOutcome)
    .map((lead) => ({
      updateOne: { filter: { _id: lead.zohoLeadId }, update: { $set: { outcome: lead.erpOutcome, checkedAt: lead.erpOutcome!.checkedAt } }, upsert: true },
    }));
  if (writes.length) await leadsDb.collection(OUTCOMES).bulkWrite(writes as any, { ordered: false });
}

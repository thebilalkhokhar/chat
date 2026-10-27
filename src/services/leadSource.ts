import type { Connection } from "mongoose";
import { isOfficeHours, pakistanStamp } from "../domain/officeHours";
import { getSettings } from "./settingsService";
import { zohoCredentialModel } from "../models/ZohoCredential";
import type { ISettings } from "../models/Settings";

/**
 * Choosing which leads may be written to.
 *
 * Leads are read from the Zoho connector's own database — the collection its
 * webhook keeps in step with the CRM — rather than from the exhibition app.
 * The app only ever sees what a rep captured on a phone at a stand; the
 * connector sees every lead the business has, whatever created it.
 *
 * Ownership comes from `ownerId`, a Zoho user id, which is matched against the
 * stored OAuth grants to get an address. That mapping is not a convenience: a
 * lead whose owner has no grant cannot be written to at all, because there is
 * no token to send as them with.
 *
 * Every rule that decides whether a stranger receives an automated email lives
 * in `rejectionReason`, so the answer to "why did this person get mail?" is
 * always readable in one place.
 */

export interface EligibleLead {
  /** The connector document id — this service's handle on the lead. */
  leadId: string;
  /** The CRM record, which is what gets tagged and noted. */
  zohoLeadId: string;

  email: string;
  fullName: string;
  company: string;

  /** Zoho user id of the owner, and the address it maps to. */
  ownerId: string;
  repEmail: string;
  repName: string;

  /** The CRM Description: the enquiry itself, often JSON from the storefront. */
  description: string;

  source: string;
  status: string;
  tags: string[];
  capturedAt: Date;
}

export interface Rejection {
  email: string;
  reason: string;
}

/** Zoho user id to the address whose grant can send as them. */
export type RepDirectory = Map<string, { email: string; fullName: string }>;

export async function loadRepDirectory(leadsDb: Connection): Promise<RepDirectory> {
  const credentials = await zohoCredentialModel(leadsDb)
    .find({ refreshToken: { $nin: ["", null] } }, { zohoUserId: 1, email: 1, fullName: 1 })
    .lean();

  return new Map(
    credentials.map((credential) => [
      String(credential.zohoUserId),
      { email: String(credential.email).toLowerCase(), fullName: credential.fullName || "" },
    ])
  );
}

function domainOf(email: string): string {
  return email.toLowerCase().trim().split("@")[1] || "";
}

/** "3 hours", "4 days" — so a rejection reason reads like a sentence. */
function describeAge(days: number): string {
  if (days < 1) {
    const hours = Math.max(1, Math.round(days * 24));
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const whole = Math.round(days);
  return `${whole} day${whole === 1 ? "" : "s"}`;
}

/**
 * A hand-picked address being used to exercise the system.
 *
 * Exempt from the office-hours rules, because a test mailbox has no colleague
 * handling it and the restriction would otherwise make the system testable only
 * inside a fourteen-hour window. Never an exemption from the internal-domain
 * rule: a colleague stays unreachable however explicitly they are named.
 */
export function isTestAddress(email: string, settings: ISettings): boolean {
  const address = String(email || "").toLowerCase().trim();
  if (!address) return false;
  if (settings.eligibility.excludedDomains.includes(domainOf(address))) return false;
  return settings.eligibility.onlyLeadEmails.includes(address);
}

export interface LeadCandidate {
  email?: string;
  ownerId?: string;
  createdAt?: Date | string;
  source?: string;
  /** The CRM's own tags. "Trade show" is the one that decides eligibility. */
  tags?: string[];
}

/**
 * The CRM source, lowercased with runs of whitespace collapsed, so a stored
 * substring matches however the source happens to be capitalised or spaced
 * ("WebSite Visit", "Website  Visit").
 */
function normaliseSource(source: string): string {
  return String(source || "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * The configured exclusion one of this lead's tags matches, or null.
 *
 * The tag is checked because the source cannot carry this. A trade show lead is
 * filed under whatever the booth was called that season — "Coffee Fest",
 * "Winter Fair SAN DIEGO 2026", "Exhibition - MJ BizCon Las Vegas, 2025" — and
 * most of them have no source at all: of 2,365 leads tagged for a show, 1,388
 * had the field blank. Excluding them by source name would need a list that
 * grows every quarter and would still miss the majority.
 */
function matchedExcludedTag(tags: string[], settings: ISettings): string | null {
  const excludedTags = settings.eligibility?.excludedTags;
  if (!Array.isArray(excludedTags) || excludedTags.length === 0) return null;

  for (const tag of tags) {
    const normalised = normaliseSource(tag);
    if (!normalised) continue;

    const hit = excludedTags.find((excluded) => normalised.includes(normaliseSource(excluded)));
    if (hit) return tag;
  }

  return null;
}

/** The configured exclusion this source matches, or null. */
function matchedExcludedSource(source: string, settings: ISettings): string | null {
  const normalised = normaliseSource(source);
  if (!normalised) return null;
  // Guarded only against a TypeError: `getSettings` backfills this list on an
  // install that predates it, so an empty one here means deliberately empty.
  const excludedSources = settings.eligibility?.excludedSources;
  if (!Array.isArray(excludedSources)) return null;

  return (
    excludedSources.find((excluded) => normalised.includes(normaliseSource(excluded))) || null
  );
}

/**
 * The decision for one lead: null when it may be written to, or the reason it
 * may not, phrased for a human reading a log or the dashboard.
 *
 * Every rule narrows; none widens. An earlier version let the test allowlist
 * override the rep limit, which meant "only this rep's leads" was not actually
 * true — the opposite of what a safety setting should do.
 */
export function rejectionReason(
  lead: LeadCandidate,
  settings: ISettings,
  reps: RepDirectory
): string | null {
  const email = String(lead.email || "").toLowerCase().trim();

  if (!email || !email.includes("@")) return "no email address";

  // Colleagues are never written to, whatever else is configured. Checked
  // first so nothing below can opt an internal address back in.
  if (settings.eligibility.excludedDomains.includes(domainOf(email))) {
    return `internal domain (${domainOf(email)})`;
  }

  // A newsletter subscriber and a logged website visit are not enquiries:
  // nobody asked to be contacted, so there is nothing to follow up. Checked
  // beside the internal-domain rule, above everything a test run can relax,
  // because it is a fact about the lead rather than a limit on the rollout.
  const excludedSource = matchedExcludedSource(String(lead.source || ""), settings);
  if (excludedSource) {
    return `source is not an enquiry (${String(lead.source).trim()})`;
  }

  // Beside the source rule and for the same reason: it is a fact about the lead,
  // not a limit on the rollout, so nothing below may relax it. A trade show lead
  // is followed up by the rep who met them at the booth, never by this service.
  const excludedTag = matchedExcludedTag(lead.tags || [], settings);
  if (excludedTag) {
    return `excluded tag (${excludedTag.trim()})`;
  }

  const ownerId = String(lead.ownerId || "").trim();
  if (!ownerId) return "no owner in the CRM";

  // Mail is sent using the owner's own Zoho grant, so a lead owned by somebody
  // who has never signed in cannot be sent at all — there is no token.
  const owner = reps.get(ownerId);
  if (!owner) return "owner has no Zoho sign-in on file";

  const onlyRep = settings.eligibility.onlyRepEmail;
  if (onlyRep && owner.email !== onlyRep) {
    return `owned by another rep (limited to ${onlyRep})`;
  }

  const allowlist = settings.eligibility.onlyLeadEmails;
  if (allowlist.length > 0 && !allowlist.includes(email)) {
    return "not in the test allowlist";
  }

  const capturedAt = lead.createdAt ? new Date(lead.createdAt) : null;
  if (!capturedAt || Number.isNaN(capturedAt.getTime())) return "no capture date";

  const ageDays = (Date.now() - capturedAt.getTime()) / 86_400_000;

  // The age rule applies to everyone, test addresses included. It answers a
  // different question from the office-hours rule: not "is a colleague dealing
  // with this right now" but "is this lead recent enough that a follow-up makes
  // any sense at all". A lead from last Tuesday is stale whoever it belongs to,
  // and exempting the allowlist from it made the dashboard show leads nobody
  // expected to see.
  if (!settings.eligibility.includeExistingLeads && ageDays > 1) {
    return `created ${describeAge(ageDays)} ago, before this service was enabled`;
  }

  // Office hours, on the other hand, a named test address does ignore —
  // nobody is handling a test mailbox, and the restriction would otherwise make
  // the system testable only inside a fourteen-hour window on weekdays.
  if (isTestAddress(email, settings)) return null;

  // Somebody was at a desk when this arrived, so it is already theirs. Judged
  // on when the lead was created, not on when the worker happens to look at it.
  if (
    settings.eligibility.skipCapturedDuringOfficeHours &&
    isOfficeHours(capturedAt, settings.officeHours)
  ) {
    return `created during office hours (${pakistanStamp(capturedAt)} PKT)`;
  }

  return null;
}

function normalise(doc: any, reps: RepDirectory): EligibleLead {
  const owner = reps.get(String(doc.ownerId || "")) || { email: "", fullName: "" };
  const fullName = [doc.firstName, doc.lastName].filter(Boolean).join(" ").trim();

  return {
    leadId: String(doc._id),
    zohoLeadId: String(doc.zohoLeadId || ""),
    email: String(doc.email || "").toLowerCase().trim(),
    fullName,
    company: doc.company || "",
    ownerId: String(doc.ownerId || ""),
    repEmail: owner.email,
    repName: owner.fullName,
    description: doc.description || "",
    source: doc.source || "",
    status: doc.status || "",
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    capturedAt: doc.createdAt ? new Date(doc.createdAt) : new Date(),
  };
}

/**
 * Leads that may be written to, newest first, alongside the rejected ones and
 * why.
 *
 * The rejections are returned rather than silently dropped: when nobody
 * receives an email, the only useful question is which rule excluded them.
 *
 * Only recent leads are examined. The connector holds over eleven thousand,
 * almost all of them years old, and scanning every one on each pass to
 * rediscover that they are too old to contact is wasted work.
 */
export async function findEligibleLeads(
  leadsDb: Connection,
  connectorDb: Connection,
  options: { lookbackDays?: number; limit?: number } = {}
): Promise<{ eligible: EligibleLead[]; rejected: Rejection[]; scanned: number }> {
  const settings = await getSettings(leadsDb);
  const reps = await loadRepDirectory(leadsDb);

  // Wide enough to cover the age rule and any allowlisted address that has been
  // sitting a while, without walking the whole collection.
  const lookbackDays = options.lookbackDays ?? 30;
  const since = new Date(Date.now() - lookbackDays * 86_400_000);

  const docs = await connectorDb
    .collection("leads")
    .find({ createdAt: { $gte: since } })
    .sort({ createdAt: -1 })
    .limit(options.limit ?? 2000)
    .toArray();

  const eligible: EligibleLead[] = [];
  const rejected: Rejection[] = [];
  // The same person appearing twice is one conversation, not two.
  const seen = new Set<string>();

  for (const doc of docs) {
    const email = String(doc.email || "").toLowerCase().trim();
    const reason = rejectionReason(doc as LeadCandidate, settings, reps);

    if (reason) {
      rejected.push({ email: email || "(none)", reason });
      continue;
    }

    if (seen.has(email)) {
      rejected.push({ email, reason: "duplicate lead, already queued" });
      continue;
    }

    seen.add(email);
    eligible.push(normalise(doc, reps));
  }

  return { eligible, rejected, scanned: docs.length };
}

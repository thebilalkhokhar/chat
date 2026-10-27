import axios from "axios";
import { config } from "../config/env";

/**
 * Writing back to the Zoho CRM lead record.
 *
 * Three things happen against a lead once the AI has written to it: the email
 * goes out as the rep, the record is tagged so anyone in the CRM can see an
 * automation touched it, and a note records what was learned. All three use the
 * rep's own access token, so every write is attributed to a real person rather
 * than to a service account.
 *
 * One API version for every call, named once below. The older projects here
 * ended up spread across v2, v6 and v8 by accretion, which means a change to
 * any shared behaviour has to be reasoned about three times. Zoho keeps old
 * versions working, so the cost of being consistent is only ever paid once, at
 * the moment a version is retired.
 *
 * Nothing here throws on failure. A lead that could not be tagged has still had
 * its email sent, and losing the conversation over a cosmetic write would be
 * the wrong trade — the caller is told what failed and carries on.
 */

const REQUEST_TIMEOUT_MS = 20_000;

/**
 * The Zoho CRM API version every call in this file uses.
 *
 * Kept in one place so a rejection can be answered by editing a single line.
 * `npm run probe:zoho` checks a live token against this version before anything
 * depends on it.
 */
const API_VERSION = "v8";

export interface ZohoWriteResult {
  ok: boolean;
  error?: string;
}

/** The tag every lead this service writes to is marked with. */
export const AI_FOLLOW_UP_TAG = "Ai Follow Up";

function apiHost(): string {
  return `https://www.zohoapis.${config.zoho.region}`;
}

/** The most specific reason Zoho gave, short enough to store and show. */
function describeError(error: any): string {
  const detail = error?.response?.data?.data?.[0];
  if (detail?.message) {
    return detail.details?.api_name ? `${detail.message} (${detail.details.api_name})` : detail.message;
  }
  return error?.response?.data?.message || error?.message || "Zoho rejected the request";
}

/**
 * Marks the lead as touched by this service.
 *
 * Zoho ignores a tag that is already present, so this is safe to call again on
 * a lead that has had several follow-ups — no duplicate tags accumulate.
 *
 * The tag goes in the body. `?tag_names=` is the v2 spelling and v8 does not
 * accept it: the id in the query is read, the tag is not, and the call comes
 * back MANDATORY_NOT_FOUND on `$.tags`. Every tag this service tried to apply
 * failed that way and nobody noticed, because a failed tag is reported and
 * then deliberately ignored — the email it belongs to has already gone out.
 */
export async function addLeadTag(
  zohoLeadId: string,
  accessToken: string,
  tag: string = AI_FOLLOW_UP_TAG
): Promise<ZohoWriteResult> {
  if (!zohoLeadId) return { ok: false, error: "No Zoho lead id" };

  try {
    await axios.post(
      `${apiHost()}/crm/${API_VERSION}/Leads/actions/add_tags` +
        `?ids=${encodeURIComponent(zohoLeadId)}`,
      { tags: [{ name: tag }] },
      {
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
          "Content-Type": "application/json",
        },
        timeout: REQUEST_TIMEOUT_MS,
      }
    );

    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

export interface UpsertLeadResult extends ZohoWriteResult {
  /** The lead's id, whether it was created now or already existed. */
  zohoLeadId?: string;
  /** What Zoho did: "insert" for a new lead, "update" for a matched one. */
  action?: string;
}

/**
 * Creates the CRM lead for a chat.
 *
 * A plain insert, not an upsert, for two reasons found the hard way.
 *
 * Permission: upserting on Email matches whatever lead already carries that
 * address, and that lead usually belongs to another rep. Zoho then refuses the
 * whole write with 403 NO_PERMISSION — "record not accessible" — because a rep
 * may not touch another rep's record. One test address already existed on four
 * leads across two owners, so this was not an edge case.
 *
 * Correctness: each chat is its own enquiry. Updating an earlier lead would
 * overwrite its Description with the new transcript and quietly destroy the
 * previous enquiry, which is worse than having two leads for one person.
 *
 * Duplicates are reconciled by the SalesIQ chat id carried in the description.
 *
 * `Last_Name` is the one field Zoho refuses a lead without, so it always has a
 * value even when the visitor stayed anonymous.
 */
/**
 * The lead this address already has, if it has one.
 *
 * `upsertChatLead` is a plain insert whatever its name suggests, so without this
 * every chat wrote a new record: the same person coming back a day later got a
 * second lead, and so did anyone already in the CRM from the website form. There
 * are fourteen addresses in the mirror carrying more than one chat lead, some of
 * them days apart, and that is what they are.
 *
 * `ok: false` is not a match, and the caller no longer treats it as license to
 * insert — a failed search used to fall through to a plain insert, on the
 * reasoning that a duplicate can be merged and a lost enquiry cannot. That held
 * for an isolated failure and stopped holding under load: clearing a large
 * backlog pushes enough search calls through in a short window that some
 * genuinely fail, and each one became a duplicate. One retry, after a short
 * pause, is what actually distinguishes the two: a real outage fails again and
 * is left for the caller to skip and retry later; a rate limit or a dropped
 * connection usually does not.
 */
export async function findLeadIdByEmail(
  email: string,
  accessToken: string
): Promise<{ ok: boolean; zohoLeadId?: string; error?: string }> {
  const address = String(email || "").trim();
  if (!address) return { ok: true };

  const attempt = async () => {
    const response = await axios.get(`${apiHost()}/crm/${API_VERSION}/Leads/search`, {
      params: { criteria: `(Email:equals:${address})`, fields: "id,Email", per_page: 1 },
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
      timeout: REQUEST_TIMEOUT_MS,
      // 204 is Zoho for "nothing matched", which is an answer and not a failure.
      validateStatus: (status) => status === 200 || status === 204,
    });

    return { ok: true as const, zohoLeadId: response.data?.data?.[0]?.id };
  };

  try {
    return await attempt();
  } catch (firstError) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      return await attempt();
    } catch (secondError) {
      return { ok: false, error: describeError(secondError) };
    }
  }
}

/**
 * A lead with this phone number, whatever format either side wrote it in.
 *
 * Zoho's `phone=` search compares digits, so "+1 (239) 483-0268" finds a lead
 * stored as "2394830268" — tested against live leads. Without it a customer
 * who only ever gave a phone (a quote form, a call logged by hand) was never
 * recognised, and the chat filed a duplicate under somebody else. With
 * several matches, the oldest is the customer's real record.
 */
export async function findLeadIdByPhone(
  phone: string,
  accessToken: string
): Promise<{ ok: boolean; zohoLeadId?: string; error?: string }> {
  const digits = String(phone || "").replace(/\D/g, "");
  if (digits.length < 10) return { ok: true };

  try {
    const response = await axios.get(`${apiHost()}/crm/${API_VERSION}/Leads/search`, {
      params: { phone: digits.slice(-10), fields: "id,Phone,Mobile,Created_Time", per_page: 10 },
      headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: (status) => status === 200 || status === 204,
    });
    const rows: any[] = response.data?.data || [];
    rows.sort((a, b) => String(a.Created_Time || "").localeCompare(String(b.Created_Time || "")));
    return { ok: true, zohoLeadId: rows[0]?.id };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

/**
 * Every lead this customer has, by email and by phone, with each one's owner.
 *
 * One customer can sit on more than one record — a SalesIQ chat makes its own the
 * moment the chat opens, next to the one a rep has been working for a month — and
 * which of them a chat belongs on depends on who owns them, not on which one a
 * single search happens to return.
 */
export async function findCustomerLeads(
  contact: { email?: string; phone?: string },
  accessToken: string
): Promise<{ ok: boolean; leads: Array<{ id: string; ownerId?: string; createdTime?: string }>; error?: string }> {
  const searches: Array<Record<string, string | number>> = [];
  const address = String(contact.email || "").trim();
  if (address) searches.push({ criteria: `(Email:equals:${address})` });
  const digits = String(contact.phone || "").replace(/\D/g, "");
  if (digits.length >= 10) searches.push({ phone: digits.slice(-10) });

  const found = new Map<string, { id: string; ownerId?: string; createdTime?: string }>();
  try {
    for (const params of searches) {
      const response = await axios.get(`${apiHost()}/crm/${API_VERSION}/Leads/search`, {
        params: { ...params, fields: "id,Owner,Created_Time", per_page: 20 },
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
        timeout: REQUEST_TIMEOUT_MS,
        validateStatus: (status) => status === 200 || status === 204,
      });
      for (const row of response.data?.data || []) {
        if (row?.id) found.set(String(row.id), { id: String(row.id), ownerId: row.Owner?.id, createdTime: row.Created_Time });
      }
    }
  } catch (error) {
    return { ok: false, leads: [], error: describeError(error) };
  }
  const leads = [...found.values()].sort((a, b) => String(a.createdTime || "").localeCompare(String(b.createdTime || "")));
  return { ok: true, leads };
}

export async function upsertChatLead(
  lead: {
    lastName: string;
    firstName?: string;
    email?: string;
    phone?: string;
    company?: string;
    description: string;
    /** Zoho user id of the rep who should own it. */
    ownerId?: string;
  },
  accessToken: string
): Promise<UpsertLeadResult> {
  const record: Record<string, unknown> = {
    Last_Name: (lead.lastName || "").trim() || "Website Chat Visitor",
    Lead_Source: "Chat",
    Description: lead.description.slice(0, 32000),
  };

  if (lead.firstName?.trim()) record.First_Name = lead.firstName.trim();
  if (lead.email?.trim()) record.Email = lead.email.trim();
  if (lead.phone?.trim()) {
    const rawPhone = lead.phone.trim();
    const digitCount = (rawPhone.match(/\d/g) || []).length;
    if (digitCount >= 6 && !/[a-zA-Z]{3,}/.test(rawPhone)) {
      record.Phone = rawPhone;
    }
  }
  if (lead.company?.trim()) record.Company = lead.company.trim();
  if (lead.ownerId?.trim()) record.Owner = { id: lead.ownerId.trim() };

  try {
    const response = await axios.post(
      `${apiHost()}/crm/${API_VERSION}/Leads`,
      { data: [record] },
      {
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
          "Content-Type": "application/json",
        },
        timeout: REQUEST_TIMEOUT_MS,
      }
    );

    const result = response.data?.data?.[0];
    return {
      ok: result?.code === "SUCCESS",
      zohoLeadId: result?.details?.id,
      action: result?.action,
      error: result?.code === "SUCCESS" ? undefined : result?.message,
    };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

/**
 * Files a note on the lead.
 *
 * Posted to the lead's own Notes related list rather than the standalone
 * `/Notes` endpoint, which needs `Parent_Id` as a polymorphic lookup and
 * rejects both a bare id string and an object without the module name. The
 * parent is already named in this URL, so there is no lookup to get wrong.
 */
export async function addLeadNote(
  zohoLeadId: string,
  title: string,
  content: string,
  accessToken: string
): Promise<ZohoWriteResult> {
  if (!zohoLeadId) return { ok: false, error: "No Zoho lead id" };

  try {
    await axios.post(
      `${apiHost()}/crm/${API_VERSION}/Leads/${encodeURIComponent(zohoLeadId)}/Notes`,
      {
        data: [
          {
            Note_Title: title.slice(0, 120),
            // Zoho caps note content; a truncated note beats a rejected one.
            Note_Content: content.slice(0, 32000),
          },
        ],
      },
      {
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
          "Content-Type": "application/json",
        },
        timeout: REQUEST_TIMEOUT_MS,
      }
    );

    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

/**
 * Reads a lead's Description straight from the CRM.
 *
 * The connector's copy is written by a webhook that Zoho fires the moment a
 * lead is created — sometimes before the Description has been committed, so a
 * fetch at that instant comes back empty and is never retried. Roughly a third
 * of new leads arrived that way.
 *
 * Asking again here costs one request and happens minutes later, by which time
 * the field exists. Returns an empty string on any failure: an enquiry we
 * cannot read is a worse first email, not a reason to abandon the lead.
 */
export async function fetchLeadDescription(
  zohoLeadId: string,
  accessToken: string
): Promise<string> {
  if (!zohoLeadId) return "";

  try {
    const response = await axios.get(
      `${apiHost()}/crm/${API_VERSION}/Leads/${encodeURIComponent(zohoLeadId)}?fields=id,Description`,
      {
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
        timeout: REQUEST_TIMEOUT_MS,
        validateStatus: () => true,
      }
    );

    return String(response.data?.data?.[0]?.Description || "");
  } catch {
    return "";
  }
}

/**
 * Whether a lead is still in the CRM as a lead.
 *
 * "gone" is Zoho saying so: no content (deleted, or converted to a contact) or an
 * id it does not know. "unknown" is anything else — a timeout, a refused token —
 * and is not a reason to think the lead has gone.
 */
export async function leadStillExists(zohoLeadId: string, accessToken: string): Promise<"yes" | "gone" | "unknown"> {
  if (!zohoLeadId) return "gone";
  try {
    const response = await axios.get(
      `${apiHost()}/crm/${API_VERSION}/Leads/${encodeURIComponent(zohoLeadId)}?fields=id`,
      {
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
        timeout: REQUEST_TIMEOUT_MS,
        validateStatus: () => true,
      }
    );
    if (response.status === 200 && response.data?.data?.[0]?.id) return "yes";
    const code = String(response.data?.code || response.data?.data?.[0]?.code || "");
    if (response.status === 204 || response.status === 404 || code === "INVALID_DATA" || code === "RECORD_NOT_FOUND") return "gone";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/** Who owns a lead now and when it was made, straight from the CRM. */
export async function fetchLeadOwner(
  zohoLeadId: string,
  accessToken: string
): Promise<{ ok: boolean; ownerId?: string; ownerName?: string; ownerEmail?: string; createdAt?: Date; error?: string }> {
  if (!zohoLeadId) return { ok: false, error: "No Zoho lead id" };

  try {
    const response = await axios.get(
      `${apiHost()}/crm/${API_VERSION}/Leads/${encodeURIComponent(zohoLeadId)}?fields=id,Owner,Created_Time`,
      {
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
        timeout: REQUEST_TIMEOUT_MS,
        validateStatus: () => true,
      }
    );

    const lead = response.data?.data?.[0];
    if (response.status >= 300 || !lead) {
      return { ok: false, error: `could not read lead ${zohoLeadId}: HTTP ${response.status}` };
    }

    return {
      ok: true,
      ownerId: lead.Owner?.id,
      ownerName: lead.Owner?.name,
      ownerEmail: String(lead.Owner?.email || "").toLowerCase(),
      createdAt: lead.Created_Time ? new Date(lead.Created_Time) : undefined,
    };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

/**
 * Hands a lead to another rep.
 *
 * Needs an admin token — a rep cannot give away a record, and cannot take one
 * that is not theirs.
 */
export async function setLeadOwner(
  zohoLeadId: string,
  ownerId: string,
  accessToken: string
): Promise<ZohoWriteResult> {
  if (!zohoLeadId || !ownerId) return { ok: false, error: "No Zoho lead id or owner" };

  try {
    const response = await axios.put(
      `${apiHost()}/crm/${API_VERSION}/Leads/${encodeURIComponent(zohoLeadId)}`,
      { data: [{ Owner: { id: ownerId } }] },
      {
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
          "Content-Type": "application/json",
        },
        timeout: REQUEST_TIMEOUT_MS,
        validateStatus: () => true,
      }
    );

    const result = response.data?.data?.[0];
    if (result?.code !== "SUCCESS") {
      return { ok: false, error: result?.message || `HTTP ${response.status}` };
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
}

/**
 * Puts contact details onto a lead that has none.
 *
 * A chat carries on after its lead is written — the address is very often the
 * last thing a visitor types — and until now none of it reached the record.
 * Yigit's lead showed "Email —" while the chat it came from had
 * yigit@safir-mediterranean.com on it, because a continuing chat only ever
 * added a note and notes are not fields anybody can filter, mail-merge or
 * click.
 *
 * Fills blanks only. A lead we matched rather than created may belong to a
 * customer a rep has already corrected by hand, and an address typed into a
 * chat window is not good enough to overwrite that. If Zoho already holds a
 * value, it stays.
 */
export async function fillLeadContact(
  zohoLeadId: string,
  contact: { email?: string; phone?: string },
  accessToken: string
): Promise<{ ok: boolean; filled: string[]; error?: string }> {
  const email = String(contact.email || "").trim();
  const phone = String(contact.phone || "").trim();
  if (!zohoLeadId || (!email && !phone)) return { ok: true, filled: [] };

  try {
    const current = await axios.get(
      `${apiHost()}/crm/${API_VERSION}/Leads/${encodeURIComponent(zohoLeadId)}?fields=id,Email,Phone`,
      {
        headers: { Authorization: `Zoho-oauthtoken ${accessToken}` },
        timeout: REQUEST_TIMEOUT_MS,
        validateStatus: () => true,
      }
    );

    if (current.status >= 300) {
      return { ok: false, filled: [], error: `could not read lead ${zohoLeadId}: HTTP ${current.status}` };
    }

    const held = current.data?.data?.[0] || {};
    const record: Record<string, unknown> = {};
    const filled: string[] = [];

    if (email && !String(held.Email || "").trim()) {
      record.Email = email;
      filled.push("email");
    }

    // The same guard the insert uses: a "phone" with letters in it, or too few
    // digits to dial, is something the reader picked up that is not a number.
    if (phone && !String(held.Phone || "").trim()) {
      const digits = (phone.match(/\d/g) || []).length;
      if (digits >= 6 && !/[a-zA-Z]{3,}/.test(phone)) {
        record.Phone = phone;
        filled.push("phone");
      }
    }

    if (!filled.length) return { ok: true, filled: [] };

    const response = await axios.put(
      `${apiHost()}/crm/${API_VERSION}/Leads/${encodeURIComponent(zohoLeadId)}`,
      { data: [record] },
      {
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
          "Content-Type": "application/json",
        },
        timeout: REQUEST_TIMEOUT_MS,
        validateStatus: () => true,
      }
    );

    const result = response.data?.data?.[0];
    if (result?.code !== "SUCCESS") {
      return { ok: false, filled: [], error: result?.message || `HTTP ${response.status}` };
    }

    return { ok: true, filled };
  } catch (error) {
    return { ok: false, filled: [], error: describeError(error) };
  }
}

export interface SendMailParams {
  zohoLeadId: string;
  accessToken: string;
  from: { name: string; email: string };
  to: { name: string; email: string };
  /** Copied in the open. Empty is the normal case, and sends no `cc` at all. */
  cc?: { name?: string; email: string }[];
  replyTo?: { name: string; email: string };
  subject: string;
  html: string;
}

/**
 * Sends the email through the CRM so it is threaded onto the lead's own
 * timeline, not just delivered.
 *
 * Zoho refuses a `from` address it does not recognise as belonging to the
 * token's user, and which addresses qualify depends on how each rep configured
 * their CRM mail. The caller is told that specifically, because the fix is a
 * Zoho settings change by that rep and not something a retry will resolve.
 */
export async function sendLeadMail(params: SendMailParams): Promise<ZohoWriteResult> {
  const { zohoLeadId, accessToken, from, to, cc, replyTo, subject, html } = params;

  if (!zohoLeadId) return { ok: false, error: "No Zoho lead id" };

  // One address per recipient, the customer never copied on themselves, and no
  // empty `cc` key: Zoho rejects the whole send if the array is present but
  // malformed, and a duplicate would show the customer their own address twice.
  const seen = new Set([to.email.toLowerCase()]);
  const copies = (cc || [])
    .map((entry) => ({ ...entry, email: String(entry.email || "").trim().toLowerCase() }))
    .filter((entry) => {
      if (!entry.email.includes("@") || seen.has(entry.email)) return false;
      seen.add(entry.email);
      return true;
    });

  try {
    await axios.post(
      `${apiHost()}/crm/${API_VERSION}/Leads/${encodeURIComponent(zohoLeadId)}/actions/send_mail`,
      {
        data: [
          {
            from: { user_name: from.name, email: from.email },
            to: [{ user_name: to.name, email: to.email }],
            ...(copies.length
              ? { cc: copies.map((entry) => ({ user_name: entry.name || entry.email, email: entry.email })) }
              : {}),
            ...(replyTo ? { reply_to: { user_name: replyTo.name, email: replyTo.email } } : {}),
            subject,
            content: html,
            mail_format: "html",
          },
        ],
      },
      {
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
          "Content-Type": "application/json",
        },
        timeout: REQUEST_TIMEOUT_MS,
      }
    );

    return { ok: true };
  } catch (error: any) {
    const detail = error?.response?.data?.data?.[0];
    const fromRejected =
      detail?.code === "INVALID_DATA" && String(detail?.details?.json_path || "").includes("from");

    return {
      ok: false,
      error: fromRejected
        ? `Zoho will not send as ${from.email}. That rep needs their email configured in Zoho CRM.`
        : describeError(error),
    };
  }
}

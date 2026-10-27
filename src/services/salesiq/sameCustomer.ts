import type { Model } from "mongoose";
import type { IChatConversation } from "../../models/ChatConversation";

/**
 * The same customer, found through a chat we already had with them.
 *
 * SalesIQ gives a visitor a different id on every channel, so nothing ties an
 * Instagram chat to a website chat until the customer gives the same email in
 * both. One did, three minutes apart: a finished chat on Instagram answered as
 * Alex, then a website chat answered as Frank — two reps, and two CRM leads six
 * minutes apart, because the CRM search run as Frank did not turn up the lead
 * Alex had just been given. Two of the week's repeat customers, and both ended
 * up with two leads.
 *
 * Our own records answer it straight away and see every rep's chats, so they
 * are asked first; the CRM search is still the fallback for a customer who came
 * in some other way.
 */

type Contactable = { _id?: unknown; email?: string; phone?: string; createdAt?: Date };

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Matching on the address or the number, whichever this chat has. */
function sameContact(conversation: Contactable): Record<string, unknown>[] {
  const matches: Record<string, unknown>[] = [];

  const email = String(conversation.email || "").trim();
  if (email) matches.push({ email: new RegExp(`^\\s*${escapeRegex(email)}\\s*$`, "i") });

  // Exact, as typed. Digits alone would match "2000 units" typed as a phone.
  const phone = String(conversation.phone || "").trim();
  if (phone.replace(/\D/g, "").length >= 7) matches.push({ phone });

  return matches;
}

/** The customer's lead, if any other chat with them already has one — the oldest wins. */
export async function otherChatWithLead(
  ChatConversation: Model<IChatConversation>,
  conversation: Contactable
) {
  const matches = sameContact(conversation);
  if (!matches.length) return null;

  return ChatConversation.findOne({
    _id: { $ne: conversation._id },
    $or: matches,
    zohoLeadId: { $nin: ["", null] },
  })
    .sort({ createdAt: 1 })
    .lean();
}

/**
 * Another chat with them whose lead is being written this minute.
 *
 * Two chats for one customer were closed by the same sweep within a second of
 * each other, neither had a lead yet, and both inserted one. Waiting for the
 * other write means the next pass finds its lead and adds to it.
 */
export async function otherLeadBeingWritten(
  ChatConversation: Model<IChatConversation>,
  conversation: Contactable,
  lockMs: number
) {
  const matches = sameContact(conversation);
  if (!matches.length) return null;

  return ChatConversation.findOne({
    _id: { $ne: conversation._id },
    $or: matches,
    zohoLeadId: { $in: ["", null] },
    leadWriteLockAt: { $gte: new Date(Date.now() - lockMs) },
  }).lean();
}

/**
 * The chat that makes this customer somebody's already.
 *
 * The one holding their lead if there is one — that rep owns them in the CRM —
 * otherwise the first chat they had.
 */
export async function earlierChatFor(
  ChatConversation: Model<IChatConversation>,
  conversation: Contactable
) {
  const matches = sameContact(conversation);
  if (!matches.length) return null;

  const withLead = await otherChatWithLead(ChatConversation, conversation);
  if (withLead?.repEmail) return withLead;

  return ChatConversation.findOne({
    _id: { $ne: conversation._id },
    $or: matches,
    repEmail: { $nin: ["", null] },
    createdAt: { $lt: conversation.createdAt || new Date() },
  })
    .sort({ createdAt: 1 })
    .lean();
}

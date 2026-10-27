import type { Connection } from "mongoose";
import { chatConversationModel, type IChatConversation } from "../../models/ChatConversation";
import { handOffToCrm } from "./handoff";
import { getSettings } from "../settingsService";
import { chatIsNotACustomer } from "../../domain/notACustomer";

/**
 * Finishing the CRM writes that did not go through the first time.
 *
 * The lead is written after the visitor has been answered, so that write is the
 * one part of a chat nobody is waiting on — and that is exactly what made it
 * dangerous. When it failed there was nothing to notice: the chat had ended
 * politely, the visitor had been told a quote was coming, and the enquiry simply
 * never reached the CRM.
 *
 * That is not hypothetical. A rep's token refresh timed out once, mid-chat, and
 * a complete enquiry — six answers, a name, an email and a phone number — sat in
 * the database with no lead against it and nothing that would ever try again.
 *
 * So the worker sweeps for them. A chat that reached the end and has no lead is
 * retried on the next pass, and the pass after that, until Zoho accepts it.
 */

/** Left alone after this many attempts, so one poisoned record cannot spin forever. */
const MAX_ATTEMPTS = 12;

/** Matches the claim the hand-off takes out. Kept in step with it deliberately. */
const LEAD_WRITE_LOCK_MS = 3 * 60_000;

/**
 * How long a chat must be silent before an unfinished one is written up anyway.
 *
 * Most visitors do not answer every question — they give a product and an email
 * and close the tab. That is still an enquiry, and waiting for a completion that
 * will never come means the only chats that ever reached the CRM were the tidy
 * ones. Long enough that somebody typing slowly is not written off mid-sentence.
 */
const ABANDONED_AFTER_MINUTES = 3;

export interface PendingLeadResult {
  retried: number;
  written: number;
  notes: string[];
}

/**
 * Whether a chat that went quiet is worth putting in front of a rep.
 *
 * An email or a phone number, and nothing else qualifies — a way to reach them
 * is the point of writing the lead at all. A fully answered enquiry with no
 * address used to pass this too, on the reasoning that a rep could still work
 * from the transcript. That was a deliberate call, and it was reversed: a rep
 * cannot quote or follow up somebody they cannot reach, and a lead with no
 * address on it was, in practice, noise the same as an empty one.
 */
function worthWritingUp(conversation: IChatConversation): boolean {
  // Not if they were never a customer. An address is exactly what a job seeker
  // does leave — two of three left one — so checking only for a way to reach
  // them is how "Product: home packing job" reached a rep's queue.
  if (chatIsNotACustomer(conversation.messages.filter((m) => m.author === "visitor").map((m) => m.text))) {
    return false;
  }
  // Not if they never typed: SalesIQ can hand over a known visitor's address on a chat
  // they only opened, and that is neither an enquiry nor a turn in the lead rotation.
  if (!conversation.messages.some((m) => m.author === "visitor" && m.text?.trim())) return false;
  return Boolean(conversation.email?.trim() || conversation.phone?.trim());
}

/**
 * Chats that have not exhausted their retries.
 *
 * Written as an `$or` because `{ leadAttempts: { $lt: MAX } }` does NOT match a
 * document where the field is absent — Mongo compares nothing against nothing
 * and returns false. Every chat written before `leadAttempts` existed has no
 * such field, so a filter that looked like "fewer than twelve tries" quietly
 * meant "and has been tried at least once".
 *
 * Twenty-two of them were invisible to both queries below, the oldest sitting
 * untouched since 24 August with nothing in the system that would ever have
 * picked it up again. Four had an email or a phone number on them.
 */
const notOutOfAttempts = {
  $or: [
    { leadAttempts: { $exists: false } },
    { leadAttempts: null },
    { leadAttempts: { $lt: MAX_ATTEMPTS } },
  ],
};

export async function writePendingChatLeads(leadsDb: Connection): Promise<PendingLeadResult> {
  const settings = await getSettings(leadsDb);
  const result: PendingLeadResult = { retried: 0, written: 0, notes: [] };

  if (!settings.chat?.writeLeadOnHandoff) return result;

  const ChatConversation = chatConversationModel(leadsDb);

  // A write that is in flight is not a write that failed. The webhook fires one
  // the moment a chat ends and Zoho takes seconds to answer; for those seconds
  // the conversation looks exactly like one whose lead never landed, and picking
  // it up here is how the same person got two.
  const notBeingWritten = {
    $or: [
      { leadWriteLockAt: { $exists: false } },
      { leadWriteLockAt: null },
      { leadWriteLockAt: { $lt: new Date(Date.now() - LEAD_WRITE_LOCK_MS) } },
    ],
  };

  /**
   * "stopped" with reason "max_turns" belongs in this retry set too.
   *
   * The idle-abandon path below closes a worthy chat as "stopped" the moment it
   * decides to write it — before the write has actually happened, so the very
   * first attempt can still fail. Without "stopped" here that record has no
   * status this query, or the idle one below, will ever match again: gone
   * silently, no retry, no "gave up" note, on nothing worse than one bad Zoho
   * round trip. This is the retry path the give-up counter exists to feed —
   * excluding the chats that most need it defeats the point of having it.
   */
  const pending = await ChatConversation.find({
    $or: [
      { status: { $in: ["ready_to_quote", "handed_off"] } },
      { status: "stopped", handoffReason: "max_turns" },
    ],
    $and: [
      {
        $or: [
          { zohoLeadId: { $exists: false } },
          { zohoLeadId: "" },
          { zohoLeadId: null },
          // Or a chat that has said more since its lead was written — a visitor
          // who came back to it. See `leadMessageCount`.
          { $expr: { $gt: [{ $size: "$messages" }, { $ifNull: ["$leadMessageCount", { $size: "$messages" }] }] } },
        ],
      },
      notBeingWritten,
      notOutOfAttempts,
    ],
  })
    .sort({ handedOffAt: 1 })
    .limit(20);

  // Unfinished chats that went quiet, where enough was said to be worth having.
  //
  // Sorted oldest first, deliberately: without an order the query returns
  // whatever Mongo's scan happens to hand back, and in practice that was the
  // same ~50 records every single pass. Sorting means a pass that closes out
  // its 50 is guaranteed to see 50 different ones next time.
  const idleCutoff = new Date(Date.now() - ABANDONED_AFTER_MINUTES * 60_000);
  //
  // With or without a lead. A chat that already had one is active again only
  // because its visitor came back to it, and it is closed the same way — its
  // new messages then go onto that lead through the pending pass.
  const idle = await ChatConversation.find({
    status: "active",
    updatedAt: { $lte: idleCutoff },
    $and: [notBeingWritten, notOutOfAttempts],
  })
    .sort({ updatedAt: 1 })
    .limit(50);

  /**
   * Every idle chat is closed here, worthy or not — that is the fix.
   *
   * It used to filter to the worthy ones first and only touch those, which
   * reads as careful and is actually the bug: a chat with no email, no phone
   * and an incomplete enquiry was read, found not worth writing, and left
   * exactly as it was — "active", unmodified, due to be read again next pass
   * and found not worth writing again. Nothing about a record like that ever
   * changes on its own, so it never left the query. Ten thousand of them
   * piled up over two weeks and permanently crowded out the hundred-odd real
   * enquiries sitting behind them in the same unsorted scan — a customer who
   * left an email and a phone number was as invisible to the sweep as someone
   * who typed nothing and closed the tab.
   *
   * A chat that fails worthWritingUp is not coming back either way; the fix is
   * to say so and let it leave the active pool, not to leave the door open.
   */
  for (const conversation of idle) {
    const aboutAJob = chatIsNotACustomer(
      conversation.messages.filter((m) => m.author === "visitor").map((m) => m.text)
    );
    conversation.status = "stopped";
    conversation.handoffReason = aboutAJob
      ? "not_a_customer"
      : worthWritingUp(conversation)
        ? "max_turns"
        : "abandoned_empty";
    conversation.handedOffAt = new Date();
    await conversation.save();

    if (conversation.handoffReason === "max_turns") pending.push(conversation);
  }

  for (const conversation of pending) {
    result.retried += 1;

    // Counted before the attempt, not after: a call that throws would otherwise
    // never record that it was tried, and the same record would be retried
    // forever on every pass.
    conversation.leadAttempts = (conversation.leadAttempts || 0) + 1;
    await conversation.save();

    const outcome = await handOffToCrm(leadsDb, conversation.conversationId, settings);

    // Nothing was written for a conversation somebody else was already writing,
    // one that already has its lead, or one with no way to reach the customer —
    // "no-contact" reaches here for a record marked "max_turns" before this rule
    // existed. Counting any of these as written would report work this pass did
    // not do.
    if (
      outcome.action === "in-flight" ||
      outcome.action === "already-linked" ||
      outcome.action === "no-contact" ||
      outcome.action === "visitor-silent"
    ) {
      continue;
    }

    if (outcome.leadOk) {
      result.written += 1;
      result.notes.push(
        `${outcome.action === "noted" ? "later messages noted on chat lead" : "chat lead"} ${outcome.zohoLeadId} ` +
          `written for ${conversation.name || "a visitor"} ` +
          `(${conversation.repName || "unassigned"}, attempt ${conversation.leadAttempts}` +
          `${conversation.handoffReason === "max_turns" ? ", chat abandoned" : ""})`
      );
    } else if (conversation.leadAttempts >= MAX_ATTEMPTS) {
      // Said plainly once, at the point it stops trying, rather than repeated
      // quietly every pass until nobody reads it.
      result.notes.push(
        `GAVE UP on the CRM lead for ${conversation.name || "a visitor"} ` +
          `after ${MAX_ATTEMPTS} attempts: ${outcome.error}`
      );
    }
  }

  return result;
}

import type { Connection } from "mongoose";
import { conversationModel, IConversation, StopReason } from "../models/Conversation";
import { settingsModel, ISettings } from "../models/Settings";
import { getSettings } from "./settingsService";
import { findEligibleLeads, EligibleLead } from "./leadSource";
import { accessTokenForRep, NoCredentialError, RefreshFailedError } from "./zohoAuth";
import { addLeadTag, addLeadNote, sendLeadMail, fetchLeadDescription } from "./zohoLead";
import { extractFields } from "./extractor";
import { composeEmail } from "./composer";
import { findRepliesFrom, repRepliedByHand } from "./replyReader";
import { buildFollowUpNote } from "../domain/followUpNote";
import { canSendNow } from "../domain/sendWindow";
import { pakistanStamp } from "../domain/officeHours";
import { describeEnquiry } from "../domain/enquiry";
import type { QuoteFieldKey, CollectedFields } from "../domain/quoteFields";

/**
 * One pass of the conversation machine.
 *
 * Every lead that may be written to becomes a conversation; every conversation
 * that is due gets looked at. The work is deliberately small and repeatable —
 * a pass that dies halfway leaves the database in a state the next pass can
 * carry on from, because each conversation is advanced and saved on its own.
 *
 * Nothing here decides *who* may be contacted. That belongs to `leadSource`,
 * and keeping it there means the answer to "why did this person get mail?" is
 * never spread across two files.
 */

/**
 * How soon to look at a waiting conversation again.
 *
 * Shorter than the poll interval, so every pass checks every waiting thread.
 * It is only a query against mail the connector has already synced — the real
 * floor on how fast a reply can be seen is that sync, not this.
 */
const REPLY_CHECK_INTERVAL_MS = 30 * 1000;

/**
 * How long a claim on a conversation is honoured.
 *
 * Long enough for the slowest realistic pass — two model calls and three Zoho
 * requests — and short enough that a process killed mid-pass does not strand
 * the conversation for long.
 */
const LOCK_TIMEOUT_MS = 5 * 60 * 1000;

/** Identifies this process in a lock, so a stuck one can be traced. */
const INSTANCE_ID = `${process.env.RAILWAY_REPLICA_ID || "local"}-${process.pid}-${Date.now()}`;

/**
 * Takes exclusive ownership of a conversation, or returns null.
 *
 * A single atomic update does the claiming: the filter demands the row still
 * be unlocked (or its lock stale) and the update stamps this instance, so two
 * processes racing on the same conversation cannot both match — one wins and
 * the other is told to leave it alone.
 */
async function claim(
  leadsDb: Connection,
  conversationId: any
): Promise<(IConversation & { _id: any }) | null> {
  const staleBefore = new Date(Date.now() - LOCK_TIMEOUT_MS);

  return conversationModel(leadsDb)
    .findOneAndUpdate(
      {
        _id: conversationId,
        $or: [{ lockedAt: null }, { lockedAt: { $exists: false } }, { lockedAt: { $lt: staleBefore } }],
      },
      { $set: { lockedAt: new Date(), lockedBy: INSTANCE_ID } },
      { new: true }
    )
    .lean<IConversation & { _id: any }>();
}

async function release(leadsDb: Connection, conversationId: any): Promise<void> {
  await conversationModel(leadsDb)
    .updateOne({ _id: conversationId }, { $set: { lockedAt: null, lockedBy: "" } })
    .catch(() => null);
}

export interface PassResult {
  created: number;
  advanced: number;
  sent: number;
  stopped: number;
  held: number;
  failed: number;
  notes: string[];
}

function enabledFieldKeys(settings: ISettings): QuoteFieldKey[] {
  return settings.quoteFields
    .filter((field) => field.enabled)
    .map((field) => field.key) as QuoteFieldKey[];
}

/** What is still unanswered, treating a field with a default as answered. */
function missingKeys(settings: ISettings, collected: CollectedFields): QuoteFieldKey[] {
  return settings.quoteFields
    .filter((field) => {
      if (!field.enabled) return false;
      const value = collected[field.key as keyof CollectedFields];
      if (value && String(value).trim()) return false;
      return !field.defaultValue?.trim();
    })
    .map((field) => field.key) as QuoteFieldKey[];
}

/** Collected answers with configured defaults filled in — what a rep is handed. */
function withDefaults(settings: ISettings, collected: CollectedFields): CollectedFields {
  const result: CollectedFields = { ...collected };
  for (const field of settings.quoteFields) {
    if (!field.enabled) continue;
    const key = field.key as keyof CollectedFields;
    if (!result[key] && field.defaultValue?.trim()) {
      result[key] = field.defaultValue.trim();
    }
  }
  return result;
}

/** Opens conversations for leads that do not have one yet. */
async function createMissingConversations(
  leadsDb: Connection,
  connectorDb: Connection,
  settings: ISettings
): Promise<{ created: number; leads: EligibleLead[] }> {
  const Conversation = conversationModel(leadsDb);
  const { eligible } = await findEligibleLeads(leadsDb, connectorDb);

  let created = 0;

  for (const lead of eligible) {
    /**
     * The enquiry, asked for again if the connector never captured it.
     *
     * Zoho fires its webhook on creation, occasionally before the Description
     * is committed, so the connector's copy is empty for a fair share of leads
     * and nothing retries. By the time a conversation opens the field exists,
     * and one request is far cheaper than an opening email that asks a customer
     * for details they already typed in.
     */
    let description = lead.description;

    if (!description && lead.zohoLeadId) {
      try {
        const token = await accessTokenForRep(leadsDb, {
          zohoUserId: lead.ownerId,
          email: lead.repEmail,
        });
        description = await fetchLeadDescription(lead.zohoLeadId, token.accessToken);
      } catch {
        // No grant, or Zoho refused. The conversation still opens; it just
        // starts without knowing what was asked for.
      }
    }

    const firstContactAt = new Date(
      Date.now() + settings.sending.firstContactDelayMinutes * 60_000
    );

    // Upsert on leadId, which carries a unique index: two passes overlapping,
    // or a restart mid-pass, must not open a second thread to the same person.
    const result = await Conversation.updateOne(
      { leadId: lead.leadId },
      {
        $setOnInsert: {
          leadId: lead.leadId,
          zohoLeadId: lead.zohoLeadId,
          customerEmail: lead.email,
          customerName: lead.fullName,
          company: lead.company,
          repZohoUserId: lead.ownerId,
          repEmail: lead.repEmail,
          repName: lead.repName,
          exhibitionTitle: lead.source,
          enquiry: describeEnquiry(description),
          status: "pending_first_contact",
          collected: {},
          messages: [],
          aiMessageCount: 0,
          nextActionAt: firstContactAt,
        },
      },
      { upsert: true }
    );

    if (result.upsertedCount > 0) created++;
  }

  return { created, leads: eligible };
}

async function stop(
  leadsDb: Connection,
  conversation: IConversation & { _id: any },
  reason: StopReason,
  note: string
): Promise<void> {
  await conversationModel(leadsDb).updateOne(
    { _id: conversation._id },
    { $set: { status: "stopped", stopReason: reason, stopNote: note, nextActionAt: null } }
  );
}

/**
 * Advances one conversation.
 *
 * Reads any reply, updates what is known, then either writes again, hands over,
 * or stops. Returns a short line describing what happened, for the pass log.
 */
async function advance(
  leadsDb: Connection,
  connectorDb: Connection,
  settings: ISettings,
  conversation: IConversation & { _id: any },
  result: PassResult
): Promise<void> {
  const Conversation = conversationModel(leadsDb);
  const messages = [...(conversation.messages || [])];

  // ---- has anyone replied? ----

  const lastLookedAt = conversation.lastOutboundAt || conversation.createdAt;

  if (conversation.lastOutboundAt) {
    if (settings.guardrails.stopWhenRepReplies) {
      const sentBodies = messages.filter((m) => m.author === "ai").map((m) => m.body);
      const byHand = await repRepliedByHand(
        connectorDb,
        conversation.customerEmail,
        lastLookedAt,
        sentBodies
      );

      if (byHand.replied) {
        await stop(
          leadsDb,
          conversation,
          "rep_replied",
          `${conversation.repEmail} answered by hand on ${pakistanStamp(byHand.at!)} PKT.`
        );
        result.stopped++;
        result.notes.push(`${conversation.customerEmail}: rep replied by hand, standing down`);
        return;
      }
    }

    const replies = await findRepliesFrom(connectorDb, conversation.customerEmail, lastLookedAt);

    // Replies are found by time, not by thread, so the same message comes back
    // on every pass until we write again and the window moves. Recording it
    // twice made the customer look like they had repeated themselves, and the
    // extractor read one answer as two.
    const alreadyRecorded = new Set(
      messages.map((message) => message.interactionId).filter(Boolean)
    );

    for (const reply of replies) {
      if (alreadyRecorded.has(reply.interactionId)) continue;
      alreadyRecorded.add(reply.interactionId);

      messages.push({
        author: "customer",
        subject: reply.subject,
        body: reply.body,
        at: reply.at,
        interactionId: reply.interactionId,
      });
    }

    if (replies.length > 0) {
      conversation.lastInboundAt = replies[replies.length - 1].at;
    }
  }

  // ---- what do we know now? ----

  let collected = conversation.collected || {};
  let optedOut = false;
  let questionsForRep: string[] = [];

  /**
   * What the customer already told us when they enquired.
   *
   * Read as the opening message of the conversation, because that is what it
   * is: a web lead arrives with product, quantity and dimensions already filled
   * in. Without this the first email asked for details the customer had just
   * typed into a form, which reads as nobody having looked.
   */
  const enquiry = conversation.enquiry?.trim();
  const forExtraction = enquiry
    ? [
        {
          author: "customer" as const,
          subject: "Enquiry",
          body: enquiry,
          at: new Date(conversation.createdAt),
        },
        ...messages,
      ]
    : messages;

  const hasCustomerMessage = forExtraction.some((message) => message.author === "customer");

  // What the company sells. Both the reading and the writing need it: one to
  // recognise "clear PET" as the material we call PET + Clear PE, the other to
  // offer real options instead of asking an open question.
  if (hasCustomerMessage) {
    const extraction = await extractFields(forExtraction, settings.quoteFields, collected, settings);
    collected = extraction.collected;
    optedOut = extraction.optedOut;
    questionsForRep = extraction.questionsForRep;
  }

  if (optedOut && settings.guardrails.stopOnOptOut) {
    await Conversation.updateOne(
      { _id: conversation._id },
      { $set: { collected, messages, status: "stopped", stopReason: "opted_out", nextActionAt: null,
                stopNote: "The customer asked not to be emailed again." } }
    );
    result.stopped++;
    result.notes.push(`${conversation.customerEmail}: opted out`);
    return;
  }

  const still = missingKeys(settings, collected);


  // ---- everything known: hand over ----

  if (still.length === 0) {
    const complete = withDefaults(settings, collected);

    await Conversation.updateOne(
      { _id: conversation._id },
      {
        $set: {
          collected: complete,
          messages,
          status: "ready_to_quote",
          handedOffAt: new Date(),
          nextActionAt: null,
        },
      }
    );

    await writeNote(leadsDb, settings, { ...conversation, collected: complete, messages, status: "ready_to_quote" });

    result.stopped++;
    result.notes.push(`${conversation.customerEmail}: all answers in — handed to ${conversation.repEmail}`);
    return;
  }

  // ---- guardrails ----

  if (conversation.aiMessageCount >= settings.guardrails.maxAiMessages) {
    await stop(
      leadsDb,
      conversation,
      "max_messages",
      `Sent ${conversation.aiMessageCount} emails without getting everything. ${conversation.repEmail} should take over.`
    );
    result.stopped++;
    result.notes.push(`${conversation.customerEmail}: message limit reached, handed over`);
    return;
  }

  const ageDays = (Date.now() - new Date(conversation.createdAt).getTime()) / 86_400_000;
  if (ageDays > settings.guardrails.maxConversationDays) {
    await stop(leadsDb, conversation, "max_duration", `Open for ${Math.round(ageDays)} days.`);
    result.stopped++;
    result.notes.push(`${conversation.customerEmail}: too old, closed`);
    return;
  }

  // ---- still waiting, and nothing new to act on ----

  const hasNewReply = messages.length > (conversation.messages?.length || 0);
  const chaseDue = !conversation.chaseAfterAt || new Date(conversation.chaseAfterAt) <= new Date();

  if (conversation.aiMessageCount > 0 && !hasNewReply && !chaseDue) {
    await Conversation.updateOne(
      { _id: conversation._id },
      { $set: { collected, messages, nextActionAt: new Date(Date.now() + REPLY_CHECK_INTERVAL_MS) } }
    );
    return;
  }

  // ---- may we send at this moment? ----

  const decision = canSendNow({ toEmail: conversation.customerEmail, settings });
  if (!decision.allowed) {
    await Conversation.updateOne(
      { _id: conversation._id },
      { $set: { collected, messages, nextActionAt: decision.retryAt || new Date(Date.now() + 3_600_000) } }
    );
    result.held++;
    result.notes.push(`${conversation.customerEmail}: held — ${decision.reason}`);
    return;
  }

  // ---- write and send ----

  try {
    // One subject for the life of the thread. `Re:` on everything after the
    // first, so the customer sees a conversation rather than a series of
    // unrelated messages.
    const threadSubject = conversation.threadSubject || "";

    const email = await composeEmail({
      customerName: conversation.customerName || "",
      company: conversation.company || "",
      repName: conversation.repName || "",
      settings,
      fields: settings.quoteFields,
      collected,
      missingKeys: still,
      // Real messages only. The enquiry goes in its own field, because it is a
      // form submission and not something the customer said to us.
      messages,
      enquiry,
      companyFacts: settings.company?.facts,
      questionsForRep,
    });

    // The model picks a subject only for the opening message; after that the
    // thread keeps the one it started with.
    const outgoingSubject = threadSubject ? `Re: ${threadSubject}` : email.subject;

    const dryRun = settings.guardrails.dryRun;

    if (!dryRun) {
      const token = await accessTokenForRep(leadsDb, {
        zohoUserId: conversation.repZohoUserId,
        email: conversation.repEmail,
      });

      const sent = await sendLeadMail({
        zohoLeadId: conversation.zohoLeadId || "",
        accessToken: token.accessToken,
        from: { name: token.fullName || conversation.repName || "", email: token.email },
        to: { name: conversation.customerName || "", email: conversation.customerEmail },
        cc: (settings.sending.ccEmails || []).map((email) => ({ email })),
        subject: outgoingSubject,
        html: email.html,
      });

      if (!sent.ok) throw new Error(sent.error || "Zoho refused the message");

      if (settings.crm.tagLeads && conversation.zohoLeadId) {
        const tagged = await addLeadTag(conversation.zohoLeadId, token.accessToken, settings.crm.tagName);
        if (!tagged.ok) {
          // Cosmetic. The email is already gone; losing the conversation over a
          // tag would be the wrong trade.
          result.notes.push(`${conversation.customerEmail}: tag failed — ${tagged.error}`);
        }
      }
    }

    messages.push({
      author: "ai",
      subject: outgoingSubject,
      body: email.body,
      at: new Date(),
      draftOnly: dryRun,
    });

    const updated: any = {
      collected,
      messages,
      status: "awaiting_reply",
      aiMessageCount: conversation.aiMessageCount + 1,
      // Look again on the next poll so a reply is noticed within minutes; do
      // not write again until the chase falls due.
      nextActionAt: new Date(Date.now() + REPLY_CHECK_INTERVAL_MS),
      chaseAfterAt: new Date(Date.now() + settings.sending.chaseAfterHours * 3_600_000),
      lastError: "",
    };
    if (!threadSubject) updated.threadSubject = email.subject;
    if (!dryRun) updated.lastOutboundAt = new Date();

    await Conversation.updateOne({ _id: conversation._id }, { $set: updated });

    await writeNote(
      leadsDb,
      settings,
      { ...conversation, collected, messages, status: "awaiting_reply", aiMessageCount: conversation.aiMessageCount + 1 },
      { subject: email.subject, body: email.body }
    );

    // The copy list is named in the note because in dry run nothing is sent —
    // this line is the only place a CC can be verified before going live.
    const copiedTo = (settings.sending.ccEmails || []).length
      ? ` (cc ${settings.sending.ccEmails.join(", ")})`
      : "";

    result.sent++;
    result.notes.push(
      `${conversation.customerEmail}: ${dryRun ? "DRAFTED (dry run)" : "sent"}${copiedTo} — "${email.subject}"`
    );
  } catch (error: any) {
    const permanent = error instanceof NoCredentialError || error instanceof RefreshFailedError;

    await Conversation.updateOne(
      { _id: conversation._id },
      {
        $set: {
          collected,
          messages,
          lastError: error.message,
          // A revoked grant will not fix itself; retrying every hour just
          // fills the log. A transient failure gets another go shortly.
          nextActionAt: permanent ? null : new Date(Date.now() + 3_600_000),
          ...(permanent ? { status: "stopped", stopReason: "manual", stopNote: error.message } : {}),
        },
      }
    );

    result.failed++;
    result.notes.push(`${conversation.customerEmail}: FAILED — ${error.message}`);
  }
}

/** Files the summary note on the CRM lead, if notes are switched on. */
async function writeNote(
  leadsDb: Connection,
  settings: ISettings,
  conversation: any,
  justSent?: { subject: string; body: string }
): Promise<void> {
  if (!settings.crm.writeNotes) return;
  if (settings.guardrails.dryRun) return;
  if (!conversation.zohoLeadId) return;

  try {
    const token = await accessTokenForRep(leadsDb, {
      zohoUserId: conversation.repZohoUserId,
      email: conversation.repEmail,
    });

    const note = buildFollowUpNote({
      conversation,
      enabledKeys: enabledFieldKeys(settings),
      justSent,
    });

    await addLeadNote(conversation.zohoLeadId, note.title, note.content, token.accessToken);
  } catch {
    // A missing note is not worth failing a delivered email over.
  }
}

/**
 * Runs one pass: open conversations for new leads, then advance whatever is due.
 */
export async function runPass(leadsDb: Connection, connectorDb: Connection): Promise<PassResult> {
  const result: PassResult = { created: 0, advanced: 0, sent: 0, stopped: 0, held: 0, failed: 0, notes: [] };

  const settings = await getSettings(leadsDb, true);

  // Stamped even when paused: the point is to prove the worker is alive, and a
  // paused service that is still ticking is a completely different problem from
  // one whose process is not running.
  const stamp = async (summary: string) => {
    await settingsModel(leadsDb)
      .updateOne({ key: "singleton" }, { $set: { lastPassAt: new Date(), lastPassSummary: summary } })
      .catch(() => null);
  };

  if (!settings.enabled) {
    result.notes.push("service is paused");
    await stamp("paused — nothing looked at");
    return result;
  }

  const { created } = await createMissingConversations(leadsDb, connectorDb, settings);
  result.created = created;

  const due = await conversationModel(leadsDb)
    .find({
      status: { $in: ["pending_first_contact", "awaiting_reply"] },
      nextActionAt: { $lte: new Date() },
    })
    .sort({ nextActionAt: 1 })
    .limit(25)
    .lean();

  for (const candidate of due) {
    // Claimed before anything is read or sent. Without this, two processes
    // both find the same conversation due and both email the customer.
    const conversation = await claim(leadsDb, (candidate as any)._id);
    if (!conversation) continue;

    result.advanced++;
    try {
      await advance(leadsDb, connectorDb, settings, conversation, result);
    } finally {
      await release(leadsDb, (candidate as any)._id);
    }
  }

  await stamp(
    `opened ${result.created}, advanced ${result.advanced}, sent ${result.sent}, ` +
      `held ${result.held}, stopped ${result.stopped}, failed ${result.failed}`
  );

  return result;
}

/** Kept for the dashboard: settings are read through the same model. */
export { settingsModel };

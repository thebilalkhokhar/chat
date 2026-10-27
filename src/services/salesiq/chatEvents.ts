import type { Request, Response } from "express";
import type { Connection } from "mongoose";
import { config } from "../../config/env";
import { salesIqCaptureModel } from "../../models/SalesIqCapture";
import { chatConversationModel, IChatConversation } from "../../models/ChatConversation";
import { hasValidToken, verifySalesIqSignature } from "./webhook";
import { moveLeadToPicker } from "./handoff";

/**
 * What SalesIQ tells us about the chat that the bot handler never does.
 *
 * The bot webhook only ever hears from the visitor: across every callback
 * SalesIQ has made to this service there are three handlers — `trigger`,
 * `message` and `failure` — and not one of them carries an operator. So when a
 * rep picks a chat up, the bot is simply dropped from the conversation, and the
 * transcript we show the team stops dead at the hand-off with no sign that
 * anybody ever came.
 *
 * SalesIQ's chat-event webhook does carry it, and is configured separately
 * (Settings → Developers → Webhooks). This reads it.
 *
 * Every field name below is a guess until a real call lands, because Zoho
 * publishes no schema for it — so nothing is required, every plausible spelling
 * is tried, and the whole body is stored either way. When a real event arrives,
 * this is the only file that changes.
 */

export interface ChatEvent {
  /** What happened, lowercased: "chat_attended", "attended", "chat_closed"… */
  event: string;
  /** Whatever it called the chat. Tried against every id we file chats under. */
  chatId: string;
  visitorId: string;
  uvid: string;
  attenderName: string;
  attenderEmail: string;
}

function first(...values: unknown[]): string {
  for (const value of values) {
    const text = String(value ?? "").trim();
    if (text && text !== "null" && text !== "undefined") return text;
  }
  return "";
}

function nameOf(who: any): string {
  if (!who || typeof who !== "object") return String(who || "").trim();
  return first(
    who.name,
    who.display_name,
    who.displayname,
    [who.first_name, who.last_name].filter(Boolean).join(" "),
    who.nick_name,
    who.email_id,
    who.email
  );
}

function emailOf(who: any): string {
  if (!who || typeof who !== "object") return "";
  return first(who.email_id, who.email, who.emailid, who.mail).toLowerCase();
}

export function readChatEvent(body: any): ChatEvent {
  const data = body?.entity_data || body?.data || body?.chat || body || {};
  const visitor = data.visitor || body?.visitor || {};
  const attender = data.attender || data.operator || data.attended_by || body?.attender || body?.operator || {};

  return {
    event: first(
      body?.event_type,
      body?.event,
      body?.operation,
      body?.handler,
      body?.entity && data.status ? `${body.entity}_${data.status}` : "",
      data.status
    ).toLowerCase(),
    chatId: first(
      data.chat_id,
      data.chatid,
      data.id,
      body?.chat_id,
      visitor.active_conversation_id,
      data.conversation_id
    ),
    visitorId: first(visitor.visitor_id, visitor.id, data.visitor_id),
    uvid: first(visitor.uvid, data.uvid, body?.uvid),
    attenderName: nameOf(attender),
    attenderEmail: emailOf(attender),
  };
}

/**
 * Whether this event means a person is now in the chat.
 *
 * Generous on purpose: an event we do not recognise is recorded and shown to
 * nobody, which is a worse failure than treating "chat_answered" and
 * "chat_attended" as the same thing — they are.
 */
export function isSomebodyJoining(event: ChatEvent): boolean {
  if (!event.attenderName && !event.attenderEmail) return false;
  return /attend|answer|accept|pick|assign|join|connect|transfer/i.test(event.event);
}

/** The line the transcript shows when they arrive. */
export function joinedLine(who: string): string {
  return `${who.trim() || "A team member"} joined the chat.`;
}

export type EventOutcome =
  | { applied: false; why: string }
  | { applied: true; conversationId: string; who: string };

/**
 * Records the join against the chat it belongs to.
 *
 * Matched on any id SalesIQ offers, because a chat is filed under its uvid on
 * the opening trigger and under the conversation id afterwards — see
 * `readIncoming`. Earlier visits, set aside with "~" in their id, are excluded:
 * the rep is joining this chat, not last week's.
 */
export async function applyChatEvent(leadsDb: Connection, event: ChatEvent): Promise<EventOutcome> {
  if (!isSomebodyJoining(event)) return { applied: false, why: `nothing to record for "${event.event}"` };

  const ids = [event.chatId, event.uvid, event.visitorId].filter(Boolean);
  if (ids.length === 0) return { applied: false, why: "the event named no chat" };

  const ChatConversation = chatConversationModel(leadsDb);
  const conversation = await ChatConversation.findOne({
    conversationId: { $not: /~/ },
    $or: [{ conversationId: { $in: ids } }, { uvid: { $in: ids } }, { visitorId: { $in: ids } }],
  }).sort({ updatedAt: -1 });

  if (!conversation) return { applied: false, why: `no chat found for ${ids.join(", ")}` };

  const who = event.attenderName || event.attenderEmail;
  const line = joinedLine(who);

  // The same person joining twice — a reconnect, a redelivered event — is one
  // arrival. A second, different rep joining is worth showing.
  const alreadySaid = conversation.messages.some(
    (message: IChatConversation["messages"][number]) => message.author === "system" && message.text === line
  );

  if (!alreadySaid) {
    conversation.messages.push({ author: "system", text: line, at: new Date() });
  }

  conversation.attenderName = event.attenderName || conversation.attenderName;
  conversation.attenderEmail = event.attenderEmail || conversation.attenderEmail;
  if (!conversation.attendedAt) conversation.attendedAt = new Date();
  await conversation.save();

  // Whoever picks the chat up owns its lead. A lead not written yet goes to them
  // when it is (handoff.ts); one already written by the rotation moves to them now.
  const move = await moveLeadToPicker(leadsDb, conversation as any).catch((error: any) => ({ moved: false, why: error.message }));
  console.log(`[salesiq] ${conversation.conversationId}: lead ${move.moved ? `moved to ${who}` : `not moved (${move.why})`}`);

  return { applied: true, conversationId: conversation.conversationId, who };
}

/**
 * The endpoint itself.
 *
 * Answers 200 to anything it can authenticate, whether or not it understood the
 * body. SalesIQ disables a webhook that keeps failing, and an event shape we
 * have not seen before is something to read in the captures afterwards, not a
 * reason to lose the integration.
 */
export function createSalesIqEventsWebhook(leadsDb: Connection) {
  const Capture = salesIqCaptureModel(leadsDb);

  return async function handleSalesIqEvent(req: Request, res: Response): Promise<void> {
    const startedAt = Date.now();
    const verification = verifySalesIqSignature(req);
    const tokenPresented = hasValidToken(req);

    if (!verification.verified && !tokenPresented && !config.salesiq.captureUnverified) {
      console.warn(`[salesiq] event rejected: ${verification.detail}`);
      res.status(401).json({ error: "Unauthorised" });
      return;
    }

    let outcome: EventOutcome = { applied: false, why: "not read" };
    let event: ChatEvent | null = null;

    try {
      event = readChatEvent(req.body);
      outcome = await applyChatEvent(leadsDb, event);
      console.log(
        `[salesiq] chat event "${event.event}" ` +
          (outcome.applied
            ? `— ${outcome.who} joined ${outcome.conversationId}`
            : `— not recorded: ${outcome.why}`)
      );
    } catch (error: any) {
      console.error("[salesiq] chat event failed:", error.message);
    }

    res.json({ ok: true });

    try {
      await Capture.create({
        receivedAt: new Date(startedAt),
        method: req.method,
        path: req.originalUrl.split("?")[0],
        headers: { note: "chat event" },
        query: { ...req.query, token: req.query.token ? "[redacted]" : undefined },
        body: req.body,
        // Prefixed so these never look like bot handlers in the capture counts.
        handler: `event:${event?.event || "unknown"}`,
        reply: outcome,
        tookMs: Date.now() - startedAt,
        verified: verification.verified,
      });
    } catch (error: any) {
      console.error("[salesiq] could not store the chat event:", error.message);
    }
  };
}

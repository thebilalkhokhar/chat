import axios from "axios";
import type { Connection } from "mongoose";
import { config } from "../config/env";
import { chatConversationModel, type IChatConversation } from "../models/ChatConversation";
import { isPlaceholderName } from "../domain/contactFields";
import type { ISettings } from "../models/Settings";

/**
 * Telling a rep, in the ERP, that a chat of theirs is live.
 *
 * The chat already belongs to somebody: a rep is chosen when it opens and the
 * bot speaks as them from the first word. What was missing is that the rep had
 * no idea — they found out when the lead appeared, long after the visitor had
 * gone. This puts the alert in front of them while the person is still on the
 * page.
 *
 * Never throws and never blocks the visitor. A rep not being told is a missed
 * opportunity; a chat that stops answering because a notification failed is a
 * lost customer, and the second is much worse than the first.
 */

const REQUEST_TIMEOUT_MS = 15_000;

/** How much of what they said goes in the alert. Enough to judge it by. */
const PREVIEW_CHARS = 200;

export interface NotifyOutcome {
  sent: boolean;
  /** Why nothing was sent, when that was the right answer rather than a failure. */
  skipped?: string;
  status?: number;
  error?: string;
}

/**
 * The ERP's own id for a rep.
 *
 * The ERP identifies people by an integer of its own, not by email and not by
 * the Zoho user id the quotes endpoint takes, so the two have to be married up
 * somewhere. Here, from settings, so adding a rep is a dashboard edit.
 */
export function erpUserIdFor(settings: ISettings, repEmail?: string): number | null {
  const ids = (settings.chat?.erpUserIds || {}) as Record<string, unknown>;
  const id = Number(ids[String(repEmail || "").trim().toLowerCase()]);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Everybody who should hear about a chat.
 *
 * All four agents, not just whoever the bot was speaking as. Since the chat is
 * offered to the whole pool and whoever accepts it first owns it, telling only
 * one of them is telling the wrong one three times out of four.
 *
 * The same list the chat itself is forwarded to — deliberately not a fourth
 * roster to keep in step with the other three. An agent with no ERP id is left
 * out rather than silently dropping the alert for everyone.
 *
 * Falls back to the assigned rep when the pool is empty or nobody in it has an
 * id, which is exactly what this did before the pool existed.
 */
export function erpRecipients(
  settings: ISettings,
  repEmail?: string
): Array<{ email: string; userId: number }> {
  const pool = (settings.chat?.liveAgentEmails || []).map((e) => String(e || "").trim()).filter(Boolean);

  const found: Array<{ email: string; userId: number }> = [];
  for (const email of pool) {
    const userId = erpUserIdFor(settings, email);
    if (userId && !found.some((r) => r.userId === userId)) found.push({ email, userId });
  }

  if (found.length) return found;

  const assigned = erpUserIdFor(settings, repEmail);
  return assigned ? [{ email: String(repEmail || ""), userId: assigned }] : [];
}

/** How many messages the visitor has sent. The alert count is measured against it. */
export function visitorMessageCount(conversation: IChatConversation): number {
  return conversation.messages.filter((message) => message.author === "visitor").length;
}

/**
 * Whether this chat has reached the point of telling its rep — again, possibly.
 *
 * Nothing is raised once the chat has left the bot's hands. There is no takeover
 * event to listen for: SalesIQ only ever sends trigger, message and failure, and
 * a chat a rep has taken over simply stops arriving here. So "until the rep
 * takes over" is not something this decides — it is what happens when SalesIQ
 * stops asking us to answer. What this does decide is the case we do see: a chat
 * the bot itself has finished, which is no longer live and must not keep
 * alerting.
 *
 * A chat handed to a person is the exception. By day that happens on the
 * visitor's very first message, before this is asked, so excluding it meant not
 * one working-hours chat ever reached the ERP — the ones a person has to pick
 * up. The alert counter still stops it being raised twice.
 */
export function shouldNotifyRep(conversation: IChatConversation, settings: ISettings): boolean {
  if (!settings.chat?.notifyRepOfChats) return false;
  if (!conversation.repEmail) return false;
  if (conversation.status !== "active" && conversation.status !== "handed_off") return false;

  const sent = conversation.erpAlerts || 0;
  const spoken = visitorMessageCount(conversation);

  switch (settings.chat.notifyRepOn || "first_message") {
    case "chat_open":
      return sent === 0;
    case "every_message":
      return spoken > sent;
    default:
      return sent === 0 && spoken >= 1;
  }
}

/**
 * What they just said — the newest message, not the first.
 *
 * With an alert per message, quoting the opening line every time would make
 * every alert after the first look like a repeat of the one before it.
 */
export function latestVisitorMessage(conversation: IChatConversation): string {
  const latest = [...conversation.messages].reverse().find((message) => message.author === "visitor");
  const text = (latest?.text || conversation.question || "").trim().replace(/\s+/g, " ");
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS - 1)}…` : text;
}

const previewOf = latestVisitorMessage;

/**
 * Where the alert sends the rep. `{chat_id}` is theirs.
 *
 * Two things the published spec gets wrong, both found by asking the endpoint.
 * It lists chat_url as optional: leave it out and the answer is 422, "The chat
 * url field is required". And its own example is a bare path — /admin/chat/
 * chat_1238 — which the same validator rejects as "The chat url format is
 * invalid", because it wants an absolute URL.
 *
 * So this is never empty, and a template written as a path is made absolute
 * against the ERP rather than sent as-is and refused.
 */
const DEFAULT_CHAT_PATH = "/admin/chat/{chat_id}";

export function chatUrlFor(conversation: IChatConversation, settings: ISettings): string {
  const template = String(settings.chat?.chatUrlTemplate || "").trim() || DEFAULT_CHAT_PATH;

  /**
   * Every id SalesIQ gives us, because which one its console wants is its
   * business and not something to guess in code. `visitor_id` is the numeric
   * one — the same value SalesIQ also sends as `active_conversation_id`, and
   * the one its own URLs use: /allchats/948557000003797015.
   */
  const ids: Record<string, string> = {
    chat_id: conversation.conversationId,
    chatid: conversation.conversationId,
    visitor_id: conversation.visitorId || "",
    visitorid: conversation.visitorId || "",
    uvid: conversation.uvid || "",
    uuid: conversation.uuid || "",
  };

  let unknown = false;
  const filled = template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    const value = ids[key.toLowerCase()] || "";
    if (!value) unknown = true;
    return encodeURIComponent(value);
  });

  /**
   * A template asking for an id this chat has not got.
   *
   * SalesIQ sends no visitor_id on the opening trigger, so a chat alerted before
   * the visitor has typed has nothing to put in the path. Half a URL is a dead
   * link; the console's own front page is not, and the rep is one click from the
   * chat rather than looking at an error.
   */
  if (unknown) {
    const origin = template.match(/^https?:\/\/[^/]+/);
    return origin ? `${origin[0]}/` : config.erp.baseUrl;
  }

  if (/^https?:\/\//i.test(filled)) return filled;
  return `${config.erp.baseUrl}/${filled.replace(/^\/+/, "")}`;
}

export async function notifyRepOfChat(
  leadsDb: Connection,
  conversationId: string,
  settings: ISettings
): Promise<NotifyOutcome> {
  if (!settings.chat?.notifyRepOfChats) return { sent: false, skipped: "not switched on" };
  if (!config.erp.baseUrl) return { sent: false, skipped: "no ERP base url configured" };

  const ChatConversation = chatConversationModel(leadsDb);

  const before = await ChatConversation.findOne({ conversationId }).lean();
  if (!before) return { sent: false, skipped: "no such conversation" };
  if (!shouldNotifyRep(before as IChatConversation, settings)) {
    return { sent: false, skipped: "nothing new to raise" };
  }

  /**
   * Claimed by moving the count on from the value we just read.
   *
   * Two turns of the same chat can be in flight together. Both would see the
   * same count; only one can move it, and the other matches nothing and stops.
   * The ERP would answer the duplicate with a 409 anyway, but sending a request
   * we already know is wrong is not a plan.
   */
  const claimed = before.erpAlerts || 0;
  const conversation = await ChatConversation.findOneAndUpdate(
    { conversationId, $or: [{ erpAlerts: claimed }, ...(claimed === 0 ? [{ erpAlerts: { $exists: false } }] : [])] },
    { $set: { erpNotifiedAt: new Date() }, $inc: { erpAlerts: 1 } },
    { new: true }
  );

  if (!conversation) return { sent: false, skipped: "another turn is raising it" };

  /** Hands the count back, so the next message tries again. */
  const release = async () => {
    await ChatConversation.updateOne({ conversationId }, { $inc: { erpAlerts: -1 } });
  };

  const recipients = erpRecipients(settings, conversation.repEmail);
  if (!recipients.length) {
    await release();
    console.warn(`[chat] no ERP user ids for any agent — nobody was told about ${conversationId}`);
    return { sent: false, skipped: "no ERP user id for any agent" };
  }

  const name = isPlaceholderName(conversation.name) ? "" : conversation.name.trim();
  const preview = previewOf(conversation);
  const chatUrl = chatUrlFor(conversation, settings);

  /**
   * One id per alert, because the ERP treats a repeat as the same notification.
   *
   * The first keeps the conversation's own id, so a chat that only ever raises
   * one alert reads exactly as the ERP's documentation expects. Later ones are
   * numbered.
   */
  const chatId = claimed === 0 ? conversation.conversationId : `${conversation.conversationId}-m${claimed + 1}`;

  /**
   * One id per person as well as per alert.
   *
   * The ERP treats a repeated chat_id as the same notification and answers 409,
   * so four agents sharing one id would mean one alert and three no-ops. A
   * single recipient keeps the bare id, which is the shape the ERP's own
   * documentation describes and what every existing alert already used.
   */
  const idFor = (userId: number) => (recipients.length === 1 ? chatId : `${chatId}-u${userId}`);

  const common: Record<string, unknown> = {};
  // Optional, and only when we actually have them: the ERP shows these to the
  // rep, and an empty string on the alert is worse than the field being absent.
  if (name) common.customer_name = name;
  if (conversation.email?.trim()) common.customer_email = conversation.email.trim();
  if (conversation.phone?.trim()) common.customer_phone = conversation.phone.trim();
  if (preview) common.message_preview = preview;
  if (conversation.zohoLeadId) common.reference_id = conversation.zohoLeadId;
  // Required, despite being documented as optional.
  common.chat_url = chatUrl;

  const delivered: string[] = [];
  const failures: string[] = [];
  let lastStatus: number | undefined;

  for (const recipient of recipients) {
    const body = { ...common, chat_id: idFor(recipient.userId), assigned_user_id: recipient.userId };

    try {
      const response = await axios.post(`${config.erp.baseUrl}/api/live-chat/incoming`, body, {
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...(config.erp.token ? { Authorization: `Bearer ${config.erp.token}` } : {}),
        },
        timeout: REQUEST_TIMEOUT_MS,
        validateStatus: () => true,
      });

      lastStatus = response.status;

      // 409 is the ERP saying this chat is already in front of somebody, which
      // is the outcome we wanted. Anything else in the 2xx range is a fresh alert.
      if (response.status === 201 || response.status === 200 || response.status === 409) {
        delivered.push(recipient.email);
        continue;
      }

      // 422 names the field it did not like, and that is the whole diagnosis —
      // an assigned_user_id the ERP does not know reads exactly like this.
      const detail =
        response.status === 422
          ? JSON.stringify(response.data?.errors || response.data?.message || {})
          : String(response.data?.message || "").slice(0, 200);

      failures.push(`${recipient.email}: ${response.status} ${detail}`);
      console.error(
        `[chat] ERP would not take the alert for ${conversationId} to ${recipient.email}: ${response.status} ${detail}`
      );
    } catch (error: any) {
      failures.push(`${recipient.email}: ${error.message}`);
      console.error(`[chat] could not reach the ERP for ${conversationId} (${recipient.email}): ${error.message}`);
    }
  }

  // Held back only when nobody at all was told. One agent hearing about it means
  // the chat is in front of somebody, and retrying would alert them twice.
  if (!delivered.length) {
    await release();
    return { sent: false, status: lastStatus, error: failures.join("; ") };
  }

  return {
    sent: true,
    status: lastStatus,
    error: failures.length ? failures.join("; ") : undefined,
  };
}

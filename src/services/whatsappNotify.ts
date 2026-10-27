import axios from "axios";
import type { Connection } from "mongoose";
import { config } from "../config/env";
import { chatConversationModel, type IChatConversation } from "../models/ChatConversation";
import { chatUrlFor, visitorMessageCount, latestVisitorMessage } from "./erpChatNotify";
import type { ISettings } from "../models/Settings";

/**
 * The same alert, in the room where the team actually is.
 *
 * Two messages, not one. The group is how the team sees the shape of the day and
 * how somebody else can pick a chat up when its owner is away from their desk;
 * the personal message is the one that actually gets answered, because a message
 * addressed to everybody is answered by nobody. They go out together and neither
 * depends on the other.
 *
 * Never throws and never blocks the visitor. A rep not being told is a missed
 * opportunity; a chat that stops answering because a message failed is a lost
 * customer, and the second is much worse than the first.
 */

const REQUEST_TIMEOUT_MS = 15_000;

export interface WhatsAppOutcome {
  sent: boolean;
  /** Which of the two landed: "group", "rep", or both. */
  delivered?: string[];
  skipped?: string;
  status?: number;
  error?: string;
}

/** The rep's own WhatsApp, in the bridge's form, if one is on file. */
export function repNumberFor(settings: ISettings, repEmail?: string): string {
  const numbers = (settings.chat?.whatsappRepNumbers || {}) as Record<string, unknown>;
  return String(numbers[String(repEmail || "").trim().toLowerCase()] || "").trim();
}

/**
 * Everybody who should get a personal message about a chat.
 *
 * All four agents rather than whoever the bot was speaking as. The chat is
 * offered to the whole pool and whoever accepts it first owns it, so one
 * personal message goes to the wrong person most of the time.
 *
 * The same roster the chat is forwarded to and the ERP alert uses. An agent
 * with no number on file is left out; the rest still get theirs. Falls back to
 * the assigned rep when the pool is empty or none of them have a number, which
 * is what this did before the pool existed.
 */
export function whatsAppRecipients(
  settings: ISettings,
  repEmail?: string
): Array<{ email: string; number: string }> {
  const pool = (settings.chat?.liveAgentEmails || []).map((e) => String(e || "").trim()).filter(Boolean);

  const found: Array<{ email: string; number: string }> = [];
  for (const email of pool) {
    const number = repNumberFor(settings, email);
    if (number && !found.some((r) => r.number === number)) found.push({ email, number });
  }

  if (found.length) return found;

  const assigned = repNumberFor(settings, repEmail);
  return assigned ? [{ email: String(repEmail || ""), number: assigned }] : [];
}

/** Whether there is anywhere to send and the credentials to send with. */
export function isWhatsAppConfigured(settings: ISettings): boolean {
  const hasSomewhere =
    Boolean(settings.chat?.whatsappChatId?.trim()) ||
    Object.keys(settings.chat?.whatsappRepNumbers || {}).length > 0;

  return Boolean(
    settings.chat?.whatsappEnabled &&
      hasSomewhere &&
      config.whatsapp.baseUrl &&
      config.whatsapp.sessionId &&
      config.whatsapp.apiKey
  );
}

/**
 * Whether this chat owes anybody a message.
 *
 * The same shape as the ERP rule and counted separately, so one falling over
 * does not silence the other, and turning one off does not turn off both.
 */
export function shouldWhatsApp(conversation: IChatConversation, settings: ISettings): boolean {
  if (!isWhatsAppConfigured(settings)) return false;
  if (!conversation.repEmail) return false;
  // A chat handed to a person counts. By day that happens on the visitor's very
  // first message, before this is asked, so requiring "active" meant not one
  // working-hours chat was ever announced — the ones a person has to pick up.
  if (conversation.status !== "active" && conversation.status !== "handed_off") return false;

  const sent = conversation.waAlerts || 0;
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
 * Which page they are on.
 *
 * The address itself, every time, including the front page. A rep reading
 * "Custom Boxes | Print247" still has to guess which of several box pages that
 * is, while the path says it outright — and an address is something you can tap
 * and land on, which a name is not.
 *
 * The query string goes. Half our traffic arrives on a paid link, and
 * ?utm_source=google&utm_medium=pmax&gclid=… is two lines of noise on a phone
 * that tells the rep nothing they can act on.
 */
function pageLabel(conversation: IChatConversation): string {
  const address = String(conversation.currentPageUrl || "").trim();

  if (address) {
    try {
      const url = new URL(address);
      return `${url.origin}${url.pathname}`;
    } catch {
      // Not a URL we can read — send it as it came rather than dropping it.
      return address;
    }
  }

  return conversation.landingPageTitle?.trim() || "";
}

/**
 * What gets read.
 *
 * Every line names itself, including the link — a bare URL at the end of a
 * message is a thing people scroll past without knowing it was the one worth
 * tapping.
 *
 * No customer name: at the moment this goes out the visitor is usually still
 * "Visitor 621026", SalesIQ's placeholder, and that is a line to read past
 * rather than information.
 *
 * The only difference between the two versions is the top line. The group has to
 * be told whose chat it is; the rep already knows, and being told their own name
 * by a robot reads like a mailing list.
 */
/**
 * Direct web view URL showing the mobile-responsive chat transcript.
 */
export function chatWebViewUrl(conversationId: string): string {
  const base = config.appBaseUrl || "https://lead-follow-up-production.up.railway.app";
  return `${base.replace(/\/+$/, "")}/chat-view/${encodeURIComponent(conversationId)}`;
}

export function messageFor(
  conversation: IChatConversation,
  settings: ISettings,
  audience: "group" | "rep"
): string {
  const rep = conversation.repName?.trim() || conversation.repEmail || "unassigned";
  const said = latestVisitorMessage(conversation);
  const page = pageLabel(conversation);

  // Offered to the whole live pool, so nobody owns it yet — whoever accepts first does.
  const toThePool = conversation.status === "handed_off" && conversation.handoffReason === "live_agent";

  const lines =
    audience === "rep"
      ? [toThePool ? "*New website chat — waiting for an agent*" : "*New website chat — yours*"]
      : ["*New website chat*", toThePool ? "Waiting for an agent — first to accept owns it" : `Assigned to: ${rep}`];

  if (said) lines.push(`Message: ${said}`);
  if (page) lines.push(`Page: ${page}`);
  lines.push(`Web view: ${chatWebViewUrl(conversation.conversationId)}`);
  lines.push(`Open chat: ${chatUrlFor(conversation, settings)}`);

  return lines.join("\n");
}

/** One message to one WhatsApp id. */
export async function sendText(
  chatId: string,
  text: string
): Promise<{ ok: boolean; status?: number; error?: string }> {
  const url =
    `${config.whatsapp.baseUrl}/api/sessions/${encodeURIComponent(config.whatsapp.sessionId)}` +
    `/messages/send-text`;

  try {
    const response = await axios.post(
      url,
      { chatId, text },
      {
        headers: { "Content-Type": "application/json", "x-api-key": config.whatsapp.apiKey },
        timeout: REQUEST_TIMEOUT_MS,
        validateStatus: () => true,
      }
    );

    if (response.status >= 200 && response.status < 300) return { ok: true, status: response.status };

    const detail = String(
      response.data?.message || response.data?.error || JSON.stringify(response.data || {})
    ).slice(0, 200);

    return { ok: false, status: response.status, error: detail };
  } catch (error: any) {
    return { ok: false, error: error.message };
  }
}

export async function whatsAppRepAlert(
  leadsDb: Connection,
  conversationId: string,
  settings: ISettings
): Promise<WhatsAppOutcome> {
  if (!isWhatsAppConfigured(settings)) return { sent: false, skipped: "not configured" };

  const ChatConversation = chatConversationModel(leadsDb);

  const before = await ChatConversation.findOne({ conversationId }).lean();
  if (!before) return { sent: false, skipped: "no such conversation" };
  if (!shouldWhatsApp(before as IChatConversation, settings)) {
    return { sent: false, skipped: "nothing new to send" };
  }

  // Claimed by moving the count on, exactly as the ERP alert is: two turns in
  // flight together both read the same number and only one can move it.
  const claimed = before.waAlerts || 0;
  const conversation = await ChatConversation.findOneAndUpdate(
    {
      conversationId,
      $or: [{ waAlerts: claimed }, ...(claimed === 0 ? [{ waAlerts: { $exists: false } }] : [])],
    },
    { $set: { waNotifiedAt: new Date() }, $inc: { waAlerts: 1 } },
    { new: true }
  );

  if (!conversation) return { sent: false, skipped: "another turn is sending it" };

  /** Hands the count back, so the next message tries again. */
  const release = async () => {
    await ChatConversation.updateOne({ conversationId }, { $inc: { waAlerts: -1 } });
  };

  const group = String(settings.chat?.whatsappChatId || "").trim();
  const personal = whatsAppRecipients(settings, conversation.repEmail);

  const targets: Array<{ who: string; chatId: string; text: string }> = [];
  if (group) targets.push({ who: "group", chatId: group, text: messageFor(conversation, settings, "group") });
  for (const recipient of personal) {
    targets.push({
      who: recipient.email || "rep",
      chatId: recipient.number,
      text: messageFor(conversation, settings, "rep"),
    });
  }

  if (targets.length === 0) {
    await release();
    return { sent: false, skipped: "no group, and no number on file for any agent" };
  }

  const delivered: string[] = [];
  const failures: string[] = [];

  for (const target of targets) {
    const result = await sendText(target.chatId, target.text);
    if (result.ok) {
      delivered.push(target.who);
    } else {
      failures.push(`${target.who}: ${result.status || ""} ${result.error || ""}`.trim());
      console.error(
        `[chat] WhatsApp to the ${target.who} failed for ${conversationId}: ${result.status} ${result.error}`
      );
    }
  }

  // Held back only when nothing at all got through. One of the two landing means
  // somebody has been told, and retrying on the next message would send it twice.
  if (delivered.length === 0) {
    await release();
    return { sent: false, error: failures.join("; ") };
  }

  // Not a failure, but worth saying: with no personal numbers on file the only
  // place anybody hears about this is the group, which is where an alert
  // addressed to everybody is easiest to miss.
  if (!personal.length) {
    console.warn(`[chat] no WhatsApp number on file for any agent — group only`);
  }

  return { sent: true, delivered, error: failures.length ? failures.join("; ") : undefined };
}

import type { Connection } from "mongoose";
import { chatConversationModel } from "../../models/ChatConversation";
import { applyChatEvent } from "./chatEvents";
import { salesIqToken, fetchConversation, fetchMessages, fetchOperator } from "./salesIqApi";
import { sendText } from "../whatsappNotify";

/**
 * Who took each chat over, and what was said after — read from SalesIQ's API.
 *
 * SalesIQ drops the bot from a chat the moment a rep picks it up and tells this
 * service nothing more: not that someone joined (this plan has no chat-event
 * webhook), not what they said. Until 24 Oct no chat had ever been recorded as
 * taken over, so every take-over rule — the rep who picks a chat up owns its lead,
 * a clash with another rep's customer goes to the manager — had never once run.
 *
 * Every few minutes this asks SalesIQ about the recent chats nobody is recorded on.
 * A rep found in one is applied exactly as the webhook would have (applyChatEvent →
 * moveLeadToPicker). Once a chat has ended, everything the rep and the visitor said
 * after the bot's last line is added to the transcript, which the lead pass then
 * notes on the Zoho lead.
 *
 * Zoho publishes the endpoints but not every field in their answers, so the reading
 * below tries each plausible spelling. A field it does not find leaves the chat as
 * it was, never guessed.
 */

const POLL_EVERY_MS = 3 * 60_000;
/**
 * How long a chat is followed, counted from when it started (never from updatedAt, which every
 * check moves). A chat nobody took over stops being asked about after NOT_TAKEN_FOR_MS; a taken-over
 * one is followed until SalesIQ closes it, which it does on its own about 13 hours after the chat
 * goes quiet, or TAKEN_FOR_MS at most.
 */
const NOT_TAKEN_FOR_MS = 6 * 60 * 60_000;
const TAKEN_FOR_MS = 24 * 60 * 60_000;
/** A taken-over chat this quiet has its messages collected without waiting for SalesIQ to close it. */
const QUIET_MS = 30 * 60_000;
/** A chat this young is asked about every pass; an older one every LATER_EVERY_MS. */
const RECENT_MS = 60 * 60_000;
const LATER_EVERY_MS = 30 * 60_000;
const CHATS_PER_PASS = 40;
/** The sync shares the worker pass with lead writing and follow-ups, so it never holds it up for longer. */
const PASS_BUDGET_MS = 20_000;
const STATE = "salesiq_operator_sync";

let warnedOff = false;

function text(...values: unknown[]): string {
  for (const value of values) {
    const s = String(value ?? "").trim();
    if (s && s !== "null" && s !== "undefined") return s;
  }
  return "";
}

/** The people SalesIQ lists on a conversation, whatever it calls them. */
function participants(conv: any): any[] {
  const list = [
    conv?.attender,
    conv?.operator,
    conv?.attended_by,
    ...(Array.isArray(conv?.attenders) ? conv.attenders : []),
    ...(Array.isArray(conv?.operators) ? conv.operators : []),
    ...(Array.isArray(conv?.participants) ? conv.participants : []),
  ];
  return list.filter((p) => p && typeof p === "object");
}

function isBot(person: any): boolean {
  // SalesIQ marks its bot `is_bot: true, type: "Bot"`; a rep is `is_bot: false, type: "Salesiq User"`.
  return person.is_bot === true || /bot/i.test(text(person.type, person.user_type, person.role));
}

/** The rep in the chat, with an email to match them to a Zoho sign-in. Bots never count. */
async function repIn(leadsDb: Connection, conv: any): Promise<{ name: string; email: string } | null> {
  for (const person of participants(conv)) {
    if (isBot(person)) continue;
    let email = text(person.email_id, person.email, person.emailid).toLowerCase();
    let name = text(person.name, person.display_name, person.nick_name);
    const id = text(person.id, person.operator_id, person.user_id);
    if (!email && id) {
      // A bot has no operator record, so this lookup is also what rules one out.
      const operator = await fetchOperator(leadsDb, id).catch(() => null);
      email = text(operator?.email_id, operator?.email).toLowerCase();
      name = name || text(operator?.name, operator?.nick_name);
    }
    if (email) return { name: name || email, email };
  }
  return null;
}

function hasEnded(conv: any): boolean {
  // Not `status`: that is a label such as "Attended Online", which contains "end".
  const state = text(conv?.chat_status?.state_key, conv?.chat_status?.status_key).toLowerCase();
  return state === "end" || state === "closed" || state === "missed" || Boolean(conv?.end_time);
}

/** When anything last happened in the chat, by SalesIQ's account, else by ours. */
function lastActivityOf(conv: any, chat: any): number {
  const stamp = Number(conv?.last_modified_time || conv?.last_message_info?.time);
  if (Number.isFinite(stamp) && stamp > 0) return stamp;
  const last = (chat?.messages || []).filter((m: any) => m.author !== "system").slice(-1)[0];
  return last?.at ? new Date(last.at).getTime() : new Date(chat?.createdAt || Date.now()).getTime();
}

type Said = { author: "rep" | "visitor"; text: string; at: Date };

function readMessages(rows: any): Said[] {
  const list: any[] = Array.isArray(rows) ? rows : Array.isArray(rows?.messages) ? rows.messages : [];
  const said: Said[] = [];
  for (const row of list) {
    // Typed messages only: "info" rows are SalesIQ's own (joined, transferred, closed).
    if (row?.type && row.type !== "text") continue;
    const sender = row?.sender || row?.from || {};
    const kind = text(sender.type, row?.sender_type, row?.user_type).toLowerCase();
    const author = /operator|agent/.test(kind) ? "rep" : /visitor|customer|user/.test(kind) ? "visitor" : null;
    const words = text(row?.message?.text, row?.message?.content, typeof row?.message === "string" ? row.message : "", row?.text, row?.msg);
    const raw = row?.time ?? row?.created_time ?? row?.sent_time;
    const at = new Date(typeof raw === "string" && /^\d+$/.test(raw) ? Number(raw) : raw);
    if (author && words && !isNaN(at.getTime())) said.push({ author, text: words, at });
  }
  return said.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/**
 * One pass at a time across every process, and not more often than POLL_EVERY_MS.
 * Returns when the sync first ran: only chats started after that are touched, so
 * chats already handled before it existed keep the owners and notes they have.
 */
async function claimTurn(leadsDb: Connection): Promise<Date | null> {
  try {
    const claimed: any = await leadsDb.collection(STATE).findOneAndUpdate(
      { _id: "singleton" as any, $or: [{ runAt: { $lt: new Date(Date.now() - POLL_EVERY_MS) } }, { runAt: { $exists: false } }] },
      { $set: { runAt: new Date() }, $setOnInsert: { since: new Date() } },
      { upsert: true, returnDocument: "after" }
    );
    const row = claimed?.value !== undefined ? claimed.value : claimed;
    if (!row) return null;
    if (row.since) return new Date(row.since);
    // A row from before `since` existed: the sync starts now.
    const since = new Date();
    await leadsDb.collection(STATE).updateOne({ _id: "singleton" as any, since: { $exists: false } }, { $set: { since } });
    return since;
  } catch (error: any) {
    // The upsert racing an existing, recent row: not this pass's turn.
    if (error?.code === 11000) return null;
    throw error;
  }
}

/** Hammad, told when the sync loses SalesIQ access and when it has it back. */
const ACCESS_ALERT_WHATSAPP = (process.env.SALESIQ_ALERT_WHATSAPP || "923260533337").replace(/\D/g, "") + "@c.us";

/**
 * One WhatsApp when SalesIQ access is lost, one when it is back.
 *
 * Without it the sync just stops: take-overs go unrecorded and the leads go to the
 * rotation, with nothing to show anything is wrong but a log line. Kept in the
 * state row, so a restart or a second process does not send it again.
 */
async function tellAboutAccess(leadsDb: Connection, working: boolean): Promise<void> {
  const state: any = await leadsDb.collection(STATE).findOne({ _id: "singleton" as any });
  const alerted = Boolean(state?.accessAlertedAt);
  if (working === !alerted) return;

  const text = working
    ? "SalesIQ access is working again. Chat take-overs are being recorded and reps get their leads."
    : [
        "SalesIQ access stopped working for lead-follow-up.",
        "",
        "Rep take-overs of website chats are not being recorded, so those leads go to the round robin instead of the rep who picked the chat, and what reps say after picking up is not saved.",
        "",
        "Fix: a SalesIQ admin (e.g. support@print247.us) logs out of https://exhibitions.print247.us, logs in again with Zoho, and accepts the SalesIQ permission.",
      ].join("\n");
  const sent = await sendText(ACCESS_ALERT_WHATSAPP, text);
  if (!sent.ok) {
    console.error(`[salesiq] could not WhatsApp about SalesIQ access: ${sent.error}`);
    return;
  }
  await leadsDb
    .collection(STATE)
    .updateOne({ _id: "singleton" as any }, working ? { $unset: { accessAlertedAt: "" } } : { $set: { accessAlertedAt: new Date() } });
}

export async function syncOperatorTakeovers(leadsDb: Connection): Promise<{ changed: number; notes: string[] }> {
  const notes: string[] = [];
  const since = await claimTurn(leadsDb);
  if (!since) return { changed: 0, notes };
  const token = await salesIqToken(leadsDb).catch((error: any) => {
    console.error(`[salesiq] take-over sync: ${error.message}`);
    return "";
  });
  if (!token) {
    if (!warnedOff) {
      console.log("[salesiq] take-over sync waiting: no Zoho sign-in carries SalesIQ access yet (a SalesIQ admin signs in to the exhibition app again)");
      warnedOff = true;
    }
    await tellAboutAccess(leadsDb, false);
    return { changed: 0, notes };
  }
  warnedOff = false;
  await tellAboutAccess(leadsDb, true);

  const ChatConversation = chatConversationModel(leadsDb);
  const now = Date.now();
  const chats = await ChatConversation.find({
    // Not an earlier visit set aside ("~"), and with a number SalesIQ's API accepts: the chat's own
    // id when it is one (WhatsApp, social), otherwise the conversation number kept from SalesIQ's
    // messages (a website chat is filed under the visitor's uvid, which SalesIQ answers "Invalid URL").
    conversationId: { $not: /~/ },
    $and: [
      { $or: [{ conversationId: { $regex: /^\d+$/ } }, { salesIqConversationId: { $regex: /^\d+$/ } }] },
      // How often a chat is asked about: every pass in its first hour, when a rep is most likely to
      // pick it up, then every 30 minutes. Website chats are most of the volume.
      {
        $or: [
          { takeoverCheckedAt: { $exists: false } },
          { createdAt: { $gte: new Date(now - RECENT_MS) }, takeoverCheckedAt: { $lt: new Date(now - POLL_EVERY_MS + 5_000) } },
          { createdAt: { $lt: new Date(now - RECENT_MS) }, takeoverCheckedAt: { $lt: new Date(now - LATER_EVERY_MS) } },
        ],
      },
    ],
    // Somebody to take over: a chat where the visitor never typed is a greeting nobody answered.
    "messages.author": "visitor",
    createdAt: { $gte: new Date(Math.max(since.getTime(), now - TAKEN_FOR_MS)) },
    $or: [
      { attenderEmail: { $nin: [null, ""] } },
      { createdAt: { $gte: new Date(now - NOT_TAKEN_FOR_MS) } },
    ],
    transcriptSyncedAt: { $exists: false },
  })
    .sort({ takeoverCheckedAt: 1, createdAt: -1 })
    .limit(CHATS_PER_PASS);

  let changed = 0;
  const startedAt = Date.now();
  for (const chat of chats) {
    if (Date.now() - startedAt > PASS_BUDGET_MS) break;
    try {
      const salesIqId = /^\d+$/.test(chat.conversationId) ? chat.conversationId : String(chat.salesIqConversationId || "");
      // Not counted as activity on the chat: updatedAt stays the visitor's.
      await ChatConversation.updateOne({ _id: chat._id }, { $set: { takeoverCheckedAt: new Date() } }, { timestamps: false });
      const conv = await fetchConversation(leadsDb, salesIqId);
      if (!conv) {
        // SalesIQ does not know this conversation: asking again will not change that.
        await ChatConversation.updateOne({ _id: chat._id }, { $set: { transcriptSyncedAt: new Date() } }, { timestamps: false });
        continue;
      }

      if (!chat.attenderEmail) {
        const rep = await repIn(leadsDb, conv);
        if (rep) {
          const outcome = await applyChatEvent(leadsDb, {
            event: "chat_attended",
            chatId: chat.conversationId,
            visitorId: "",
            uvid: "",
            attenderName: rep.name,
            attenderEmail: rep.email,
          });
          if (outcome.applied) {
            changed++;
            notes.push(`${rep.name} took over chat ${chat.conversationId}`);
          }
        }
      }

      const ended = hasEnded(conv);
      const quiet = now - lastActivityOf(conv, chat) >= QUIET_MS;
      const fresh = await ChatConversation.findById(chat._id);
      if (!fresh) continue;

      // What the rep and the visitor said after the take-over: collected once the chat has gone
      // quiet, not only when SalesIQ closes it, since that can be 13 hours later; any later
      // messages are added on the next quiet check.
      if (fresh.attenderEmail && (ended || quiet)) {
        // Everything after the bot's last stored line: that is where SalesIQ stopped telling us.
        const lastStored = [...fresh.messages].reverse().find((m) => m.author !== "system");
        const after = lastStored?.at ? new Date(lastStored.at).getTime() - 1000 : 0;
        const known = new Set(fresh.messages.map((m) => `${m.author}|${m.text.trim()}`));
        const added = readMessages(await fetchMessages(leadsDb, salesIqId)).filter(
          (m) => m.at.getTime() > after && !known.has(`${m.author}|${m.text.trim()}`)
        );
        for (const m of added) fresh.messages.push({ author: m.author, text: m.text, at: m.at } as any);
        // "Jessica Joe joined the chat." is stamped when this sync noticed, minutes after
        // she started typing, so it sat below her own messages. It goes just before them.
        const firstRep = fresh.messages.findIndex((m) => m.author === "rep");
        const joined = fresh.messages.findIndex((m) => m.author === "system" && /joined the chat/i.test(m.text));
        if (firstRep >= 0 && joined > firstRep) {
          const [line] = fresh.messages.splice(joined, 1);
          line.at = new Date(new Date(fresh.messages[firstRep].at).getTime() - 1000);
          fresh.messages.splice(firstRep, 0, line);
          fresh.markModified("messages");
        }
        if (added.length) {
          changed++;
          notes.push(`chat ${fresh.conversationId}: ${added.length} message(s) after the take-over added`);
        }
      }
      const age = now - new Date(fresh.createdAt || now).getTime();
      const finished = ended || age >= (fresh.attenderEmail ? TAKEN_FOR_MS : NOT_TAKEN_FOR_MS);
      // Ended (or followed long enough), so nothing more will come of asking: stop.
      if (finished) fresh.transcriptSyncedAt = new Date();
      if (fresh.isModified()) await fresh.save();
    } catch (error: any) {
      console.error(`[salesiq] take-over sync for ${chat.conversationId} failed: ${error.message}`);
    }
  }
  return { changed, notes };
}

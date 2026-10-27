import { connectLeadsDb, closeConnections } from "../db/connections";
import { chatConversationModel } from "../models/ChatConversation";
import { salesIqCaptureModel } from "../models/SalesIqCapture";
import { readMessage } from "../services/salesiq/webhook";

/**
 * Puts the links back on files shared before the chat kept them.
 *
 * Until the webhook saved `attachments`, a shared photo reached the transcript as
 * "[shared a file: IMG_1906.jpeg]" and its link was thrown away — but every
 * request SalesIQ sent is still in `salesiq_captures`. Each captured file message
 * is paired with the visitor's "[shared …]" line in the same chat that was stored
 * closest in time to it, within two minutes, and that line gains the links.
 *
 *   npm run backfill:attachments            # shows what it would change
 *   npm run backfill:attachments -- --apply # writes it
 *
 * Only `chat_conversations` changes, and only messages that have no links yet,
 * so running it twice does nothing the second time.
 */

const PAIRING_WINDOW_MS = 2 * 60_000;
const SHARED_NOTE = /^\[shared (?:a file|\d+ files)\b/i;

async function main() {
  const apply = process.argv.includes("--apply");
  const leadsDb = await connectLeadsDb();
  try {
    const Chat = chatConversationModel(leadsDb);
    const captures = await salesIqCaptureModel(leadsDb)
      .find({ "body.message.meta.urls": { $exists: true } }, { receivedAt: 1, body: 1 })
      .sort({ receivedAt: 1 })
      .lean();

    // The files each chat was sent, in the order they arrived.
    const sent = new Map<string, { at: number; files: { url: string; name: string }[] }[]>();
    for (const capture of captures as any[]) {
      const conversationId = String(capture.body?.visitor?.active_conversation_id || "");
      const files = readMessage(capture.body).files || [];
      if (!conversationId || !files.length) continue;
      const list = sent.get(conversationId) ?? [];
      list.push({ at: new Date(capture.receivedAt).getTime(), files });
      sent.set(conversationId, list);
    }
    console.log(`captured file messages: ${captures.length}, in ${sent.size} chats`);

    let chatsChanged = 0;
    let messagesLinked = 0;
    let unpaired = 0;
    for (const [conversationId, deliveries] of sent) {
      const chat = await Chat.findOne({ conversationId });
      if (!chat) {
        unpaired += deliveries.length;
        continue;
      }

      let changed = false;
      for (const delivery of deliveries) {
        // The nearest "[shared …]" line from the visitor that has no links yet.
        let best: { index: number; gap: number } | null = null;
        chat.messages.forEach((message, index) => {
          if (message.author !== "visitor" || message.attachments?.length || !SHARED_NOTE.test(message.text)) return;
          const gap = Math.abs(new Date(message.at).getTime() - delivery.at);
          if (gap <= PAIRING_WINDOW_MS && (!best || gap < best.gap)) best = { index, gap };
        });
        const match = best as { index: number; gap: number } | null;
        if (!match) {
          unpaired++;
          continue;
        }
        chat.messages[match.index].attachments = delivery.files;
        messagesLinked++;
        changed = true;
      }

      if (changed) {
        chatsChanged++;
        if (apply) {
          chat.markModified("messages");
          await chat.save();
        }
      }
    }

    console.log(`${apply ? "linked" : "would link"} ${messagesLinked} message(s) in ${chatsChanged} chat(s); ${unpaired} captured file message(s) had no matching line`);
    if (!apply) console.log("dry run: nothing written. Add --apply to write.");
  } finally {
    await closeConnections();
  }
}

main().catch((error) => {
  console.error("backfill failed:", error.message);
  process.exit(1);
});

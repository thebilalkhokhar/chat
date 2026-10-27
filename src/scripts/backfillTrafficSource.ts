import { connectLeadsDb, closeConnections } from "../db/connections";
import { chatConversationModel } from "../models/ChatConversation";
import { salesIqCaptureModel } from "../models/SalesIqCapture";
import { readIncoming } from "../services/salesiq/webhook";

/**
 * Fills in where past chats came from: landing page, referrer and channel.
 *
 * Chats only started keeping these with the traffic-source work, but every
 * request SalesIQ sent is in `salesiq_captures`. Each chat takes the values from
 * the earliest captured request for it, and only fields still empty are set.
 *
 *   npm run backfill:sources            # shows what it would change
 *   npm run backfill:sources -- --apply # writes it
 *
 * Only `chat_conversations` changes, so running it twice does nothing the second time.
 */
async function main() {
  const apply = process.argv.includes("--apply");
  const leadsDb = await connectLeadsDb();
  try {
    const Chat = chatConversationModel(leadsDb);
    const captures = salesIqCaptureModel(leadsDb)
      .find({ "body.visitor": { $exists: true } }, { body: 1 })
      .sort({ receivedAt: 1 })
      .lean()
      .cursor();

    // The first request that carries each value, per chat.
    const found = new Map<string, { landingPageUrl?: string; referer?: string; visitorChannel?: string }>();
    let scanned = 0;
    for await (const capture of captures as any) {
      scanned++;
      const incoming = readIncoming(capture.body);
      if (!incoming.conversationId) continue;
      const entry = found.get(incoming.conversationId) ?? {};
      if (!entry.landingPageUrl && incoming.landingPageUrl) entry.landingPageUrl = incoming.landingPageUrl;
      if (!entry.referer && incoming.referer) entry.referer = incoming.referer;
      if (!entry.visitorChannel && incoming.visitorChannel) entry.visitorChannel = incoming.visitorChannel;
      found.set(incoming.conversationId, entry);
    }
    console.log(`captures read: ${scanned}; chats they describe: ${found.size}`);

    const chats = await Chat.find(
      { conversationId: { $in: [...found.keys()] } },
      { conversationId: 1, landingPageUrl: 1, referer: 1, visitorChannel: 1 }
    ).lean();
    const writes = chats.flatMap((chat) => {
      const values = found.get(chat.conversationId)!;
      const set: Record<string, string> = {};
      if (!chat.landingPageUrl && values.landingPageUrl) set.landingPageUrl = values.landingPageUrl;
      if (!chat.referer && values.referer) set.referer = values.referer;
      if (!chat.visitorChannel && values.visitorChannel) set.visitorChannel = values.visitorChannel;
      return Object.keys(set).length ? [{ updateOne: { filter: { _id: chat._id }, update: { $set: set } } }] : [];
    });
    console.log(`chats found: ${chats.length}; chats to fill in: ${writes.length}`);

    if (!apply) {
      console.log("dry run: nothing written. Add --apply to write.");
      return;
    }
    let changed = 0;
    for (let i = 0; i < writes.length; i += 1000) {
      changed += (await Chat.bulkWrite(writes.slice(i, i + 1000) as any, { ordered: false })).modifiedCount;
    }
    console.log(`filled in ${changed} chat(s)`);
  } finally {
    await closeConnections();
  }
}

main().catch((error) => {
  console.error("backfill failed:", error.message);
  process.exit(1);
});

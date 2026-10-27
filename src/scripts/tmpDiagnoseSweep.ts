/** Read-only: why the abandoned-chat sweep never wrote this lead up. */
import "dotenv/config";
import { connectLeadsDb, closeConnections } from "../db/connections";
import { getSettings } from "../services/settingsService";
import { chatConversationModel } from "../models/ChatConversation";
import { isComplete } from "../domain/quoteFields";

const CONVERSATION_ID = "5a018b73-dcb7-4b37-bd7a-c3c5f461aea2-2";

(async () => {
  const db = await connectLeadsDb();
  const settings: any = await getSettings(db);

  console.log(`settings.chat.writeLeadOnHandoff : ${settings.chat.writeLeadOnHandoff}`);
  console.log(`settings.chat.enabled            : ${settings.chat.enabled}`);

  const ChatConversation = chatConversationModel(db);
  const c: any = await ChatConversation.findOne({ conversationId: CONVERSATION_ID }).lean();

  console.log(`\nrecord as it stands:`);
  console.log(`  status        : ${c.status}`);
  console.log(`  updatedAt     : ${new Date(c.updatedAt).toISOString()}`);
  console.log(`  zohoLeadId    : ${JSON.stringify(c.zohoLeadId || "")}`);
  console.log(`  leadAttempts  : ${c.leadAttempts}`);
  console.log(`  isComplete    : ${isComplete(c.collected || {})}`);

  // The exact idle-sweep query from pendingLeads.ts, run against this one record.
  const idleCutoff = new Date(Date.now() - 3 * 60_000);
  const matchesIdleQuery = await ChatConversation.findOne({
    conversationId: CONVERSATION_ID,
    status: "active",
    updatedAt: { $lte: idleCutoff },
    $and: [
      { $or: [{ zohoLeadId: { $exists: false } }, { zohoLeadId: "" }, { zohoLeadId: null }] },
      {
        $or: [
          { leadWriteLockAt: { $exists: false } },
          { leadWriteLockAt: null },
          { leadWriteLockAt: { $lt: new Date(Date.now() - 3 * 60_000) } },
        ],
      },
    ],
    leadAttempts: { $lt: 12 },
  }).lean();

  console.log(`\nmatches the sweep's idle query today: ${matchesIdleQuery ? "YES" : "no"}`);

  // worthWritingUp, reproduced.
  const worthWritingUp = Boolean(c.email?.trim() || c.phone?.trim()) || isComplete(c.collected || {});
  console.log(`worthWritingUp (has email/phone, or complete): ${worthWritingUp}`);

  // How many active chats in total are sitting exactly like this one — old, with
  // an email, never written.
  const stuck = await ChatConversation.countDocuments({
    status: "active",
    updatedAt: { $lte: idleCutoff },
    email: { $nin: ["", null] },
    $or: [{ zohoLeadId: { $exists: false } }, { zohoLeadId: "" }, { zohoLeadId: null }],
  });
  console.log(`\nother chats stuck the same way (active, idle, has an email, no lead): ${stuck}`);

  await closeConnections();
  process.exit(0);
})();

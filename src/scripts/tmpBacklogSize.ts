/** Read-only: how big is the backlog the sweep's unsorted .limit(50) has to get through? */
import "dotenv/config";
import { connectLeadsDb, closeConnections } from "../db/connections";
import { chatConversationModel } from "../models/ChatConversation";

(async () => {
  const db = await connectLeadsDb();
  const ChatConversation = chatConversationModel(db);
  const idleCutoff = new Date(Date.now() - 3 * 60_000);

  const totalIdleUnwritten = await ChatConversation.countDocuments({
    status: "active",
    updatedAt: { $lte: idleCutoff },
    $or: [{ zohoLeadId: { $exists: false } }, { zohoLeadId: "" }, { zohoLeadId: null }],
    leadAttempts: { $lt: 12 },
  });

  console.log(`total "active", idle >3min, no lead, attempts<12: ${totalIdleUnwritten}`);

  // Of those, how many actually have an email/phone or a complete quote —
  // i.e. would pass worthWritingUp and should have been written.
  const worthy = await ChatConversation.countDocuments({
    status: "active",
    updatedAt: { $lte: idleCutoff },
    $or: [{ zohoLeadId: { $exists: false } }, { zohoLeadId: "" }, { zohoLeadId: null }],
    leadAttempts: { $lt: 12 },
    $and: [{ $or: [{ email: { $nin: ["", null] } }, { phone: { $nin: ["", null] } }] }],
  });
  console.log(`  of those, with an email or phone (worthWritingUp): ${worthy}`);

  // Age distribution — the oldest few, since an unsorted query with no index hint
  // tends to return roughly insertion order.
  const oldest = await ChatConversation.find({
    status: "active",
    updatedAt: { $lte: idleCutoff },
    $or: [{ zohoLeadId: { $exists: false } }, { zohoLeadId: "" }, { zohoLeadId: null }],
    leadAttempts: { $lt: 12 },
  })
    .sort({ createdAt: 1 })
    .limit(5)
    .select("conversationId createdAt email phone leadAttempts")
    .lean();

  console.log("\noldest 5 unwritten idle chats:");
  for (const c of oldest as any[]) {
    console.log(`  ${new Date(c.createdAt).toISOString()}  attempts=${c.leadAttempts}  email=${!!c.email}  phone=${!!c.phone}  ${c.conversationId}`);
  }

  // The exact query pendingLeads.ts runs, no sort — what actually comes back.
  const asTheSweepSeesIt = await ChatConversation.find({
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
  })
    .limit(50)
    .select("conversationId createdAt")
    .lean();

  console.log(`\nthe sweep's unsorted top 50 right now — oldest and newest in that batch:`);
  const dates = (asTheSweepSeesIt as any[]).map((c) => new Date(c.createdAt).getTime()).sort((a, b) => a - b);
  console.log(`  ${new Date(dates[0]).toISOString()}  ->  ${new Date(dates[dates.length - 1]).toISOString()}`);
  console.log(`  does it contain our chat from 2026-09-06T22:04? ${
    (asTheSweepSeesIt as any[]).some((c) => c.conversationId === "5a018b73-dcb7-4b37-bd7a-c3c5f461aea2-2")
  }`);

  // "stopped" but never got a zohoLeadId and leadAttempts stayed at 0 — the
  // black-hole state: marked stopped, but handOffToCrm was apparently never
  // even attempted for it.
  const blackHole = await ChatConversation.countDocuments({
    status: "stopped",
    handoffReason: "max_turns",
    leadAttempts: 0,
    $or: [{ zohoLeadId: { $exists: false } }, { zohoLeadId: "" }, { zohoLeadId: null }],
  });
  console.log(`\n"stopped" (abandoned) but leadAttempts=0 — never even tried: ${blackHole}`);

  await closeConnections();
  process.exit(0);
})();

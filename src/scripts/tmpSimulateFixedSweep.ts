/**
 * Read-only: reproduces the fixed sweep's query and classification against the
 * real backlog, without saving or writing a single record. Proves the shape of
 * the fix before anything actually runs.
 */
import "dotenv/config";
import { connectLeadsDb, closeConnections } from "../db/connections";
import { chatConversationModel } from "../models/ChatConversation";
import { isComplete } from "../domain/quoteFields";

function worthWritingUp(c: any): boolean {
  if (c.email?.trim() || c.phone?.trim()) return true;
  return isComplete(c.collected || {});
}

(async () => {
  const db = await connectLeadsDb();
  const ChatConversation = chatConversationModel(db);
  const idleCutoff = new Date(Date.now() - 3 * 60_000);

  const batch = await ChatConversation.find({
    status: "active",
    updatedAt: { $lte: idleCutoff },
    $or: [{ zohoLeadId: { $exists: false } }, { zohoLeadId: "" }, { zohoLeadId: null }],
    leadAttempts: { $lt: 12 },
  })
    .sort({ updatedAt: 1 })
    .limit(50)
    .lean();

  const worthy = batch.filter(worthWritingUp);
  const empty = batch.filter((c) => !worthWritingUp(c));

  console.log(`first pass with the fix, oldest 50: ${batch.length}`);
  console.log(`  worthy (would be sent to handOffToCrm)  : ${worthy.length}`);
  console.log(`  empty (closed, no CRM call)              : ${empty.length}`);
  console.log(`  batch spans: ${new Date(batch[0].updatedAt).toISOString()} -> ${new Date(batch[batch.length - 1].updatedAt).toISOString()}`);

  const totalBacklog = await ChatConversation.countDocuments({
    status: "active",
    updatedAt: { $lte: idleCutoff },
    $or: [{ zohoLeadId: { $exists: false } }, { zohoLeadId: "" }, { zohoLeadId: null }],
    leadAttempts: { $lt: 12 },
  });
  console.log(`\ntotal backlog: ${totalBacklog}  ->  ~${Math.ceil(totalBacklog / 50)} passes at 50/pass, ~${(Math.ceil(totalBacklog / 50) * 30 / 60).toFixed(0)} min at the 30s poll interval to fully drain`);

  // Where does our specific chat sit in the queue, sorted the way the fix sorts it?
  const position = await ChatConversation.countDocuments({
    status: "active",
    updatedAt: { $lte: idleCutoff, $lt: new Date("2026-09-06T22:04:43.206Z") },
    $or: [{ zohoLeadId: { $exists: false } }, { zohoLeadId: "" }, { zohoLeadId: null }],
    leadAttempts: { $lt: 12 },
  });
  console.log(`\nthe freezer-bags chat sits at roughly position ${position} in the sorted queue`);
  console.log(`  -> would naturally surface after ~${Math.ceil(position / 50)} passes (~${(Math.ceil(position / 50) * 30 / 60).toFixed(0)} min) once deployed`);

  await closeConnections();
  process.exit(0);
})();

/** Read-only: the chat behind that SalesIQ visitor id, in full. */
import "dotenv/config";
import { connectLeadsDb, closeConnections } from "../db/connections";
import { chatConversationModel } from "../models/ChatConversation";
import { isComplete, missingFields } from "../domain/quoteFields";

const VISITOR_ID = "948557000003814009";

(async () => {
  const db = await connectLeadsDb();
  const c: any = await chatConversationModel(db)
    .findOne({ $or: [{ visitorId: VISITOR_ID }, { conversationId: VISITOR_ID }] })
    .lean();

  if (!c) {
    console.log("not found by visitorId or conversationId — searching messages for a hint");
    await closeConnections();
    process.exit(0);
  }

  console.log(`conversationId  : ${c.conversationId}`);
  console.log(`visitorId       : ${c.visitorId}`);
  console.log(`repEmail        : ${c.repEmail}`);
  console.log(`status          : ${c.status}   handoffReason: ${c.handoffReason || "-"}`);
  console.log(`aiMessageCount  : ${c.aiMessageCount}   max allowed elsewhere`);
  console.log(`name            : ${JSON.stringify(c.name)}`);
  console.log(`email           : ${JSON.stringify(c.email)}`);
  console.log(`phone           : ${JSON.stringify(c.phone)}`);
  console.log(`zohoLeadId      : ${JSON.stringify(c.zohoLeadId || "")}`);
  console.log(`leadAttempts    : ${c.leadAttempts}`);
  console.log(`leadWriteLockAt : ${c.leadWriteLockAt}`);
  console.log(`collected       : ${JSON.stringify(c.collected)}`);
  console.log(`askedCounts     : ${JSON.stringify(c.askedCounts)}`);
  console.log(`lastAsked       : ${c.lastAsked}`);
  console.log(`isComplete      : ${isComplete(c.collected || {})}`);
  console.log(`missingFields   : ${JSON.stringify(missingFields(c.collected || {}))}`);
  console.log(`erpAlerts       : ${c.erpAlerts}   waAlerts: ${c.waAlerts}`);
  console.log(`createdAt       : ${new Date(c.createdAt).toISOString()}`);
  console.log(`updatedAt       : ${new Date(c.updatedAt).toISOString()}`);

  console.log("\ntranscript:");
  for (const m of c.messages || []) {
    console.log(`  ${new Date(m.at).toISOString().slice(11, 19)} ${m.author === "ai" ? "Bot    " : "Visitor"}: ${m.text}`);
  }

  await closeConnections();
  process.exit(0);
})();

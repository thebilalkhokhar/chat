import "dotenv/config";
/**
 * The last few website chats, as the bot actually left them.
 *
 * Written to answer "why did it stop asking for an email?", which needed
 * askedCounts and the status side by side — the counts said 2, the status said
 * active, and the lead id said nothing had been filed.
 */
import { connectLeadsDb } from "../db/connections";
import { chatConversationModel } from "../models/ChatConversation";

(async () => {
  const db = await connectLeadsDb();
  const C = chatConversationModel(db);
  const rows = await C.find({}).sort({ updatedAt: -1 }).limit(3).lean();
  for (const c of rows as any[]) {
    console.log("=".repeat(70));
    console.log(c.conversationId, "| status:", c.status, "| handoff:", c.handoffReason || "-", "| aiMessages:", c.aiMessageCount);
    console.log("name:", JSON.stringify(c.name), "email:", JSON.stringify(c.email), "phone:", JSON.stringify(c.phone));
    console.log("askedCounts:", JSON.stringify(c.askedCounts));
    console.log("collected:", JSON.stringify(c.collected));
    console.log("leadId:", c.zohoLeadId || c.leadId || "(none)");
    console.log("updatedAt:", c.updatedAt);
  }
  process.exit(0);
})();

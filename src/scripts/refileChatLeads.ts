import "dotenv/config";
/**
 * Files the chat leads that were given up on.
 *
 * A chat stops being retried after twelve failed attempts, and on 13 September
 * every attempt failed: Zoho had stopped letting the reps' own tokens create
 * leads (403 NO_PERMISSION / Crm_Implied_Create_Leads). By the time the writes
 * went through an admin account instead, fifty-odd chats carrying real
 * customers were frozen at the limit, where the sweep will never look again.
 *
 * This is the way back: clear the counter and file them, one at a time, through
 * the same `handOffToCrm` the worker uses — so the duplicate check, the owner,
 * the tag and the note all behave exactly as they do in production.
 *
 *   npm run refile-chat-leads              # dry run: lists what it would file
 *   npm run refile-chat-leads -- --apply   # writes them
 *   npm run refile-chat-leads -- --apply --days=60 --limit=20
 */
import { connectLeadsDb, closeConnections } from "../db/connections";
import { chatConversationModel } from "../models/ChatConversation";
import { getSettings } from "../services/settingsService";
import { handOffToCrm } from "../services/salesiq/handoff";

/** Zoho is somebody else's API; a pause between writes keeps this polite. */
const DELAY_MS = 400;

/**
 * Addresses that are ours, not customers'.
 *
 * The backlog carries the team's own test chats — hammadtest01@gmail.com
 * through hammadtest10, test@gmail.com — and a test lead in the CRM is worse
 * than no lead: somebody rings it. Override with --exclude=<regex>, or
 * --exclude= to file everything.
 */
const DEFAULT_EXCLUDE = "hammadtest|^test@|@example\\.(com|org)|\\+e2e|api\\.check";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function numberArg(name: string, fallback: number): number {
  const raw = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  const value = raw ? Number(raw.split("=")[1]) : NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

(async () => {
  const apply = process.argv.includes("--apply");
  const days = numberArg("days", 30);
  const limit = numberArg("limit", 500);

  const db = await connectLeadsDb();
  const settings = await getSettings(db, true);
  const ChatConversation = chatConversationModel(db);

  if (!settings.chat?.writeLeadOnHandoff) {
    console.log("chat.writeLeadOnHandoff is off — nothing would be written. Stopping.");
    await closeConnections();
    process.exit(0);
  }

  /**
   * Every chat that should have a lead and has none. Status is not part of the
   * question: a chat with a way to reach somebody is a lead whether it finished,
   * ran out of turns or was abandoned.
   */
  const excludeArg = process.argv.find((arg) => arg.startsWith("--exclude="));
  const excludePattern = excludeArg === undefined ? DEFAULT_EXCLUDE : excludeArg.split("=").slice(1).join("=");
  const exclude = excludePattern ? new RegExp(excludePattern, "i") : null;

  const found = await ChatConversation.find({
    createdAt: { $gte: new Date(Date.now() - days * 24 * 60 * 60_000) },
    $and: [
      { $or: [{ zohoLeadId: { $exists: false } }, { zohoLeadId: "" }, { zohoLeadId: null }] },
      { $or: [{ email: { $nin: ["", null] } }, { phone: { $nin: ["", null] } }] },
    ],
  })
    .sort({ createdAt: 1 })
    .limit(limit)
    .select({ conversationId: 1, email: 1, phone: 1, repEmail: 1, status: 1, handoffReason: 1, leadAttempts: 1, createdAt: 1 })
    .lean();

  const stuck = (found as any[]).filter((chat) => !(exclude && exclude.test(`${chat.email || ""} ${chat.phone || ""}`)));
  const skipped = found.length - stuck.length;

  console.log(
    `lead writer: ${settings.chat.leadWriterEmail || "(none — writing as each rep)"}\n` +
      `${found.length} chat(s) in the last ${days} days with a contact and no lead` +
      (skipped ? `, ${skipped} skipped as ours (${excludePattern})` : "") +
      `\n`
  );

  for (const chat of stuck as any[]) {
    console.log(
      `  ${new Date(chat.createdAt).toISOString().slice(0, 16)}  ${chat.repEmail || "(no rep)"}  ` +
        `${chat.email || chat.phone}  ${chat.status}/${chat.handoffReason || "-"}  attempts=${chat.leadAttempts ?? 0}`
    );
  }

  if (!apply) {
    console.log(`\nDry run. Re-run with --apply to file these ${stuck.length} lead(s).`);
    await closeConnections();
    process.exit(0);
  }

  console.log("\nfiling...\n");
  const tally: Record<string, number> = {};
  const failures: string[] = [];

  for (const chat of stuck as any[]) {
    // The counter is what froze them out; the lock is cleared in case one was
    // left behind by a process that died mid-write.
    await ChatConversation.updateOne({ conversationId: chat.conversationId }, { $set: { leadAttempts: 0, leadWriteLockAt: null } });

    let outcome: any;
    try {
      outcome = await handOffToCrm(db, chat.conversationId, settings);
    } catch (error: any) {
      outcome = { leadOk: false, error: error.message };
    }

    const result = outcome.leadOk ? outcome.action || "written" : "FAILED";
    tally[result] = (tally[result] || 0) + 1;

    if (outcome.leadOk) {
      console.log(`  ${result.padEnd(14)} ${chat.email || chat.phone} -> ${outcome.zohoLeadId || "(nothing to write)"}`);
    } else {
      console.log(`  FAILED         ${chat.email || chat.phone}: ${outcome.error}`);
      failures.push(`${chat.conversationId} (${chat.email || chat.phone}): ${outcome.error}`);
    }

    await sleep(DELAY_MS);
  }

  console.log(`\ndone: ${JSON.stringify(tally)}`);
  if (failures.length) {
    console.log(`\nstill failing:\n  ${failures.join("\n  ")}`);
  }

  await closeConnections();
  process.exit(0);
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

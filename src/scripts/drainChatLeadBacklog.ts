/**
 * Drains the chat-lead backlog immediately, instead of waiting for the worker's
 * normal 30-second sweep to get through it ~50 records at a time.
 *
 * Calls the exact same production function, `writePendingChatLeads`, in a tight
 * loop — no separate logic to drift out of sync with what the worker actually
 * runs. Real writes: a worthy chat gets a real lead in Zoho, under the rep it
 * was assigned to.
 *
 * Kept as a standing script rather than a one-off, because the backlog this was
 * written for (10,000+ stuck chats, two bugs in the sweep) is not the only shape
 * this can take — any future gap in the sweep leaves the same kind of trail, and
 * this is how to clear it once the gap is closed.
 */
import "dotenv/config";
import { connectLeadsDb, closeConnections } from "../db/connections";
import { writePendingChatLeads } from "../services/salesiq/pendingLeads";
import { chatConversationModel } from "../models/ChatConversation";

/** Stop asking once a pass finds nothing left to do. */
const MAX_PASSES = 400;
/** Room to breathe between passes — Zoho is someone else's API, not just ours. */
const DELAY_MS = 800;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How many chats are genuinely left, independent of the lock.
 *
 * `result.retried === 0` is not proof the backlog is empty — the production
 * worker runs this same sweep every 30 seconds, and a pass that lands mid-way
 * through one of its runs finds every candidate locked and reports zero. That
 * is what happened the first time this ran: one empty pass, stop, backlog
 * still at 9,461. This count skips the lock entirely, so it says what is
 * actually left rather than what was free to claim in one particular instant.
 */
async function backlogSize(db: Awaited<ReturnType<typeof connectLeadsDb>>): Promise<number> {
  const ChatConversation = chatConversationModel(db);
  const idleCutoff = new Date(Date.now() - 3 * 60_000);
  return ChatConversation.countDocuments({
    status: "active",
    updatedAt: { $lte: idleCutoff },
    $or: [{ zohoLeadId: { $exists: false } }, { zohoLeadId: "" }, { zohoLeadId: null }],
    leadAttempts: { $lt: 12 },
  });
}

(async () => {
  const db = await connectLeadsDb();

  let pass = 0;
  let totalRetried = 0;
  let totalWritten = 0;
  const notes: string[] = [];

  const startSize = await backlogSize(db);
  console.log(`backlog to clear: ${startSize}\ndraining, up to ${MAX_PASSES} passes...\n`);

  while (pass < MAX_PASSES) {
    pass += 1;
    const result = await writePendingChatLeads(db);

    totalRetried += result.retried;
    totalWritten += result.written;
    notes.push(...result.notes);

    if (pass === 1 || pass % 10 === 0 || result.written > 0) {
      console.log(
        `pass ${pass}: touched ${result.retried}, wrote ${result.written}` +
          (result.notes.length ? `  — ${result.notes.join(" | ")}` : "")
      );
    }

    // Checked every pass rather than only when a pass comes back empty: a run
    // that keeps finding 50 idle records to close can still be near the end of
    // the real backlog if most of them turn out empty, and the ground truth is
    // cheap enough to ask for directly instead of inferring it.
    const remaining = await backlogSize(db);
    if (remaining === 0) {
      console.log(`pass ${pass}: backlog genuinely empty. Stopping.`);
      break;
    }

    await sleep(DELAY_MS);
  }

  const endSize = await backlogSize(db);
  console.log(
    `\ndone: ${pass} pass(es), ${totalRetried} chats touched, ${totalWritten} leads written to Zoho.` +
      `\nbacklog: ${startSize} -> ${endSize}`
  );
  if (notes.length) {
    console.log(`\nnotes from the run:`);
    for (const note of notes) console.log(`  ${note}`);
  }

  await closeConnections();
  process.exit(0);
})();

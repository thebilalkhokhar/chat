import type { Connection } from "mongoose";
import { config } from "./config/env";
import { connectLeadsDb, connectConnectorDb, closeConnections } from "./db/connections";
import { getSettings } from "./services/settingsService";
import { runPass } from "./services/conversationEngine";
import { pakistanStamp, isOfficeHours } from "./domain/officeHours";
import { writePendingChatLeads } from "./services/salesiq/pendingLeads";
import { storePendingAttachments } from "./services/salesiq/attachmentStore";
import { syncOperatorTakeovers } from "./services/salesiq/operatorSync";

/**
 * The loop.
 *
 * Wakes on a timer, does one pass, sleeps. Deliberately dull: all the judgement
 * lives in the engine and the eligibility rules, and this file only decides how
 * often to ask.
 *
 * Exported as a function rather than run on import, because in production the
 * dashboard and the worker share one process — Railway bills per service, and
 * a loop this light does not need one of its own.
 */

let running = false;
let stopping = false;
let timer: NodeJS.Timeout | null = null;

export async function tick(leadsDb: Connection, connectorDb: Connection): Promise<void> {
  // Passes must never overlap. A slow model call or a Zoho timeout would
  // otherwise let the next tick join in, and both would advance the same
  // conversation — sending one customer two emails at once.
  if (running) {
    console.log("[worker] previous pass still running, skipping this tick");
    return;
  }

  running = true;
  const startedAt = Date.now();

  try {
    const result = await runPass(leadsDb, connectorDb);

    // Chats that ended but whose CRM lead did not get written — a Zoho timeout,
    // a refused token. Retried here because nothing else ever would.
    // Which rep took each chat over, and what was said after, from SalesIQ's API —
    // its webhooks do not send either on this plan. Before the lead pass, so a lead
    // written this pass already goes to the rep who took the chat.
    const takeovers = await syncOperatorTakeovers(leadsDb);
    result.notes.push(...takeovers.notes);

    const pendingLeads = await writePendingChatLeads(leadsDb);
    result.notes.push(...pendingLeads.notes);

    // Files shared in a chat whose copy did not happen when they arrived. SalesIQ's
    // links expire once the chat is over, so this is retried only for a while.
    const files = await storePendingAttachments(leadsDb);
    result.notes.push(...files.notes);

    const didSomething =
      result.created + result.sent + result.stopped + result.failed + result.held +
        pendingLeads.written + files.stored + takeovers.changed > 0;

    // A paused or idle service should not print a line every minute; one that
    // did something should always say so.
    if (didSomething) {
      console.log(
        `[worker] ${pakistanStamp(new Date())} PKT — ` +
          `opened ${result.created}, advanced ${result.advanced}, sent ${result.sent}, ` +
          `held ${result.held}, stopped ${result.stopped}, failed ${result.failed} ` +
          `(${Date.now() - startedAt}ms)`
      );
      for (const note of result.notes) console.log(`         ${note}`);
    }
  } catch (error: any) {
    // One bad pass must not take the worker down; the next tick tries again.
    console.error(`[worker] pass failed: ${error.message}`);
  } finally {
    running = false;
  }
}

/** Starts the loop. Returns a function that stops it and waits for a pass in flight. */
export async function startWorker(
  leadsDb: Connection,
  connectorDb: Connection
): Promise<() => Promise<void>> {
  const settings = await getSettings(leadsDb, true);

  console.log(`  Worker      polling every ${config.worker.pollSeconds}s`);
  console.log(`  Office      ${isOfficeHours(new Date(), settings.officeHours) ? "staffed — holding sends" : "empty — may send"}`);

  await tick(leadsDb, connectorDb);

  timer = setInterval(() => {
    if (!stopping) void tick(leadsDb, connectorDb);
  }, config.worker.pollSeconds * 1000);

  return async () => {
    stopping = true;
    if (timer) clearInterval(timer);

    // Let a pass in flight finish rather than killing it mid-send, which could
    // leave an email delivered but unrecorded.
    for (let waited = 0; running && waited < 30_000; waited += 500) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  };
}

/** Running this file directly starts only the worker — used in development. */
async function main() {
  const leadsDb = await connectLeadsDb();
  const connectorDb = await connectConnectorDb();
  const settings = await getSettings(leadsDb, true);

  console.log(`\n  Worker only (no dashboard)`);
  console.log(`  Pakistan    ${pakistanStamp(new Date())}`);
  console.log(`  Service     ${settings.enabled ? "ENABLED" : "PAUSED — nothing will be looked at"}`);
  console.log(`  Sending     ${settings.guardrails.dryRun ? "DRY RUN — composes, never sends" : "LIVE"}\n`);

  const stop = await startWorker(leadsDb, connectorDb);

  const shutdown = async () => {
    await stop();
    await closeConnections();
    console.log("[worker] stopped");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (require.main === module) {
  main().catch((error) => {
    console.error("worker failed to start:", error.message);
    process.exit(1);
  });
}

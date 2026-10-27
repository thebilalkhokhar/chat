import { config } from "./config/env";
import { connectLeadsDb, connectConnectorDb, closeConnections } from "./db/connections";
import { createApi } from "./server/api";
import { startWorker } from "./worker";
import { installSlowCallLog } from "./server/slowCallLog";
import { getSettings } from "./services/settingsService";
import { adminUserModel } from "./models/AdminUser";
import { isOfficeHours, pakistanStamp } from "./domain/officeHours";

/**
 * Production entry point: the dashboard and the worker in one process.
 *
 * They are separate concerns but not separate services. Railway bills per
 * service, the loop is idle almost all the time, and running them together
 * means the settings an admin saves are the very same objects the worker reads
 * moments later — no second deployment to keep in step.
 *
 * `index.ts` and `worker.ts` still run each half on its own for development,
 * where it is useful to restart the dashboard without interrupting a pass.
 */
async function main() {
  // Names whatever a slow chat turn is waiting on — see slowCallLog.ts.
  installSlowCallLog();
  const leadsDb = await connectLeadsDb();
  const connectorDb = await connectConnectorDb();

  const settings = await getSettings(leadsDb, true);
  const adminCount = await adminUserModel(leadsDb).countDocuments();

  const app = createApi(leadsDb, connectorDb);

  // Railway supplies PORT and expects the process to bind it.
  const server = app.listen(config.port, () => {
    console.log(`\n  Dashboard   listening on port ${config.port}`);
    console.log(`  Pakistan    ${pakistanStamp(new Date())}`);
    console.log(`  Office      ${isOfficeHours(new Date(), settings.officeHours) ? "staffed" : "empty"}`);
    console.log(`  Service     ${settings.enabled ? "ENABLED" : "PAUSED"}`);
    console.log(`  Sending     ${settings.guardrails.dryRun ? "DRY RUN — composes, never sends" : "LIVE"}`);
    console.log(`  Admins      ${adminCount}`);
  });

  if (adminCount === 0) {
    console.warn(
      "\n  No admin accounts exist — nobody can sign in.\n" +
        "  Create one with:  npm run create-admin -- you@example.com 'a long password'\n"
    );
  }

  const stopWorker = await startWorker(leadsDb, connectorDb);
  console.log("");

  const shutdown = async () => {
    console.log("\nshutting down…");
    server.close();
    await stopWorker();
    await closeConnections();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error) => {
  console.error("failed to start:", error.message);
  process.exit(1);
});

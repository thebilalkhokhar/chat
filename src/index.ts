import { config } from "./config/env";
import { connectLeadsDb, connectConnectorDb, closeConnections } from "./db/connections";
import { createApi } from "./server/api";
import { getSettings } from "./services/settingsService";
import { adminUserModel } from "./models/AdminUser";
import { isOfficeHours, pakistanStamp } from "./domain/officeHours";

/**
 * Boots the dashboard.
 *
 * The worker that actually writes to customers is a separate entry point, so
 * this process can be run on its own to inspect and change settings without any
 * risk of a message going out while somebody is looking at the configuration.
 */
async function main() {
  const leadsDb = await connectLeadsDb();
  const connectorDb = await connectConnectorDb();

  // Creates the settings document from the environment on first run.
  const settings = await getSettings(leadsDb, true);

  const adminCount = await adminUserModel(leadsDb).countDocuments();
  if (adminCount === 0) {
    console.warn(
      "\n  No admin accounts exist yet — nobody can sign in.\n" +
        "  Create one with:  npm run create-admin -- you@example.com 'a long password'\n"
    );
  }

  const app = createApi(leadsDb, connectorDb);

  const server = app.listen(config.port, () => {
    console.log(`\n  Dashboard   http://localhost:${config.port}`);
    console.log(`  Pakistan    ${pakistanStamp(new Date())}`);
    console.log(`  Office      ${isOfficeHours(new Date(), settings.officeHours) ? "staffed — AI stays quiet" : "empty — AI may work"}`);
    console.log(`  Service     ${settings.enabled ? "enabled" : "PAUSED"}`);
    console.log(`  Sending     ${settings.guardrails.dryRun ? "DRY RUN — nothing is sent" : "LIVE"}`);
    console.log(`  Admins      ${adminCount}\n`);
  });

  const shutdown = async () => {
    console.log("\nshutting down…");
    server.close();
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

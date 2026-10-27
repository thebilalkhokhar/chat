/**
 * Writes CC_EMAILS into the live settings document.
 *
 * The environment only seeds settings the first time the service ever runs, so
 * on an install that is already going, adding CC_EMAILS to .env changes
 * nothing on its own. This applies it once, deliberately, and prints what the
 * document holds afterwards. The dashboard owns the value from then on.
 *
 * Sends no mail and touches nothing else.
 */
import { config } from "../config/env";
import { connectLeadsDb, closeConnections } from "../db/connections";
import { getSettings, updateSettings } from "../services/settingsService";

async function main() {
  const leads = await connectLeadsDb();

  const before = await getSettings(leads, true);
  console.log("current cc :", (before.sending.ccEmails || []).join(", ") || "(none)");
  console.log("CC_EMAILS  :", config.mail.ccEmails.join(", ") || "(none)");

  if (!config.mail.ccEmails.length) {
    console.log("\nCC_EMAILS is empty. Set it in .env, or clear the CC from the dashboard instead —");
    console.log("this script will not blank the list by accident.");
    await closeConnections();
    return;
  }

  const after = await updateSettings(
    leads,
    { "sending.ccEmails": [...config.mail.ccEmails] },
    "setCcEmails script"
  );

  console.log("\nsaved cc   :", (after.sending.ccEmails || []).join(", ") || "(none)");
  console.log("Every email the AI sends from now on is copied to these addresses.");

  await closeConnections();
}

main().catch((e) => { console.error(e.message); process.exit(1); });

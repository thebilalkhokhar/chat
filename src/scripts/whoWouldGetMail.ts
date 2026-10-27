/**
 * The single most important question this service can answer: with the current
 * settings, exactly who receives an email? Sends nothing.
 */
import { config } from "../config/env";
import { connectLeadsDb, connectConnectorDb, closeConnections } from "../db/connections";
import { findEligibleLeads } from "../services/leadSource";

async function main() {
  const leads = await connectLeadsDb();
  const connector = await connectConnectorDb();
  const { eligible, rejected, scanned } = await findEligibleLeads(leads, connector);

  console.log("SETTINGS");
  console.log("  excluded domains :", config.eligibility.excludedDomains.join(", "));
  console.log("  excluded sources :", config.eligibility.excludedSources.join(", ") || "(none)");
  console.log("  only rep         :", config.eligibility.onlyRepEmail || "(all reps)");
  console.log("  only these leads :", config.eligibility.onlyLeadEmails.join(", ") || "(none)");
  console.log("  existing leads   :", config.eligibility.includeExistingLeads);
  console.log("  DRY_RUN          :", config.guardrails.dryRun);

  console.log(`\nWOULD EMAIL (${eligible.length}):`);
  for (const lead of eligible) {
    console.log(
      `  ${lead.email.padEnd(34)} ${String(lead.fullName).padEnd(20)} ${String(lead.company).slice(0, 22).padEnd(24)} rep=${lead.repEmail}`
    );
  }
  if (eligible.length === 0) console.log("  (nobody)");

  const grouped = new Map<string, number>();
  for (const r of rejected) grouped.set(r.reason, (grouped.get(r.reason) || 0) + 1);

  console.log(`\nSKIPPED (${rejected.length}), by reason:`);
  for (const [reason, count] of [...grouped.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(count).padStart(3)}  ${reason}`);
  }

  await closeConnections();
}

main().catch((e) => { console.error(e.message); process.exit(1); });

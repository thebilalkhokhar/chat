/**
 * Proves the two things the whole service rests on, against live systems:
 * that a rep's stored Zoho grant still refreshes, and that the connector's
 * mail is readable. Sends nothing.
 */
import { config } from "../config/env";
import { connectLeadsDb, connectConnectorDb, closeConnections } from "../db/connections";
import { zohoCredentialModel } from "../models/ZohoCredential";
import { accessTokenForRep } from "../services/zohoAuth";

async function main() {
  const leads = await connectLeadsDb();
  const connector = await connectConnectorDb();

  const Credential = zohoCredentialModel(leads);
  const reps = await Credential.find({ refreshToken: { $nin: ["", null] } })
    .sort({ updatedAt: -1 })
    .limit(3);

  console.log(`\nreps with a stored grant: ${await Credential.countDocuments()}`);
  console.log("--- refreshing the 3 most recent ---");

  for (const rep of reps) {
    try {
      const token = await accessTokenForRep(leads, { zohoUserId: rep.zohoUserId });
      console.log(`  OK    ${rep.email.padEnd(30)} token len ${token.accessToken.length}`);
    } catch (error: any) {
      console.log(`  FAIL  ${rep.email.padEnd(30)} ${error.message}`);
    }
  }

  const interactions = connector.collection("interactions");
  const inbound = await interactions.countDocuments({ type: "Email", direction: "Inbound" });
  const outbound = await interactions.countDocuments({ type: "Email", direction: "Outbound" });
  console.log(`\nconnector mail: ${inbound} inbound, ${outbound} outbound`);

  const newest = await interactions.find({ type: "Email" }).sort({ timestamp: -1 }).limit(1).toArray();
  if (newest[0]) {
    const age = Math.round((Date.now() - new Date(newest[0].timestamp).getTime()) / 3600000);
    console.log(`newest synced email: ${age}h old  (sync freshness)`);
  }

  console.log(`\nDRY_RUN=${config.guardrails.dryRun}`);
  await closeConnections();
}

main().catch((error) => {
  console.error("smoke failed:", error.message);
  process.exit(1);
});

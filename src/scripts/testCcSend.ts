/**
 * Proves that a real send still works now that a CC is attached to it.
 *
 * Worth a script of its own because the failure being checked for is not "the
 * CC was missing" but "Zoho rejected the whole message". A malformed `cc` does
 * not degrade — it takes the email down with it, and with DRY_RUN off that is a
 * live conversation going silent on a customer.
 *
 * Sends one obviously-marked test message and touches nothing else: no
 * conversation state, no message count, no note, no tag. Refuses any address
 * that is not on the test allowlist, so it can never reach a real customer.
 *
 *   npm run test:cc -- someone@example.com
 */
import { config } from "../config/env";
import { connectLeadsDb, closeConnections } from "../db/connections";
import { getSettings } from "../services/settingsService";
import { conversationModel } from "../models/Conversation";
import { accessTokenForRep } from "../services/zohoAuth";
import { sendLeadMail } from "../services/zohoLead";

async function main() {
  const target = String(process.argv[2] || "").trim().toLowerCase();
  if (!target) {
    console.error("Give the address to test, e.g. npm run test:cc -- hammadnadir75@gmail.com");
    process.exit(1);
  }

  const leads = await connectLeadsDb();
  const settings = await getSettings(leads, true);

  // The allowlist is the whole safety of this script. A test message signed by
  // a real rep must never be able to land on a real customer because somebody
  // mistyped an address.
  //
  // Both lists count, and deliberately so. The live one empties the moment the
  // service goes wide -- that is what going live means -- but the mailboxes
  // named in ONLY_LEAD_EMAILS are still the hand-picked test addresses they
  // always were. Reading only the live list would leave no way to test a send
  // at exactly the point testing matters most: when real customers are in scope.
  const permitted = new Set([
    ...settings.eligibility.onlyLeadEmails,
    ...config.eligibility.onlyLeadEmails,
  ]);

  if (!permitted.has(target)) {
    console.error("");
    console.error(`${target} is not a known test mailbox. Refusing to send.`);
    console.error(`  live allowlist   : ${settings.eligibility.onlyLeadEmails.join(", ") || "(empty)"}`);
    console.error(`  ONLY_LEAD_EMAILS : ${config.eligibility.onlyLeadEmails.join(", ") || "(empty)"}`);
    console.error("");
    console.error("Add it to ONLY_LEAD_EMAILS in .env if it really is a test mailbox.");
    await closeConnections();
    process.exit(1);
  }

  const conversation = await conversationModel(leads).findOne({ customerEmail: target }).lean();
  if (!conversation?.zohoLeadId) {
    console.error(`No conversation with a Zoho lead id for ${target}.`);
    await closeConnections();
    process.exit(1);
  }

  const cc = (settings.sending.ccEmails || []).map((email) => ({ email }));

  console.log("to   :", target);
  console.log("cc   :", cc.map((c) => c.email).join(", ") || "(none — nothing to prove)");
  console.log("lead :", conversation.zohoLeadId);
  console.log("as   :", conversation.repEmail);

  const token = await accessTokenForRep(leads, {
    zohoUserId: conversation.repZohoUserId,
    email: conversation.repEmail,
  });

  const result = await sendLeadMail({
    zohoLeadId: conversation.zohoLeadId,
    accessToken: token.accessToken,
    from: { name: token.fullName || conversation.repName || "", email: token.email },
    to: { name: conversation.customerName || "", email: target },
    cc,
    subject: "Test — please ignore (CC check)",
    html:
      "<p>Automated test of the follow-up service. Nothing to action.</p>" +
      "<p>Sent to confirm that a message still goes out with a CC attached, " +
      "and that the copied addresses receive it.</p>",
  });

  console.log("\nresult:", result.ok ? "SENT" : "FAILED — " + result.error);
  if (result.ok) {
    console.log("Check the inbox, and check that the CC addresses got it too.");
  }

  await closeConnections();
  process.exit(result.ok ? 0 : 1);
}

main().catch((e) => { console.error(e.message); process.exit(1); });

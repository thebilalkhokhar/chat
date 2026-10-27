/**
 * Does the office-hours hold apply to the right addresses, at the right times?
 * Reads the live settings. Sends nothing.
 */
import { connectLeadsDb, closeConnections } from "../db/connections";
import { getSettings } from "../services/settingsService";
import { canSendNow } from "../domain/sendWindow";
import { pakistanStamp } from "../domain/officeHours";

/** Pakistan is UTC+5, so local hour H is (H-5) UTC on the same day. */
const at = (dayOffset: number, hour: number) =>
  new Date(Date.UTC(2026, 7, 24) + dayOffset * 86400000 + (hour - 5) * 3600000);

async function main() {
  const connection = await connectLeadsDb();
  const settings = await getSettings(connection, true);

  console.log("service enabled              :", settings.enabled);
  console.log("hold during office hours     :", settings.sending.onlySendDuringOfflineHours);
  console.log("test addresses (clock exempt):", settings.eligibility.onlyLeadEmails.join(", ") || "(none)");
  console.log();

  const times: [string, Date][] = [
    ["Fri 22:00  office staffed", at(4, 22)],
    ["Sat 02:00  office staffed", at(5, 2)],
    ["Sat 10:00  nobody in", at(5, 10)],
    ["Sun 15:00  weekend", at(6, 15)],
    ["Mon 20:00  office staffed", at(0, 20)],
  ];

  const addresses = [
    ["TEST     hammadnadir75@gmail.com", "hammadnadir75@gmail.com"],
    ["TEST     hkashifarshad@gmail.com", "hkashifarshad@gmail.com"],
    ["CUSTOMER nicole@unholybrands.com", "nicole@unholybrands.com"],
    ["STAFF    sarah@print247.us", "sarah@print247.us"],
  ];

  for (const [label, email] of addresses) {
    console.log(label);
    for (const [when, date] of times) {
      const decision = canSendNow({ toEmail: email, settings, at: date });
      console.log(
        `   ${when.padEnd(28)} ${decision.allowed ? "SEND" : "HOLD"}` +
          (decision.reason ? `  — ${decision.reason}` : "")
      );
    }
    console.log();
  }

  console.log("right now:", pakistanStamp(new Date()), "PKT");
  for (const [label, email] of addresses) {
    const decision = canSendNow({ toEmail: email, settings });
    console.log(`   ${label.padEnd(36)} ${decision.allowed ? "SEND" : "HOLD"}`);
  }

  await closeConnections();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

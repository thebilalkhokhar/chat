import "dotenv/config";
import { connectLeadsDb, closeConnections } from "../db/connections";
import { getSettings } from "../services/settingsService";

(async () => {
  const db = await connectLeadsDb();
  const s: any = await getSettings(db);
  console.log("live officeHours:", JSON.stringify(s.officeHours, null, 2));

  const now = new Date();
  console.log("\nserver clock (UTC):", now.toISOString());
  const pkt = new Date(now.getTime() + 5 * 60 * 60_000); // UTC+5, no DST
  console.log("Pakistan time (UTC+5):", pkt.toISOString().slice(11, 16), " day:", pkt.getUTCDay());

  await closeConnections();
  process.exit(0);
})();

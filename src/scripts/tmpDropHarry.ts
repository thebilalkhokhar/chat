/** Removes harry.brook from the chat rep pool. Dry run unless --apply. */
import "dotenv/config";
import { connectLeadsDb, closeConnections } from "../db/connections";
import { getSettings, updateSettings } from "../services/settingsService";

(async () => {
  const apply = process.argv.includes("--apply");
  const db = await connectLeadsDb();
  const settings: any = await getSettings(db);

  const before = settings.chat.repPool || [];
  const after = before.filter((e: string) => e.toLowerCase() !== "harry.brook@print247.us");

  console.log(`repPool was: ${JSON.stringify(before)}`);
  console.log(`repPool now: ${JSON.stringify(after)}`);

  if (before.length === after.length) {
    console.log("\nharry.brook was not in the pool — nothing to do.");
    await closeConnections();
    process.exit(0);
  }

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to write it.");
    await closeConnections();
    process.exit(0);
  }

  await updateSettings(db, { chat: { ...settings.chat, repPool: after } } as any, "drop-harry-from-pool");
  const written: any = await getSettings(db);
  console.log(`\nwritten: ${JSON.stringify(written.chat.repPool)}`);

  await closeConnections();
  process.exit(0);
})();

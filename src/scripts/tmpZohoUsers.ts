import "dotenv/config";
import { connectLeadsDb } from "../db/connections";

(async () => {
  const db = await connectLeadsDb();
  const rows = await db.collection("zohocredentials").find({}, { projection: { email: 1, zohoUserId: 1, userId: 1, name: 1 } }).limit(8).toArray();
  for (const r of rows as any[]) console.log(r.email, "|", r.zohoUserId || r.userId || "(none)");
  process.exit(0);
})();

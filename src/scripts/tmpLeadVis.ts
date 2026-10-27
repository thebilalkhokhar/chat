import axios from "axios";
import { connectLeadsDb, connectConnectorDb, closeConnections } from "../db/connections";
import { accessTokenForRep } from "../services/zohoAuth";
import { config } from "../config/env";

async function probe(db: any, email: string, leadId: string) {
  try {
    const rep = await accessTokenForRep(db, { email });
    const res = await axios.get(
      `https://www.zohoapis.${config.zoho.region}/crm/v8/Leads/${leadId}`,
      { headers: { Authorization: `Zoho-oauthtoken ${rep.accessToken}` }, timeout: 20000 }
    );
    const d = res.data?.data?.[0];
    console.log(`  ${email.padEnd(28)} -> SEES IT: ${d?.Last_Name} <${d?.Email || "no email"}>`);
  } catch (e: any) {
    const msg = e.response?.status === 204 ? "204 no content" : (e.response?.data?.message || e.response?.status || e.message);
    console.log(`  ${email.padEnd(28)} -> CANNOT SEE IT: ${msg}`);
  }
}

async function main() {
  const leadsDb = await connectLeadsDb();
  const connector = await connectConnectorDb();
  const lead: any = await connector.collection("leads").findOne(
    { zohoLeadId: { $exists: true, $ne: "" }, email: { $ne: "" } },
    { sort: { createdAt: -1 } }
  );
  console.log(`known lead from the connector DB: ${lead.zohoLeadId} (${lead.email})\n`);
  await probe(leadsDb, "nancy.wilson@print247.us", lead.zohoLeadId);
  await probe(leadsDb, "johnhenry.it@print247.us", lead.zohoLeadId);
  await closeConnections();
}
main().catch(e => { console.error(e); process.exit(1); });

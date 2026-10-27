/**
 * Sets up and checks the SalesIQ API access that operatorSync.ts needs.
 *
 *   npx ts-node src/scripts/salesIqConnect.ts code <grant code>
 *     Swaps a one-time code from api-console.zoho.com (Self Client → Generate Code,
 *     scope "SalesIQ.conversations.READ,SalesIQ.operators.READ") for a refresh token,
 *     using SALESIQ_API_CLIENT_ID / SALESIQ_API_CLIENT_SECRET. Put the printed token
 *     in SALESIQ_API_REFRESH_TOKEN on Railway.
 *
 *   npx ts-node src/scripts/salesIqConnect.ts probe <SalesIQ conversation id>
 *     Prints what SalesIQ answers for one chat and its messages, read-only, so the
 *     field names operatorSync.ts reads can be checked against a real answer.
 */
import "dotenv/config";
import axios from "axios";
import { config } from "../config/env";
import { fetchConversation, fetchMessages } from "../services/salesiq/salesIqApi";
import { connectLeadsDb } from "../db/connections";

async function main() {
  const [command, value] = process.argv.slice(2);

  if (command === "code" && value) {
    const response = await axios.post(`https://accounts.zoho.${config.zoho.region}/oauth/v2/token`, null, {
      params: {
        grant_type: "authorization_code",
        code: value,
        client_id: config.salesiq.apiClientId || config.zoho.clientId,
        client_secret: config.salesiq.apiClientSecret || config.zoho.clientSecret,
      },
      validateStatus: () => true,
    });
    if (!response.data?.refresh_token) {
      console.error("Zoho did not issue a refresh token:", JSON.stringify(response.data));
      process.exit(1);
    }
    console.log(`SALESIQ_API_REFRESH_TOKEN=${response.data.refresh_token}`);
    console.log(`(scope: ${response.data.scope || "not stated"})`);
    return;
  }

  if (command === "probe" && value) {
    const leadsDb = await connectLeadsDb();
    const conversation = await fetchConversation(leadsDb, value);
    console.log("CONVERSATION", JSON.stringify(conversation, null, 2)?.slice(0, 4000));
    const messages = await fetchMessages(leadsDb, value);
    console.log("MESSAGES", JSON.stringify(messages, null, 2)?.slice(0, 4000));
    return;
  }

  console.log("usage: salesIqConnect.ts code <grant code> | probe <conversation id>");
}

main().then(() => process.exit(0), (error) => {
  console.error(error.message);
  process.exit(1);
});

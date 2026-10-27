/**
 * Checks that the API version this service uses actually works with a real
 * rep's token, before anything depends on it.
 *
 * Reads only. Nothing is sent, tagged or written — the write endpoints are
 * probed with a deliberately invalid record id, so Zoho answers "no such
 * record" if the version and scope are fine, and something quite different if
 * they are not. That distinction is the whole point: a 404 here is a pass.
 */
import axios from "axios";
import { config } from "../config/env";
import { connectLeadsDb, closeConnections } from "../db/connections";
import { zohoCredentialModel } from "../models/ZohoCredential";
import { accessTokenForRep } from "../services/zohoAuth";

const VERSIONS = ["v8", "v6", "v2"];
const host = `https://www.zohoapis.${config.zoho.region}`;

/** An id that is well-formed but cannot exist, so no real record is touched. */
const NON_EXISTENT_LEAD_ID = "1000000000000000001";

async function probe(label: string, url: string, token: string, method: "get" | "post") {
  try {
    const response = await axios.request({
      method,
      url,
      headers: { Authorization: `Zoho-oauthtoken ${token}`, "Content-Type": "application/json" },
      data: method === "post" ? { data: [{ Note_Title: "probe", Note_Content: "probe" }] } : undefined,
      timeout: 15000,
      validateStatus: () => true,
    });

    const status = response.status;
    const code = response.data?.code || response.data?.data?.[0]?.code || "";

    // The version and permission are what is being tested, not the record.
    // "not found" means the route resolved and the token was accepted.
    const versionOk =
      status !== 400 || !String(code).includes("INVALID_URL_PATTERN");
    const authOk = status !== 401 && code !== "OAUTH_SCOPE_MISMATCH" && code !== "INVALID_TOKEN";

    const verdict = !authOk
      ? `DENIED  ${code || status}`
      : !versionOk
      ? `NO ROUTE  ${code}`
      : `OK  (${status}${code ? " " + code : ""})`;

    console.log(`  ${label.padEnd(34)} ${verdict}`);
    return authOk && versionOk;
  } catch (error: any) {
    console.log(`  ${label.padEnd(34)} ERROR  ${error.message}`);
    return false;
  }
}

async function main() {
  const connection = await connectLeadsDb();

  const rep = await zohoCredentialModel(connection)
    .findOne({ refreshToken: { $nin: ["", null] } })
    .sort({ updatedAt: -1 });

  if (!rep) {
    console.error("No rep with a stored Zoho grant.");
    process.exit(1);
  }

  const { accessToken } = await accessTokenForRep(connection, { zohoUserId: rep.zohoUserId });
  console.log(`\ntoken belongs to: ${rep.email}\n`);

  for (const version of VERSIONS) {
    console.log(`--- ${version} ---`);
    await probe(
      "GET /Leads (read)",
      `${host}/crm/${version}/Leads?per_page=1`,
      accessToken,
      "get"
    );
    await probe(
      "POST /Leads/{id}/Notes",
      `${host}/crm/${version}/Leads/${NON_EXISTENT_LEAD_ID}/Notes`,
      accessToken,
      "post"
    );
    await probe(
      "POST /Leads/actions/add_tags",
      `${host}/crm/${version}/Leads/actions/add_tags?ids=${NON_EXISTENT_LEAD_ID}&tag_names=Ai%20Follow%20Up`,
      accessToken,
      "post"
    );
    console.log();
  }

  await closeConnections();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

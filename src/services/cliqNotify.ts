import axios from "axios";
import type { Connection } from "mongoose";
import { config } from "../config/env";
import { zohoCredentialModel } from "../models/ZohoCredential";

/**
 * Direct Cliq messages, next to the WhatsApp alerts, for people who live in Cliq.
 *
 * Sent as IT Support (linda.james@print247.us, CLIQ_SENDER_EMAIL), from that
 * account's stored Zoho sign-in. Posting needs ZohoCliq.Webhooks.CREATE, which the
 * exhibition app's login asks for from 24 Oct, so the account has to sign in there
 * once more before anything is sent; until then a send fails and says why.
 */

const SENDER_EMAIL = (process.env.CLIQ_SENDER_EMAIL || "linda.james@print247.us").toLowerCase();

let cached: { token: string; expiresAt: number } | null = null;

async function accessToken(leadsDb: Connection): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  const credential: any = await zohoCredentialModel(leadsDb).findOne({ email: SENDER_EMAIL }, { refreshToken: 1 }).lean();
  if (!credential?.refreshToken) throw new Error(`no stored Zoho sign-in for ${SENDER_EMAIL}`);

  const response = await axios.post(`https://accounts.zoho.${config.zoho.region}/oauth/v2/token`, null, {
    params: {
      grant_type: "refresh_token",
      refresh_token: credential.refreshToken,
      client_id: config.zoho.clientId,
      client_secret: config.zoho.clientSecret,
    },
    timeout: 15_000,
    validateStatus: () => true,
  });
  const token = response.data?.access_token;
  if (!token) throw new Error(`Zoho refused ${SENDER_EMAIL}'s sign-in: ${response.data?.error || "no token"}`);
  if (!/ZohoCliq/i.test(String(response.data?.scope || ""))) {
    throw new Error(`${SENDER_EMAIL}'s sign-in has no Cliq permission yet (sign in to the exhibition app again)`);
  }
  cached = { token, expiresAt: Date.now() + (Number(response.data.expires_in) || 3600) * 1000 };
  return token;
}

/** Sends `text` to one person's Cliq chat, by their Zoho email. Never throws. */
export async function sendCliqMessage(leadsDb: Connection, email: string, text: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const response = await axios.post(
      `https://cliq.zoho.${config.zoho.region}/api/v2/buddies/${encodeURIComponent(email)}/message`,
      { text },
      { headers: { Authorization: `Zoho-oauthtoken ${await accessToken(leadsDb)}` }, timeout: 15_000, validateStatus: () => true }
    );
    if (response.status >= 300) return { ok: false, error: `HTTP ${response.status} ${JSON.stringify(response.data).slice(0, 200)}` };
    return { ok: true };
  } catch (error: any) {
    return { ok: false, error: error.message };
  }
}

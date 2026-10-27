import axios from "axios";
import type { Connection } from "mongoose";
import { config } from "../../config/env";
import { zohoCredentialModel } from "../../models/ZohoCredential";

/**
 * SalesIQ's REST API — read-only, for what its webhooks do not send on this plan.
 *
 * The bot webhook hears only the visitor and the bot, and the chat-event webhook
 * (which would report a rep joining) is not offered, so the only way to know who
 * took a chat over, and what they said, is to ask.
 *
 * The token comes from a Zoho sign-in that carries SalesIQ.conversations.READ. The
 * exhibition app's login asks for it since 24 Oct, so once a SalesIQ admin signs in
 * there again their stored grant is used — SALESIQ_API_USER_EMAIL names whose to try
 * first. SALESIQ_API_REFRESH_TOKEN, when set, is used instead of any of them.
 */

const REQUEST_TIMEOUT_MS = 15_000;
const SALESIQ_SCOPE = /SalesIQ\.conversations\.READ/i;
/** How long to wait before looking through the stored sign-ins again when none carried SalesIQ. */
const GRANT_SEARCH_EVERY_MS = 30 * 60_000;

let cached: { token: string; expiresAt: number } | null = null;
let grantEmail = "";
let lastGrantSearchAt = 0;

async function refresh(refreshToken: string, clientId: string, clientSecret: string) {
  const response = await axios.post(`https://accounts.zoho.${config.zoho.region}/oauth/v2/token`, null, {
    params: { grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret },
    timeout: REQUEST_TIMEOUT_MS,
    validateStatus: () => true,
  });
  return {
    token: String(response.data?.access_token || ""),
    scope: String(response.data?.scope || ""),
    expiresIn: Number(response.data?.expires_in) || 3600,
    error: response.data?.error,
  };
}

/** Whose stored sign-in to use, if anyone's carries SalesIQ — tried in that order. */
async function fromStoredSignIns(leadsDb: Connection): Promise<string> {
  const Credential = zohoCredentialModel(leadsDb);
  const preferred = [grantEmail, config.salesiq.apiUserEmail.toLowerCase()].filter(Boolean);
  if (!grantEmail && Date.now() - lastGrantSearchAt < GRANT_SEARCH_EVERY_MS) return "";

  let rows: any[] = await Credential.find({ refreshToken: { $nin: [null, ""] } }, { email: 1, refreshToken: 1 })
    .sort({ updatedAt: -1 })
    .lean();
  rows.sort((a, b) => Number(preferred.includes(b.email)) - Number(preferred.includes(a.email)));
  // Already found: only that sign-in is refreshed again.
  if (grantEmail) rows = rows.filter((row) => row.email === grantEmail);
  else lastGrantSearchAt = Date.now();

  for (const row of rows) {
    const result = await refresh(row.refreshToken, config.zoho.clientId, config.zoho.clientSecret).catch(() => null);
    if (!result?.token || !SALESIQ_SCOPE.test(result.scope)) continue;
    if (grantEmail !== row.email) console.log(`[salesiq] using ${row.email}'s sign-in for the SalesIQ API`);
    grantEmail = row.email;
    cached = { token: result.token, expiresAt: Date.now() + result.expiresIn * 1000 };
    return result.token;
  }
  grantEmail = "";
  return "";
}

/** An access token for SalesIQ, or "" when no sign-in carries SalesIQ access yet. */
export async function salesIqToken(leadsDb: Connection): Promise<string> {
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

  if (config.salesiq.apiRefreshToken) {
    const result = await refresh(
      config.salesiq.apiRefreshToken,
      config.salesiq.apiClientId || config.zoho.clientId,
      config.salesiq.apiClientSecret || config.zoho.clientSecret
    );
    if (!result.token) throw new Error(`Zoho refused SALESIQ_API_REFRESH_TOKEN: ${result.error || "no token"}`);
    cached = { token: result.token, expiresAt: Date.now() + result.expiresIn * 1000 };
    return result.token;
  }
  return fromStoredSignIns(leadsDb);
}

/** A GET against the portal; null for "no such thing", an error for anything else. */
async function get(leadsDb: Connection, path: string, params?: Record<string, unknown>): Promise<any> {
  const token = await salesIqToken(leadsDb);
  if (!token) throw new Error("no Zoho sign-in carries SalesIQ access");
  const base = `https://salesiq.zoho.${config.zoho.region}/api/v2/${encodeURIComponent(config.salesiq.screenName)}`;
  const response = await axios.get(`${base}${path}`, {
    params,
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    timeout: REQUEST_TIMEOUT_MS,
    validateStatus: () => true,
  });
  if (response.status === 404 || response.status === 204) return null;
  if (response.status >= 300) {
    throw new Error(`SalesIQ ${path}: HTTP ${response.status} ${JSON.stringify(response.data).slice(0, 200)}`);
  }
  return response.data?.data ?? response.data;
}

export const fetchConversation = (leadsDb: Connection, conversationId: string) =>
  get(leadsDb, `/conversations/${encodeURIComponent(conversationId)}`);

export const fetchMessages = (leadsDb: Connection, conversationId: string) =>
  get(leadsDb, `/conversations/${encodeURIComponent(conversationId)}/messages`, { limit: 100 });

export const fetchOperator = (leadsDb: Connection, operatorId: string) =>
  get(leadsDb, `/operators/${encodeURIComponent(operatorId)}`);

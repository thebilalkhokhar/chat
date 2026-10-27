import axios from "axios";
import { config } from "../config/env";

/**
 * Ecommerce lead figures by traffic source, from the main backend
 * (print247-node, the one behind the Zoho Analytics dashboard).
 *
 * The backend sorts every ecommerce CRM lead into PPC, social and organic and
 * matches ERP payments to them; this reads that result for the same dates as
 * the chat funnel, so the page can set chat figures beside all-lead figures.
 * It signs in with a backend account (BACKEND_EMAIL / BACKEND_PASSWORD) and
 * only reads. A range the backend has not worked out before is computed live
 * there, which can take a while, so answers are kept here for ten minutes.
 */

export interface LeadChannel {
  leads: number;
  converted: number;
  conversionRate: number;
  payingCustomers: number;
  /** Paying customers as a share of leads, in percent. */
  maturityRate: number;
  revenue: number;
}

export interface LeadChannels {
  configured: boolean;
  error?: string;
  from?: string;
  to?: string;
  lastRefreshed?: string | null;
  channels?: { ppc: LeadChannel; social: LeadChannel; organic: LeadChannel };
  summary?: { totalLeads: number; payingCustomers: number; totalRevenue: number };
}

const REQUEST_TIMEOUT_MS = 90_000;
const ANSWER_TTL_MS = 10 * 60_000;
const MAX_ANSWERS = 30;

export const isConfigured = () => Boolean(config.backend.baseUrl && config.backend.email && config.backend.password);

let session: { token: string; expiresAt: number } | null = null;

/** The backend's sign-in token, reused until five minutes before it expires. */
async function token(force = false): Promise<string> {
  if (!force && session && Date.now() < session.expiresAt - 5 * 60_000) return session.token;

  const response = await axios.post(
    `${config.backend.baseUrl}/api/user/login`,
    { email: config.backend.email, password: config.backend.password },
    { timeout: 20_000, validateStatus: () => true }
  );
  const value = response.data?.token;
  if (response.status !== 200 || !value) throw new Error(`the backend refused the sign-in (${response.status})`);

  // A JWT says when it expires; an unreadable one is trusted for an hour.
  let expiresAt = Date.now() + 60 * 60_000;
  try {
    const payload = JSON.parse(Buffer.from(String(value).split(".")[1], "base64url").toString());
    if (Number.isFinite(payload.exp)) expiresAt = payload.exp * 1000;
  } catch {
    // Not a readable JWT: keep the hour.
  }
  session = { token: String(value), expiresAt };
  return session.token;
}

const channelOf = (raw: any): LeadChannel => ({
  leads: Number(raw?.leads) || 0,
  converted: Number(raw?.converted) || 0,
  conversionRate: Number(raw?.conversionRate) || 0,
  payingCustomers: Number(raw?.payingCustomers) || 0,
  maturityRate: Number(raw?.maturityRate) || 0,
  revenue: Number(raw?.revenue) || 0,
});

async function fetchChannels(from: string, to: string, retry = true): Promise<LeadChannels> {
  const response = await axios.get(`${config.backend.baseUrl}/api/zoho-analytics/department-analytics`, {
    params: { fromDate: from, toDate: to },
    headers: { Authorization: `Bearer ${await token(!retry)}` },
    timeout: REQUEST_TIMEOUT_MS,
    validateStatus: () => true,
  });
  // A token the backend no longer accepts: sign in again, once.
  if (response.status === 401 && retry) return fetchChannels(from, to, false);
  const ecommerce = response.data?.data?.ecommerce;
  if (response.status !== 200 || !ecommerce?.channels) {
    throw new Error(`the backend answered ${response.status}${response.data?.message ? `: ${response.data.message}` : ""}`);
  }
  return {
    configured: true,
    from,
    to,
    lastRefreshed: response.data.lastRefreshed || null,
    channels: { ppc: channelOf(ecommerce.channels.ppc), social: channelOf(ecommerce.channels.social), organic: channelOf(ecommerce.channels.organic) },
    summary: {
      totalLeads: Number(ecommerce.summary?.totalLeads) || 0,
      payingCustomers: Number(ecommerce.summary?.payingCustomers) || 0,
      totalRevenue: Number(ecommerce.summary?.totalRevenue) || 0,
    },
  };
}

const answers = new Map<string, { at: number; value: Promise<LeadChannels> }>();

/** All ecommerce leads by traffic source for two inclusive YYYY-MM-DD days. Never throws. */
export async function leadChannels(from: string, to: string): Promise<LeadChannels> {
  if (!isConfigured()) return { configured: false };

  const key = `${from}|${to}`;
  const hit = answers.get(key);
  if (hit && Date.now() - hit.at < ANSWER_TTL_MS) return hit.value;

  if (answers.size >= MAX_ANSWERS) answers.clear();
  const value = fetchChannels(from, to).catch((error: any): LeadChannels => {
    // A failure is not kept, so the next look tries again.
    answers.delete(key);
    return { configured: true, error: `Could not read the backend: ${error.message}` };
  });
  answers.set(key, { at: Date.now(), value });
  return value;
}

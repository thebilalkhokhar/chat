import axios from "axios";
import { config } from "../config/env";

/**
 * Signing in to the ERP's token-protected door.
 *
 * The ERP has two credentials (see `config.erp`): a fixed token for the quote
 * list, and a refresh token that is traded here for a short-lived access token.
 * Instant pricing and the chat funnel both use the second, so they share one
 * cached token rather than each minting their own.
 */

const REQUEST_TIMEOUT_MS = 6_000;

let token: { value: string; expiresAt: number } | null = null;

/**
 * A short-lived access token, minted from the refresh token when the cached one
 * is spent. A minute of slack, because a token that dies mid-request costs the
 * customer their price. Null when the ERP refuses or cannot be reached.
 */
export async function erpAccessToken(force = false): Promise<string | null> {
  if (!force && token && Date.now() < token.expiresAt - 60_000) return token.value;

  try {
    const response = await axios.post(
      `${config.erp.baseUrl}/api/get-access-token`,
      { refresh_token: config.erp.refreshToken },
      {
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${config.erp.refreshToken}`,
        },
        timeout: REQUEST_TIMEOUT_MS,
        validateStatus: () => true,
      }
    );

    if (response.status !== 200 || response.data?.status !== "success" || !response.data?.token) {
      console.warn("[erp] refused a token:", response.status, response.data?.message || "");
      return null;
    }

    const expiresAt = Date.parse(String(response.data.expires_at || "").replace(" ", "T"));
    token = {
      value: String(response.data.token),
      // An unreadable expiry is ten minutes, not forever.
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 10 * 60_000,
    };
    return token.value;
  } catch (error: any) {
    console.warn("[erp] could not reach the ERP for a token:", error.message);
    return null;
  }
}

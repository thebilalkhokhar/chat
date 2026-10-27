import axios from "axios";
import type { Connection } from "mongoose";
import { config } from "../config/env";
import { zohoCredentialModel } from "../models/ZohoCredential";

/**
 * Turning a rep's stored grant into a usable access token.
 *
 * Every email this service sends goes out as a real person, using the OAuth
 * grant they gave when they last signed in to the exhibition app. Access tokens
 * last about an hour and refresh tokens do not expire, so the refresh token is
 * the durable thing and is exchanged whenever the cached access token is cold.
 *
 * Tokens are cached in memory per rep. A worker sending to twenty leads for the
 * same rep should hit Zoho's token endpoint once, not twenty times — Zoho
 * rate-limits that endpoint and will start refusing.
 */

interface CachedToken {
  accessToken: string;
  /** Conservative: treated as stale a few minutes before Zoho expires it. */
  expiresAt: number;
}

const cache = new Map<string, CachedToken>();

/** Refreshed a little early, so a token never dies mid-request. */
const EXPIRY_SAFETY_MARGIN_MS = 5 * 60 * 1000;

export class NoCredentialError extends Error {
  constructor(identity: string) {
    super(`No Zoho credential stored for ${identity}. They must sign in to the app once.`);
    this.name = "NoCredentialError";
  }
}

export class RefreshFailedError extends Error {
  constructor(identity: string, detail: string) {
    super(`Zoho refused to refresh the grant for ${identity}: ${detail}`);
    this.name = "RefreshFailedError";
  }
}

/**
 * Exchanges a refresh token for an access token.
 *
 * A failure here is usually permanent rather than transient — a revoked grant,
 * a password change, or the per-user token cap being hit — so the caller is
 * told plainly rather than left to retry something that cannot succeed.
 */
async function exchangeRefreshToken(refreshToken: string, identity: string): Promise<string> {
  const url = `https://accounts.zoho.${config.zoho.region}/oauth/v2/token`;

  const params = new URLSearchParams({
    refresh_token: refreshToken,
    client_id: config.zoho.clientId,
    client_secret: config.zoho.clientSecret,
    grant_type: "refresh_token",
  });

  const response = await axios
    .post(url, params.toString(), {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 20000,
    })
    .catch((error) => {
      throw new RefreshFailedError(identity, error?.response?.data?.error || error.message);
    });

  const accessToken = response.data?.access_token;
  if (!accessToken) {
    // Zoho answers 200 with an `error` body for a revoked grant, so a missing
    // token here is the normal shape of failure rather than an oddity.
    throw new RefreshFailedError(identity, response.data?.error || "no access_token in response");
  }

  return accessToken;
}

/**
 * An access token for this rep, by Zoho user id or email address.
 *
 * Leads captured before the app knew a rep's Zoho id carry an invented id but
 * always a real address, so both are accepted and email is the fallback.
 */
export async function accessTokenForRep(
  connection: Connection,
  rep: { zohoUserId?: string; email?: string }
): Promise<{ accessToken: string; email: string; fullName: string; zohoUserId: string }> {
  const identity = rep.zohoUserId || rep.email || "unknown rep";

  const Credential = zohoCredentialModel(connection);
  const credential =
    (rep.zohoUserId ? await Credential.findOne({ zohoUserId: rep.zohoUserId }) : null) ||
    (rep.email ? await Credential.findOne({ email: rep.email.toLowerCase().trim() }) : null);

  if (!credential) throw new NoCredentialError(identity);

  const cached = cache.get(credential.zohoUserId);
  if (cached && cached.expiresAt > Date.now()) {
    return {
      accessToken: cached.accessToken,
      email: credential.email,
      fullName: credential.fullName,
      zohoUserId: credential.zohoUserId,
    };
  }

  if (!credential.refreshToken) throw new NoCredentialError(credential.email);

  const accessToken = await exchangeRefreshToken(credential.refreshToken, credential.email);

  cache.set(credential.zohoUserId, {
    accessToken,
    expiresAt: Date.now() + 60 * 60 * 1000 - EXPIRY_SAFETY_MARGIN_MS,
  });

  // Written back so the exhibition app benefits from the fresh token too, and
  // so a restart does not have to refresh every rep again immediately.
  await Credential.updateOne({ _id: credential._id }, { $set: { accessToken } }).catch(() => null);

  return {
    accessToken,
    email: credential.email,
    fullName: credential.fullName,
    zohoUserId: credential.zohoUserId,
  };
}

/** Drops a rep's cached token, forcing the next call to refresh. */
export function invalidateCachedToken(zohoUserId: string): void {
  cache.delete(zohoUserId);
}

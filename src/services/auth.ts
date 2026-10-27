import crypto from "crypto";
import bcrypt from "bcryptjs";
import type { Connection } from "mongoose";
import { config } from "../config/env";
import { adminUserModel, type DashboardRole } from "../models/AdminUser";

/**
 * Dashboard sessions.
 *
 * A session is a signed payload, not an opaque id, so no server-side store is
 * needed for a handful of admins. Two details are deliberate:
 *
 *   - the payload names its own type (`typ: "dashboard-admin"`) and that claim
 *     is verified. Tokens signed with the same secret for different purposes
 *     are otherwise interchangeable, and a token minted for one thing then
 *     satisfies the check for another
 *   - signatures are compared only after a length check, because
 *     `timingSafeEqual` throws on a length mismatch, and a forged short
 *     signature would crash the request rather than being rejected
 */

const SESSION_TYPE = "dashboard-admin";
const SESSION_DURATION_MS = 12 * 60 * 60 * 1000;

export const SESSION_COOKIE = "followup_session";

export interface AdminSession {
  email: string;
  fullName: string;
  role: DashboardRole;
}

/** Anything but an explicit "manager" is an admin: every account and token from before roles was one. */
const roleOf = (value: unknown): DashboardRole =>
  value === "manager" ? "manager" : value === "super_admin" ? "super_admin" : "admin";

function sign(payload: string): string {
  return crypto.createHmac("sha256", config.auth.secret).update(payload).digest("hex");
}

export function createSessionToken(admin: AdminSession): string {
  const payload = JSON.stringify({
    ...admin,
    typ: SESSION_TYPE,
    exp: Date.now() + SESSION_DURATION_MS,
  });
  return `${Buffer.from(payload).toString("base64url")}.${sign(payload)}`;
}

export function verifySessionToken(token: string | undefined): AdminSession | null {
  if (!token) return null;

  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return null;

  try {
    const payload = Buffer.from(encoded, "base64url").toString();

    const given = Buffer.from(signature);
    const expected = Buffer.from(sign(payload));
    if (given.length !== expected.length) return null;
    if (!crypto.timingSafeEqual(given, expected)) return null;

    const data = JSON.parse(payload);
    if (data.typ !== SESSION_TYPE) return null;
    if (!Number.isFinite(data.exp) || Date.now() >= data.exp) return null;
    if (!data.email) return null;

    return { email: String(data.email), fullName: String(data.fullName || ""), role: roleOf(data.role) };
  } catch {
    return null;
  }
}

/**
 * Checks an email and password.
 *
 * A missing user still runs a bcrypt comparison against a dummy hash, so the
 * response takes the same time whether or not the address exists — otherwise
 * the timing difference tells an attacker which addresses are real.
 */
const DUMMY_HASH = "$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy";

export async function verifyCredentials(
  connection: Connection,
  email: string,
  password: string
): Promise<AdminSession | null> {
  const AdminUser = adminUserModel(connection);
  const user = await AdminUser.findOne({ email: email.toLowerCase().trim() });

  const matches = await bcrypt.compare(password, user?.passwordHash || DUMMY_HASH);
  if (!user || !matches) return null;

  await AdminUser.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } }).catch(() => null);

  return { email: user.email, fullName: user.fullName, role: roleOf(user.role) };
}

export async function createAdmin(
  connection: Connection,
  email: string,
  password: string,
  fullName: string,
  role: DashboardRole = "admin"
): Promise<void> {
  if (password.length < 10) {
    throw new Error("Password must be at least 10 characters.");
  }

  const AdminUser = adminUserModel(connection);
  await AdminUser.findOneAndUpdate(
    { email: email.toLowerCase().trim() },
    { $set: { passwordHash: await bcrypt.hash(password, 12), fullName, role } },
    { upsert: true }
  );
}

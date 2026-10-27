import { Schema, Connection, Model } from "mongoose";

/**
 * What a dashboard account may do. An admin sees and changes everything; a
 * manager sees only the chat funnel and can change nothing.
 */
/** super_admin: the full-screen marketing view and nothing else. */
export type DashboardRole = "admin" | "manager" | "super_admin";

/**
 * Somebody allowed to sign in to the dashboard — and, as an admin, to change the settings.
 *
 * Passwords are bcrypt hashes; the plain value is never stored and never
 * logged. This is a small collection guarded by one rule: whoever is in it can
 * turn on a system that emails customers, so adding a row is a deliberate act.
 */
export interface IAdminUser {
  email: string;
  passwordHash: string;
  fullName: string;
  /** Absent on accounts made before roles existed, which are admins. */
  role?: DashboardRole;
  lastLoginAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const AdminUserSchema = new Schema<IAdminUser>(
  {
    email: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    passwordHash: { type: String, required: true },
    fullName: { type: String, default: "" },
    role: { type: String, enum: ["admin", "manager", "super_admin"], default: "admin" },
    lastLoginAt: { type: Date },
  },
  { timestamps: true, collection: "followup_admins" }
);

export function adminUserModel(connection: Connection): Model<IAdminUser> {
  return (
    (connection.models.AdminUser as Model<IAdminUser>) ||
    connection.model<IAdminUser>("AdminUser", AdminUserSchema)
  );
}

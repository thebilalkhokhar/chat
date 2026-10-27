/**
 * Creates or updates a dashboard account.
 *
 *   npm run create-admin -- you@example.com "a long password" "Your Name"
 *   npm run create-admin -- boss@example.com "a long password" "Their Name" --manager
 *
 * Whoever is an admin can enable a system that emails customers, so adding one
 * is deliberate and done from a shell, never from the web. `--manager` makes an
 * account that sees only the chat funnel and can change nothing. Running it
 * again for an existing address resets that account's password, name and role.
 */
import { connectLeadsDb, closeConnections } from "../db/connections";
import { createAdmin } from "../services/auth";
import { adminUserModel } from "../models/AdminUser";

async function main() {
  const args = process.argv.slice(2);
  const role = args.includes("--super-admin") ? "super_admin" : args.includes("--manager") ? "manager" : "admin";
  const [email, password, ...nameParts] = args.filter((arg) => arg !== "--manager" && arg !== "--super-admin");

  if (!email || !password) {
    console.error('Usage: npm run create-admin -- you@example.com "a long password" "Your Name" [--manager]');
    process.exit(1);
  }

  const connection = await connectLeadsDb();
  await createAdmin(connection, email, password, nameParts.join(" ") || email.split("@")[0], role);

  const Accounts = adminUserModel(connection);
  const total = await Accounts.countDocuments();
  const managers = await Accounts.countDocuments({ role: "manager" });
  console.log(
    `\n  ${email} can now sign in as ${role === "manager" ? "a manager (chat funnel only)" : role === "super_admin" ? "a super admin" : "an admin"}.` +
      ` Accounts: ${total} (${managers} manager${managers === 1 ? "" : "s"})\n`
  );

  await closeConnections();
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});

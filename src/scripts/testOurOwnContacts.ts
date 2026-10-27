/**
 * The our-own-contacts guard, against the values that actually got written.
 *
 * Runs on its own — no database, no model — so the table can be proved in a
 * second rather than by holding a chat.
 */
import { isOurEmail, isOurPhone } from "../domain/ourOwnContacts";

const settings: any = {
  company: { facts: "Support@print247.us · +1 (832) 807-3429 · WhatsApp · support available 24/7." },
  eligibility: { excludedDomains: ["print247.us", "colorwing.com"] },
};

const PHONES: Array<[string, boolean]> = [
  // Ours, in the shapes it gets written — all of these must be rejected.
  ["+1 (832) 807-3429", true],
  ["8328073429", true],
  ["832-807-3429", true],
  ["+18328073429", true],
  ["1 832 807 3429", true],
  // Real customers' numbers, from actual chats — all must be kept.
  ["425-345-7330", false],
  ["3177939116", false],
  ["+1 (323) 561-8144", false],
  ["513-630-4166", false],
  ["", false],
];

const EMAILS: Array<[string, boolean]> = [
  ["support@print247.us", true],
  ["Support@Print247.us", true],
  ["johnhenry.it@print247.us", true],
  ["zack.morris@print247.us", true],
  ["jason@colorwing.com", true],
  ["harry.brook@colorwing.com", true],
  // Real customers — must be kept.
  ["mychosid@gmail.com", false],
  ["bryon@chanticleercabins.com", false],
  ["products@basicallybirdee.com", false],
  ["", false],
];

let bad = 0;

for (const [phone, expected] of PHONES) {
  const got = isOurPhone(phone, settings);
  const ok = got === expected;
  if (!ok) bad += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  phone ${JSON.stringify(phone).padEnd(22)} ours=${got}`);
}

for (const [email, expected] of EMAILS) {
  const got = isOurEmail(email, settings);
  const ok = got === expected;
  if (!ok) bad += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  email ${JSON.stringify(email).padEnd(32)} ours=${got}`);
}

console.log(bad === 0 ? "\nall pass" : `\n${bad} failing`);
process.exit(bad === 0 ? 0 : 1);

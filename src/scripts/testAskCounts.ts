import "dotenv/config";
import { MAX_ASKS, askOutcome, applyAskOutcome, type AskOutcome } from "../domain/askAttempts";

/**
 * The counting rule on its own, replayed over the chat that lost an enquiry.
 *
 * The bot asked for an email twice — once answered with a mistyped "ocated",
 * once with "where is print247 located" — then never asked again, and the chat
 * was filed nowhere. Neither of those was a refusal.
 */
const cases: [string, string, boolean, AskOutcome][] = [
  // The two that wrongly retired the email question.
  ["email", "ocated", false, "spent"],
  ["email", "where is print247 located", false, "free"],
  ["email", "where are you based?", false, "free"],
  // A real refusal ends it at once rather than after two more asks.
  ["phone", "no phone no", false, "declined"],
  ["phone", "no", false, "declined"],
  ["email", "prefer not to", false, "declined"],
  // "no" against a suggested product is not a refusal to answer.
  ["product", "no", false, "spent"],
  ["product", "no, something else", false, "spent"],
  // Spec updates on contact questions cost nothing.
  ["name", "whatever is cheaper finish", false, "free"],
  ["name", "matte finish", false, "free"],
  ["phone", "500 pcs", false, "free"],
  ["phone", "40x28x17 inches", false, "free"],
  // Answers cost nothing.
  ["email", "hammad@biztek.pk", true, "free"],
  ["quantity", "25000", true, "free"],
  ["sizes", "5x6 inches", true, "free"],
];

let failed = 0;
for (const [key, text, gotIt, expected] of cases) {
  const got = askOutcome(key, text, gotIt);
  const ok = got === expected;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${key} <- "${text}" => ${got}${ok ? "" : `   expected ${expected}`}`);
}

// The whole email sequence, as it happened.
let asked = 0;
for (const [text, gotIt] of [["ocated", false], ["where is print247 located", false]] as [string, boolean][]) {
  asked = applyAskOutcome(asked, askOutcome("email", text, gotIt));
}
const asksAgain = asked < MAX_ASKS;
console.log(`\nafter both replies: email attempts = ${asked}, asks again = ${asksAgain}`);
if (!asksAgain) failed++;

console.log(`\n${failed === 0 ? "all passed" : `${failed} failed`}`);
process.exit(failed ? 1 : 0);

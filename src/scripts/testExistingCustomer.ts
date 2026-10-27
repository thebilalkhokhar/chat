/**
 * The existing-customer check, against real messages from both kinds of chat.
 *
 * The risk cuts both ways: miss one and a customer with a problem gets asked
 * about label sizes; over-match and a genuine new enquiry gets handed off
 * before anyone finds out what they want.
 */
const ALREADY_A_CUSTOMER =
  /\b(i (already )?(purchased|ordered|bought|placed an order)|my (order|invoice|shipment|delivery|package|tracking)|(haven'?t|have not|hasn'?t|has not|still (haven'?t|not)) (received|got|arrived)|where is my|order (status|number)|already (have|received) (them|it|those)|refund|damaged|wrong (item|order|size)|previous order|last order|reorder)\b/i;

const CASES: Array<[string, boolean]> = [
  // From the screenshot — must all be caught.
  ["I purchased labels from you guys and I haven't received them yet", true],
  ["I already have them", true],
  ["I don't need bags. I purchased labels from you guys", true],
  // Other ways an existing customer opens.
  ["Where is my order?", true],
  ["my delivery hasn't arrived", true],
  ["I ordered 2 weeks ago and still haven't received", true],
  ["I need a refund", true],
  ["the wrong size was sent", true],
  ["I want to reorder the same labels", true],
  ["my tracking number isn't working", true],
  ["order status please", true],

  // Genuine new enquiries — must NOT be caught.
  ["I need a quote for custom mylar bags", false],
  ["I want to order 5000 boxes", false],
  ["I'd like to place an order for stickers, what's the cost?", false],
  ["Looking for freezer bags commercial grade", false],
  ["How much for 4x6 size?", false],
  ["Do you offer a design option?", false],
  ["I need labels for peptide vials", false],
  ["what is your MOQ?", false],
  ["I make knives and wanted a custom sticker", false],
];

let bad = 0;
for (const [text, expected] of CASES) {
  const got = ALREADY_A_CUSTOMER.test(text);
  const ok = got === expected;
  if (!ok) bad += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  existing=${String(got).padEnd(5)} "${text}"`);
}
console.log(bad === 0 ? "\nall pass" : `\n${bad} failing`);
process.exit(bad === 0 ? 0 : 1);

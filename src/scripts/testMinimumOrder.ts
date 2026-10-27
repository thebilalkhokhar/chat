/**
 * The minimum-order check, against the quantities customers actually type.
 *
 * Runs on its own — no database, no model — so the table can be proved in a
 * second rather than by holding a chat.
 */
import {
  quantityIn,
  belowMinimum,
  minimumApplies,
  wantsSmallerRun,
  askedToGoBelowMinimum,
  answerToTheMinimum,
} from "../domain/minimumOrder";
import { isBagFamily } from "../domain/salesScript";
import { isDesignCountAnswer } from "../domain/quoteFields";

const CASES: Array<[string, number | null, boolean]> = [
  // [what they typed, the number we read, is it under the minimum]
  ["80", 80, true],
  ["50", 50, true],
  ["999", 999, true],
  ["1000", 1000, false],
  ["1,000", 1000, false],
  ["5000", 5000, false],
  ["2k", 2000, false],
  ["2K units", 2000, false],
  ["almmost 5000", 5000, false],
  ["around 200 pcs", 200, true],
  ["50-100", 50, true],
  ["maybe 50.", 50, true],
  ["1600", 1600, false],
  ["50-100 per item", 50, true],
  // Words are not parsed. Unreadable means unflagged, which is the safe way to
  // be wrong: the prompt rule still applies, and nobody is told their order is
  // too small on the strength of a guess.
  ["one thousand", 1000, false],
  ["I only need one", 1, true],
  ["single box", 1, true],
  ["just one", 1, true],
  ["", null, false],
  ["not given", null, false],
  ["one design", null, false],
  ["a few", null, false],
];

let bad = 0;
for (const [input, expectedNumber, expectedLow] of CASES) {
  const number = quantityIn(input);
  const low = belowMinimum(input);
  const ok = number === expectedNumber && low === expectedLow;
  if (!ok) bad += 1;
  console.log(
    `${ok ? "ok  " : "FAIL"}  ${JSON.stringify(input).padEnd(20)} read=${String(number).padEnd(6)} belowMinimum=${low}`
  );
}

// Whether the minimum applies at all. Banners are made one, two or more at a
// time; a single pop-up banner was told the minimum was 1000.
const PRODUCTS: Array<[string, boolean]> = [
  // [product, minimum applies]
  ["A pop up banner", false],
  ["pop-up banner", false],
  ["pull up banner", false],
  ["standard pull-up banner", false],
  ["roll up banner", false],
  ["retractable banner stand", false],
  ["vinyl banners", false],
  ["step and repeat backdrop", false],
  ["x-stand", false],
  ["Pouches", true],
  ["mylar bags", true],
  ["plain white box", true],
  ["pop up box", true],
  ["pop-up cards", true],
  ["die-cut stickers", true],
  ["", true],
];

console.log("");
for (const [product, expected] of PRODUCTS) {
  const got = minimumApplies(product);
  const ok = got === expected;
  if (!ok) bad += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${JSON.stringify(product).padEnd(28)} minimumApplies=${got}`);
}

// "Roll up banner" says roll; it must not pick up the zipper and tear notch.
for (const [product, expected] of [["roll up banner", false], ["film rolls", true]] as Array<[string, boolean]>) {
  const got = isBagFamily(product);
  const ok = got === expected;
  if (!ok) bad += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${JSON.stringify(product).padEnd(28)} isBagFamily=${got}`);
}

// Their answer once the minimum has been put to them. Only ever read on that
// turn, which is why a bare number counts and a size does not have to.
const ANSWERS: Array<[string, boolean]> = [
  ["yes smaller", true],
  ["smaller", true],
  ["can you do less?", true],
  ["that's too many for us", true],
  ["we need fewer than that", true],
  ["can't do 1000", true],
  ["something under the minimum", true],
  ["200", true],
  ["just 200", true],
  ["200 pcs", true],
  // Going with the minimum, or saying anything else at all.
  ["1000 is fine", false],
  ["1000", false],
  ["let's do 2000", false],
  ["ok", false],
  ["matte", false],
  ["what is the turnaround?", false],
  ["", false],
];

console.log("");
for (const [said, expected] of ANSWERS) {
  const got = wantsSmallerRun(said);
  const ok = got === expected;
  if (!ok) bad += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${JSON.stringify(said).padEnd(30)} wantsSmallerRun=${got}`);
}

// The live chat this was written for: "200", the minimum, "yes smaller", and
// the reply that asked about materials instead.
const TRANSCRIPT = [
  { fromUs: true, text: "What quantity are you looking to order for your first run?" },
  { fromUs: false, text: "200" },
  {
    fromUs: true,
    text:
      "Minimum for a first run is 1000 per size and per design. Would you like to proceed with 1000 " +
      "per size, or shall I explore options for a smaller run?",
  },
  { fromUs: false, text: "yes smaller" },
];

const TRANSCRIPTS: Array<[string, Array<{ fromUs: boolean; text: string }>, boolean]> = [
  ["asked for the smaller run", TRANSCRIPT, true],
  ["the low number alone is not insisting", TRANSCRIPT.slice(0, 2), false],
  ["told, and has not answered yet", TRANSCRIPT.slice(0, 3), false],
  [
    "went up to the minimum instead",
    [...TRANSCRIPT.slice(0, 3), { fromUs: false, text: "ok 1000 then" }],
    false,
  ],
  [
    "a size after the minimum is not a quantity",
    [...TRANSCRIPT.slice(0, 3), { fromUs: false, text: "5by5by5" }],
    false,
  ],
  ["nothing said about a minimum at all", [{ fromUs: false, text: "smaller" }], false],
];

console.log("");
for (const [name, messages, expected] of TRANSCRIPTS) {
  const got = askedToGoBelowMinimum(messages);
  const ok = got === expected;
  if (!ok) bad += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name.padEnd(44)} askedToGoBelowMinimum=${got}`);
}

// A bare yes or no, read against the question that drew it. The live chat asked
// "...the minimum is 1000 per size and per design — would that work for you?",
// which neither answer resolved: "no" was dropped and "yes" left the lead
// saying the customer wanted 200.
const YES_NO_QUESTION =
  "Got it. I can look into a smaller run for 6x5x4 inches gloss boxes. For a first run, the " +
  "minimum is 1000 per size and per design — would that work for you?";
const EITHER_OR_QUESTION =
  "Would you like to proceed with 1000 per size, or shall I explore options for a smaller run?";
const ORDINARY_QUESTION = "What finish do you prefer: matte, gloss or soft touch?";

const PAIRED: Array<[string, string, string, "smaller" | "minimum" | null]> = [
  // [name, the question we asked, what they typed, what it means]
  ["no to the minimum", YES_NO_QUESTION, "no", "smaller"],
  ["nope", YES_NO_QUESTION, "nope", "smaller"],
  ["not really", YES_NO_QUESTION, "not really", "smaller"],
  ["too many", YES_NO_QUESTION, "that's too many", "smaller"],
  ["yes to the minimum", YES_NO_QUESTION, "yes", "minimum"],
  ["that works", YES_NO_QUESTION, "that works", "minimum"],
  ["ok", YES_NO_QUESTION, "ok", "minimum"],
  ["says it in words anyway", YES_NO_QUESTION, "can you do less", "smaller"],
  ["names a number over the minimum", YES_NO_QUESTION, "1000 is fine", "minimum"],
  ["names a number under it", YES_NO_QUESTION, "200", "smaller"],
  // An either/or cannot be answered yes or no, so nothing is read into one.
  ["bare yes to an either/or", EITHER_OR_QUESTION, "yes", null],
  ["bare no to an either/or", EITHER_OR_QUESTION, "no", null],
  ["but the words still count", EITHER_OR_QUESTION, "yes smaller", "smaller"],
  // Nothing to do with the minimum: a yes here must never become a quantity.
  ["yes to something else", ORDINARY_QUESTION, "yes", null],
  ["a finish, not an answer", YES_NO_QUESTION, "matte", null],
  ["nothing said", YES_NO_QUESTION, "", null],
];

console.log("");
for (const [name, question, said, expected] of PAIRED) {
  const got = answerToTheMinimum(said, question);
  const ok = got === expected;
  if (!ok) bad += 1;
  console.log(
    `${ok ? "ok  " : "FAIL"}  ${name.padEnd(32)} ${JSON.stringify(said).padEnd(18)} -> ${String(got)}`
  );
}

// And the lead flag follows the LAST answer: asking for the smaller run and
// then settling for a thousand is not a decision waiting on a rep.
const SETTLED = [
  { fromUs: true, text: YES_NO_QUESTION },
  { fromUs: false, text: "no" },
  { fromUs: true, text: "Understood. Let me put 200 to the team and come back to you on what we can do." },
  { fromUs: true, text: "Would 1000 per size work if we can hold the price? Our minimum is 1000." },
  { fromUs: false, text: "yes" },
];

console.log("");
for (const [name, messages, expected] of [
  ["asked smaller, then settled at the minimum", SETTLED, false],
  ["asked smaller and left it there", SETTLED.slice(0, 3), true],
] as Array<[string, Array<{ fromUs: boolean; text: string }>, boolean]>) {
  const got = askedToGoBelowMinimum(messages);
  const ok = got === expected;
  if (!ok) bad += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name.padEnd(44)} askedToGoBelowMinimum=${got}`);
}

// The designs answer read as a quantity. A chat where the customer had never
// been asked the quantity was told its order was under the minimum, because "1"
// answering "How many total designs or SKUs do you have?" became quantity=1.
const DESIGNS = "Great. How many total designs or SKU's do you have?";
const QUANTITY = "What quantity are you looking to order for your first run?";

const DESIGN_ANSWERS: Array<[string, string, string, boolean]> = [
  // [what we last asked (key), what the bot's last message said, what they typed, is it a design count]
  ["skus", DESIGNS, "1", true],
  ["", DESIGNS, "1", true],
  ["", DESIGNS, "2", true],
  ["skus", DESIGNS, " 3 ", true],
  // Four digits answering the designs question is somebody giving a quantity.
  ["skus", DESIGNS, "1000", false],
  // The quantity question, answered — the minimum check must still see this.
  ["quantity", QUANTITY, "200", false],
  ["", QUANTITY, "1", false],
  // Anything that is not a bare number.
  ["skus", DESIGNS, "just one design", false],
  ["skus", DESIGNS, "matte", false],
  ["skus", DESIGNS, "", false],
];

console.log("");
for (const [lastAsked, lastBotText, typed, expected] of DESIGN_ANSWERS) {
  const got = isDesignCountAnswer(lastAsked, lastBotText, typed);
  const ok = got === expected;
  if (!ok) bad += 1;
  const where = lastBotText === DESIGNS ? "after the designs question" : "after the quantity question";
  console.log(
    `${ok ? "ok  " : "FAIL"}  ${JSON.stringify(typed).padEnd(20)} ${where.padEnd(28)} isDesignCountAnswer=${got}`
  );
}

console.log(bad === 0 ? "\nall pass" : `\n${bad} failing`);
process.exit(bad === 0 ? 0 : 1);

/**
 * The plain-packaging check, against what visitors actually type.
 *
 * Plain means no artwork, so the designs/SKUs question is skipped. Miss one and
 * a customer who said "plain white box" is asked how many designs it has; over-
 * match and somebody with three printed designs is never asked.
 */
import { wantsPlainPackaging } from "../domain/salesScript";

const CASES: Array<[string, boolean]> = [
  // From the screenshot — must be caught.
  ["This is just for a no design plain white box for now. Do you do that?", true],
  // Other ways of saying it.
  ["plain kraft mailer boxes", true],
  ["blank mylar bags", true],
  ["unprinted boxes please", true],
  ["no printing, just the box", true],
  ["no-print white boxes", true],
  ["without any printing", true],
  ["no logo on them", true],
  ["no design, just white", true],

  // Printed jobs — must NOT be caught.
  ["I have 3 designs", false],
  ["I have no design yet, can you help?", false],
  ["no design ready at the moment", false],
  ["full color print on all sides", false],
  ["can you explain the options?", false],
  ["I need custom printed pouches", false],
  ["", false],
];

let bad = 0;
for (const [text, expected] of CASES) {
  const got = wantsPlainPackaging([text]);
  const ok = got === expected;
  if (!ok) bad += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  plain=${String(got).padEnd(5)} "${text}"`);
}
console.log(bad === 0 ? "\nall pass" : `\n${bad} failing`);
process.exit(bad === 0 ? 0 : 1);

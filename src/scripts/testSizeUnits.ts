/** Read-only: the size check against the sizes real chats have produced. */
import {
  sizeMissingUnit,
  guessUnit,
  sizeWithAssumedUnit,
  unitWasAssumed,
  withCorrectedUnit,
} from "../domain/sizeUnit";

const CASES: Array<[string, boolean]> = [
  ["50x30 and 40x20", true],
  ["50x30mm and 40x20mm", false],
  ["50 X 30 MM", false],
  ['3.5 x 3.5 x 6"', false],
  ["3.5 x 3.5 x 6 inches", false],
  ["3.5 x 3.5 x 6", true],
  ["12oz", false],
  ["500ml", false],
  ["8 x 10 cm", false],
  ["A4", false],
  ["4x6 in", false],
  ["", false],
  ["same as the sample", false],
  ["not given", false],
  ["10x14 inch stand up pouch", false],
  ["6 x 9", true],
  // A capacity written out, which is how a mylar bag is usually specified.
  // "Is 28 grams a size in inches, cm, or mm?" went to a real customer.
  ["28 grams", false],
  ["big enough to hold 28 grams of product", false],
  ["28g", false],
  ["1 ounce", false],
  ["2 ounces", false],
  ["1 pound", false],
  ["500 millilitres", false],
  ["1 liter", false],
  ["2 kilos", false],
  ["8 x 5 inches", false],
  // Still a bare number: a unit somewhere else in the sentence is the point,
  // and there is none here.
  ["28", true],
  ["4 x 6", true],
];

let bad = 0;
for (const [value, expected] of CASES) {
  const got = sizeMissingUnit(value);
  const ok = got === expected;
  if (!ok) bad += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${JSON.stringify(value).padEnd(30)} missing=${got}`);
}

console.log("\n-- the unit read from the numbers, rather than asked for");
const GUESSES: Array<[string, string, string]> = [
  // [size, product, unit we should take it as]
  ["50x30", "labels", "mm"],
  ["50x30 and 40x20", "labels", "mm"],
  ["2x3", "stickers", "inches"],
  ["4x6", "labels", "inches"],
  ["10x8x4", "custom mailer boxes", "inches"],
  ["3.5 x 3.5 x 6", "rigid boxes", "inches"],
  ["250x200x100", "boxes", "mm"],
  ["6 x 9", "mylar bags", "inches"],
  ["150x230", "stand up pouches", "mm"],
  ["3x6", "pull-up banner", "ft"],
  ["33x81", "retractable banner", "inches"],
  // Nothing to work out: the unit is already there, or there are no numbers.
  ["50x30mm", "labels", ""],
  ['3.5 x 3.5 x 6"', "boxes", ""],
  ["same as the sample", "boxes", ""],
  ["", "boxes", ""],
];

for (const [size, product, expected] of GUESSES) {
  const got = guessUnit(size, product);
  const ok = got === expected;
  if (!ok) bad += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${JSON.stringify(size).padEnd(24)} as ${product.padEnd(20)} -> ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
}

console.log("\n-- marking it as ours, and letting them correct it");
const marked = sizeWithAssumedUnit("50x30", "mm");
const show = (label: string, got: unknown, expected: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) bad += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};
show("written onto the size", marked, "50x30 mm (assumed)");
show("no longer missing a unit", sizeMissingUnit(marked), false);
show("and known to be ours", unitWasAssumed(marked), true);
show("a size they gave is not", unitWasAssumed("50x30 mm"), false);
show("their correction wins", withCorrectedUnit(marked, "cm"), "50x30 cm");
show("and drops the marking", unitWasAssumed(withCorrectedUnit(marked, "cm")), false);

console.log(bad === 0 ? "\nall pass" : `\n${bad} failing`);
process.exit(bad === 0 ? 0 : 1);

/**
 * The instant price against the way customers actually write.
 *
 * Each case is what the chat has collected plus what the visitor typed, and
 * what the ERP should be asked for — or null when a rep has to price it.
 * Read-only: nothing here calls the ERP.
 */
import {
  priceRequestFor,
  needsGusset,
  dimensionsInInches,
  withGusset,
  quantityGivenByThem,
  quantityIsTheDesignCount,
} from "../services/erpPricing";
import { quantityIn, quantityIsAPackCount } from "../domain/minimumOrder";
import { withoutRepeatedGreeting } from "../services/salesiq/chatComposer";
import { sizeIsAPackCount } from "../domain/sizeUnit";

let bad = 0;
const check = (label: string, got: unknown, expected: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) bad += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}: ${JSON.stringify(got)}${ok ? "" : `  (expected ${JSON.stringify(expected)})`}`);
};

const said = (...texts: string[]) => texts.map((text) => ({ author: "visitor", text }));
const base = { product: "mylar bags", quantity: "1000", skus: "1" };

/** product_id and dimensions only — what most cases are about. */
const style = (collected: Record<string, string>, messages = said()) => {
  const r = priceRequestFor({ ...base, ...collected }, messages);
  return r ? [r.product_id, r.dimensions] : null;
};
const finishing = (collected: Record<string, string>, messages = said()) =>
  priceRequestFor({ ...base, sizes: "4x6x2 in", ...collected }, messages)?.finishing_ids ?? null;

console.log("\n— sizes, however they are written —");
check("4 x 6 x 2 inches", dimensionsInInches("4 x 6 x 2 inches"), [4, 6, 2]);
check("curly inch marks", dimensionsInInches("4”x6”"), [4, 6]);
check("4 by 6 inches", dimensionsInInches("4 by 6 inches"), [4, 6]);
check("words: 4in wide 6in tall 2in gusset", dimensionsInInches("4in wide 6in tall 2in gusset"), [4, 6, 2]);
check("mm, all three", dimensionsInInches("120mm x 200mm x 80mm"), [4.72, 7.87, 3.15]);
check("labelled without colons", dimensionsInInches("width 4 inch, height 6 inch, gusset 2 inch"), [4, 6, 2]);
check("W 4 H 6 G 2", dimensionsInInches("W 4 H 6 G 2"), [4, 6, 2]);
check("a size with a capacity beside it", dimensionsInInches("7x10 in for 1oz"), [7, 10]);
check("capacity alone is not a size", dimensionsInInches("3.5g bags"), null);
check("half pound is not a size", dimensionsInInches("1/2 lb"), null);
check("two sizes", dimensionsInInches("6x9 and 4x6"), null);

console.log("\n— the style, from the size —");
check("mylar bags 4x6: flat pouch", style({ sizes: "4x6 inches" }), [36, [4, 6]]);
check("mylar bags 4x6x2: stand-up", style({ sizes: "4x6x2 inches" }), [26, [4, 6, 2]]);
check("pouches 5x8x3 in", style({ product: "pouches", sizes: "5x8x3 in" }), [26, [5, 8, 3]]);

console.log("\n— the style, from their words —");
check("stand up pouches, 3", style({ product: "stand up pouches", sizes: "5x8x3 in" }), [26, [5, 8, 3]]);
check("standing pouch", style({ product: "standing pouch", sizes: "5x8x3 in" }), [26, [5, 8, 3]]);
check("zipper bags that stand", style({ sizes: "5x8x3 in" }, said("zipper bags that stand")), [26, [5, 8, 3]]);
check("flat bags, 2", style({ product: "flat bags", sizes: "4x6 in" }), [36, [4, 6]]);
check("lay flat, but gave 3 — flat, first two", style({ sizes: "4x6x2 in" }, said("lay flat please")), [36, [4, 6]]);
check("box pouch", style({ product: "box pouch", sizes: "4x6x2 in" }), [25, [4, 6, 2]]);
check("flat bottom coffee bags", style({ product: "flat bottom coffee bags", sizes: "4x6x2 in" }), [25, [4, 6, 2]]);
check("pre-roll bags are ordinary pouches", style({ product: "pre-roll bags", sizes: "3x5 in" }), [36, [3, 5]]);

console.log("\n— a rep's, not ours —");
check("kraft paper bags", style({ product: "kraft paper bags", sizes: "4x6x2 in" }), null);
check("rollstock", style({ product: "roll stock", sizes: "4x6 in" }), null);
check("quad seal", style({ product: "quad seal bags", sizes: "4x6x2 in" }), null);
check("coffee bags with a valve", style({ product: "coffee bags", sizes: "4x6x2 in" }, said("need a one way valve")), null);
check("plain, unprinted bags", style({ sizes: "4x6 in" }, said("plain bags, no printing")), null);
check("boxes and bags", style({ product: "boxes and bags", sizes: "4x6x2 in" }), null);
check("labels", style({ product: "labels for pouches", sizes: "2x3 in" }), null);

console.log("\n— the gusset —");
check("stands up, 4x6: ask", needsGusset({ ...base, sizes: "4x6 in" }, said("stand up pouch")), true);
check("flat bottom, 4x6: ask", needsGusset({ ...base, product: "flat bottom bag", sizes: "4x6 in" }), true);
check("never said, 4x6: flat, no ask", needsGusset({ ...base, sizes: "4x6 in" }), false);

// The chat that asked twice: "4.6 inch * 9.1", then "3.15".
check("'3.15' onto '4.6 inch * 9.1'", withGusset("4.6 inch * 9.1", "3.15"), "4.6 inch * 9.1 x 3.15");
check("and it prices as a flat bottom bag", style({ product: "flat bottom bag", sizes: withGusset("4.6 inch * 9.1", "3.15")! }), [25, [4.6, 9.1, 3.15]]);
check("'4 by 6 inches' + '2'", withGusset("4 by 6 inches", "2"), "4 by 6 x 2 inches");
check("'width 4 height 6' + '2'", dimensionsInInches(withGusset("width 4 height 6", "2")!), [4, 6, 2]);
check("'4x6' + '2 inch gusset'", withGusset("4x6", "2 inch gusset"), "4x6 x 2");
check("'10 x 15 cm' + '5'", withGusset("10 x 15 cm", "5"), "10 x 15 x 5 cm");

console.log("\n— quantity —");
check("1,000", quantityIn("1,000"), 1000);
check("1.000 (European)", quantityIn("1.000"), 1000);
check("10.000 (European)", quantityIn("10.000"), 10000);
check("10k", quantityIn("10k"), 10000);
check("5000 pcs", quantityIn("5000 pcs"), 5000);
check("about 3000", quantityIn("about 3000"), 3000);
check("2.5k", quantityIn("2.5k"), 2500);
// Laurie's boxes: "Just fifty to start" was no quantity at all, so the minimum was never said.
check("Just fifty to start", quantityIn("Just fifty to start"), 50);
check("two hundred", quantityIn("two hundred"), 200);
check("fifteen hundred", quantityIn("fifteen hundred"), 1500);
check("a couple thousand", quantityIn("I need a couple thousand"), 2000);
check("one design is not a quantity", quantityIn("one design"), null);

console.log("\n— 'nice to meet you' once, and only with their name —");
check("while asking the name", withoutRepeatedGreeting("Nice to meet you. Could I take your name?", ["Hi, I'm Harry."], false), "Could I take your name?");
check("the first time, with the name", withoutRepeatedGreeting("Nice to meet you, Laurie. Could I get your phone number?", ["Could I take your name?"], true), "Nice to meet you, Laurie. Could I get your phone number?");
check("the second time", withoutRepeatedGreeting("Nice to meet you, Laurie. Could I get your phone number?", ["Nice to meet you, Laurie. What finish?"], true), "Could I get your phone number?");
check("after a comma", withoutRepeatedGreeting("Great, nice meeting you! What size?", ["Nice to meet you, Sam."], true), "Great. What size?");

console.log("\n— a pack count is not the order —");
const pack = (quantity: string, ...texts: string[]) => quantityIsAPackCount(quantity, texts);
check("'i need 2 count gummy pouch' (this chat)", pack("2", "i need 2 count gummy pouch", "3 by 4"), true);
check("'10 ct'", pack("10", "10 ct capsule bags"), true);
check("'5-pack'", pack("5", "5-pack cookie pouch"), true);
check("'30 per bag'", pack("30", "30 per bag, gummies"), true);
check("'30 pieces in each'", pack("30", "30 pieces in each pouch"), true);
check("pack count, then the order as a bare number", pack("2", "2 count gummy pouch", "2"), false);
check("a real order", pack("2000", "2000 pouches for 2 count gummies"), false);
check("the order, with a different pack count", pack("5000", "5 count packs, 5000 of them"), false);
check("'2k' is not '2 count'", pack("2000", "2k pouches"), false);
// The e2e run: an email with a 2 in it made "2 count" look like it was also said as an order.
check("a 2 inside an email is not a mention", pack("2", "I need 2 count Gummy pouch", "e2e.customer@example.com", "3x4 inches"), true);
check("'2 count gummy pouch' is not given as an order", quantityGivenByThem("2", said("I need 2 count Gummy pouch")), false);
check("'10 ct pouches' is not an order", quantityGivenByThem("10", said("10 ct pouches")), false);
check("'2000 pouches' still is", quantityGivenByThem("2000", said("2000 pouches for 2 count gummies")), true);

console.log("\n— only a quantity they gave as one —");
const ai = (text: string) => ({ author: "ai", text });
const v = (text: string) => ({ author: "visitor", text });
// The chat priced at 5 bags: "5" was the answer to the designs question.
const kashif = [
  ai("What bag size are you looking for?"), v("2 by 3"),
  ai("What finish do you prefer: matte, gloss or soft touch?"), v("maat with uv"),
  ai("Thanks for the details. How many total designs or SKU's do you have for your gummy pouches?"), v("5"),
  ai("Do you want me to add a zipper and tear notch to the pouches?"), v("cr zipper"),
];
check("kashif: '5' to the designs question is not a quantity", quantityGivenByThem("5", kashif), false);
check("kashif: and is taken off the quantity", quantityIsTheDesignCount("5", kashif), true);
check("kashif: '1000 quantity' is", quantityGivenByThem("1000", [...kashif, v("1000 quantity")]), true);
check("kashif: 'maat with uv' prices spot UV", finishing({ finishes: "maat with uv" }), [1, 2, 6, 289]);
check(
  "answer to the quantity question",
  quantityGivenByThem("500", [ai("What quantity are you looking to order for your first run?"), v("500")]),
  true
);
check("'how many bags' is the quantity question", quantityGivenByThem("300", [ai("How many bags do you need?"), v("300")]), true);
check("in their own words", quantityGivenByThem("1000", [v("I need 1,000 stand up pouches 4x6x2")]), true);
check("'2k pouches'", quantityGivenByThem("2000", [v("2k pouches please")]), true);
check("a bare number nobody asked for", quantityGivenByThem("4", [ai("What bag size are you looking for?"), v("4")]), false);
check("the size is not a quantity", quantityGivenByThem("4", [v("4x6 pouches")]), false);
check("nor is the gusset", quantityGivenByThem("2", [v("4 x 6 x 2 inch pouches")]), false);
check("size and quantity together", quantityGivenByThem("1000", [v("4x6 pouches, 1000 of them")]), false);
check("size and quantity together, as an order", quantityGivenByThem("1000", [v("4x6, 1000 pouches")]), true);
check(
  "'5' answering the quantity question stays",
  quantityIsTheDesignCount("5", [ai("What quantity are you looking to order?"), v("5")]),
  false
);

console.log("\n— a pack count is not a size —");
// "I need 2 count Gummy pouch" became the size "2 count inches (assumed)" and the size was never asked.
for (const [value, expected] of [
  ["2 count", true],
  ["2 count inches (assumed)", true],
  ["10 ct", true],
  ["5-pack", true],
  ["30 per bag", true],
  ["2 pcs", true],
  ["4x6, 2 count", false],
  ["4 x 6 inches", false],
  ["12oz", false],
  ["4 by 6", false],
] as const) check(`size ${JSON.stringify(value)} is a pack count`, sizeIsAPackCount(value), expected);

console.log("\n— SKUs —");
check("two designs", priceRequestFor({ ...base, sizes: "4x6 in", skus: "two" })?.no_of_sku, 2);
check("3 designs", priceRequestFor({ ...base, sizes: "4x6 in", skus: "3 designs" })?.no_of_sku, 3);

console.log("\n— finishes and extras —");
check("nothing said: matte", finishing({}), [1, 2, 6]);
check("shiny", finishing({ finishes: "shiny" }), [1, 2, 5]);
check("glossy", finishing({ finishes: "glossy" }), [1, 2, 5]);
check("soft touch", finishing({ finishes: "soft touch" }), [1, 2, 7]);
check("matte with spot uv", finishing({ finishes: "matte with spot uv" }), [1, 2, 6, 289]);
check("foil stamping", finishing({ finishes: "gloss and foil stamping" }), [1, 2, 5, 11]);
check("embossed", finishing({ finishes: "embossed logo" }), [1, 2, 6, 199]);
check("front and back", finishing({ finishes: "matte, printed front and back" }), [1, 3, 6]);
check("zipper only", finishing({ extras: "zipper only" }), [1, 2, 6, 80]);
check("child resistant zipper", finishing({ extras: "child resistant zipper" }), [1, 2, 6, 81]);
check("zipper, no tear notch", finishing({ extras: "zipper but no tear notch" }), [1, 2, 6, 80]);
check("yes to both", finishing({ extras: "yes" }), [1, 2, 6, 80, 85]);
check("no", finishing({ extras: "no" }), [1, 2, 6]);
check("hang hole and window", finishing({ extras: "hang hole and a window" }), [1, 2, 6, 14, 91]);

console.log("\n— material —");
const material = (m: string) => {
  const r = priceRequestFor({ ...base, sizes: "4x6 in", material: m });
  return r ? [r.material_id, r.micron] : null;
};
check("nothing special", material("nothing special"), [55, 120]);
check("metallic / silver", material("metallic silver"), [55, 120]);
check("clear", material("clear"), [54, 120]);
check("clear window is not a clear bag", material("clear window"), [55, 120]);
check("foil lined", material("foil lined"), [56, 120]);
check("white", material("white"), [53, 120]);
check("holographic", material("holographic"), [65, 120]);
check("thicker, 150 micron", material("150 micron"), [55, 150]);
check("a thickness we do not stock", material("125 microns"), [55, 120]);

console.log("\n— words in the wrong sense —");
check("'stand out on the shelf' is not stand-up", style({ sizes: "4x6 in" }, said("I want it to stand out on the shelf")), [36, [4, 6]]);
check("'I don't want it flat' is not flat", style({ sizes: "4x6x2 in" }, said("I don't want it flat")), [26, [4, 6, 2]]);
check("'I want it flat' is flat", style({ sizes: "4x6x2 in" }, said("I want it flat")), [36, [4, 6]]);
check("'flat' as the whole answer", style({ sizes: "4x6x2 in" }, said("flat")), [36, [4, 6]]);
check("'the flat one please'", style({ sizes: "4x6x2 in" }, said("the flat one please")), [36, [4, 6]]);
check("'not flat' is not flat", style({ sizes: "4x6x2 in" }, said("not flat, it has to stand")), [26, [4, 6, 2]]);
check("'flat rate shipping' is not flat", style({ sizes: "4x6x2 in" }, said("do you have flat rate shipping?")), [26, [4, 6, 2]]);
check("'flat price' is not flat", style({ sizes: "4x6x2 in" }, said("is it a flat price?")), [26, [4, 6, 2]]);
check("'I understand' is nothing", style({ sizes: "4x6 in" }, said("I understand")), [36, [4, 6]]);
check("'paper' in passing is not a paper bag", style({ sizes: "4x6 in" }, said("I have the design on paper")), [36, [4, 6]]);
check("changed their mind: flat, then stand up", style({ sizes: "4x6x2 in" }, said("flat pouch", "actually stand up")), [26, [4, 6, 2]]);
check("stand-up by words, 2 measurements: wait for the gusset", style({ sizes: "4x6 in" }, said("stand up pouch")), null);
check("'won't fall over' stands", needsGusset({ ...base, sizes: "4x6 in" }, said("one that won't fall over")), true);

console.log(bad === 0 ? "\nall pass" : `\n${bad} failing`);
process.exit(bad === 0 ? 0 : 1);

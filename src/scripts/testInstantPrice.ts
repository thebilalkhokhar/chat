/**
 * The instant pouch price: what the chat's answers are sent to the ERP as.
 *
 * Read-only by default. `--live` also prices two real requests, which writes
 * two price records in the ERP under chat ids starting "test-".
 */
import {
  pouchStyleFor,
  dimensionsInInches,
  priceRequestFor,
  fetchPrice,
  describePrice,
  isConfigured,
  STYLE_QUESTION,
  needsGusset,
  gussetQuestion,
  gussetAsks,
  withGusset,
} from "../services/erpPricing";
import { afterThePrice } from "../services/salesiq/chatEngine";

let bad = 0;
const show = (label: string, got: unknown, expected: unknown) => {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) bad += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}: ${JSON.stringify(got)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
};

const visitor = (...texts: string[]) => texts.map((text) => ({ author: "visitor", text }));
const STYLE_Q = "What style of Mylar bag do you need: Flat, Standup or which one?";

// Nobody says our names. The style comes from how they describe it...
show("stands on the shelf", pouchStyleFor("mylar bags", visitor("I need bags that stand on the shelf"))?.id, 26);
show("stand on its own", pouchStyleFor("pouches", visitor("something that can stand up on its own"))?.id, 26);
show("with a bottom", pouchStyleFor("mylar bags", visitor("zip bags with a bottom for gummies"))?.id, 26);
show("lays flat", pouchStyleFor("mylar bags", visitor("just ones that lay flat"))?.id, 36);
show("doesn't need to stand", pouchStyleFor("mylar bags", visitor("they don't need to stand"))?.id, 36);
show("sachet", pouchStyleFor("sachets", [])?.id, 36);
show(
  "the first one, to our question",
  pouchStyleFor("mylar bags", [...visitor("mylar bags"), { author: "ai", text: STYLE_Q }, ...visitor("the first one")])?.id,
  36
);
show(
  "the second one",
  pouchStyleFor("mylar bags", [...visitor("mylar bags"), { author: "ai", text: STYLE_Q }, ...visitor("second")])?.id,
  26
);
show(
  "latest word wins",
  pouchStyleFor("mylar bags", visitor("flat ones I think", "actually make them stand up"))?.id,
  26
);
// ...and when they do not say, the size decides: 2 measurements flat, 3 stand-up. No question.
const askedNoAnswer: Array<{ author: string; text: string }> = [];
show("mylar bags, 2 measurements: flat", pouchStyleFor("mylar bags", [], 2)?.id, 36);
show("smell proof bags, 3 measurements: stand-up", pouchStyleFor("smell proof mylar bags", [], 3)?.id, 26);
show("no size yet", pouchStyleFor("mylar bags", [], 0), null);
show("'understand' is not 'stand'", pouchStyleFor("mylar bags", visitor("I understand"), 2)?.id, 36);
show("old style question, 'the first one'", pouchStyleFor("mylar bags", [{ author: "ai", text: STYLE_QUESTION }, ...visitor("the first one")], 3)?.id, 36);

// The gummies chat: priced straight off the size.
const gummies = { product: "mylar bags", sizes: "4x6 inches", finishes: "matte", skus: "1", quantity: "1000" };
const gummyChat = visitor("mylar bags for gummies, 4x6 inches", "hammadtest00009@gmail.com", "matte", "1", "1000");
show("gummies: 4x6 is a flat pouch", priceRequestFor(gummies, gummyChat)?.product_id, 36);
show("gummies, 4x6x2: stand-up", priceRequestFor({ ...gummies, sizes: "4x6x2 inches" }, gummyChat)?.product_id, 26);
show("gummies, but 'stands on the shelf' and 4x6: asks the gusset", needsGusset(gummies, [...gummyChat, ...visitor("one that stands on the shelf")]), true);
show("'lays flat' with 3 measurements: their words win", priceRequestFor({ ...gummies, sizes: "4x6x2 in" }, visitor("lays flat"))?.product_id, 36);
// A flat bottom bag is the ERP's product 25 — the one in the team's own example.
show("flat bottom", pouchStyleFor("flat bottom bags", [], 3)?.id, 25);
show("box bottom", pouchStyleFor("mylar bags", visitor("with a box bottom"), 3)?.id, 25);
// The chat that went unpriced: Sep 25, "I need Flat bottom bag AND ITS dimension is 4.6 * 9.1 * 3.15".
const flatBottomChat = visitor("Hi", "I need Flat bottom bag AND ITS dimension is 4.6 * 9.1 * 3.15", "no", "1.0000", "1000", "no", "no", "no");
const flatBottomAnswers = { product: "Flat bottom bag", sizes: "4.6 * 9.1 * 3.15 inches (assumed)", quantity: "1000", finishes: "not specified", material: "none", extras: "none" };
show("that chat: priced as product 25", priceRequestFor(flatBottomAnswers, flatBottomChat), {
  product_id: 25,
  material_id: 55,
  dimensions: [4.6, 9.1, 3.15],
  micron: 120,
  qty: 1000,
  no_of_sku: 1,
  finishing_ids: [1, 2, 6],
  shipment_service_id: 9,
});
show("flat bottom, two measurements: asks the gusset", needsGusset({ product: "flat bottom bag", sizes: "4x6 in" }, []), true);
// Other bags are other products.
show("coffee bag with side gusset", pouchStyleFor("coffee bags", visitor("side gusset please"), 3), null);
show("kraft paper", pouchStyleFor("kraft paper bags", [], 3), null);
show("poly mailers", pouchStyleFor("poly mailer bags", [], 2), null);
show("boxes", pouchStyleFor("mailer boxes", [], 3), null);
show("heart shaped gummies are fine", pouchStyleFor("mylar bags", [...visitor("for heart shaped gummies"), ...askedNoAnswer], 2)?.id, 36);

show("inches", dimensionsInInches("4 x 6 x 2 inches"), [4, 6, 2]);
show("assumed inches", dimensionsInInches("4.9x9.16x3.15 in (assumed)"), [4.9, 9.16, 3.15]);
show("mm converted", dimensionsInInches("100 x 150 mm"), [3.94, 5.91]);
show("cm converted", dimensionsInInches("10x15cm"), [3.94, 5.91]);
show("a capacity is not a size", dimensionsInInches("12oz"), null);
show("two sizes are not one", dimensionsInInches("4x6 and 5x8 in"), null);
// Pasted from our website calculator, every side in inches and mm.
show(
  "website calculator paste",
  dimensionsInInches("W : 4.9 Inch W : 124.46 mm H : 9.1 Inch H : 231.14 mm G : 3.15 Inch G : 80.01 mm"),
  [4.9, 9.1, 3.15]
);
show("labelled, mm only", dimensionsInInches("W: 100 mm H: 150 mm"), [3.94, 5.91]);
show("labelled, no unit", dimensionsInInches("Width: 4 Height: 6 Gusset: 2"), [4, 6, 2]);

const standUp = {
  product: "mylar bags",
  sizes: "4.9 x 9.16 x 3.15 in",
  quantity: "1000",
  skus: "5",
};
show("defaults", priceRequestFor(standUp, askedNoAnswer), {
  product_id: 26,
  material_id: 55,
  dimensions: [4.9, 9.16, 3.15],
  micron: 120,
  qty: 1000,
  no_of_sku: 5,
  finishing_ids: [1, 2, 6],
  shipment_service_id: 9,
});
show(
  "gloss, clear, 130 micron, zipper and notch",
  priceRequestFor({ ...standUp, finishes: "gloss", material: "clear 130 micron", extras: "yes please" }, askedNoAnswer),
  {
    product_id: 26,
    material_id: 54,
    dimensions: [4.9, 9.16, 3.15],
    micron: 130,
    qty: 1000,
    no_of_sku: 5,
    finishing_ids: [1, 2, 5, 80, 85],
    shipment_service_id: 9,
  }
);
show(
  "stands up, but no gusset yet — waits",
  priceRequestFor({ ...standUp, sizes: "4 x 6 in" }, visitor("bags that stand up")),
  null
);
show("two measurements is a flat pouch", priceRequestFor({ ...standUp, sizes: "4 x 6 in" }, askedNoAnswer)?.product_id, 36);
// The gusset, when they want it standing and gave two measurements.
show("stands, two measurements: ask", needsGusset({ product: "mylar bags", sizes: "4x6 in" }, visitor("ones that stand up")), true);
show("never said, two measurements: flat, no ask", needsGusset({ product: "mylar bags", sizes: "4x6 in" }, []), false);
show("already has three: no ask", needsGusset({ product: "mylar bags", sizes: "4x6x2 in" }, visitor("stand up")), false);
show("first asking", gussetQuestion("4x6 in", 0).includes("2 inches"), true);
show("in their unit", gussetQuestion("100x150 mm", 0).includes("50 mm"), true);
show("second asking is worded differently", gussetQuestion("4x6 in", 1) !== gussetQuestion("4x6 in", 0), true);
show(
  "both wordings are counted",
  gussetAsks([{ author: "ai", text: gussetQuestion("4x6 in", 0) }, { author: "ai", text: gussetQuestion("4x6 in", 1) }]),
  2
);
show("'2' onto inches", withGusset("4x6 in", "2"), "4x6 x 2 in");
show("'2 inches please'", withGusset("4 x 6 inches (assumed)", "2 inches please"), "4 x 6 x 2 inches (assumed)");
show("cm into mm", withGusset("100x150 mm", "5cm"), "100x150 x 50 mm");
show("inch marks", withGusset('4" x 6"', "2"), '4" x 6" x 2');
show("no number, no change", withGusset("4x6 in", "not sure"), null);
show(
  "and then it prices",
  priceRequestFor({ ...standUp, sizes: withGusset("4x6 in", "2")! }, visitor("stand up"))?.dimensions,
  [4, 6, 2]
);

show("under 1000 is priced too", priceRequestFor({ ...standUp, quantity: "500" }, askedNoAnswer)?.qty, 500);
show("a run of 100", priceRequestFor({ ...standUp, quantity: "100" }, askedNoAnswer)?.qty, 100);
show("no quantity yet", priceRequestFor({ ...standUp, quantity: "not given" }, askedNoAnswer), null);

show(
  "what they read",
  describePrice(priceRequestFor(standUp, askedNoAnswer)!, { erpId: 18, unitCost: 1.6924, total: 846 }),
  [
    "Here's your estimated pricing:",
    "• Stand-up pouch, 4.9 x 9.16 x 3.15 in, matte",
    "• Quantity: 5,000 (1,000 each of 5 designs)",
    "• Unit price: $1.69",
    "• Estimated total: $846",
    "",
    "Your final quote will confirm this.",
  ].join("\n")
);
// Kashif's chat: "$0.23 each, $1,136 total" for 5,000 bags did not add up on the page.
show(
  "under a dollar: three decimals, and the options named",
  describePrice(
    { product_id: 26, material_id: 55, dimensions: [2, 6, 1.5], micron: 120, qty: 1000, no_of_sku: 5, finishing_ids: [1, 2, 6, 81], shipment_service_id: 9 },
    { erpId: 1, unitCost: 0.2272, total: 1136 }
  ),
  [
    "Here's your estimated pricing:",
    "• Stand-up pouch, 2 x 6 x 1.5 in, matte, CR zipper",
    "• Quantity: 5,000 (1,000 each of 5 designs)",
    "• Unit price: $0.227",
    "• Estimated total: $1,136",
    "",
    "Your final quote will confirm this.",
  ].join("\n")
);
show(
  "only the question follows the price",
  afterThePrice("Taking that as 3 by 4 inches. Got it, gummy pouch. What finish do you prefer: matte, gloss or soft touch?"),
  "What finish do you prefer: matte, gloss or soft touch?"
);
show(
  "kept whole when they asked something",
  afterThePrice("Yes, we ship to Canada. What finish do you prefer?", true),
  "Yes, we ship to Canada. What finish do you prefer?"
);

(async () => {
  if (process.argv.includes("--live")) {
    if (!isConfigured()) {
      console.log("\nERP pricing is not configured — set ERP_REFRESH_TOKEN");
      bad += 1;
    } else {
      for (const [label, collected] of [
        ["stand up, defaults", standUp],
        ["flat, gloss + zipper + notch", { product: "mylar bags", sizes: "4 x 6 in", quantity: "2000", finishes: "gloss", extras: "yes" }],
      ] as const) {
        const request = priceRequestFor(collected, askedNoAnswer)!;
        const started = Date.now();
        const price = await fetchPrice(request, `test-${Date.now()}`);
        console.log(`\n${price ? "ok  " : "FAIL"}  live ${label} (${Date.now() - started}ms): ${price ? describePrice(request, price) : "no price"}`);
        if (!price) bad += 1;
      }
    }
  }

  console.log(bad === 0 ? "\nall pass" : `\n${bad} failing`);
  process.exit(bad === 0 ? 0 : 1);
})();

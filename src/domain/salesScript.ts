/**
 * The sales team's live chat script.
 *
 * Just the script now — the questions, in their order, in their words. It used
 * to be a rule engine as well: regexes that guessed which family a customer was
 * on, a sort that put the fields in order, flags that added a question back when
 * a family word had been mistaken for a style.
 *
 * All of that is gone, and it went because every single failure it produced was
 * its own and not the model's. It read "Custom Packaging Boxes, Mylar Bags &
 * Stickers" — the home page, naming all three families — and put the visitor on
 * the labels script, because labels was the first pattern tested. It recorded
 * "burger" as a product. It fell back to the order the fields happened to be
 * declared in, which asks for a material second. And when a visitor answered
 * "pizza" to a question about size, it had nothing to say except the same
 * sentence again.
 *
 * A model reading this script and the conversation gets all of that right
 * without being told, because working out that somebody selling pizza needs a
 * pizza box is the thing it is good at, and a regex never will be. What is left
 * here is the part a model should not invent: what the team actually says.
 */

export type ProductFamily = "bags" | "boxes" | "labels";

/**
 * Whether what they have named is something the bag list applies to.
 *
 * Only used to rule the bag list OUT. Which list somebody is on is a judgement
 * about the whole conversation and the model makes it — but a customer who has
 * said "boxes" being asked whether they want a zipper and a tear notch is not a
 * judgement call, it is an answer no packaging company would give, and it
 * happened: a peptide box enquiry was asked to confirm the zipper on its boxes.
 */
export function isBagFamily(product?: string): boolean {
  // "Roll up banner" says roll, and a banner stand has no zipper either.
  if (isBannerFamily(product)) return false;
  return /\b(bag|bags|pouch|pouches|mylar|film|foil|roll|rolls|sachet|stand ?-?up|doypack|gusset)\b/i.test(
    String(product || "")
  );
}

/**
 * A banner or a banner stand: pull-up, roll-up, pop-up, retractable, backdrop.
 *
 * Its own kind of order. A banner is big and expensive per unit, so customers
 * buy one, two, a handful — and the team makes one, two or more. A pop-up banner
 * enquiry for a single unit was told "our minimum is 1000 per size and per
 * design", twice, which is a figure for boxes and bags and turns away an order
 * we would have taken.
 *
 * "Pop up" alone is a banner to most people who type it, but a pop-up box or
 * card is packaging, so those are left out.
 */
export function isBannerFamily(product?: string): boolean {
  return /\b(banners?|pull[- ]?ups?|roll[- ]?ups?|pop[- ]?ups?(?!\s*(?:box|boxes|card|cards|book|books|carton|cartons|mailer|mailers)\b)|retractables?|backdrops?|step[- ]and[- ]repeat|x[- ]?stands?)\b/i.test(
    String(product || "")
  );
}

/**
 * They want the packaging plain: no print, no artwork, nothing on it.
 *
 * Then there is no design, and asking how many designs or SKUs there are is a
 * question about something that does not exist. A visitor who had just said "a
 * no design plain white box for now, I have a sticker" was asked exactly that —
 * "for a no-design plain white box, how many total designs or SKU's" — which
 * reads as not having listened.
 *
 * Read from what the visitor said, never what the bot said. "No design yet" is
 * left out: that is somebody without artwork, not somebody who wants none.
 */
export function wantsPlainPackaging(visitorSaid: string[]): boolean {
  return visitorSaid.some((text) =>
    /\b(plain|blank|unprinted|un-printed|non-printed|not printed|no[- ]print(?:ing)?|without (?:any )?(?:print(?:ing)?|logo|branding)|no (?:logo|branding)|no[- ]design(?!\s+(?:yet|ready|file|files|done)\b))\b/i.test(
      String(text || "")
    )
  );
}

/**
 * A question about the quote itself rather than the job.
 *
 * A labels chat spent eight turns on the paperwork — a digital proof, PDF or
 * link, file naming for 15 SKUs, whether to group them by size, a delivery
 * address, a carrier preference — and asked the grouping three different ways.
 * The team asks none of that: a rep sorts the quote out once they have the job.
 */
const ABOUT_THE_QUOTE =
  /\b(proofs?|artwork|file names?|naming|attachments?|pdfs?|approval|carriers?|shipping method|delivery address|ship(?:ping)? to|line items?|grouped|grouping|organi[sz]ed?|layout|invoice|payment link)\b/i;

export function asksAboutTheQuote(question: string): boolean {
  return ABOUT_THE_QUOTE.test(String(question || ""));
}

/**
 * A question, and the minimum order the team states alongside it.
 *
 * The two are kept apart because the surfaces differ. On live chat the MOQ goes
 * out with the quantity question every time, and it has to: a visitor who has
 * not been told it answers "maybe 50", which is not an order we can take, and
 * the chat ends with a number nobody can quote. In email it is not volunteered —
 * there it reads as a condition attached to a first approach. Asked directly it
 * is answered on both, from the company facts.
 */
type ScriptQuestion = string | { ask: string; moq: string };

interface FamilyScript {
  /** What a customer on this script is buying, in the team's terms. */
  buying: string;
  /** The questions, in the order they ask them. */
  questions: ScriptQuestion[];
}

const SCRIPTS: Record<ProductFamily, FamilyScript> = {
  bags: {
    buying: "Mylar bags, pouches, film or rolls",
    questions: [
      "What bag size are you looking for?",
      "What style of Mylar bag do you need: Flat, Standup or which one?",
      "What finish do you prefer: matte, gloss or soft touch?",
      {
        ask: "What quantity are you looking to order for your first run?",
        moq: "Our MOQ is 1000 per size and per design.",
      },
      "How many total designs or SKU's do you have?",
      "Do you want me to add a zipper and tear notch, correct?",
      "Do you have any specific material or special features in mind?",
    ],
  },
  boxes: {
    buying: "boxes of any kind — rigid, corrugated, folding carton, mailers",
    questions: [
      "What box size are you looking for?",
      "What style of box do you need or can you share a reference image?",
      "What finish do you prefer: matte, gloss or soft touch?",
      {
        ask: "What quantity are you looking to order for your first run?",
        moq: "Our MOQ is 1000 per size and per design.",
      },
      "How many total designs or SKU's do you have?",
      "Do you have any specific material or special features in mind?",
    ],
  },
  labels: {
    buying: "labels, stickers or decals",
    questions: [
      "What label size are you looking for?",
      "What finish do you prefer: matte, gloss or soft touch?",
      {
        ask: "What quantity are you looking to order for your first run?",
        moq: "Our MOQ is 1000 per size and per design.",
      },
      "How many total designs or SKU's do you have?",
      "Do you have any specific material or special features in mind?",
    ],
  },
};

/**
 * The whole script, as the model reads it.
 *
 * All three are given every time rather than the one a guess picked, because
 * which one applies is a judgement about the conversation and the model is
 * holding the conversation. It also means a customer who turns out to want
 * something else halfway through simply moves to the other list, which the old
 * sort could not do — the family was decided on turn one and never revisited.
 */
export function describeScripts(options: { stateMoq?: boolean } = {}): string {
  const blocks = (Object.keys(SCRIPTS) as ProductFamily[]).map((family) => {
    const script = SCRIPTS[family];
    const numbered = script.questions
      .map((question, i) => {
        const text =
          typeof question === "string"
            ? question
            : question.ask + (options.stateMoq ? " " + question.moq : "");
        return `  ${i + 1}. ${text}`;
      })
      .join("\n");
    return `${family.toUpperCase()} — for a customer buying ${script.buying}:\n${numbered}`;
  });

  return blocks.join("\n\n");
}

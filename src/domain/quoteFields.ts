/**
 * What the conversation is trying to find out.
 *
 * These six answers are the whole point of the exchange: the AI keeps writing
 * until it has them, then stops and hands the lead to the rep to price. They
 * are defined once, here, because three separate things depend on agreeing
 * exactly what "complete" means — the extractor reading replies, the composer
 * deciding what to ask next, and the engine deciding when to stop.
 */

export const QUOTE_FIELDS = [
  {
    key: "product",
    label: "Product",
    /** Shown to the model so it knows what a real answer looks like. */
    description:
      "The packaging or print item WE would make: mylar bags, pouches, a folding " +
      "carton, a rigid box, labels, stickers. Never the customer's own product — " +
      "somebody packing burgers needs boxes, and 'burger' is not an answer to " +
      "this. If they have only said what goes inside, leave this null.",
    question: "What product are you looking for?",
  },
  {
    key: "material",
    label: "Material",
    description:
      "Substrate, stock, material, or special features/requirements (e.g. kraft, 350gsm SBS, matte BOPP, corrugated E-flute, waterproof, refrigerator/freezer safe, oil resistant, vinyl, clear). Any material or special feature they mention.",
    question: "What material or stock would you like it in?",
  },
  {
    key: "sizes",
    label: "Sizes",
    description:
      "Dimensions, with units. Any format the customer gives, e.g. 4x6x2 inches, 100x150mm. " +
      "Never a pack count: '2 count', '10 ct', '5-pack' say how many items go inside, not how big " +
      "the bag is — leave sizes null for those.",
    question: "What size do you need? Width x height x depth, in inches or mm.",
  },
  {
    key: "finishes",
    label: "Finishes / Lamination",
    description:
      "Surface finish and embellishment, e.g. matte lamination, gloss, spot UV, foil stamping, embossing, none.",
    question: "What finish would you like — matte or gloss lamination, foil, spot UV, or none?",
  },
  {
    key: "quantity",
    label: "Quantity",
    description:
      "How many units to order, per SKU. A number or a range, e.g. 5000, or 1000-2000. " +
      "Never a pack count: '2 count gummy pouch', '10 ct', '5-pack', '30 capsules per bag' say " +
      "what goes inside each bag, not how many bags — leave quantity null for those.",
    question: "How many units do you need?",
  },
  {
    key: "extras",
    label: "Extras",
    description:
      "Add-ons on a bag — a zipper, a tear notch, a hang hole, a window. 'none' if they do not want any.",
    question: "Do you want me to add a zipper and tear notch?",
  },
  {
    key: "skus",
    label: "Number of SKUs",
    description:
      "How many different designs or variants. Assume 1 unless the customer indicates more than one.",
    question: "How many different designs or SKUs is that across?",
  },
] as const;

export type QuoteFieldKey = (typeof QUOTE_FIELDS)[number]["key"];

/** A field the customer has not answered yet is simply absent. */
export type CollectedFields = Partial<Record<QuoteFieldKey, string>>;

/**
 * SKU count is the one field with a safe default: a customer asking about a
 * single product means one design unless they say otherwise, so never hold up
 * a quote waiting to be told "1".
 */
export const DEFAULTED_FIELDS: Partial<Record<QuoteFieldKey, string>> = {
  skus: "1",
  /**
   * Step five of the bag script, and only the bag script — a box or a label has
   * no zipper to add. Defaulting it means a label conversation is never held up
   * waiting for an answer to a question nobody asked; the bags script puts it
   * back into play deliberately, between quantity and material, where the team
   * asks it.
   */
  extras: "none",
};

/**
 * A value the field reader wrote in place of nothing.
 *
 * Told to leave an unanswered field null, it sometimes writes the word "null",
 * or "not specified", "n/a", "not stated" — 21 of them in one week. Each counts
 * as answered, so its question is never asked: a retail kit enquiry reached its
 * rep with "material: not specified" and nobody had asked. "not sure" (they
 * told us they do not know) and "not given" (we asked twice) are real answers
 * and are not in this list.
 */
export function isPlaceholderValue(value?: string): boolean {
  const text = String(value || "").trim();
  return (
    /^(null|undefined|none specified|not specified|unspecified|n\/?a|not stated|not mentioned|not provided|unknown|tbd)$/i.test(
      text
    ) ||
    isOurOwnMenu(text) ||
    (Boolean(text) && !withoutTemplateBlanks(text))
  );
}

/**
 * A value with the ad's unfilled form taken out.
 *
 * The Facebook and Instagram ads open WhatsApp with "Hi, I need a quote for custom
 * boxes. Qty: __ Size: __", and most people send it as it is. The read recorded
 * `quantity: "Qty: __"` and `sizes: "__"`, the bot took both as answered and never
 * asked, and one chat closed as a complete enquiry with no size and no quantity.
 * The labels and the blanks go; what is left is what they actually typed
 * ("Size: __16"×10"" keeps 16"×10"), and nothing left means nothing was said.
 */
export function withoutTemplateBlanks(value?: string): string {
  return String(value || "")
    .replace(/_{2,}/g, " ")
    .replace(/\b(?:qty|quantity|size|sizes)\s*:/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s.,:;\-–—]+|[\s.,:;\-–—]+$/g, "")
    .trim();
}

/**
 * The list we offered them, recorded as the answer they gave.
 *
 * Asked "boxes, bags, or labels?" a visitor answered "Both", and the read wrote
 * back our own menu: `product: "boxes, bags, or labels"`. That is not a product
 * anybody can quote, and it counts as answered — so the bot never asks again
 * and the rep gets the question printed where the answer belongs.
 *
 * "Any size" and its neighbours are here for the same reason: they are the
 * customer declining to specify, not a dimension, and stored as a size they
 * stop the bot ever asking for a real one.
 */
function isOurOwnMenu(text: string): boolean {
  if (!text) return false;
  return (
    PRODUCT_MENU.test(text) ||
    FINISH_MENU.test(text) ||
    /^(?:any|any of them|whatever|anything|either|both|all of them|no preference|doesn'?t matter)(?:\s+(?:size|sizes|finish|material|one|is fine|works))?$/i.test(
      text
    )
  );
}

/**
 * Two or more of our own options, listed the way we list them.
 *
 * The separator has to cover every way the question is written — "boxes, bags,
 * or labels" and "matte, gloss or soft touch" are the same list with and
 * without the comma before "or", and only one of them was being caught.
 */
function menuOf(items: string): RegExp {
  const between = "(?:\\s*[,/]\\s*(?:or\\s+)?|\\s+or\\s+)";
  return new RegExp(`^(?:${items})(?:${between}(?:${items}))+$`, "i");
}

const PRODUCT_MENU = menuOf("boxes|bags|labels|pouches|stickers");
const FINISH_MENU = menuOf("matte|gloss|soft ?touch");

/**
 * A field value that is the customer's own question, copied in as an answer.
 *
 * Asked for a box size, a visitor wrote "What is a standard package size", and
 * that was recorded as the size. A size on file is one the bot is told never to
 * ask for again — and the rep would have been handed a question where the
 * dimensions belong.
 */
export function isAQuestionNotAnAnswer(value?: string): boolean {
  const text = String(value || "").trim();
  return (
    /\?\s*$/.test(text) ||
    /^(what|what's|whats|how|which|where|when|why|who|is|are|do|does|did|can|could|would|will|should)(?!\s+not\b)\s+\S+\s+\S+/i.test(
      text
    )
  );
}

export function missingFields(collected: CollectedFields): QuoteFieldKey[] {
  return QUOTE_FIELDS.map((field) => field.key).filter((key) => {
    const value = collected[key];
    if (value && value.trim()) return false;
    // A defaulted field counts as answered even when nobody said it.
    return !DEFAULTED_FIELDS[key];
  });
}

export function isComplete(collected: CollectedFields): boolean {
  return missingFields(collected).length === 0;
}

/** The collected answers with defaults filled in — what the rep is handed. */
export function withDefaults(collected: CollectedFields): CollectedFields {
  return { ...DEFAULTED_FIELDS, ...collected };
}

export function fieldByKey(key: QuoteFieldKey) {
  return QUOTE_FIELDS.find((field) => field.key === key)!;
}

const NUMBER_WORDS: Record<string, string> = {
  one: "1",
  two: "2",
  three: "3",
  four: "4",
  five: "5",
  six: "6",
  seven: "7",
  eight: "8",
  nine: "9",
  ten: "10",
  single: "1",
};

/** The designs/SKU question, however the writer phrased it that turn. */
const ASKED_THE_DESIGNS_QUESTION =
  /\b(?:how many|number of)\b[^?]{0,40}\b(?:designs?|sku'?s?|artworks?|variants?)\b/i;

/**
 * A bare number that answers the designs question and nothing else.
 *
 * Asked "How many total designs or SKUs do you have?", a customer answered "1"
 * and the read filed it as the order quantity — so somebody who had never named
 * a quantity was told mid-script that their order was under our minimum. There
 * was nothing for them to say back to that, because they had not asked for
 * anything.
 *
 * Four digits are left alone: "1000" in answer to the designs question is
 * somebody giving a quantity early, not a thousand artworks.
 */
export function isDesignCountAnswer(lastAsked: string, lastBotText: string, typed: string): boolean {
  if (!/^\s*\d{1,3}\s*$/.test(String(typed || ""))) return false;
  return lastAsked === "skus" || ASKED_THE_DESIGNS_QUESTION.test(String(lastBotText || ""));
}

/**
 * Extracts number of designs or SKUs mentioned in visitor text.
 * E.g., "having 2 designs", "with 2 designs", "3 skus", "single design" -> "2", "3", "1".
 */
export function extractSkusInText(text: string): string | null {
  if (!text) return null;
  const str = String(text).trim();

  const match = str.match(
    /\b(\d+|one|two|three|four|five|six|seven|eight|nine|ten|single)\s*(?:total\s*)?(?:different\s*)?(?:designs?|skus?|artworks?|variants?|versions?)\b/i
  );
  if (match) {
    const raw = match[1].toLowerCase();
    return NUMBER_WORDS[raw] || raw;
  }

  const colonMatch = str.match(/\b(?:designs?|skus?)\s*[:=]\s*(\d+)/i);
  if (colonMatch) {
    return colonMatch[1];
  }

  const justMatch = str.match(/\b(?:only|just)\s+(\d+|one)\s+design/i);
  if (justMatch) {
    const raw = justMatch[1].toLowerCase();
    return NUMBER_WORDS[raw] || raw;
  }

  return null;
}


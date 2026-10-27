/**
 * Whether a size can be read by the person who has to quote it.
 *
 * "50x30" is a label in millimetres and a box in inches, and the difference is
 * the whole price. Customers give a size that way constantly — the numbers are
 * obvious to them because they are looking at the thing — and both bots took it
 * down as an answer and moved on, which is how a lead reaches a rep with a size
 * on it that nobody can use.
 *
 * Deliberately a plain check rather than something the model is asked to judge:
 * it decides whether one extra question gets asked, and a model that is unsure
 * about it lets the bad size through, which is the failure we are here for.
 */

/**
 * Anything that says what the numbers mean.
 *
 * The boundary is "not a letter" on either side rather than \b, because a unit
 * is written straight onto the number as often as not — 50x30mm has no word
 * boundary in front of the mm, and requiring one made the check call every
 * properly-given size unitless. Letters on either side still rule it out, so
 * "cmyk" is not centimetres and "milk" is not mils.
 *
 * Capacities count. Someone asking for a 12oz pouch or a 500ml bottle label has
 * said something a rep can work from, even though it is not a dimension.
 *
 * Written out in full as well as abbreviated, which is how people actually
 * type them. The abbreviations were here and the words were not, so a customer
 * who opened with "custom Mylar bags. Big enough to hold 28 grams of product"
 * was asked "Is 28 grams a size in inches, cm, or mm?" — grams is a unit, it is
 * simply not a length. That reply also cost him his real question, because the
 * unit rule tells the writer to ask that and nothing else.
 */
const UNIT_WORD =
  /(?<![a-z])(mm|millimet(?:er|re)s?|cm|centimet(?:er|re)s?|mtr|met(?:er|re)s?|m|in|inch|inches|ft|feet|foot|yd|yards?|oz|ounces?|ml|millilit(?:er|re)s?|l|ltr|lit(?:er|re)s?|g|gm|grams?|grammes?|kg|kilos?|kilograms?|gsm|gallons?|lb|lbs|pounds?|pt|pints?|qt|quarts?|micron|microns|mil)(?![a-z])/i;

/** The inch and foot marks, in the several quotes a keyboard produces. */
const UNIT_MARK = /["”″'’]/;

/** A paper size names itself. Asking whether A4 is in millimetres is absurd. */
const NAMED_SIZE = /^\s*(a\d|b\d|letter|legal|tabloid)\b/i;

/** A value that is only numbers — no unit anywhere in it. */
export function sizeMissingUnit(value?: string): boolean {
  const size = String(value || "").trim();
  if (!size) return false;

  // No digits at all is not a measurement: "same as the sample", "small window".
  // There is nothing to put a unit on, so nothing to ask about.
  if (!/\d/.test(size)) return false;

  if (NAMED_SIZE.test(size)) return false;

  return !UNIT_WORD.test(size) && !UNIT_MARK.test(size);
}

/** Products whose sizes are written in different units by convention. */
const A_LABEL = /\b(label|sticker|decal)/i;
const A_BANNER = /\b(banner|pull[- ]?up|roll[- ]?up|pop[- ]?up|retractable|backdrop|x[- ]?stand|step and repeat)/i;

/** How an assumed unit is marked, so a rep can see it was not their word. */
export const ASSUMED = "(assumed)";

/**
 * The unit a size was almost certainly meant in.
 *
 * Asking is the safe answer and a poor one: it spends a message of the
 * customer's patience on something the numbers already say. A 50x30 label is
 * millimetres — 50 inches is a poster — and a 10x8x4 box is inches, because a
 * 10mm box holds nothing. The rule is the size of the numbers, read against
 * what they are buying, and the company sells from Houston, so inches is the
 * default where both readings are possible.
 *
 * The guess is written onto the size marked `(assumed)`, never presented as
 * something they said. The bot says which way it took it, so anybody who meant
 * the other one can correct it in a word, and the rep quoting it can see the
 * assumption rather than inheriting it silently.
 *
 * Empty when there is nothing to go on, and that is still worth asking about.
 */
export function guessUnit(value?: string, product?: string): string {
  const size = String(value || "").trim();
  if (!sizeMissingUnit(size)) return "";

  const numbers = (size.match(/\d+(?:\.\d+)?/g) || []).map(Number).filter((n) => n > 0);
  if (!numbers.length) return "";

  const biggest = Math.max(...numbers);
  const what = String(product || "");

  // A banner is quoted in feet at the sizes people ask for — a 3x6 banner is
  // not three inches — and in inches once the numbers are pull-up sized.
  if (A_BANNER.test(what) || A_BANNER.test(size)) return biggest <= 12 ? "ft" : "inches";

  // Labels run small, so the number that means millimetres is lower for them:
  // a 50x30 label is mm, a 50x30 box would be cm or mm and is not an inch box.
  return biggest >= (A_LABEL.test(what) || A_LABEL.test(size) ? 20 : 30) ? "mm" : "inches";
}

const MEASUREMENT = String.raw`\d+(?:\.\d+)?\s*(?:["”″]|in(?:ch(?:es)?)?\b|mm\b|cm\b)?`;
const JOIN = String.raw`\s*(?:[x×*]|by)\s*`;
/** Two or three measurements joined up — "5x7", "4 x 6 x 2 in", "4 by 6 inches". */
const DIMENSIONS = new RegExp(
  `${MEASUREMENT}${JOIN}${MEASUREMENT}(?:${JOIN}${MEASUREMENT})?(?:\\s*(?:inch(?:es)?|in\\b|mm\\b|cm\\b|["”″]))?`,
  "i"
);

/**
 * The measurements alone, when the read handed back the whole sentence.
 *
 * "5x7, one that can stand on the shelf" went into the size, and the unit we
 * assumed went on the end of it: "Taking that as 5x7, one that can stand on the
 * shelf inches." The words stay in the transcript; the size keeps the numbers.
 * Left as it is when there are no joined-up measurements to keep — a capacity,
 * a labelled size, "same as the sample".
 */
export function tidySize(value?: string): string {
  const size = String(value || "").trim();
  const found = size.match(DIMENSIONS);
  if (!found) return size;

  let kept = found[0].trim();
  const leftover = withoutAssumedMark(size.replace(found[0], " "));
  if (!leftover.replace(/[\s,.;:()-]+/g, "")) return size;

  // A unit left behind in the words — "…on the shelf inches (assumed)" — comes with it.
  if (!UNIT_WORD.test(kept)) {
    const unit = leftover.match(/(?<![a-z])(inches|inch|in|mm|cm|ft|feet)\s*$/i);
    if (unit) kept = `${kept} ${unit[1]}`;
  }
  return `${kept}${unitWasAssumed(size) ? ` ${ASSUMED}` : ""}`;
}

/** The size with a unit we worked out ourselves, marked as ours. */
export function sizeWithAssumedUnit(value: string, unit: string): string {
  return `${String(value || "").trim()} ${unit} ${ASSUMED}`.replace(/\s+/g, " ").trim();
}

/** A size carrying a unit we assumed rather than one they gave. */
export function unitWasAssumed(value?: string): boolean {
  return String(value || "").includes(ASSUMED);
}

/** The same size without the marker, which is how the reader hands it back. */
export function withoutAssumedMark(value?: string): string {
  return String(value || "")
    .replace(new RegExp(`\\s*${ASSUMED.replace(/[()]/g, "\\$&")}`, "g"), "")
    .trim();
}

/**
 * Their correction to a unit we assumed: "no, mm" replaces it outright.
 *
 * Without this the size keeps the guess — the value is no longer missing a
 * unit, so the answer that would have been appended has nowhere to go.
 */
export function withCorrectedUnit(value: string, unit: string): string {
  return withoutAssumedMark(value).replace(UNIT_WORD, unit).trim();
}

/**
 * The unit, when a message is nothing but a unit.
 *
 * The answer to "is that inches, cm or mm?". Put onto the size in code: the
 * model's read often left the size as it was, and a label chat reached its rep
 * as "50x30" after the customer had said "mm".
 */
export function unitAnswer(text?: string): string {
  const match = String(text || "")
    .trim()
    .match(/^(mm|cm|in|inch|inches|millimet(?:er|re)s?|centimet(?:er|re)s?|ft|feet)\s*[.!]?$/i);
  return match ? match[1].toLowerCase() : "";
}

/**
 * A "size" that names nothing a rep could measure.
 *
 * Asked "What is a standard package size", gpt-4o-mini recorded the size as
 * "standard package size" — in all three test runs. A size with no numbers in
 * it can still be an answer ("same as the sample"), but one that talks about
 * what is standard or typical is the customer's own question wearing the
 * clothes of a value.
 */
export function sizeIsNotASize(value?: string): boolean {
  const size = String(value || "").trim();
  if (!size || /\d/.test(size)) return false;
  if (NAMED_SIZE.test(size)) return false;
  return /\b(standard|typical|usual|average|recommend(?:ed|ation)?|normal|common)\b/i.test(size);
}

/**
 * A "size" that is how many go inside: "2 count", "10 ct", "5-pack", "30 per bag".
 *
 * "I need 2 count Gummy pouch" was recorded as the size, the unit guess made it
 * "2 count inches", and with a size on file the real one was never asked for —
 * the chat went to the name question with nothing to price. A value with the
 * measurements joined up ("4x6, 2 count") still has a size in it and is kept.
 */
export function sizeIsAPackCount(value?: string): boolean {
  const size = withoutAssumedMark(String(value || "")).trim();
  if (!size || /\d\s*(?:["”″]\s*)?(?:[x×*]|by)\s*\d/i.test(size)) return false;
  return /\b\d+\s*[- ]?\s*(?:count|ct|pack|pk|pcs?|pieces?|per\s+(?:bag|pouch|pack)|in\s+(?:each|a|one)\b)/i.test(size);
}

/**
 * A "size" that is really the quantity.
 *
 * The field reader copied "1000 per size/design" into both quantity and size.
 * As a size it is numbers with no unit, so the bot asked whether it was inches,
 * cm or mm before the customer had given a size at all, and the lead reached a
 * rep with a quantity where the size belongs. A value with a dimension or a unit
 * in it is left alone; one that matches the quantity, or counts units and
 * pieces, is not a size.
 */
export function sizeIsReallyAQuantity(sizes?: string, quantity?: string): boolean {
  const size = String(sizes || "").trim();
  if (!size) return false;
  if (/\d\s*(x|×|\*|by)\s*\d/i.test(size) || UNIT_WORD.test(size) || UNIT_MARK.test(size)) return false;

  const normal = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();
  if (quantity && normal(size) === normal(quantity)) return true;

  // Nothing but large bare numbers — "2000, 5000, and 10000", typed in answer
  // to another question — is a run of quantities. Nothing we make is sized in
  // the hundreds or thousands with no unit and no "x".
  const numbers = (size.match(/\d[\d,]*/g) || []).map((n) => Number(n.replace(/,/g, "")));
  if (numbers.length && numbers.every((n) => n >= 250)) return true;

  return /\b(per|units?|pcs|pieces|qty|quantity)\b/i.test(size);
}

/** What customers say goes inside a box, counted rather than measured. */
const GOES_INSIDE =
  /\b(?:cookies?|biscuits?|cupcakes?|muffins?|macarons?|macaroons?|donuts?|doughnuts?|brownies?|pastries|cakes?|chocolates?|truffles?|candies|sweets?|gummies|bottles?|jars?|cans?|tins?|tubes?|vials?|capsules?|tablets?|bars?|soaps?|candles?|eggs?|slices?|sachets?|tea ?bags?|pods?|servings?|portions?|cigars?|pens?)\b/i;

/**
 * A "size" that is how many fit inside, not how big the box is.
 *
 * "custom cookie boxes to fit 6, 12 and 24 cookies" is three variants of a box,
 * described the only way the customer can describe them — they know what goes
 * in, not what it measures. Every existing guard let it through: sizeIsNotASize
 * gives up the moment there is a digit, and sizeIsReallyAQuantity wants "per",
 * "units" or numbers in the hundreds. So it came back as a size with no unit,
 * and the next question would have asked whether six cookies is inches, cm or
 * mm.
 *
 * A real size is left alone whatever else is in it: "4 inches tall, fits 12
 * cookies" has a unit, so it is a size and not this.
 */
export function sizeIsACapacity(value?: string): boolean {
  const size = String(value || "").trim();
  if (!size || !/\d/.test(size)) return false;
  if (/\d\s*(x|×|\*|by)\s*\d/i.test(size) || UNIT_WORD.test(size) || UNIT_MARK.test(size)) return false;
  return GOES_INSIDE.test(size);
}

/**
 * Whether we have already put the question.
 *
 * The bound on asking. An answer of "mm" does not always come back written into
 * the size — the extractor may leave the field as it was — so without this the
 * bot would ask which unit it is for the rest of the conversation.
 */
export function alreadyAskedTheUnit(botMessages: string[]): boolean {
  return botMessages.some((text) => /\b(inch|inches|cm|mm|centimet|millimet)\b/i.test(text));
}

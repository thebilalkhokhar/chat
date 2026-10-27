/**
 * Whether the bot is asking what it just asked.
 *
 * "Never send a sentence you have already sent" has been in the prompt all
 * along, and in one week 101 of 360 chats had a bot question sharing most of its
 * words with one it had already put. The worst read like a loop: a customer
 * answered "2000, 5000, and 10000", then "1000", then "yes", and was asked for
 * her first-run quantity after every one; answered "yes complete kit" and got
 * the same kit question again word for word.
 *
 * Measured on the question itself — the sentences with a question mark — by the
 * share of meaningful words the two have in common. The acknowledgement in front
 * changes every time ("Great, thank you." / "Perfect, thanks.") and says nothing
 * about whether the question moved on.
 */

const FILLER = new Set(
  (
    "the you your are for and what that this with looking thank thanks great got perfect just can could " +
    "would will like want need have has any please our out about into from them they its is was be to " +
    "of in on a an or do does sure okay also"
  ).split(" ")
);

function contentWords(text: string): Set<string> {
  return new Set(
    String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length > 2 && !FILLER.has(word))
  );
}

/**
 * A sentence ends at . ! or ? followed by a capital or a digit — not at "U.S."
 * in the middle of "shipping terms to the U.S. would you prefer", which split
 * one question into a statement and half a question.
 */
export const SENTENCE_BREAK = /(?<=[.!?])\s+(?=[A-Z0-9"“‘'])/;

const OPENS_A_QUESTION = /^\s*(?:what|which|how|where|when|why|who|do|does|did|can|could|would|will|should|is|are|may)\b/i;

/**
 * A sentence that asks something — with a question mark, or opening like a
 * question without one: "What style of box do you need for the kit, or please
 * share a reference image. Do you have any specific material…?" is two.
 */
export function isQuestionSentence(sentence: string): boolean {
  const text = String(sentence || "").trim();
  return /\?\s*$/.test(text) || OPENS_A_QUESTION.test(text);
}

export function questionSentences(text: string): string[] {
  return String(text || "")
    .split(SENTENCE_BREAK)
    .filter(isQuestionSentence);
}

/** The sentences that ask something. */
export function questionIn(text: string): string {
  return String(text || "")
    .split(SENTENCE_BREAK)
    .filter((sentence) => sentence.includes("?"))
    .join(" ");
}

/**
 * Which details a question asks for, by its own words.
 *
 * The writer labels its question itself, and not always truly: in a replay of
 * chat #4457 it asked "What total quantity and SKUs/designs will you have for
 * the first run?", called it a SKU question, and so asked a third time for a
 * quantity it already had. Only the details whose questions have unmistakable
 * words.
 */
const ASKS_ABOUT: Array<[string, RegExp]> = [
  [
    "quantity",
    /\bquantit(?:y|ies)\b|\bhow many (?:\w+ )?(?:units|pieces|pcs|kits|boxes|bags|pouches|labels|stickers)\b/i,
  ],
  ["sizes", /\bwhat size\b|\bsizes? (?:are|do|would|should|is)\b|\bdimensions\b/i],
  ["finishes", /\bfinish\b/i],
  ["skus", /\bdesigns?\b|\bsku['’]?s?\b/i],
  ["material", /\b(?:material|special features?|stock|substrate)\b/i],
  ["extras", /\b(?:zipper|tear notch|hang hole|window)\b/i],
  ["name", /\b(?:take your name|what(?:'s| is) your name|who am i speaking with|could i have your name)\b/i],
  ["email", /\b(?:email|email address|send the quote to)\b/i],
  ["phone", /\b(?:phone|phone number|number in case)\b/i],
];

export function fieldsAskedAbout(question: string): string[] {
  return ASKS_ABOUT.filter(([, pattern]) => pattern.test(String(question || ""))).map(([key]) => key);
}

/** Shared meaningful words over all meaningful words, 0 to 1. */
export function questionOverlap(a: string, b: string): number {
  const first = contentWords(a);
  const second = contentWords(b);
  if (!first.size || !second.size) return 0;

  let shared = 0;
  first.forEach((word) => {
    if (second.has(word)) shared += 1;
  });
  return shared / (first.size + second.size - shared);
}

/**
 * At or above this, the two ask the same thing in nearly the same words.
 *
 * Set against the real pairs: the #4457 repeats score 0.60 to 1.00, and
 * different questions in the same chats score under 0.2.
 */
export const SAME_QUESTION = 0.6;

export function repeatsTheQuestion(reply: string, earlier: string): boolean {
  if (questionOverlap(questionIn(reply), questionIn(earlier)) >= SAME_QUESTION) return true;

  // Or both ask for the same detail. "How many total designs or SKUs do you
  // have?" came back seven times in one chat, reworded each time — "Since you'll
  // have separate designs for each SKU, how many total designs or SKUs…?" — and
  // the shared-words count never reached the threshold because the padding in
  // front of it kept changing.
  const asked = fieldsAskedAbout(questionIn(reply));
  const before = fieldsAskedAbout(questionIn(earlier));
  return asked.length > 0 && asked.some((key) => before.includes(key));
}

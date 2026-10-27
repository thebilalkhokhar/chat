/**
 * The questions customers actually ask, and what a reply owes them.
 *
 * Measured on four days of live chats: 62 visitor questions, and 30 of them got
 * no answer at all — an acknowledgement and the next question off the script.
 *
 *   "How much does the 1000 pieces cost?"  ->  "…our minimum is 1000 per size…"
 *   "how quickly could you ship them out"  ->  "Got it. What box size are you looking for?"
 *   "I have my own design how much for 1000" -> "How many total designs or SKU's do you have?"
 *
 * The company facts cover the minimum, the turnaround, the address and payment.
 * These are the ones the facts cannot answer, where the honest reply is still
 * not silence: a price is a rep's to give, and it comes with the quote.
 */

/** Asking what it costs. */
const ABOUT_PRICE =
  /\b(how much|what.{0,12}(cost|price)|pricing|price|cost|quote for|per unit|unit price|rate|rates|budget|cheap(er|est)?|discount)\b/i;

/** A reply that deals with it: pricing comes with the quote, and no figure is invented. */
const ANSWERS_PRICE = /\b(quote|pricing|price)\b/i;

export function asksAboutPrice(text: string): boolean {
  return ABOUT_PRICE.test(String(text || ""));
}

export function answersAboutPrice(reply: string): boolean {
  return ANSWERS_PRICE.test(String(reply || ""));
}

/** What to say when they ask a price. The rep prices it; the quote carries it. */
export const PRICING_COMES_WITH_THE_QUOTE =
  "I can't price it here — your quote will carry the pricing.";

/**
 * Somebody's own question, asked back at them.
 *
 * "Do each of those finishes cost extra? What is the 'standard' finish" was
 * answered with "Great question. What is the standard finish for our boxes, and
 * do matte, gloss, or soft touch finishes cost extra?".
 */
export function parrotsTheirQuestion(reply: string, theirs: string): boolean {
  /**
   * Word for word, which the share-of-words test below cannot see.
   *
   * It ignores words of three letters or fewer and gives up on anything with
   * less than three long words left, so a short question can never trip it —
   * and "Do y'all do designing?" has exactly one. That question was handed
   * straight back to the customer who asked it.
   */
  const plain = (text: string) =>
    String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  if (plain(reply) && plain(reply) === plain(theirs)) return true;

  const words = (text: string) =>
    new Set(
      String(text || "")
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, " ")
        .split(/\s+/)
        .filter((word) => word.length > 3)
    );

  const mine = words(reply);
  const theirWords = words(theirs);
  if (theirWords.size < 3 || mine.size === 0) return false;

  let shared = 0;
  theirWords.forEach((word) => {
    if (mine.has(word)) shared += 1;
  });

  return shared / theirWords.size >= 0.7;
}

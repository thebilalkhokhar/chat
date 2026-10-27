/**
 * Whether the quantity a customer named is one we can actually make.
 *
 * The rule has been in the prompt for days: under a thousand, say so and give
 * the minimum. It is followed most of the time, which is the problem — a
 * customer who says "80" and is told "thanks, I have your details" has been
 * quietly accepted for an order that cannot be produced, and nobody finds out
 * until a rep reads the lead. "Most of the time" is not a rule, it is a
 * tendency.
 *
 * So the arithmetic happens here, in code, and the writer is told the answer
 * rather than asked to work it out. The same reasoning as the size-unit check:
 * a model that is unsure lets the bad value through, and the bad value is the
 * whole reason the check exists.
 */

import { isBannerFamily } from "./salesScript";

/** Per size and per design. The customer-facing wording lives in the company facts. */
export const MINIMUM_ORDER = 1000;

/**
 * Whether the minimum is a thing for what they are buying at all.
 *
 * Banners have none — the team makes one, two or more — so a quantity of 1 is
 * an order, not a number to push back on.
 */
export function minimumApplies(product?: string): boolean {
  return !isBannerFamily(product);
}

const WORD_QUANTITIES: Record<string, number> = {
  single: 1,
  one: 1,
  two: 2,
  couple: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

const UNITS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, couple: 2, few: 3,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

/**
 * A quantity written in words — "fifty", "two hundred", "fifteen hundred",
 * "twenty five thousand" — or null.
 *
 * Only a run with a tens word, "hundred" or "thousand" in it: "one" and "two"
 * on their own are left to the rules below, which know "one design" from "one
 * box".
 */
function spelledNumberIn(text: string): number | null {
  const words = text.toLowerCase().replace(/-/g, " ").split(/[^a-z]+/).filter(Boolean);
  let best: number | null = null;

  for (let i = 0; i < words.length; i++) {
    let total = 0;
    let current = 0;
    let big = false;
    let used = 0;

    for (let j = i; j < words.length; j++) {
      const w = words[j];
      if (w in UNITS) current += UNITS[w];
      else if (w in TENS) {
        current += TENS[w];
        big = true;
      } else if (w === "hundred") {
        current = (current || 1) * 100;
        big = true;
      } else if (w === "thousand") {
        total += (current || 1) * 1000;
        current = 0;
        big = true;
      } else if (w === "and" && used > 0) continue;
      else if ((w === "a" || w === "an") && used === 0) continue;
      else break;
      used += 1;
    }

    const value = total + current;
    if (used && big && value > 0) best = Math.max(best ?? 0, value);
  }
  return best;
}

/**
 * The number in what they said, or null if there is not one.
 *
 * Deliberately takes the FIRST number in a range: "50-100" is a customer asking
 * whether fifty is possible, and fifty is the number that has to be answered.
 * "2k" is two thousand — people write quantities that way constantly and
 * reading it as two would put a real order in front of the minimum.
 */
export function quantityIn(value?: string): number | null {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return null;

  // Words that specify design count rather than quantity: "one design", "single design"
  if (
    /\b(one|single|two|\d+)\s*(?:designs?|skus?|artworks?|variants?)\b/i.test(text) &&
    !/\b(boxes?|bags?|labels?|pouches?|units?|pcs?|pieces?)\b/i.test(text)
  ) {
    return null;
  }

  // Digits first
  const match = text.match(/(\d[\d,.\s]*)\s*(k\b|thousand\b)?/);
  if (match) {
    let digits = match[1].replace(/[,\s]/g, "");
    // "1.000" and "10.000" are thousands written the European way. Read as a
    // decimal they became 1 and 10, and a customer ordering ten thousand was
    // told they were under the minimum.
    if (!match[2] && /^\d{1,3}(?:\.\d{3})+\.?$/.test(digits)) digits = digits.replace(/\./g, "");
    if (digits && /\d/.test(digits)) {
      const number = Number.parseFloat(digits);
      if (Number.isFinite(number) && number > 0) {
        return match[2] ? Math.round(number * 1000) : Math.round(number);
      }
    }
  }

  // Written out in words: "fifty", "two hundred", "fifteen hundred", "five
  // thousand". "Just fifty to start" read as no quantity at all, so a box
  // customer asking for fifty was never told about the minimum.
  const spelled = spelledNumberIn(text);
  if (spelled !== null) return spelled;

  // Word quantities with thousands: "one thousand", "two thousand", "a couple thousand"
  const thousandWordMatch = text.match(
    /\b(one|two|three|four|five|six|seven|eight|nine|ten|couple|a couple)\s*(?:k\b|thousand\b)/i
  );
  if (thousandWordMatch) {
    const baseWord = thousandWordMatch[1].toLowerCase().replace(/^a\s+/, "");
    const baseNum = WORD_QUANTITIES[baseWord] || 1;
    return baseNum * 1000;
  }

  // Small word quantities: "I only need one", "just single box", "a couple", "only 1", "single"
  const smallWordMatch = text.match(
    /\b(only\s+need\s+(?:one|a\s+single)|just\s+(?:one|a\s+single)|single\s+(?:box|bag|pouch|unit|item)|only\s+(?:one|single)|single|one)\b/i
  );
  if (smallWordMatch) {
    if (!/\b(thousand|design|sku)\b/i.test(text)) {
      return 1;
    }
  }

  return null;
}

/**
 * A quantity field that came back as a whole sentence.
 *
 * Asked how many she wanted, a customer answered "I like rustic like brown
 * 300" — a preference and a quantity in one breath — and the reader put the
 * entire sentence in the quantity. The rep opens the lead and reads
 * "Quantity: I like rustic like brown 300", which is not a number anybody can
 * price, and the lead sweep cannot compare it to the minimum either.
 *
 * Only when there is exactly one number to keep. "2000, 5000 and 10000" is a
 * customer asking for tiers and every number matters; "1000 per size" and
 * "50 each" already say what they mean and are left alone. Nothing is lost —
 * the sentence they typed stays in the transcript the rep reads underneath.
 */
export function tidyQuantity(value?: string): string {
  const text = String(value || "").trim();
  if (!text) return text;

  // Already just a quantity: digits, separators, and at most a unit word.
  if (/^[\d,.\s\-x×/+]*(?:k|units?|pcs|pieces|boxes|bags|labels|stickers|pouches|each|per\s+\w+)?$/i.test(text)) {
    return text;
  }

  const numbers = text.match(/\d[\d,]*(?:\.\d+)?\s*k?\b/gi) || [];
  if (numbers.length !== 1) return text;

  const kept = numbers[0].trim();
  const unit = new RegExp(`${kept.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*(units?|pcs|pieces|boxes|bags|labels|stickers|pouches|each)\\b`, "i").exec(text);
  return unit ? `${kept} ${unit[1]}` : kept;
}

/**
 * The quantity on file is a pack count, not an order.
 *
 * "i need 2 count gummy pouch" is a pouch that holds two gummies. The read put
 * 2 in the quantity, and the chat was priced at two bags — $56 each — before
 * anybody had asked how many they wanted. True when every time they wrote that
 * number it was as a count of what goes inside: "2 count", "10 ct", "5-pack",
 * "30 per bag". Once they give it as an order — "2000 pouches", or the number on
 * its own — it is theirs again.
 */
export function quantityIsAPackCount(quantity: string | undefined, visitorSaid: string[]): boolean {
  const n = quantityIn(quantity);
  if (n === null) return false;

  // Not inside a word or an address: "e2e.customer@…" has a 2 in it that is
  // nobody's quantity, and counting it made "2 count" look like an order.
  const number = `(?<![\\w.,@])${n}(?![\\d.,]|\\s*k\\b)`;
  visitorSaid = visitorSaid.map((text) => String(text).replace(/\S+@\S+/g, " "));
  const asPack = new RegExp(
    `${number}\\s*-?\\s*(?:count|ct\\b|pack\\b|pk\\b|pc\\s+pack|pieces?\\s+(?:per|in\\s+each|each)|per\\s+(?:bag|pouch|pack))`,
    "i"
  );
  const anywhere = new RegExp(number, "g");

  let packs = 0;
  let mentions = 0;
  for (const text of visitorSaid) {
    mentions += (String(text).match(anywhere) || []).length;
    packs += (String(text).match(new RegExp(asPack.source, "gi")) || []).length;
  }
  return packs > 0 && packs === mentions;
}

/** A quantity we cannot take, and therefore one that has to be answered. */
export function belowMinimum(value?: string): boolean {
  const quantity = quantityIn(value);
  return quantity !== null && quantity < MINIMUM_ORDER;
}

/** A message that puts the minimum to them. */
const STATES_THE_MINIMUM = /\bmoq\b|\bminimum\b|\b1,?000 per\b/i;

/**
 * Whether the minimum has already been put to them.
 *
 * The bound on saying it. Once told, a customer who carries on with a smaller
 * number has heard the answer and is deciding — repeating it every turn is
 * haggling, and the team does not haggle in the chat window.
 */
export function minimumAlreadyStated(botMessages: string[]): boolean {
  return botMessages.some((text) => STATES_THE_MINIMUM.test(text));
}

/** Asking for the smaller run in words rather than in a number. */
const WANTS_LESS =
  /\b(?:smaller|less|lesser|lower|fewer|reduce[d]?|not that many|too many|under (?:the )?(?:minimum|moq|1,?000)|below (?:the )?(?:minimum|moq|1,?000))\b|\bcan(?:'|’)?t (?:do|afford|manage) (?:that|1,?000)\b/i;

/** A message that is essentially just a number: "200", "just 200", "200 please". */
const BARE_QUANTITY = /^[^a-z]*(?:just|only|still|about|around)?\s*[\d,.\s]+\s*(?:pcs|pieces|units|boxes|bags|labels|stickers|pouches)?[^a-z]*$/i;

/**
 * Their answer to the minimum, when the answer is "the smaller run please".
 *
 * Only ever consulted on the turn after we have put the minimum to them, which
 * is what makes it safe to read a bare number as a quantity — at any other
 * point in the chat "5" is a size, a design count or a floor number.
 *
 * "yes smaller" is the whole reason this exists. Asked whether they wanted to
 * go ahead at a thousand or have us look at the smaller run, a customer
 * answered exactly that and was asked about materials instead: the one question
 * they had answered went nowhere, and the thing the team would have made an
 * exception for never reached a rep.
 */
export function wantsSmallerRun(text: string): boolean {
  const said = String(text || "").trim();
  if (!said) return false;
  if (WANTS_LESS.test(said)) return true;
  return BARE_QUANTITY.test(said) && belowMinimum(said);
}

/**
 * A question the minimum can be answered with a plain yes or no.
 *
 * "...the minimum is 1000 per size and per design — would that work for you?"
 * is one. The either/or version — "go ahead at 1000, or shall I look at a
 * smaller run?" — is not: "yes" against that means nothing, so it is excluded
 * by the bare `or` and the answer is left unread rather than guessed at.
 */
const ASKS_IF_THE_MINIMUM_WORKS =
  /\b(?:would|does|will)\b[^?]{0,40}\bwork\b|\bwork(?:s)? for you\b|\bis that (?:ok|okay|fine|alright|workable)\b|\bare you (?:ok|okay|fine) with\b|\bhappy with that\b|\bcan you (?:do|manage) that\b/i;

const BARE_YES =
  /^\s*(?:yes|yeah|yep|yup|sure|ok(?:ay)?|fine|perfect|great|agreed|that works|works for me|sounds good|go ahead|let'?s do it|no problem)\b[\s.!,]*$/i;

const BARE_NO =
  /^\s*(?:no|nope|nah|not really|afraid not|unfortunately not|that'?s? too (?:many|much)|too many|too much)\b[\s.!,]*$/i;

/** What they did with the minimum once it was put to them. */
export type MinimumAnswer = "smaller" | "minimum" | null;

/**
 * Their answer to the minimum, read against the question that drew it.
 *
 * A bare "no" is the whole reason this takes the question as well as the reply.
 * Told "the minimum is 1000 per size and per design — would that work for
 * you?", a customer who says "no" has asked for the smaller run as plainly as
 * one who says "yes smaller", and a customer who says "yes" has just agreed to
 * order a thousand — which has to reach the quantity, or a rep prices the two
 * hundred they opened with.
 *
 * Null where it is genuinely ambiguous. Nothing is guessed: an unread answer
 * costs a turn, and a wrong one puts a number on the lead nobody said.
 */
export function answerToTheMinimum(theirReply: string, ourQuestion: string): MinimumAnswer {
  const said = String(theirReply || "").trim();
  if (!said) return null;

  if (wantsSmallerRun(said)) return "smaller";

  const named = quantityIn(said);
  if (named !== null && named >= MINIMUM_ORDER) return "minimum";

  const question = String(ourQuestion || "");
  const answerable =
    STATES_THE_MINIMUM.test(question) && ASKS_IF_THE_MINIMUM_WORKS.test(question) && !/\bor\b/i.test(question);
  if (!answerable) return null;

  if (BARE_YES.test(said)) return "minimum";
  if (BARE_NO.test(said)) return "smaller";
  return null;
}

/**
 * They have been told the minimum and asked to go under it anyway.
 *
 * Read from the transcript rather than kept as a flag, so it is true of chats
 * that happened before this existed and so nothing has to be migrated. Only
 * what they said AFTER we said it counts: the low number that started the whole
 * exchange is not them insisting, it is them not knowing yet.
 *
 * The last answer wins. Somebody who asks for the smaller run and then settles
 * for a thousand is not a decision waiting on a rep any more, and a lead that
 * says otherwise sends them chasing an exception nobody needs.
 */
export function askedToGoBelowMinimum(messages: Array<{ fromUs: boolean; text: string }>): boolean {
  const stated = messages.findIndex((message) => message.fromUs && STATES_THE_MINIMUM.test(message.text));
  if (stated === -1) return false;

  let standing: MinimumAnswer = null;
  for (let at = stated + 1; at < messages.length; at += 1) {
    if (messages[at].fromUs) continue;
    const asked = [...messages.slice(0, at)].reverse().find((message) => message.fromUs)?.text || "";
    const answer = answerToTheMinimum(messages[at].text, asked);
    if (answer) standing = answer;
  }

  return standing === "smaller";
}

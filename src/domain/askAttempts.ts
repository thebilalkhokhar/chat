import { type ContactFieldKey } from "./contactFields";

/**
 * Deciding whether asking for something again is fair.
 *
 * The bot gives up on a detail after two attempts, and for a while it counted an
 * attempt the moment a question went out. That measured how often the bot spoke,
 * not how often the visitor declined to say — so in one chat the email question
 * was spent on a mistyped "ocated" and on a turn where the visitor broke off to
 * ask where the company was, and it never asked a third time. The enquiry behind
 * it was complete: Pillow Pouch, PET + White PE, 5x6, softtouch, 25,000 units.
 * It reached nobody, because a chat with no email and no phone was invisible to
 * the sweep that writes leads up.
 *
 * An attempt is spent when the visitor had a go and we still do not have it.
 */

/** Give up on a detail after this many spent attempts and move on. */
export const MAX_ASKS = 2;

/**
 * A message that is asking us something rather than answering us.
 *
 * That turn is spent giving them an answer, so it is not a failed attempt at
 * ours.
 */
const IS_A_QUESTION =
  /\?\s*$|^\s*(where|what|who|when|why|how|which|is|are|do|does|did|can|could|would|will|should)\b/i;

/**
 * A refusal — for a contact detail only.
 *
 * "no phone no" is a final answer, and asking twice more is rude. Retired on the
 * spot instead.
 *
 * Deliberately not applied to the quote fields, where "no" almost always rejects
 * a suggestion rather than the question: one chat opened "a Stand Up Pouch or a
 * Flat Bottom Bag?" and the visitor answered "no", meaning neither of those.
 */
const DECLINES =
  /^\s*(no|nope|nah|none|not now|later|skip|maybe later|n\/a|na)\b|\b(no|dont|don't|do not|haven't|havent|not|wont|won't) (have |got |a |give |share )?(phone|email|number|e-mail|mail|cell)\b|\bprefer not\b|\brather not\b|\b(?:reach|contact|email|message|write|call)(?:\s+(?:me|out))?\s+(?:on|by|via|through)\s+(?:email|mail|phone|number)\b|\b(?:just|only|use)\s+(?:email|mail|phone|number)\b|\b(?:email|mail|phone)\s+(?:only|please|is fine|is enough|instead)\b/i;

export const CONTACT_KEYS = ["name", "email", "phone"] as const;

export function isContactKey(key: string): key is ContactFieldKey {
  return (CONTACT_KEYS as readonly string[]).includes(key);
}

export type AskOutcome =
  /** They tried, or did not engage with it, and we still do not have it. */
  | "spent"
  /** Answered, or the turn went on something else. Costs nothing. */
  | "free"
  /** They said no. Stop asking. */
  | "declined";

/**
 * Words indicating the visitor is discussing or updating a job specification
 * (finish, size, quantity, material, product, etc.) rather than answering a contact question.
 */
const SPEC_WORDS =
  /\b(matte|gloss|soft\s*touch|finish|cheaper|cheapest|economical|cost[-\s]?effective|lowest\s*cost|inches|cm|mm|size|dimension|depth|height|width|x\s*\d|\d+\s*x|qty|quantity|pcs|pieces|units|boxes|bags|pouches|labels|stickers|cardboard|corrugated|rigid|kraft|foil|mylar|material|paper|coating|laminate|laminated)\b/i;

/**
 * "Please send it to my email" — a refusal of everything except the email.
 *
 * Asked for a phone number, a customer said exactly that and was asked for it
 * again in the next breath; she answered by pasting her email address a second
 * time. Not applied when the email is what we asked for, where it is a
 * preference and not a no.
 */
const PREFERS_EMAIL =
  /\b(?:send|share|forward|mail)\b[^.?!]{0,25}\b(?:to\s+)?(?:my\s+|the\s+)?e-?mail\b|\b(?:communicate|talk|deal|correspond)\b[^.?!]{0,20}\b(?:through|via|by|over|on)\s+(?:the\s+)?e-?mail\b/i;

export function askOutcome(lastAsked: string, text: string, haveItNow: boolean): AskOutcome {
  if (haveItNow) return "free";
  if (isContactKey(lastAsked)) {
    if (DECLINES.test(text)) return "declined";
    if (lastAsked !== "email" && PREFERS_EMAIL.test(text)) return "declined";
    if (SPEC_WORDS.test(text)) return "free";
  }
  return IS_A_QUESTION.test(text) || visitorIsAsking(text) ? "free" : "spent";
}

/**
 * Whether their message asks us something, anywhere in it.
 *
 * Wider than IS_A_QUESTION, which only has to tell an answer from a question. A
 * long enquiry lists what it wants to know in the middle — "please confirm: Can
 * you produce and assemble the complete kit in-house? ... Minimum order quantity
 * ... production lead time" — and none of it was answered, not even the minimum
 * and the turnaround, which are written answers.
 */
const ASKS_US =
  /\?|\b(please (confirm|advise|let me know|share|send)|can you|could you|do you|does your|are you able|is it possible|what is your|what's your|what are your|how long|how much|how soon|how fast|let me know|i'?d like to know|wondering)\b/i;

export function visitorIsAsking(text: string): boolean {
  const message = String(text || "");
  // And any sentence that opens as a question, with or without the mark:
  // "What is a standard package size" was taken for an answer to our size
  // question, and stored as the size.
  return ASKS_US.test(message) || message.split(/(?<=[.!?])\s+|\n+/).some((sentence) => IS_A_QUESTION.test(sentence));
}

/**
 * They are asking what is usual, not telling us what they want.
 *
 * "What is a standard package size" is a question about the size, and answering
 * it with "What size are you looking for?" ignores what they asked. There is no
 * standard — everything is made to fit what goes inside — and that is the
 * answer they are owed before the question comes back to them.
 */
const ASKS_WHAT_IS_USUAL =
  /\b(standard|typical|usual|common|average|normal)\b|\b(?:what\s+do\s+you\s+|what\s+would\s+you\s+|can\s+you\s+)?(recommend|suggest)\b/i;

const NOT_SPEC_RECOMMENDATION = /\b(someone|somebody|person|contact|rep|who|who\s+to|manager|call)\b/i;

export function asksWhatIsUsual(text: string): boolean {
  const str = String(text || "");
  if (!visitorIsAsking(str)) return false;
  if (NOT_SPEC_RECOMMENDATION.test(str)) return false;
  return ASKS_WHAT_IS_USUAL.test(str);
}

/**
 * They have told us they cannot answer: "no idea", "not sure", "you tell me".
 *
 * Not a question, so `asksWhatIsUsual` never saw it, and on most fields it is a
 * perfectly good answer — a customer with no view on the finish is told what we
 * would use and the rep quotes it. The size is the one field where it is not,
 * because there is no default box: asked what size he wanted, a visitor said
 * "no idea", was answered "Thanks." and the enquiry reached the rep reading
 * "Size: no idea".
 *
 * Anything with a number in it is an answer, not a shrug — "not sure, maybe
 * 4x6" is a size.
 */
const DOES_NOT_KNOW =
  /\b(?:no idea|not sure|unsure|no clue|don'?t know|do not know|dunno|not decided|haven'?t decided|undecided|not yet decided|no preference|you tell me|up to you|your call|whatever you (?:recommend|suggest|think))\b/i;

export function saysTheyDoNotKnow(text: string): boolean {
  const value = String(text || "").trim();
  if (!value || /\d/.test(value)) return false;
  return DOES_NOT_KNOW.test(value);
}

/**
 * A message with nothing in it anybody could act on.
 *
 * "Q as the Ty of" was taken as the product, repeated back — "Got it — Q as the
 * Ty of." — and the chat moved on to ask for an email. No digits, no address,
 * not one word longer than three letters, and most of it two letters or fewer:
 * there is nothing there to record. A question is never this, however short.
 */
export function saysNothingUseful(text: string): boolean {
  const value = String(text || "").trim();
  if (!value || /\d|@/.test(value) || visitorIsAsking(value)) return false;

  const words = value.split(/\s+/).filter(Boolean);
  if (words.length < 3) return false;

  const letters = (word: string) => word.replace(/[^a-z]/gi, "");
  const hasARealWord = words.some((word) => letters(word).length >= 4);
  const mostlyTiny = words.filter((word) => letters(word).length <= 2).length / words.length >= 0.6;

  return !hasARealWord && mostlyTiny;
}

/** The attempt count after one reply. */
export function applyAskOutcome(current: number, outcome: AskOutcome): number {
  if (outcome === "declined") return MAX_ASKS;
  if (outcome === "spent") return current + 1;
  return current;
}

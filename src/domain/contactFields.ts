/**
 * How to reach the person once the chat is over.
 *
 * Kept apart from the quote fields on purpose. Both are things the AI asks for,
 * but they are not the same kind of thing: the quote fields describe the job and
 * are shared with the email side, which already knows who it is writing to. Only
 * a chat starts with an anonymous stranger, so only a chat has to ask.
 *
 * Adding these to QUOTE_FIELDS would have made the email bot ask customers for
 * their own email address, which it already has and is writing to.
 *
 * Asked after the job details, not before. Someone who has just described what
 * they want has a reason to leave their number; someone greeted by a form has
 * not.
 */

export const CONTACT_FIELDS = [
  {
    key: "name",
    label: "Name",
    question: "Could I take your name?",
    description: "The person's own name.",
  },
  {
    key: "email",
    label: "Email",
    question: "What is the best email to send the quote to?",
    description: "An email address to send the quote to.",
  },
  {
    key: "phone",
    label: "Phone",
    question: "And a phone number in case we need to check anything?",
    description: "A contact phone number, in whatever format they give it.",
  },
] as const;

export type ContactFieldKey = (typeof CONTACT_FIELDS)[number]["key"];

export type CollectedContact = Partial<Record<ContactFieldKey, string>>;

/**
 * SalesIQ hands anonymous visitors a placeholder name — "Visitor 365140" — and
 * treating that as an answer means never asking for a real one, then filing a
 * lead a rep cannot address.
 */
export function isPlaceholderName(name?: string): boolean {
  const value = String(name || "").trim();
  if (!value) return true;
  if (/^visitor\s*\d*$/i.test(value) || /^\d+$/.test(value)) return true;

  /**
   * A word that answered the question without naming anybody.
   *
   * "Could I take your name?" answered "yes" was recorded as the name, which
   * completed the chat — and the next message reopened it asking for the name
   * again, because the read had thought better of it by then.
   */
  return /^(yes|yeah|yep|no|nope|ok|okay|sure|thanks?|thank you|hi|hello|hey|none|n\/?a|test|asap|please)\b[\s.!]*$/i.test(
    value
  );
}

/**
 * A name that is our rep's, not the visitor's.
 *
 * The bot introduces itself — "Hi, I'm Jessica" — and the contact read took
 * that for the visitor's name in 43 chats in one week: "Jessica Joe" went onto
 * the lead for a visitor who had signed her message Sara Cecchini. Kept only if
 * the visitor typed the name themselves; a customer called Alex talking to Alex
 * is rare, and then their own words say so.
 */
export function isOurRepsName(
  name: string | undefined,
  repNames: Array<string | undefined>,
  visitorSaid: string[]
): boolean {
  const value = String(name || "").trim().toLowerCase();
  if (!value) return false;

  const ours = repNames.flatMap((rep) => {
    const full = String(rep || "").trim().toLowerCase();
    return full ? [full, full.split(/\s+/)[0]] : [];
  });
  if (!ours.includes(value)) return false;

  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return !visitorSaid.some((text) => new RegExp(`\\b${escaped}\\b`, "i").test(String(text || "")));
}

/**
 * A plausible email address.
 *
 * Deliberately loose — this is here to catch "i'll send it later" and obvious
 * typos being stored as an address, not to adjudicate the RFC. A rejected
 * address is asked for again, which is cheap; a bad one saved is a lead nobody
 * can reach.
 */
export function looksLikeEmail(value?: string): boolean {
  const email = String(value || "").trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

/**
 * The email address in something they typed, if there is one.
 *
 * Read in code as well as by the model. A visitor typed their address in answer
 * to the email question, was thanked for it, and was asked for it again seven
 * minutes later — the model's read had not kept it. An address is the one
 * thing in a chat a pattern reads without mistakes.
 */
export function emailIn(text?: string): string {
  const match = String(text || "").match(/[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/i);
  const email = match ? match[0].toLowerCase() : "";
  return looksLikeEmail(email) ? email : "";
}

/** At least seven digits, ignoring spaces, dashes, brackets and a leading +. */
export function looksLikePhone(value?: string): boolean {
  return String(value || "").replace(/[^\d]/g, "").length >= 7;
}

export function isContactValueUsable(key: ContactFieldKey, value?: string): boolean {
  const text = String(value || "").trim();
  if (!text) return false;
  if (key === "email") return looksLikeEmail(text);
  if (key === "phone") return looksLikePhone(text);
  return !isPlaceholderName(text);
}

/**
 * Which contact details are still needed, in the order they should be asked.
 *
 * `wanted` comes from settings so a brand that does not want to ask for a phone
 * number simply stops asking, without a code change.
 */
export function missingContactFields(
  collected: CollectedContact,
  wanted: readonly string[]
): ContactFieldKey[] {
  return CONTACT_FIELDS.map((field) => field.key).filter(
    (key) => wanted.includes(key) && !isContactValueUsable(key, collected[key])
  );
}

export function contactFieldByKey(key: ContactFieldKey) {
  return CONTACT_FIELDS.find((field) => field.key === key)!;
}

/**
 * The ones that are a way of reaching somebody.
 *
 * A name is worth having and is not one of these: a rep holding "Kelvin" and
 * nothing else has a lead they cannot answer.
 */
export const REACHABLE_KEYS = ["email", "phone"] as const;

/**
 * Whether this chat can be replied to at all.
 *
 * Both are wanted and both are asked for. Only one is required, because that is
 * the honest line: a visitor who gives a phone number and refuses an address is
 * still a lead a rep can work, and holding out for the second one costs the
 * enquiry. Neither is not a lead — it is a transcript nobody can act on.
 *
 * The per-field give-up rule is not allowed to leave us here. It retires a
 * question after two unanswered tries, which is right for a finish or a
 * material and wrong for the only means of contact in the conversation, so the
 * engine checks this before it lets a chat finish.
 */
export function hasReachableContact(collected: CollectedContact): boolean {
  return REACHABLE_KEYS.some((key) => isContactValueUsable(key, collected[key]));
}

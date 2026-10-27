/**
 * Our own contact details, so they are never recorded as a customer's.
 *
 * A visitor asked for a number to call. The bot gave them ours — correctly, it
 * is in the company facts for exactly that purpose — and the contact extractor
 * then read that number back out of the transcript and filed it as the
 * customer's phone. A lead went to Zoho with Print247's own switchboard number
 * on it as the way to reach the customer. Five chats did this before anyone
 * noticed: four with a @print247.us address, one with the company phone.
 *
 * The prompt is told not to do this, and the prompt is not the guarantee. This
 * is: whatever the model returns, a value that belongs to us is dropped. The
 * same shape as the size-unit and minimum-order checks — the decision that
 * matters is made in code, because a model that is unsure will guess and the
 * guess is the failure.
 *
 * Both lists come from settings rather than constants here. The domains are
 * already maintained as `eligibility.excludedDomains`, which exists to stop the
 * service emailing colleagues, and the number is read from the company facts
 * the bot quotes from — so changing either in the dashboard moves this too.
 */
import type { ISettings } from "../models/Settings";

/** Digits only, so +1 (832) 807-3429 and 8328073429 compare equal. */
function digitsOf(value: string): string {
  return String(value || "").replace(/\D/g, "");
}

/**
 * Every phone-shaped string in the company facts.
 *
 * Read from the facts rather than configured separately, because the facts are
 * the thing the bot actually quotes to customers — a number it can hand out is
 * by definition one it could later mistake for theirs.
 */
export function ourPhoneNumbers(settings?: ISettings): string[] {
  const facts = String(settings?.company?.facts || "");
  return (facts.match(/\+?\d[\d\s().-]{7,}\d/g) || []).map(digitsOf).filter((d) => d.length >= 7);
}

/** Ours, in any of the shapes a phone number gets written in. */
export function isOurPhone(phone: string, settings?: ISettings): boolean {
  const digits = digitsOf(phone);
  if (digits.length < 7) return false;

  return ourPhoneNumbers(settings).some((ours) => {
    // Compared on the last ten digits so a country code on one side and not the
    // other still matches: +1 (832) 807-3429 and 832-807-3429 are one number.
    const a = digits.slice(-10);
    const b = ours.slice(-10);
    return a.length >= 7 && a === b;
  });
}

/** An address at one of our own domains is a colleague, not a lead. */
export function isOurEmail(email: string, settings?: ISettings): boolean {
  const address = String(email || "").trim().toLowerCase();
  if (!address.includes("@")) return false;

  const domain = address.split("@").pop() || "";
  const ours = (settings?.eligibility?.excludedDomains || []).map((d) => String(d).trim().toLowerCase());

  return ours.some((d) => d && (domain === d || domain.endsWith(`.${d}`)));
}

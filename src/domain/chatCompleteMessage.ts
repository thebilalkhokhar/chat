/**
 * Dynamic chat completion messages based on US Texas time (Central Time).
 *
 * When a visitor has answered all required qualification questions and provided
 * reachable contact details, the bot concludes with a timing-appropriate response
 * indicating when pricing will be delivered.
 *
 * Windows:
 * 1. Weekdays 9:00 AM - 3:30 PM Texas Time:
 *    "within today" (market competitive pricing)
 * 2. Weekdays 3:30 PM - 6:00 PM Texas Time:
 *    "within today if possible; otherwise, first thing tomorrow morning"
 * 3. Weekdays 6:00 PM - 8:59 AM Texas Time (outside business hours):
 *    "within our business hours"
 * 4. Weekends (Saturday & Sunday) anytime:
 *    "by Monday morning"
 */

export const TEXAS_TIME_ZONE = "America/Chicago";

export const COMPLETE_MESSAGE_WEEKDAY_DAYTIME =
  "Thank you for sharing the project details. Based on the specifications provided, we’ll prepare our market competitive pricing and will send that over within today.\n\nIf we need anything further, we’ll contact you on the email/ number provided.";

export const COMPLETE_MESSAGE_WEEKDAY_LATE_AFTERNOON =
  "Thank you for sharing the project details. Based on the specifications provided, we’ll prepare our most competitive pricing and will send that over within today if possible; otherwise, first thing tomorrow morning.\n\nIf we need anything further, we’ll contact you on the email/ number provided.";

export const COMPLETE_MESSAGE_WEEKDAY_OFF_HOURS =
  "Thank you for sharing the project details. Based on the specifications provided, we’ll prepare our most competitive pricing and will send that over within our business hours. \n\nIf we need anything further, we’ll contact you on the email/number provided.";

export const COMPLETE_MESSAGE_WEEKEND =
  "Thank you for sharing the project details. Based on the specifications provided, we’ll prepare our most competitive pricing and will send that over by Monday morning. \n\nIf we need anything further, we’ll contact you on the email/number provided.";

export const ALL_CHAT_COMPLETE_MESSAGES: string[] = [
  COMPLETE_MESSAGE_WEEKDAY_DAYTIME,
  COMPLETE_MESSAGE_WEEKDAY_LATE_AFTERNOON,
  COMPLETE_MESSAGE_WEEKDAY_OFF_HOURS,
  COMPLETE_MESSAGE_WEEKEND,
];

/** Extracts hour (0-23), minute (0-59), and weekday (0=Sun, 1=Mon, ..., 6=Sat) in Texas time. */
export function texasParts(at: Date = new Date()): { hour: number; minute: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TEXAS_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(at);

  const hourPart = parts.find((p) => p.type === "hour")?.value ?? "0";
  const minutePart = parts.find((p) => p.type === "minute")?.value ?? "0";
  const weekdayPart = parts.find((p) => p.type === "weekday")?.value ?? "Sun";

  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  return {
    hour: Number(hourPart) % 24,
    minute: Number(minutePart),
    weekday: Math.max(0, days.indexOf(weekdayPart)),
  };
}

type Window = "daytime" | "lateAfternoon" | "offHours" | "weekend";

function windowAt(at: Date): Window {
  const { hour, minute, weekday } = texasParts(at);
  if (weekday === 0 || weekday === 6) return "weekend";

  const totalMinutes = hour * 60 + minute;
  // 9:00 AM to 3:30 PM
  if (totalMinutes >= 9 * 60 && totalMinutes < 15 * 60 + 30) return "daytime";
  // 3:30 PM to 6:00 PM
  if (totalMinutes >= 15 * 60 + 30 && totalMinutes < 18 * 60) return "lateAfternoon";
  // 6:00 PM to 8:59 AM
  return "offHours";
}

const WHEN: Record<Window, string> = {
  daytime: "within today",
  lateAfternoon: "within today if possible; otherwise, first thing tomorrow morning",
  offHours: "within our business hours",
  weekend: "by Monday morning",
};

/**
 * When the team will be back to them, in the same Texas-time windows as the
 * closing line — "within today", "by Monday morning" — so every message that
 * promises a reply promises the same thing.
 */
export function whenTheTeamReplies(at: Date = new Date()): string {
  return WHEN[windowAt(at)];
}

/** How the priced closing opens, so it is recognised as the closing line. */
export const PRICED_COMPLETE_OPENING = "Thank you for sharing the project details. You have your estimated pricing above";

/**
 * The closing after an instant price — see erpPricing.ts.
 *
 * The usual one promises "we'll prepare our pricing and send it over" to
 * somebody who has just been given a price, which reads as though the figure
 * they were shown was not real. This one stands behind it and says what
 * follows it: the full quote, confirming it.
 */
function pricedCompleteMessage(window: Window): string {
  return (
    `${PRICED_COMPLETE_OPENING}. We'll send the full quote confirming it to your email ${WHEN[window]}.` +
    "\n\nIf we need anything further, we’ll contact you on the email/number provided."
  );
}

/**
 * Returns the appropriate complete message based on US Texas time and day of week.
 */
export function getChatCompleteMessage(at: Date = new Date(), priced = false): string {
  const window = windowAt(at);
  if (priced) return pricedCompleteMessage(window);

  return {
    daytime: COMPLETE_MESSAGE_WEEKDAY_DAYTIME,
    lateAfternoon: COMPLETE_MESSAGE_WEEKDAY_LATE_AFTERNOON,
    offHours: COMPLETE_MESSAGE_WEEKDAY_OFF_HOURS,
    weekend: COMPLETE_MESSAGE_WEEKEND,
  }[window];
}

/**
 * Checks if a message matches any of the completion messages or previous legacy completion messages.
 */
export function isChatCompleteMessage(text: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (ALL_CHAT_COMPLETE_MESSAGES.some((msg) => msg.trim() === trimmed)) {
    return true;
  }
  // Also match if it starts with the standard opening line, or the priced one —
  // which may follow the price line in the same message.
  return (
    trimmed.startsWith("Thank you for sharing the project details. Based on the specifications provided") ||
    trimmed.includes(PRICED_COMPLETE_OPENING)
  );
}

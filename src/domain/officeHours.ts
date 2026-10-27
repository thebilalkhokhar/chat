/**
 * When the office is staffed, and therefore when this service must stay quiet.
 *
 * The team works a night shift in Pakistan — 7pm until 5am the following
 * morning — because that is daytime for the customers they serve. This service
 * exists to cover the hours when nobody is at a desk.
 *
 * The shift is named by the evening it BEGINS. Shifts run Monday through
 * Friday evening, so:
 *
 *   Mon 19:00 -> Tue 05:00   staffed
 *   ...
 *   Fri 19:00 -> Sat 05:00   staffed  (last shift of the week)
 *   Sat 05:00 -> Mon 19:00   nobody in — a 62 hour gap this service covers
 *
 * Saturday evening and Sunday evening are NOT shifts, so a lead arriving
 * Saturday at 9pm belongs to this service, while the same time on Friday
 * belongs to a colleague.
 *
 * Two separate uses, both mattering:
 *   - a lead captured while the office was staffed is never picked up, because
 *     a colleague already has it
 *   - nothing is sent while the office is staffed either, so a customer never
 *     receives an automated reply at a moment a real person could have answered
 *
 * The window crosses midnight, which is why this is a tested module rather than
 * an inline comparison: `19 <= h && h < 5` is false for every hour of the day,
 * and that mistake reads as correct.
 */

const TIME_ZONE = "Asia/Karachi";

export interface OfficeHoursWindow {
  /** Hour the shift begins, local time. */
  startHour: number;
  /** Hour it ends the next morning. */
  endHour: number;
  /**
   * Days whose EVENING starts a shift, 0=Sunday … 6=Saturday.
   * Monday-Friday by default; Friday's shift still finishes on Saturday.
   */
  shiftStartDays: number[];
}

export const DEFAULT_OFFICE_HOURS: OfficeHoursWindow = {
  startHour: 19,
  endHour: 5,
  shiftStartDays: [1, 2, 3, 4, 5],
};

/** Hour and weekday in Pakistan, whatever the server's own clock says. */
function pakistanParts(at: Date): { hour: number; weekday: number } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    hour: "2-digit",
    hour12: false,
    weekday: "short",
  }).formatToParts(at);

  const hourPart = parts.find((p) => p.type === "hour")?.value ?? "0";
  const weekdayPart = parts.find((p) => p.type === "weekday")?.value ?? "Sun";

  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  return {
    hour: Number(hourPart) % 24,
    weekday: Math.max(0, days.indexOf(weekdayPart)),
  };
}

export function hourInPakistan(at: Date = new Date()): number {
  return pakistanParts(at).hour;
}

/** Readable local time, for logs a human has to reason about. */
export function pakistanTime(at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    weekday: "short",
    dateStyle: undefined,
    timeStyle: "short",
  } as Intl.DateTimeFormatOptions).format(at);
}

export function pakistanStamp(at: Date = new Date()): string {
  const { hour, weekday } = pakistanParts(at);
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const minutes = new Intl.DateTimeFormat("en-GB", {
    timeZone: TIME_ZONE,
    minute: "2-digit",
  }).format(at);
  return `${days[weekday]} ${String(hour).padStart(2, "0")}:${minutes.padStart(2, "0")}`;
}

/**
 * Was somebody at a desk at this moment?
 *
 * An hour late in the evening belongs to the shift starting that day; an hour
 * before dawn belongs to the shift that started the PREVIOUS day, which is what
 * makes Saturday morning staffed but Saturday evening not.
 */
export function isOfficeHours(
  at: Date = new Date(),
  window: OfficeHoursWindow = DEFAULT_OFFICE_HOURS
): boolean {
  const { hour, weekday } = pakistanParts(at);
  const { startHour, endHour, shiftStartDays } = window;

  if (hour >= startHour) {
    // Evening: a shift begins today, if today is a working evening.
    return shiftStartDays.includes(weekday);
  }

  if (hour < endHour) {
    // Small hours: still the shift that began yesterday evening.
    const yesterday = (weekday + 6) % 7;
    return shiftStartDays.includes(yesterday);
  }

  // Daylight in Pakistan — never staffed.
  return false;
}

/** The opposite, named for how it is actually used at the call site. */
export function isOfflineHours(
  at: Date = new Date(),
  window: OfficeHoursWindow = DEFAULT_OFFICE_HOURS
): boolean {
  return !isOfficeHours(at, window);
}

/**
 * When the office next empties, so a message held back during a shift can be
 * scheduled rather than dropped or retried in a tight loop.
 */
export function nextOfflineWindowStart(
  from: Date = new Date(),
  window: OfficeHoursWindow = DEFAULT_OFFICE_HOURS
): Date {
  if (isOfflineHours(from, window)) return from;

  // An hour at a time: cheap, obviously correct across midnight and weekends,
  // and a shift is never longer than a day.
  const candidate = new Date(from);
  for (let i = 0; i < 48; i++) {
    candidate.setTime(candidate.getTime() + 60 * 60 * 1000);
    if (isOfflineHours(candidate, window)) {
      candidate.setMinutes(0, 0, 0);
      return candidate;
    }
  }

  return candidate;
}

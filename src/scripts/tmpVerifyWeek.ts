/** Read-only: isOfficeHours across every hour of a full week, against what was described. */
import { isOfficeHours, DEFAULT_OFFICE_HOURS } from "../domain/officeHours";

// A known Monday 00:00 UTC+5 (Pakistan). 2026-09-07 is a Monday.
const MONDAY = new Date("2026-09-06T19:00:00Z"); // 2026-09-07 00:00 Pakistan (UTC+5)

const DAY_NAMES = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

for (let day = 0; day < 7; day++) {
  const flags: string[] = [];
  for (let hour = 0; hour < 24; hour++) {
    const at = new Date(MONDAY.getTime() + (day * 24 + hour) * 60 * 60 * 1000);
    flags.push(isOfficeHours(at, DEFAULT_OFFICE_HOURS) ? "S" : ".");
  }
  console.log(`${DAY_NAMES[day]}  ${flags.join("")}`);
}
console.log(`\n     ${Array.from({ length: 24 }, (_, h) => (h % 10)).join("")}`);
console.log("S = staffed, . = not staffed. Columns are Pakistan-local hour 00-23.");

/** Poora hafta, har ghanta. Weekend aur midnight crossing dono. */
import { isOfficeHours, isOfflineHours, pakistanStamp, nextOfflineWindowStart } from "../domain/officeHours";

// Pakistan is UTC+5 year-round. 2026-08-24 is a Monday.
const MONDAY_UTC = Date.UTC(2026, 7, 24);
// PKT is UTC+5, so the UTC instant for a given local day/hour is simply that
// local wall-clock time minus five hours.
const at = (dayOffset: number, hour: number) =>
  new Date(MONDAY_UTC + dayOffset * 86400000 + (hour - 5) * 3600000);

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Staffed = shift started Mon-Fri evening; runs 19:00 to 05:00 next morning. */
function expected(dayIdx: number, hour: number): boolean {
  if (hour >= 19) return dayIdx <= 4;           // Mon-Fri evening starts a shift
  if (hour < 5) return ((dayIdx + 6) % 7) <= 4; // previous day was Mon-Fri
  return false;
}

let failures = 0;
console.log("     " + Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0")).join(" "));

for (let d = 0; d < 7; d++) {
  const row: string[] = [];
  for (let h = 0; h < 24; h++) {
    const when = at(d, h);
    const actual = isOfficeHours(when);
    const want = expected(d, h);
    if (actual !== want) { failures++; row.push("XX"); }
    else row.push(actual ? "##" : "..");
    if (isOfflineHours(when) === actual) failures++;
  }
  console.log(`${DAYS[d]}  ${row.join(" ")}`);
}
console.log("\n## = office staffed (AI quiet)   .. = offline (AI works)");

console.log("\n--- key moments ---");
const checks: [string, number, number, boolean][] = [
  ["Friday 20:00  (shift on)",      4, 20, true],
  ["Saturday 04:00 (Fri shift end)", 5, 4,  true],
  ["Saturday 06:00 (weekend gap)",   5, 6,  false],
  ["Saturday 21:00 (no Sat shift)",  5, 21, false],
  ["Sunday 03:00",                   6, 3,  false],
  ["Sunday 22:00",                   6, 22, false],
  ["Monday 04:00 (still weekend)",   0, 4,  false],
  ["Monday 20:00 (back at work)",    0, 20, true],
];
for (const [label, d, h, want] of checks) {
  const actual = isOfficeHours(at(d, h));
  const ok = actual === want;
  if (!ok) failures++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${label.padEnd(32)} ${actual ? "OFFICE" : "offline"}`);
}

console.log("\n--- office hours par aayi lead, AI kab shuru karega ---");
for (const [label, d, h] of [["Fri 21:00", 4, 21], ["Tue 23:00", 1, 23], ["Wed 02:00", 2, 2]] as [string, number, number][]) {
  const when = at(d, h);
  const resume = nextOfflineWindowStart(when);
  console.log(`  ${label} -> ${pakistanStamp(resume)}   offline=${isOfflineHours(resume)}`);
  if (!isOfflineHours(resume)) failures++;
}

console.log(failures === 0 ? "\nAll cases pass." : `\n${failures} FAILING`);
process.exit(failures === 0 ? 0 : 1);

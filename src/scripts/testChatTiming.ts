import {
  getChatCompleteMessage,
  isChatCompleteMessage,
  texasParts,
  COMPLETE_MESSAGE_WEEKDAY_DAYTIME,
  COMPLETE_MESSAGE_WEEKDAY_LATE_AFTERNOON,
  COMPLETE_MESSAGE_WEEKDAY_OFF_HOURS,
  COMPLETE_MESSAGE_WEEKEND,
} from "../domain/chatCompleteMessage";

let failures = 0;

function check(label: string, got: unknown, expected: unknown) {
  const ok = got === expected;
  if (!ok) {
    failures += 1;
    console.log(`FAIL  ${label}`);
    console.log(`      got:      ${JSON.stringify(got)}`);
    console.log(`      expected: ${JSON.stringify(expected)}`);
  } else {
    console.log(`ok    ${label}`);
  }
}

console.log("=== Testing Texas Time Extraction ===");
const partsMonDay = texasParts(new Date("2026-09-14T10:15:00-05:00"));
check("Texas weekday is Monday (1)", partsMonDay.weekday, 1);
check("Texas hour is 10", partsMonDay.hour, 10);
check("Texas minute is 15", partsMonDay.minute, 15);

const partsSat = texasParts(new Date("2026-09-19T20:00:00-05:00"));
check("Texas weekday is Saturday (6)", partsSat.weekday, 6);

const partsSun = texasParts(new Date("2026-09-20T12:00:00-05:00"));
check("Texas weekday is Sunday (0)", partsSun.weekday, 0);

console.log("\n=== Testing Chat Completion Message Time Windows (CDT / Texas Time) ===");

// 1. Weekdays: 9:00 AM to 3:30 PM Texas Time
console.log("\n-- Slot 1: Weekdays 9:00 AM to 3:30 PM (market competitive / within today) --");
check(
  "Monday 09:00 (exact start)",
  getChatCompleteMessage(new Date("2026-09-14T09:00:00-05:00")),
  COMPLETE_MESSAGE_WEEKDAY_DAYTIME
);
check(
  "Monday 12:00 (midday)",
  getChatCompleteMessage(new Date("2026-09-14T12:00:00-05:00")),
  COMPLETE_MESSAGE_WEEKDAY_DAYTIME
);
check(
  "Wednesday 15:29:59 (just before 3:30 PM cutoff)",
  getChatCompleteMessage(new Date("2026-09-16T15:29:59-05:00")),
  COMPLETE_MESSAGE_WEEKDAY_DAYTIME
);

// 2. Weekdays: 3:30 PM to 6:00 PM Texas Time
console.log("\n-- Slot 2: Weekdays 3:30 PM to 6:00 PM (most competitive / within today if possible; otherwise, first thing tomorrow morning) --");
check(
  "Monday 15:30 (exact start)",
  getChatCompleteMessage(new Date("2026-09-14T15:30:00-05:00")),
  COMPLETE_MESSAGE_WEEKDAY_LATE_AFTERNOON
);
check(
  "Thursday 16:45",
  getChatCompleteMessage(new Date("2026-09-17T16:45:00-05:00")),
  COMPLETE_MESSAGE_WEEKDAY_LATE_AFTERNOON
);
check(
  "Friday 17:59:59 (just before 6:00 PM cutoff)",
  getChatCompleteMessage(new Date("2026-09-18T17:59:59-05:00")),
  COMPLETE_MESSAGE_WEEKDAY_LATE_AFTERNOON
);

// 3. Weekdays: 6:00 PM to 8:59 AM Texas Time (Non-business hours)
console.log("\n-- Slot 3: Weekdays 6:00 PM to 8:59 AM (most competitive / within our business hours) --");
check(
  "Monday 18:00 (exact start)",
  getChatCompleteMessage(new Date("2026-09-14T18:00:00-05:00")),
  COMPLETE_MESSAGE_WEEKDAY_OFF_HOURS
);
check(
  "Monday 20:59",
  getChatCompleteMessage(new Date("2026-09-14T20:59:00-05:00")),
  COMPLETE_MESSAGE_WEEKDAY_OFF_HOURS
);
check(
  "Monday 23:45 (late night)",
  getChatCompleteMessage(new Date("2026-09-14T23:45:00-05:00")),
  COMPLETE_MESSAGE_WEEKDAY_OFF_HOURS
);
check(
  "Tuesday 04:00 (early morning)",
  getChatCompleteMessage(new Date("2026-09-15T04:00:00-05:00")),
  COMPLETE_MESSAGE_WEEKDAY_OFF_HOURS
);
check(
  "Tuesday 08:59:59 (just before 9:00 AM opening)",
  getChatCompleteMessage(new Date("2026-09-15T08:59:59-05:00")),
  COMPLETE_MESSAGE_WEEKDAY_OFF_HOURS
);

// 4. Weekends: Anytime on Saturday & Sunday
console.log("\n-- Slot 4: Weekends (most competitive / by Monday morning) --");
check(
  "Saturday 00:00 (midnight start)",
  getChatCompleteMessage(new Date("2026-09-19T00:00:00-05:00")),
  COMPLETE_MESSAGE_WEEKEND
);
check(
  "Saturday 11:30",
  getChatCompleteMessage(new Date("2026-09-19T11:30:00-05:00")),
  COMPLETE_MESSAGE_WEEKEND
);
check(
  "Saturday 21:00",
  getChatCompleteMessage(new Date("2026-09-19T21:00:00-05:00")),
  COMPLETE_MESSAGE_WEEKEND
);
check(
  "Sunday 05:00",
  getChatCompleteMessage(new Date("2026-09-20T05:00:00-05:00")),
  COMPLETE_MESSAGE_WEEKEND
);
check(
  "Sunday 15:00",
  getChatCompleteMessage(new Date("2026-09-20T15:00:00-05:00")),
  COMPLETE_MESSAGE_WEEKEND
);
check(
  "Sunday 23:59:59 (end of weekend)",
  getChatCompleteMessage(new Date("2026-09-20T23:59:59-05:00")),
  COMPLETE_MESSAGE_WEEKEND
);

console.log("\n=== Testing isChatCompleteMessage recognizer ===");
check("Recognizes weekday daytime message", isChatCompleteMessage(COMPLETE_MESSAGE_WEEKDAY_DAYTIME), true);
check("Recognizes weekday late afternoon message", isChatCompleteMessage(COMPLETE_MESSAGE_WEEKDAY_LATE_AFTERNOON), true);
check("Recognizes weekday off-hours message", isChatCompleteMessage(COMPLETE_MESSAGE_WEEKDAY_OFF_HOURS), true);
check("Recognizes weekend message", isChatCompleteMessage(COMPLETE_MESSAGE_WEEKEND), true);
check("Rejects arbitrary text", isChatCompleteMessage("What is your MOQ?"), false);

console.log("\n" + (failures === 0 ? "All timing tests passed." : `${failures} test(s) failed.`));
process.exit(failures === 0 ? 0 : 1);

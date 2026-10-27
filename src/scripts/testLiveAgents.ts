/**
 * Who a chat goes to, and when the bot steps aside.
 *
 * The rule: during office hours the bot greets, and on the visitor's first
 * reply the chat is offered to every live agent at once — whoever accepts it
 * first owns it. Outside office hours there is nobody to pass it to, so the bot
 * runs the whole script as it always did.
 *
 * Runs on its own — no database, no model.
 */
import { isOfficeHours, DEFAULT_OFFICE_HOURS } from "../domain/officeHours";
import { erpRecipients } from "../services/erpChatNotify";
import { whatsAppRecipients } from "../services/whatsappNotify";

let bad = 0;

function check(name: string, got: unknown, expected: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) bad += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}: ${JSON.stringify(got)}${ok ? "" : ` — wanted ${JSON.stringify(expected)}`}`);
}

/** What the webhook does with a hand-off, lifted out so it can be proved here. */
function operatorsFor(
  handoff: string,
  pool: string[],
  repEmail: string,
  fallback: string
): string[] {
  const live = pool.map((e) => String(e || "").trim()).filter(Boolean);
  return handoff === "live_agent" && live.length ? live : [repEmail || fallback];
}

const POOL = [
  "frank.castle@print247.us",
  "brian.taylor@print247.us",
  "harry.brook@print247.us",
  "jessica.joe@print247.us",
];

console.log("-- who the chat is offered to");
check("by day, the whole pool", operatorsFor("live_agent", POOL, "alex.kane@print247.us", "johnhenry.it@print247.us"), POOL);
check(
  "somebody who asked for a person still gets their own rep",
  operatorsFor("visitor_asked", POOL, "alex.kane@print247.us", "johnhenry.it@print247.us"),
  ["alex.kane@print247.us"]
);
check(
  "a chat with no rep falls back",
  operatorsFor("needs_human", POOL, "", "johnhenry.it@print247.us"),
  ["johnhenry.it@print247.us"]
);
check(
  "an empty pool switches the hand-over off",
  operatorsFor("live_agent", [], "alex.kane@print247.us", "johnhenry.it@print247.us"),
  ["alex.kane@print247.us"]
);
check(
  "blank entries are dropped",
  operatorsFor("live_agent", ["", "  ", "harry.brook@print247.us"], "alex.kane@print247.us", "x@y.us"),
  ["harry.brook@print247.us"]
);

console.log("");
console.log("-- when a person is there to take it");
// DEFAULT_OFFICE_HOURS is an evening shift in Pakistan time; these are the
// hours the rest of the service already runs on.
const shiftDay = DEFAULT_OFFICE_HOURS.shiftStartDays[0];
console.log("  window:", JSON.stringify(DEFAULT_OFFICE_HOURS));

/** A Date landing on the given Pakistan hour and weekday. */
function pakistanMoment(weekday: number, hour: number): Date {
  // Pakistan is UTC+5 and does not observe DST.
  const base = new Date(Date.UTC(2026, 8, 6, 0, 0, 0)); // a Sunday
  base.setUTCDate(base.getUTCDate() + weekday);
  base.setUTCHours(hour - 5);
  return base;
}

check(
  "mid-shift, so a person takes it",
  isOfficeHours(pakistanMoment(shiftDay, DEFAULT_OFFICE_HOURS.startHour + 1)),
  true
);
check(
  "daylight in Pakistan, so the bot runs the script",
  isOfficeHours(pakistanMoment(shiftDay, 12)),
  false
);

console.log("");
console.log("-- who gets told about a chat");
// All four, not just whoever the bot spoke as: the chat goes to whoever accepts
// it first, so telling one of them is telling the wrong one three times in four.
const settingsWith = (chat: Record<string, unknown>) => ({ chat }) as any;

const FOUR = [
  "frank.castle@print247.us",
  "briantylar@print247.us",
  "harry.brook@print247.us",
  "jessica.joe@print247.us",
];

const ERP_IDS = {
  "frank.castle@print247.us": 11,
  "briantylar@print247.us": 22,
  "harry.brook@print247.us": 33,
  "jessica.joe@print247.us": 44,
};

const WA_NUMBERS = {
  "frank.castle@print247.us": "111@c.us",
  "briantylar@print247.us": "222@c.us",
  "harry.brook@print247.us": "333@c.us",
  "jessica.joe@print247.us": "444@c.us",
};

check(
  "ERP: every agent with an id",
  erpRecipients(settingsWith({ liveAgentEmails: FOUR, erpUserIds: ERP_IDS }), "alex.kane@print247.us").map((r) => r.userId),
  [11, 22, 33, 44]
);
check(
  "ERP: an agent with no id is left out, the rest still told",
  erpRecipients(
    settingsWith({ liveAgentEmails: FOUR, erpUserIds: { "frank.castle@print247.us": 11, "harry.brook@print247.us": 33 } }),
    ""
  ).map((r) => r.userId),
  [11, 33]
);
check(
  "ERP: no pool falls back to the assigned rep",
  erpRecipients(settingsWith({ liveAgentEmails: [], erpUserIds: ERP_IDS }), "briantylar@print247.us").map((r) => r.userId),
  [22]
);
check(
  "ERP: nobody at all",
  erpRecipients(settingsWith({ liveAgentEmails: FOUR, erpUserIds: {} }), "nobody@print247.us"),
  []
);
check(
  "ERP: the same id twice is one alert",
  erpRecipients(
    settingsWith({
      liveAgentEmails: ["a@print247.us", "b@print247.us"],
      erpUserIds: { "a@print247.us": 7, "b@print247.us": 7 },
    }),
    ""
  ).map((r) => r.userId),
  [7]
);

check(
  "WhatsApp: every agent with a number",
  whatsAppRecipients(settingsWith({ liveAgentEmails: FOUR, whatsappRepNumbers: WA_NUMBERS }), "").map((r) => r.number),
  ["111@c.us", "222@c.us", "333@c.us", "444@c.us"]
);
check(
  "WhatsApp: no pool falls back to the assigned rep",
  whatsAppRecipients(settingsWith({ liveAgentEmails: [], whatsappRepNumbers: WA_NUMBERS }), "jessica.joe@print247.us").map(
    (r) => r.number
  ),
  ["444@c.us"]
);
check(
  "WhatsApp: nobody has a number",
  whatsAppRecipients(settingsWith({ liveAgentEmails: FOUR, whatsappRepNumbers: {} }), ""),
  []
);

console.log(bad === 0 ? "\nall pass" : `\n${bad} failing`);
process.exit(bad === 0 ? 0 : 1);

/**
 * The CRM lead rotation, against the sequence the team wrote down.
 *
 *   Round 1: Frank -> Brian -> Harry
 *   Round 2: Frank -> Brian
 *   Round 3: Frank -> Brian
 *   Round 4: Frank -> Brian
 *   Round 5: Frank -> Brian -> Harry
 *
 * Runs on its own — no database, no model.
 */
import { ROTATION, CYCLE_LENGTH, ownerIndexAt, ownersToTry, cycleFor, pickWithBalances } from "../domain/leadRotation";
import { ownerCandidates } from "../services/salesiq/handoff";

let bad = 0;

function check(name: string, got: unknown, expected: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) bad += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}`);
  if (!ok) {
    console.log(`        got      ${JSON.stringify(got)}`);
    console.log(`        wanted   ${JSON.stringify(expected)}`);
  }
}

const AGENTS = ["frank", "brian", "harry"];

// The sequence, spelled out from the spec rather than derived from the code.
const AGREED = [
  "frank", "brian", "harry", // round 1
  "frank", "brian",          // round 2
  "frank", "brian",          // round 3
  "frank", "brian",          // round 4
  "frank", "brian", "harry", // round 5
];

console.log("-- the cycle");
check("twelve leads to a cycle", CYCLE_LENGTH, 12);
check("matches the agreed sequence", cycleFor(AGENTS), AGREED);

console.log("");
console.log("-- the split over one cycle");
const tally = (names: string[]) =>
  names.reduce<Record<string, number>>((n, name) => ({ ...n, [name]: (n[name] || 0) + 1 }), {});
check("five, five and two", tally(cycleFor(AGENTS)), { frank: 5, brian: 5, harry: 2 });
check("Harry's two are at the ends", [ROTATION.indexOf(2), ROTATION.lastIndexOf(2)], [2, 11]);

console.log("");
console.log("-- it repeats, and keeps its place");
const threeCycles: string[] = [];
for (let position = 0; position < 36; position += 1) threeCycles.push(AGENTS[ownerIndexAt(position)]);
check("cycle 2 repeats cycle 1", threeCycles.slice(12, 24), AGREED);
check("cycle 3 repeats it again", threeCycles.slice(24, 36), AGREED);
check("position 12 wraps to the start", ownerIndexAt(12), ownerIndexAt(0));
check("position 13 follows", ownerIndexAt(13), ownerIndexAt(1));

console.log("");
console.log("-- nobody outside the three ever owns a lead");
const everyone = new Set(threeCycles);
check("only the three", [...everyone].sort(), ["brian", "frank", "harry"]);

console.log("");
console.log("-- a turn nobody can take");
// Brian has no Zoho sign-in, so his turn passes to the next agent rather than
// the lead going nowhere. Position 1 is Brian's.
check("Brian's turn tries Brian first", ownersToTry(1, AGENTS), ["brian", "harry", "frank"]);
check("Frank's turn tries Frank first", ownersToTry(0, AGENTS), ["frank", "brian", "harry"]);
check("Harry's turn tries Harry first", ownersToTry(2, AGENTS), ["harry", "frank", "brian"]);
check("no agents configured means no rotation", ownersToTry(0, []), []);
check("blanks are dropped", ownersToTry(0, ["frank", "", "  "]), ["frank"]);

console.log("");
console.log("-- a position that has been stored oddly");
check("negative reads as the start of a cycle", ownerIndexAt(-12), ownerIndexAt(0));
check("a fractional position is truncated", ownerIndexAt(3.9), ownerIndexAt(3));

console.log("");
console.log("the cycle, for the record:");
cycleFor(AGENTS).forEach((name, i) => console.log(`  ${String(i + 1).padStart(2)}. ${name}`));

console.log("");
console.log("-- who owns the lead, before the rotation is consulted at all");
// The person who actually dealt with the customer comes first: the agent who
// picked the chat up, then the persona an off-hours chat was run as. The
// rotation is what is left when neither applies.
const chat = (fields: Record<string, unknown>) => fields as any;

check(
  "an agent picked it up",
  ownerCandidates(chat({ attenderEmail: "Jessica.Joe@print247.us", repEmail: "frank.castle@print247.us", handoffReason: "live_agent", forwardedToOperator: true })),
  [{ email: "jessica.joe@print247.us", why: "picked the chat up" }]
);
check(
  "off-hours, the bot ran it as itself",
  ownerCandidates(chat({ attenderEmail: "", repEmail: "frank.castle@print247.us", handoffReason: "complete", forwardedToOperator: false })),
  [{ email: "frank.castle@print247.us", why: "the name the bot used" }]
);
check(
  "forwarded by day and nobody recorded — the rotation decides",
  ownerCandidates(chat({ attenderEmail: "", repEmail: "frank.castle@print247.us", handoffReason: "live_agent", forwardedToOperator: true })),
  []
);
check(
  "forwarded for any other reason is still not the bot's own chat",
  ownerCandidates(chat({ attenderEmail: "", repEmail: "frank.castle@print247.us", handoffReason: "visitor_asked", forwardedToOperator: true })),
  []
);
check(
  "the picker outranks the persona, and the persona is not repeated",
  ownerCandidates(chat({ attenderEmail: "harry.brook@print247.us", repEmail: "harry.brook@print247.us", handoffReason: "complete", forwardedToOperator: false })),
  [{ email: "harry.brook@print247.us", why: "picked the chat up" }]
);
check(
  "both, in order",
  ownerCandidates(chat({ attenderEmail: "jessica.joe@print247.us", repEmail: "frank.castle@print247.us", handoffReason: "complete", forwardedToOperator: false })),
  [
    { email: "jessica.joe@print247.us", why: "picked the chat up" },
    { email: "frank.castle@print247.us", why: "the name the bot used" },
  ]
);
check("nothing known at all", ownerCandidates(chat({})), []);

// ---- take-overs counted in the rotation ----
const TEAM = ["frank", "harry", "jessica", "paul"];
const anyone = () => true;
check("no balances: the rotation as written", pickWithBalances(1, TEAM, {}, anyone), { email: "harry", turns: 1, spent: [], repaid: null });
check(
  "harry took a chat over: passed once, jessica gets it, rotation moves two",
  pickWithBalances(1, TEAM, { harry: 1 }, anyone),
  { email: "jessica", turns: 2, spent: ["harry"], repaid: null }
);
check(
  "frank lost his lead to a take-over: he is owed the next one, rotation stays put",
  pickWithBalances(2, TEAM, { frank: -1 }, anyone),
  { email: "frank", turns: 0, spent: [], repaid: "frank" }
);
check(
  "a rep with no Zoho sign-in is passed without spending anyone's take-over",
  pickWithBalances(0, TEAM, {}, (e) => e !== "frank"),
  { email: "harry", turns: 2, spent: [], repaid: null }
);
check(
  "everybody ahead on take-overs: the first in turn still gets it",
  pickWithBalances(0, TEAM, { frank: 1, harry: 1, jessica: 1, paul: 1 }, anyone).email,
  "frank"
);
// Eight leads, one of them a take-over by harry first: everybody ends on two.
{
  const balances: Record<string, number> = { harry: 1 };
  const got: Record<string, number> = { harry: 1 };
  let position = 0;
  for (let i = 0; i < 7; i++) {
    const pick = pickWithBalances(position, TEAM, balances, anyone);
    pick.spent.forEach((e) => (balances[e] = (balances[e] || 0) - 1));
    if (pick.repaid) balances[pick.repaid] = (balances[pick.repaid] || 0) + 1;
    position += pick.turns;
    got[pick.email!] = (got[pick.email!] || 0) + 1;
  }
  check("8 leads incl. one take-over: two each", TEAM.map((e) => got[e] || 0), [2, 2, 2, 2]);
}
// A rotation lead moved from frank to paul by a take-over: frank owed, paul ahead; still two each over 8.
{
  const balances: Record<string, number> = { frank: -1, paul: 1 };
  const got: Record<string, number> = { paul: 1 };
  let position = 1;
  for (let i = 0; i < 7; i++) {
    const pick = pickWithBalances(position, TEAM, balances, anyone);
    pick.spent.forEach((e) => (balances[e] = (balances[e] || 0) - 1));
    if (pick.repaid) balances[pick.repaid] = (balances[pick.repaid] || 0) + 1;
    position += pick.turns;
    got[pick.email!] = (got[pick.email!] || 0) + 1;
  }
  check("lead moved by a take-over: still two each over 8", TEAM.map((e) => got[e] || 0), [2, 2, 2, 2]);
}

console.log(bad === 0 ? "\nall pass" : `\n${bad} failing`);
process.exit(bad === 0 ? 0 : 1);

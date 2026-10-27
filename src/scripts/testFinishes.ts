/**
 * The finish check, against what customers actually type.
 *
 * Runs on its own — no database, no model — so a change to the table can be
 * proved in a second rather than by holding a chat.
 */
import { normaliseFinish } from "../domain/finishes";

const CASES: Array<[string, string]> = [
  // The near misses this exists for.
  ["glass", "gloss"],
  ["Glass", "gloss"],
  ["glass finish", "gloss"],
  ["i want glass", "gloss"],
  ["matt", "matte"],
  ["mat", "matte"],
  ["matt lamination", "matte"],
  ["softtouch", "soft touch"],
  ["soft-touch", "soft touch"],
  ["glass with spot uv", "gloss with spot uv"],

  // Already right, and left alone.
  ["gloss", "gloss"],
  ["matte", "matte"],
  ["soft touch", "soft touch"],

  // Nothing to do with the three. Never rewritten.
  ["spot UV", "spot UV"],
  ["hot foil stamping in gold", "hot foil stamping in gold"],
  ["embossed", "embossed"],
  ["none", "none"],
  ["not given", "not given"],
  ["", ""],
];

let bad = 0;
for (const [input, expected] of CASES) {
  const got = normaliseFinish(input);
  const ok = got === expected;
  if (!ok) bad += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${JSON.stringify(input).padEnd(28)} -> ${JSON.stringify(got)}`);
}

console.log(bad === 0 ? "\nall pass" : `\n${bad} failing`);
process.exit(bad === 0 ? 0 : 1);

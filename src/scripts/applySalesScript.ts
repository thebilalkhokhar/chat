import "dotenv/config";
import { connectLeadsDb } from "../db/connections";
import { getSettings, updateSettings } from "../services/settingsService";
import { DEFAULT_COMPANY_FACTS } from "../domain/companyKnowledge";

/**
 * Puts the sales team's live chat script into the settings document.
 *
 * The facts and the stored questions are seeded from code on first run and
 * edited from the dashboard after that, so changing a default in the source does
 * nothing to a service that has already run once. This is what actually moves
 * them — and it is a script rather than a migration because these are somebody's
 * words, and the next revision of them should not need a deployment.
 *
 * Dry run unless given --apply.
 */

const QUESTIONS: Record<string, string> = {
  // Also the description the extractor sees for this field, so it says what a
  // real answer looks like: something we make, not what goes inside it.
  product: "What are you looking to get made — boxes, mylar bags and pouches, or labels and stickers?",
  sizes: "What size are you looking for?",
  finishes: "What finish do you prefer: matte, gloss or soft touch?",
  // Without the MOQ. It used to be stated here, which put it into the opening
  // email of every conversation — the questions reach the model verbatim as the
  // things still to ask. The figure is in the company facts, so a customer who
  // asks is still answered.
  quantity:
    "What quantity would you like to go for on your first run, and how many designs or SKUs do you have?",
  material: "Do you have any specific material or special features in mind?",
  extras: "Do you want me to add a zipper and tear notch?",
  skus: "How many designs or SKUs is that across?",
};

// Their sign-off, verbatim. The chats run on a night shift against US hours, so
// "in the morning" is the customer's morning and is what the reps say.
const COMPLETE_MESSAGE = "I will get you a quote in the morning and we will go from there.";

// No "colleague". As far as the customer knows they are talking to the rep whose
// name is on the chat, and being passed to someone unnamed reads as being
// passed around.
const HANDOFF_MESSAGE = "Let me check on that and come back to you shortly.";

(async () => {
  const apply = process.argv.includes("--apply");
  const db = await connectLeadsDb();
  const settings: any = await getSettings(db);

  const changes: string[] = [];

  const note = (what: string, before: string, after: string) => {
    if (before.trim() === after.trim()) return;
    changes.push(`${what}\n    was: ${JSON.stringify(before.slice(0, 90))}\n    now: ${JSON.stringify(after.slice(0, 90))}`);
  };

  note("company.facts", String(settings.company?.facts || ""), DEFAULT_COMPANY_FACTS);
  note("chat.completeMessage", String(settings.chat?.completeMessage || ""), COMPLETE_MESSAGE);
  note("chat.handoffMessage", String(settings.chat?.handoffMessage || ""), HANDOFF_MESSAGE);

  for (const field of settings.quoteFields) {
    const wanted = QUESTIONS[field.key];
    if (wanted) note(`quoteFields.${field.key}.question`, String(field.question || ""), wanted);
  }

  if (changes.length === 0) {
    console.log("Nothing to change — settings already match the script.");
    process.exit(0);
  }

  console.log(`${changes.length} change${changes.length === 1 ? "" : "s"}:\n`);
  for (const change of changes) console.log("  " + change + "\n");

  if (!apply) {
    console.log("Dry run. Re-run with --apply to write them.");
    process.exit(0);
  }

  // Whole sections, through the same path the dashboard writes by — a lean read
  // is a plain object and has no save() on it, and a $set of a nested key would
  // drop everything else in that section.
  await updateSettings(
    db,
    {
      company: { ...(settings.company || {}), facts: DEFAULT_COMPANY_FACTS },
      chat: {
        ...settings.chat,
        completeMessage: COMPLETE_MESSAGE,
        handoffMessage: HANDOFF_MESSAGE,
      },
      quoteFields: settings.quoteFields.map((field: any) => ({
        ...field,
        question: QUESTIONS[field.key] || field.question,
      })),
    },
    "apply:script"
  );

  console.log("Written.");
  process.exit(0);
})();

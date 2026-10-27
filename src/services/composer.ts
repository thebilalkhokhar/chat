import { createChatCompletion } from "./aiClient";
import type { CollectedFields } from "../domain/quoteFields";
import type { ISettings, IQuoteFieldSetting } from "../models/Settings";
import { describeScripts, isBagFamily } from "../domain/salesScript";
import { sizeMissingUnit, alreadyAskedTheUnit } from "../domain/sizeUnit";
import {
  askedToGoBelowMinimum,
  belowMinimum,
  minimumAlreadyStated,
  minimumApplies,
  MINIMUM_ORDER,
} from "../domain/minimumOrder";
import type { ConversationMessage } from "../models/Conversation";

export interface ComposeContext {
  customerName: string;
  company: string;
  repName: string;
  settings: ISettings;
  fields: IQuoteFieldSetting[];
  collected: CollectedFields;
  missingKeys: string[];
  /**
   * What the customer typed into the enquiry form.
   *
   * Kept apart from `messages` on purpose. It is not a turn in a conversation:
   * nobody has spoken to this person yet, and treating it as one had the very
   * first email opening "thanks for confirming" — for details the customer had
   * given a form, not us.
   */
  enquiry?: string;
  /**
   * Facts about the business the AI is allowed to state — where it is, what it
   * ships, opening hours. Asked "where are you based?" with none of this it
   * answered "I will get back to you about our location", which is safe and
   * absurd from somebody signing as an employee.
   */
  companyFacts?: string;
  messages: ConversationMessage[];
  /** Anything the customer asked that only a human may answer. */
  questionsForRep?: string[];
}

export interface ComposedEmail {
  subject: string;
  /** Plain text, as written. */
  body: string;
  /** The same text as simple HTML, which is what Zoho is given. */
  html: string;
}

function transcriptOf(messages: ConversationMessage[]): string {
  if (messages.length === 0) return "(no messages yet — this is the first contact)";
  return messages
    .map((message) => {
      const who = message.author === "ai" ? "Us" : message.author === "rep" ? "Our rep" : "Customer";
      return `${who}: ${message.body.trim()}`;
    })
    .join("\n\n");
}

/** Minimal HTML: paragraphs only, and the text escaped. */
function toHtml(body: string): string {
  const escaped = body
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return escaped
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${paragraph.replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

export async function composeEmail(context: ComposeContext): Promise<ComposedEmail> {
  const { settings, fields, collected, missingKeys, messages } = context;

  const missing = fields.filter((field) => missingKeys.includes(field.key));
  const known = fields.filter((field) => collected[field.key as keyof CollectedFields]);

  const signOff = settings.ai.signOffName?.trim() || context.repName || "";

  // First contact means we have not written yet — not that we know nothing.
  // A web lead arrives with half its answers already filled in, and counting
  // those as conversation made the opening email read like a reply.
  const isFirstContact = !messages.some((message) => message.author === "ai");

  const rules = [
    `You are writing as ${signOff || "a sales representative"} at Print247, a printing and packaging company.`,
    `Tone: ${settings.ai.tone}.`,
    "",
    "You are gathering the details needed to prepare a quote. You never quote.",
    "",
    "Hard rules:",
    "- Never state or estimate a price or a discount, for anything.",
    // Scoped, because the blanket version blocked the company's own published
    // facts: asked its minimum order or standard turnaround the model said it
    // would check, when both were sitting in front of it. The distinction that
    // matters is a general fact against a commitment for this order.
    "- A published fact may be stated: the standard turnaround, the minimum",
    "  order, what we can and cannot produce. A promise about THIS order may",
    "  not: no delivery date, no rush confirmed, no price.",
    // Stated when asked, never volunteered. A minimum is a condition, and a
    // condition in an opening email is read before the customer has any reason
    // to accept it — somebody who would happily have ordered a thousand reads
    // it and decides they are too small to be worth our time.
    // The exception is the quantity they have already given being under it.
    // Then it is not a condition being introduced, it is the one thing on their
    // enquiry that has to be answered before anybody can quote — and the
    // situation below says so when that is the case.
    "- Never raise the minimum order, the MOQ, or any per-size or per-design",
    "  minimum unless the customer has asked about it, or the situation below",
    "  tells you their quantity is under it. Ask the quantity question without",
    "  it. If they do ask, give the figure plainly and move on.",
    "- Ask only for the details still missing. Do not raise anything else.",
    // A size a rep cannot read is the same as no size: 50x30 is a label in mm
    // and a box in inches, and the difference is the whole quote.
    "- A size with no unit is not an answer. If they have given bare numbers —",
    "  50x30, 3.5 x 3.5 x 6 — ask whether that is inches, cm or mm.",
    "- Ask at most two or three things in one email. A list of six reads like a form.",
    "- Short. Three or four sentences. This is a working email, not marketing.",
    "- No bullet lists unless asking for three or more separate details.",
    "- Do not repeat back everything they told you; acknowledge briefly and move on.",
    "- Never say back a finish, style or material we do not make. Somebody",
    "  choosing between matte, gloss and soft touch who wrote \"glass\" means",
    "  gloss, and \"matt\" means matte. Say it back the way we write it.",
    "- Plain text. No markdown, no headings, no emoji.",
    `- Sign off as ${signOff || "the rep"} with no title or company block.`,
    "",
    "If the customer asked something you are not allowed to answer — a price, a",
    "lead time, what is possible — say that you will come back to them on it",
    "shortly, in the first person, and still ask for what you need.",
    "",
    "Never refer to 'a colleague', 'our team' or anyone else handling it. As far",
    "as the customer knows they are writing to you, and handing them to a third",
    "party reads as being passed around. It is you who will follow up.",
  ];

  // No product list any more. The ERP catalogue covered mylar bags and nothing
  // else, so it shaped questions for boxes, labels, signs and print out of bag
  // data — offering pouch films to a label customer and rewriting "mylar bags"
  // into one particular style. The team's script asks what they want; a rep
  // answers the technical half after seeing the job.
  rules.push(
    "",
    "You have no product catalogue, no options list and no price list. Do not",
    "behave as though you do.",
    "- Never name a material, film, laminate, substrate, thickness or product",
    "  code. Not PET, not PE, not micron figures, not board weights. Those are a",
    "  rep's answer, given after they have seen the job.",
    "- Never name a specific product style the customer has not named first. If",
    "  they asked about mylar bags, they want mylar bags — do not narrow that to",
    "  one style on their behalf.",
    "- Do not offer menus of options beyond what the questions below already",
    "  name. Where one names matte, gloss or soft touch, those are the three.",
    "- If they ask something technical that is genuinely not answered anywhere",
    "  below, do not guess a material or a spec. Say a rep will confirm the exact",
    "  spec, and ask your questions.",
    "",
    "THE SCRIPT — what the team asks, in their order, in their words:",
    "",
    describeScripts({ stateMoq: false }),
    "",
    "Work out from the enquiry which of the three they are buying and ask down",
    "that list, skipping anything they have already told you. What they are",
    "packing is not what they are buying: somebody selling pizza needs pizza",
    "boxes. Reason from it and put that to them.",
    "These are the questions the sales team asks, and they are enough on their own."
  );


  if (context.companyFacts?.trim()) {
    rules.push(
      "",
      "About us — you may state these, and nothing beyond them:",
      context.companyFacts.trim(),
      "",
      "If these answer what the customer asked, answer it — plainly, in one",
      "sentence, then carry on with what you need. Saying you will check",
      "something written directly in front of you is worse than not knowing it:",
      "it makes a straightforward question look like a problem.",
      "",
      "Anything they do not cover you genuinely do not know. Say you will come",
      "back on it. Never stretch one of these into a claim it does not make — an",
      "address is not a delivery date, and a standard turnaround is not a",
      "promise about this order."
    );
  }

  if (settings.ai.extraInstructions?.trim()) {
    rules.push("", "House rules:", settings.ai.extraInstructions.trim());
  }

  const known_lines = known.length
    ? known.map((f) => `  ${f.label}: ${collected[f.key as keyof CollectedFields]}`).join("\n")
    : "  (nothing yet)";

  const missing_lines = missing.length
    ? missing
        .map((f) => `  ${f.label} — ${f.question}`)
        .join("\n")
    : "  (nothing — do not ask for anything)";

  // The bag list does not apply to what they have named. Same reason as the
  // chat: asked to confirm the zipper on a box, a customer learns they are
  // writing to a machine.
  const bagQuestionsDoNotApply = Boolean(collected.product) && !isBagFamily(collected.product);

  // A size we have taken down that no rep can read. Asked once, from here, so
  // that a size sitting in "already known" is still queried — the rules tell the
  // writer never to ask again for something we have.
  const needsSizeUnit =
    sizeMissingUnit(collected.sizes) &&
    !alreadyAskedTheUnit(
      messages.filter((message) => message.author === "ai").map((message) => message.body || "")
    );

  // A quantity on the enquiry form that is under what we run. The chat has
  // answered this for months; an enquiry that arrives by form never did, so
  // "200 boxes" got a polite email asking for the finish and the lead reached a
  // rep with the one number on it that nobody had addressed. Said once — after
  // that they have heard it and are deciding.
  const quantityTooLow =
    minimumApplies(collected.product) &&
    belowMinimum(collected.quantity) &&
    !minimumAlreadyStated(
      messages.filter((message) => message.author === "ai").map((message) => message.body || "")
    );

  // Told the minimum and asking to go under it anyway. A rep's call, not ours —
  // so it is acknowledged, carried on the record, and never refused in an email.
  const askedForSmaller = askedToGoBelowMinimum(
    messages.map((message) => ({ fromUs: message.author !== "customer", text: message.body || "" }))
  );

  const situation = [
    `Customer: ${context.customerName || "there"}${context.company ? ` at ${context.company}` : ""}`,
    "",
    isFirstContact
      ? [
          "This is the FIRST email. They have never heard from you.",
          "Anything listed as already confirmed came from the enquiry form they",
          "filled in, not from a conversation — so do not thank them for",
          "confirming it, do not say 'as discussed', and do not imply you have",
          "spoken before. Acknowledge the enquiry itself, then ask for what is",
          "missing.",
        ].join(" ")
      : "This is a reply in an ongoing thread. Do not reintroduce yourself.",
    "",
    isFirstContact ? "They gave these on the enquiry form:" : "Already confirmed:",
    known_lines,
    "",
    "Still needed:",
    missing_lines,
    bagQuestionsDoNotApply
      ? `\nThey are buying ${collected.product}, not bags. The zipper, the tear notch ` +
        "and the bag style are not part of this job — never raise any of them."
      : "",
    needsSizeUnit
      ? `\nThe size we have — "${collected.sizes}" — is numbers with no unit, so ` +
        "nobody can quote it. Ask whether that is inches, cm or mm, even though a " +
        "size is listed above as confirmed."
      : "",
    quantityTooLow
      ? `\nThe quantity they gave — "${collected.quantity}" — is below our minimum of ` +
        `${MINIMUM_ORDER} per size and per design. Say we can look at it for them, give the ` +
        "minimum plainly, and ask whether they would like to go ahead at that or have us see " +
        "what we can do on the smaller run. Never tell them we cannot make their number or " +
        "that it is too small — we do go under it for some jobs and that is a rep's call, so " +
        "do not promise the smaller run outright and do not put a price on it either."
      : "",
    askedForSmaller
      ? "\nThey have been told the minimum and have asked for the smaller run anyway. Say in one " +
        "sentence that you are putting the quantity to the team and will come back to them on " +
        "what can be done at it — you personally, not 'a colleague'. Do not promise it, do not " +
        "price it, do not repeat the minimum at them, and do not talk them back up to it."
      : "",
    context.questionsForRep?.length
      ? `\nThey asked something a human must answer: ${context.questionsForRep.join("; ")}`
      : "",
    "",
    context.enquiry ? `Their enquiry, as submitted:\n${context.enquiry}` : "",
    "",
    isFirstContact ? "No messages have been exchanged yet." : "Conversation so far:",
    isFirstContact ? "" : transcriptOf(messages),
  ].join("\n");

  const response = await createChatCompletion(
    {
      temperature: 0.4,
      messages: [
        { role: "system", content: rules.join("\n") },
        { role: "user", content: situation },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "email",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              subject: {
                type: "string",
                description:
                  "Only used for the very first email in a thread; later messages reuse it as Re: <subject>. Short and concrete.",
              },
              body: { type: "string", description: "Plain text, including the sign-off." },
            },
            required: ["subject", "body"],
          },
        },
      },
    },
    settings,
    "email-compose"
  );

  const raw = response.choices[0]?.message?.content;
  if (!raw) throw new Error("The model returned no email");

  const parsed = JSON.parse(raw);
  const body = String(parsed.body || "").trim();
  if (!body) throw new Error("The model returned an empty email body");

  return {
    subject: String(parsed.subject || "").trim() || "Following up on your enquiry",
    body,
    html: toHtml(body),
  };
}

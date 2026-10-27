import { createChatCompletion } from "./aiClient";
import { isPlaceholderValue, isAQuestionNotAnAnswer, withoutTemplateBlanks, type CollectedFields } from "../domain/quoteFields";
import { normaliseFinish } from "../domain/finishes";
import { sizeIsReallyAQuantity, sizeIsNotASize, sizeIsACapacity, sizeIsAPackCount } from "../domain/sizeUnit";
import type { IQuoteFieldSetting, ISettings } from "../models/Settings";
import type { ConversationMessage } from "../models/Conversation";

export interface ExtractionResult {
  collected: CollectedFields;
  /** True when the customer signalled they want no more email. */
  optedOut: boolean;
  /** Anything they asked that the AI is not allowed to answer, e.g. a price. */
  questionsForRep: string[];
}

function transcriptOf(messages: ConversationMessage[]): string {
  return messages
    .map((message) => {
      const who = message.author === "ai" ? "Us" : message.author === "rep" ? "Our rep" : "Customer";
      return `${who}: ${message.body.trim()}`;
    })
    .join("\n\n");
}

/**
 * Pulls the quote fields out of a conversation.
 *
 * Returns whatever it can. A failure here must not end a conversation — the
 * next reply gets another attempt at the same text, so the cost of an error is
 * a delay rather than a lost answer.
 */
export async function extractFields(
  messages: ConversationMessage[],
  fields: IQuoteFieldSetting[],
  existing: CollectedFields,
  settings?: ISettings
): Promise<ExtractionResult> {
  const wanted = fields.filter((field) => field.enabled);

  if (messages.length === 0 || wanted.length === 0) {
    return { collected: existing, optedOut: false, questionsForRep: [] };
  }

  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      ...Object.fromEntries(
        wanted.map((field) => [
          field.key,
          {
            type: ["string", "null"],
            description: `${field.label}. ${field.question} Null if the customer has not said.`,
          },
        ])
      ),
      opted_out: {
        type: "boolean",
        description: "True if the customer asked to stop being emailed, or is clearly irritated.",
      },
      questions_for_rep: {
        type: "array",
        items: { type: "string" },
        description: "Anything the customer asked that needs a human — prices, lead times, promises.",
      },
    },
    required: [...wanted.map((field) => field.key), "opted_out", "questions_for_rep"],
  };

  const instructions = [
    "You read a sales conversation and record only what the customer has actually stated.",
    "",
    "Rules:",
    "- Record a field only if the customer said it. Never infer, guess, or fill from typical values.",
    "- If they corrected themselves, keep the latest value.",
    // No longer scoped to "sizes, quantities and free text". It was narrowed
    // once so the catalogue rule could rewrite a product or a material into the
    // ERP's name for it; with no catalogue to rewrite towards, their own words
    // are the answer for every field.
    "- Some messages are an ad's pre-filled form, like 'Qty: __ Size: __'. The underscores",
    "  are blanks the customer left empty: record nothing for them, only what they typed in.",
    "- Keep their own words and units, for every field.",
    "  Do not convert, round or normalise those.",
    "- A field nobody has answered is null. Null is always better than a plausible guess:",
    "  an invented size or material reaches a rep as fact and gets quoted.",
    "- Values already recorded are shown below; keep them unless the customer changed them.",
    "- But DO fold in detail that sharpens one. A customer with 'food boxes'",
    "  recorded who then says 'pizza' has told you it is a pizza box — record",
    "  'pizza boxes'. Their later words refine the earlier ones; dropping them",
    "  because the field already had something in it throws away the only new",
    "  thing they said.",
    "",
    "One exception to the null rule. If the customer has clearly said they do not",
    "know, have no preference, want a recommendation, or ask for 'whatever is cheaper' /",
    "'which is cheaper' / 'most economical' for a field, record their preference (e.g. 'whatever is cheaper'",
    "or 'not sure') for it. That is an answer: it tells the rep what to quote rather than asking repeatedly.",
    "Left null, nobody would ever stop asking them for it.",
    "Only when they actually said so — never because they have not mentioned it.",

    "",
    "The product field is what WE make for them — a bag, a pouch, a box, a label.",
    "It is never what they are putting inside it. \"I need food\", \"burger\",",
    "\"coffee\", \"vitamins\" all describe the contents; none of them is a product",
    "we sell, and recording one leaves the conversation believing it has an answer",
    "it does not have. Leave it null until they say what they want made.",
    "",
    "Record what they said, in their words. There is no product list to match",
    "against and nothing to normalise towards: if they say 'mylar bags', the",
    "product is 'mylar bags', not the nearest specific style. Rewriting a",
    "customer's category into one particular item is how a visitor who asked for",
    "mylar bags was recorded as wanting a Slider Zipper Mylar bag, and was then",
    "asked about a style they had never chosen.",
    "",
    "For the material field: Record any substrate, stock, material, or special features/requirements they specify",
    "(e.g. 'waterproof and refrigerator', 'kraft', 'cardboard', 'clear vinyl', 'matte bopp', 'food grade', 'tear proof', 'foil').",
  ].join("\n");

  const priorLines = Object.entries(existing)
    .filter(([, value]) => value)
    .map(([key, value]) => `  ${key}: ${value}`)
    .join("\n");

  const response = await createChatCompletion(
    {
      temperature: 0,
      messages: [
        { role: "system", content: instructions },
        {
          role: "user",
          content:
            (priorLines ? `Already recorded:\n${priorLines}\n\n` : "") +
            `Conversation so far:\n\n${transcriptOf(messages)}`,
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: { name: "quote_fields", schema, strict: true },
      },
    },
    settings,
    "extract-fields"
  );

  const raw = response.choices[0]?.message?.content;
  if (!raw) return { collected: existing, optedOut: false, questionsForRep: [] };

  const parsed = JSON.parse(raw);

  const collected: CollectedFields = { ...existing };
  for (const field of wanted) {
    const value = typeof parsed[field.key] === "string" ? withoutTemplateBlanks(parsed[field.key]) : parsed[field.key];
    if (typeof value === "string" && value.trim() && !isPlaceholderValue(value) && !isAQuestionNotAnAnswer(value)) {
      // The one field where a near miss is worth correcting. Asked to pick from
      // three, people type "glass" for gloss and "matt" for matte, and both the
      // reply and the lead then carry a finish we do not make.
      collected[field.key as keyof CollectedFields] =
        field.key === "finishes" ? normaliseFinish(value) : value.trim();
    }
  }

  // Checked after the merge as well, so a bad value kept from an earlier turn
  // does not survive either — see isPlaceholderValue, isAQuestionNotAnAnswer and
  // sizeIsReallyAQuantity.
  for (const key of Object.keys(collected) as Array<keyof CollectedFields>) {
    if (isPlaceholderValue(collected[key]) || isAQuestionNotAnAnswer(collected[key])) delete collected[key];
  }
  if (
    sizeIsReallyAQuantity(collected.sizes, collected.quantity) ||
    sizeIsNotASize(collected.sizes) ||
    // How many go inside is not a size — see sizeIsAPackCount.
    sizeIsAPackCount(collected.sizes) ||
    // How many cookies fit is not a box size — see sizeIsACapacity.
    sizeIsACapacity(collected.sizes)
  ) {
    delete collected.sizes;
  }

  return {
    collected,
    optedOut: Boolean(parsed.opted_out),
    questionsForRep: ourOwnQuestionsRemoved(
      Array.isArray(parsed.questions_for_rep) ? parsed.questions_for_rep : [],
      messages
    ),
  };
}

/**
 * Our own questions, handed back as things the customer asked.
 *
 * A chat that went nowhere came out with questionsForRep holding "What quantity
 * are you looking to order for your first run?" and "How many total designs or
 * SKU's do you have for this home packing job?" — both of them ours, word for
 * word. The rep's note prints that list under "They asked something needing a
 * person", so the CRM said a customer had asked us our own script.
 *
 * Nothing checked where the text came from. Now anything that matches something
 * we said goes, and a question only survives if the customer actually wrote it.
 */
function ourOwnQuestionsRemoved(questions: string[], messages: ConversationMessage[]): string[] {
  const normalise = (text: string) =>
    String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();

  const weSaid = messages
    .filter((message) => message.author !== "customer")
    .map((message) => normalise(message.body));

  return questions.filter((question) => {
    const asked = normalise(question);
    if (!asked) return false;
    return !weSaid.some((said) => said.includes(asked));
  });
}

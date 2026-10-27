import { createChatCompletion } from "../aiClient";
import { ENGLISH, languageOf, visitorLanguage } from "../../domain/visitorLanguage";
import type { ISettings } from "../../models/Settings";
import type { ChatMessage } from "../../models/ChatConversation";

/**
 * Answering a visitor in their own language.
 *
 * Every reply is written in English, whoever wrote it — the model, or one of
 * the fixed lines the engine uses for a file, a hand-off or a closing — and is
 * kept in the transcript in English, because every rule that reads what the
 * bot has already said ("has the minimum been stated?", "was the size asked?")
 * is written against English. Translating on the way out is the one place that
 * catches all of them. Before this, a visitor who wrote "No hablo inglés" got a
 * Spanish line from the model and then "Thanks. What box size are you looking
 * for?" from the script.
 *
 * What the visitor actually saw is kept beside the English as `shown`.
 */

/**
 * The latest a translated reply can be ready, counted from when SalesIQ's
 * request arrived. SalesIQ gives up at about ten seconds; this leaves room for
 * the save and the network. Past it the English goes out — late in their
 * language is no reply at all.
 */
export const SEND_BY_MS = 9300;

/**
 * Taken off the composer's budget in a chat that will be translated, so the
 * translation fits. Measured at 1.4–1.5s for a line and 2.8s for a long closing
 * message on a cold call.
 */
export const TRANSLATION_MS = 2500;

function withDeadline<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([work, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);
}

/** The language to answer this chat in; English unless the visitor has written in another. */
export function replyLanguageFor(messages: Pick<ChatMessage, "author" | "text">[]): string {
  return visitorLanguage(messages);
}

/**
 * The texts in the visitor's language, in the same order. Anything already in
 * it is left alone; null when the translation did not come back in time.
 */
export async function translateReplies(
  texts: string[],
  messages: Pick<ChatMessage, "author" | "text">[],
  settings: ISettings,
  msLeft: number
): Promise<string[] | null> {
  const language = replyLanguageFor(messages);
  if (language === ENGLISH) return texts;

  const pending = texts.map((text, index) => ({ text, index })).filter(({ text }) => text.trim() && languageOf(text) !== language);
  if (!pending.length) return texts;

  // Their own words, so the translator matches them — Bulgarian rather than
  // Russian, Mexican Spanish rather than textbook — instead of a guessed name.
  const theirWords = messages
    .filter((message) => message.author === "visitor" && languageOf(message.text) === language)
    .slice(-3)
    .map((message) => `- ${message.text.slice(0, 300)}`)
    .join("\n");

  const work = createChatCompletion(
    {
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            `Translate chat messages from a Print247 sales rep into ${language}, the language the customer is writing in.`,
            "Write the way a friendly sales rep types in a live chat in that language, matching the customer's own variety of it.",
            "Keep names, numbers, sizes, units, quantities, prices, email addresses, phone numbers and links exactly as they are.",
            "Keep the meaning, the question and the length. Add nothing and leave nothing out.",
            'Reply with JSON: {"translations": ["...", ...]}, one entry per message, in the same order.',
          ].join("\n"),
        },
        {
          role: "user",
          content:
            (theirWords ? `The customer has written:\n${theirWords}\n\n` : "") +
            `Messages to translate:\n${JSON.stringify(pending.map(({ text }) => text))}`,
        },
      ],
    },
    settings,
    "chat-translate"
  )
    .then((response) => {
      const parsed = JSON.parse(response.choices[0]?.message?.content || "{}");
      const translations: unknown[] = Array.isArray(parsed.translations) ? parsed.translations : [];
      if (translations.length !== pending.length) throw new Error(`expected ${pending.length} translations, got ${translations.length}`);
      const out = [...texts];
      pending.forEach(({ index }, i) => {
        const translated = String(translations[i] || "").trim();
        if (translated) out[index] = translated;
      });

      return out;
    })
    .catch((error: any) => {
      console.error(`[chat] could not translate the reply into ${language}: ${error.message}`);

      return null;
    });

  return withDeadline(work, Math.max(0, msLeft), null);
}

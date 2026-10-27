import type { Connection } from "mongoose";
import { createChatCompletion } from "../aiClient";
import { ENGLISH, languageOf } from "../../domain/visitorLanguage";
import { chatConversationModel, type ChatMessage, type IChatConversation } from "../../models/ChatConversation";
import type { ISettings } from "../../models/Settings";

/**
 * English beside every non-English line of a chat, for the people reading it.
 *
 * Reps read the chat view and most of them read English. The bot's own replies
 * already carry their English (`text`, with what the visitor saw in `shown`);
 * this covers what the visitor wrote, and the older chats where the bot itself
 * replied in their language. Translated the first time somebody opens the
 * chat and saved, so each line is translated once.
 *
 * `english` equal to `text` means "checked, nothing to translate" — a line
 * already in English, a name, an address — so it is not asked about again.
 */

const FILE_LINE = /^\[shared a file:[^\]]*\]$/i;

function wordsIn(text: string): string {
  return String(text || "")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, " ")
    .trim();
}

/** Whether a line could need translating at all. */
function translatable(message: ChatMessage, foreignChat: boolean): boolean {
  if (message.author === "system" || message.english !== undefined) return false;
  if (message.author === "ai" && message.shown) return false; // its `text` is the English already
  const words = wordsIn(message.text);
  if (!words || FILE_LINE.test(words) || (words.match(/\p{L}/gu) || []).length < 2) return false;
  const language = languageOf(words);
  if (language === ENGLISH) return false;
  // "Cajas" or "Ok" says too little to tell on its own; in a chat already in
  // another language it is worth asking about.
  return language !== "" || foreignChat;
}

/**
 * Fills `english` on the conversation's messages that need it and saves them.
 * Gives up quietly after `msLeft` — the page then shows the chat without it,
 * and the next view tries again.
 */
export async function addEnglishTranscript(
  leadsDb: Connection,
  conversation: Pick<IChatConversation, "conversationId" | "messages">,
  settings: ISettings,
  msLeft = 8000
): Promise<void> {
  const messages = conversation.messages || [];
  const foreignChat = messages.some((message) => {
    const language = message.author === "system" ? "" : languageOf(wordsIn(message.text));
    return language !== "" && language !== ENGLISH;
  });
  if (!foreignChat) return;

  const todo = messages.map((message, index) => ({ message, index })).filter(({ message }) => translatable(message, foreignChat));
  if (!todo.length) return;

  const work = createChatCompletion(
    {
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "Translate each line of a sales chat into plain English for a sales rep to read.",
            "Keep names, numbers, sizes, units, prices, email addresses, phone numbers and links exactly as they are.",
            "A line that is already English, or is only a name, number or address, comes back unchanged.",
            'Reply with JSON: {"translations": ["...", ...]}, one entry per line, in the same order.',
          ].join("\n"),
        },
        { role: "user", content: JSON.stringify(todo.map(({ message }) => message.text)) },
      ],
    },
    settings,
    "chat-view-english"
  ).then((response) => {
    const parsed = JSON.parse(response.choices[0]?.message?.content || "{}");
    const translations: unknown[] = Array.isArray(parsed.translations) ? parsed.translations : [];
    if (translations.length !== todo.length) throw new Error(`expected ${todo.length} translations, got ${translations.length}`);

    return translations.map((value) => String(value ?? "").trim());
  });

  let translations: string[] | null;
  try {
    translations = await Promise.race([work, new Promise<null>((resolve) => setTimeout(() => resolve(null), msLeft))]);
  } catch (error: any) {
    console.error(`[chat-view] could not translate ${conversation.conversationId} into English: ${error.message}`);
    return;
  }
  if (!translations) return;

  const set: Record<string, string> = {};
  todo.forEach(({ message, index }, i) => {
    const english = translations![i] || message.text;
    message.english = english;
    set[`messages.${index}.english`] = english;
  });

  // By position: a chat's messages are only ever appended to, so an index
  // still names the same line.
  await chatConversationModel(leadsDb)
    .updateOne({ conversationId: conversation.conversationId }, { $set: set })
    .catch((error: any) => console.error(`[chat-view] could not save the English for ${conversation.conversationId}: ${error.message}`));
}

/** The English to show under a line, or "" when it is English already. */
export function englishFor(message: Pick<ChatMessage, "text" | "english" | "shown" | "author">): string {
  if (message.author === "ai" && message.shown) return message.text;
  const english = String(message.english || "").trim();
  if (!english) return "";
  const same = (a: string) => a.toLowerCase().replace(/\s+/g, " ").trim();

  return same(english) === same(message.text) ? "" : english;
}

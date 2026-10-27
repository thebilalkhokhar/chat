import { createChatCompletion } from "../aiClient";
import type { ChatMessage } from "../../models/ChatConversation";
import type { ISettings } from "../../models/Settings";
import {
  CollectedContact,
  isContactValueUsable,
  looksLikeEmail,
  looksLikePhone,
} from "../../domain/contactFields";
import { isOurEmail, isOurPhone } from "../../domain/ourOwnContacts";

// "Us", never the rep's name. Labelled "Jessica Joe:", the model took Jessica
// Joe for the visitor.
function transcriptOf(messages: ChatMessage[]): string {
  const me = "Us";
  return messages
    .filter((message) => message.author !== "system")
    .map((message) => `${message.author === "ai" ? me : "Visitor"}: ${message.text.trim()}`)
    .join("\n");
}

/**
 * Whatever contact details the visitor has actually given.
 *
 * Returns the existing values untouched on any failure: losing a stored address
 * because one extraction call failed would be worse than not learning a new one.
 */
export async function extractContact(
  messages: ChatMessage[],
  existing: CollectedContact,
  repName = "",
  settings?: ISettings
): Promise<CollectedContact> {
  if (messages.length === 0) return existing;

  const instructions = [
    "You read a sales chat and record only the contact details the visitor has actually given about themselves.",
    "",
    "Rules:",
    "- Record a value only if the visitor stated it. Never invent, infer or complete one.",
    "- Null is always the right answer when they have not said. A guessed email address",
    "  produces a lead nobody can contact, which is worse than an empty one.",
    "- Emails are often spoken: 'ali at gmail dot com' means 'ali@gmail.com'. Normalise those.",
    "- Keep phone numbers exactly as typed, including any country code.",
    "- The name wanted is the visitor's own. Never take it from a company name,",
    "  a product, or the name the assistant used for itself.",
    ...(repName ? [`  Our side introduces itself as ${repName}. That is never the visitor's name.`] : []),
    "- Only what the VISITOR gave about themselves. Our side of the chat hands out",
    "  our own phone number and email when somebody asks how to reach us, and those",
    "  are ours, not theirs. A number or address that appears only in our messages",
    "  is never the visitor's contact detail.",
    "- If they corrected themselves, keep the later value.",
  ].join("\n");

  const priorLines = Object.entries(existing)
    .filter(([, value]) => value)
    .map(([key, value]) => `  ${key}: ${value}`)
    .join("\n");

  try {
    const response = await createChatCompletion(
      {
        temperature: 0,
        messages: [
          { role: "system", content: instructions },
          {
            role: "user",
            content:
              (priorLines ? `Already recorded:\n${priorLines}\n\n` : "") +
              `Chat so far:\n\n${transcriptOf(messages)}`,
          },
        ],
        response_format: {
          type: "json_schema",
          json_schema: {
            name: "contact_details",
            strict: true,
            schema: {
              type: "object",
              additionalProperties: false,
              properties: {
                name: { type: ["string", "null"], description: "The visitor's own name. Null if not given." },
                email: { type: ["string", "null"], description: "Their email address. Null if not given." },
                phone: { type: ["string", "null"], description: "Their phone number. Null if not given." },
              },
              required: ["name", "email", "phone"],
            },
          },
        },
      },
      settings,
      "extract-contact"
    );

    const raw = response.choices[0]?.message?.content;
    if (!raw) return existing;

    const parsed = JSON.parse(raw);
    const collected: CollectedContact = { ...existing };

    // Checked here rather than trusted: the model will happily return a
    // well-formed address it assembled itself.
    const name = String(parsed.name || "").trim();
    if (name && isContactValueUsable("name", name)) collected.name = name;

    /**
     * Ours is not theirs, whatever the model concluded.
     *
     * The rule above tells it not to take our own details; this is what makes
     * that true. A visitor who asks for a number to call gets ours, and without
     * this the next extraction reads it straight back off the transcript and
     * files it as the way to reach them.
     */
    const email = String(parsed.email || "").trim().toLowerCase();
    if (email && looksLikeEmail(email)) {
      if (isOurEmail(email, settings)) {
        console.warn(`[chat] ignored our own address offered as the visitor's: ${email}`);
      } else {
        collected.email = email;
      }
    }

    const phone = String(parsed.phone || "").trim();
    if (phone && looksLikePhone(phone)) {
      if (isOurPhone(phone, settings)) {
        console.warn(`[chat] ignored our own number offered as the visitor's: ${phone}`);
      } else {
        collected.phone = phone;
      }
    }

    return collected;
  } catch (error: any) {
    console.error("[chat] could not read contact details:", error.message);
    return existing;
  }
}

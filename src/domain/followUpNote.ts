import { QUOTE_FIELDS, CollectedFields, QuoteFieldKey } from "./quoteFields";
import type { IConversation } from "../models/Conversation";
import { pakistanStamp } from "./officeHours";

/**
 * The note written back to the Zoho lead after each exchange.
 *
 * A rep opening the record should be able to see, without reading the whole
 * thread, what the AI has established and what is still missing — because the
 * moment they most need this is when they are about to price the job, or when
 * they are deciding whether to step in and take over.
 *
 * Written as plain text rather than HTML: Zoho renders notes as text, and
 * markup shows up as literal tags in the CRM.
 */

/** How far through the six answers this conversation has got. */
export function progressLine(collected: CollectedFields, enabledKeys: QuoteFieldKey[]): string {
  const answered = enabledKeys.filter((key) => (collected[key] || "").trim()).length;
  return `${answered} of ${enabledKeys.length} answered`;
}

export interface NoteInput {
  conversation: Pick<
    IConversation,
    "collected" | "messages" | "aiMessageCount" | "status" | "stopReason" | "customerEmail"
  >;
  /** Field keys currently switched on in settings. */
  enabledKeys: QuoteFieldKey[];
  /** What the AI has just sent, if this note follows a send. */
  justSent?: { subject: string; body: string };
}

export function buildFollowUpNote(input: NoteInput): { title: string; content: string } {
  const { conversation, enabledKeys, justSent } = input;
  const collected = conversation.collected || {};

  const known: string[] = [];
  const missing: string[] = [];

  for (const key of enabledKeys) {
    const field = QUOTE_FIELDS.find((f) => f.key === key);
    const label = field?.label || key;
    const value = (collected[key] || "").trim();

    if (value) known.push(`  ${label}: ${value}`);
    else missing.push(`  ${label}`);
  }

  const lines: string[] = [];

  lines.push(`AI follow-up — ${progressLine(collected, enabledKeys)}`);
  lines.push("");

  if (known.length) {
    lines.push("Confirmed by the customer:");
    lines.push(...known);
  } else {
    lines.push("Nothing confirmed by the customer yet.");
  }

  if (missing.length) {
    lines.push("");
    lines.push("Still needed before quoting:");
    lines.push(...missing);
  } else {
    lines.push("");
    lines.push("Everything needed for a quote has been collected. Ready to price.");
  }

  if (justSent) {
    lines.push("");
    lines.push(`Email just sent (${conversation.aiMessageCount} from the AI so far):`);
    lines.push(`  Subject: ${justSent.subject}`);
    // A short extract, not the whole email. The full thread is in the mailbox
    // and repeating it here buries the summary the rep actually came for.
    lines.push(`  ${justSent.body.replace(/\s+/g, " ").slice(0, 400)}`);
  }

  const lastCustomer = [...(conversation.messages || [])]
    .reverse()
    .find((message) => message.author === "customer");

  if (lastCustomer) {
    lines.push("");
    lines.push(`Customer last replied ${pakistanStamp(new Date(lastCustomer.at))} PKT:`);
    lines.push(`  ${lastCustomer.body.replace(/\s+/g, " ").slice(0, 400)}`);
  }

  if (conversation.status === "stopped") {
    lines.push("");
    lines.push(`STOPPED (${conversation.stopReason || "unknown"}) — the AI will not write again.`);
  }

  if (conversation.status === "ready_to_quote") {
    lines.push("");
    lines.push("HANDED OVER — the AI has stopped. This lead is yours to quote.");
  }

  const title =
    conversation.status === "ready_to_quote"
      ? "AI follow-up complete — ready to quote"
      : `AI follow-up — ${progressLine(collected, enabledKeys)}`;

  return { title, content: lines.join("\n") };
}

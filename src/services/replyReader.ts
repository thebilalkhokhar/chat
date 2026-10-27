import type { Connection } from "mongoose";
import type { ConversationMessage } from "../models/Conversation";

/**
 * Finding out whether a customer has answered.
 *
 * Replies are read from the mail the Zoho connector has already synced from the
 * organisation's mailboxes, rather than by polling Zoho Mail again here. That
 * sync is live — new messages appear within the hour — and it already handles
 * the authentication, paging and de-duplication that reading mailboxes needs.
 *
 * The trade is that this service sees a reply only once the sync has picked it
 * up. For an email conversation that is fine; it would not be for anything
 * expected to answer in seconds.
 */

/** `"Name <a@b.com>"`, `"a@b.com"`, and the odd `"<a@b.com>"` all reduce to the address. */
function addressOf(raw: unknown): string {
  const text = String(raw || "").toLowerCase();
  const angled = text.match(/<([^>]+)>/);
  return (angled ? angled[1] : text).trim();
}

/**
 * Mail bodies arrive as HTML, so the markup comes off before anything reads it.
 *
 * Gmail and Outlook both send `<div>` soup with inline styles. Handed to the
 * extractor untouched it is mostly font declarations and colour codes, and the
 * two lines the customer actually typed are buried inside them.
 *
 * Deliberately not a real HTML parser: this only has to turn a mail body into
 * readable lines, and a parser would be a dependency and an attack surface for
 * no gain — nothing here is rendered.
 */
export function htmlToText(body: string): string {
  const text = String(body || "");

  // Nothing that looks like a tag: treat it as plain text and leave it alone.
  if (!/<[a-z!/]/i.test(text)) return text;

  return text
    // Anything invisible goes first, with its contents.
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    // Quoted history that mail clients mark up rather than prefix with ">".
    .replace(/<blockquote[\s\S]*?<\/blockquote>/gi, "\n")
    // Structure becomes line breaks so paragraphs survive.
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    // Collapse the blank-line drifts that stripping tags leaves behind.
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Quoted history and signatures, removed.
 *
 * A reply usually carries the entire thread beneath it. Left in, the extractor
 * re-reads its own earlier questions as though the customer had written them,
 * and a signature block full of addresses and phone numbers reads like answers.
 */
export function stripQuotedText(body: string): string {
  const lines = htmlToText(body).split(/\r?\n/);
  const kept: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // "On 12 Aug 2026, X wrote:" and its many variations.
    if (/^on .{4,80}wrote:?$/i.test(trimmed)) break;
    if (/^-{2,}\s*original message\s*-{2,}$/i.test(trimmed)) break;
    if (/^from:\s/i.test(trimmed) && kept.length > 0) break;
    // A standard signature separator, which is "-- " exactly.
    if (trimmed === "--") break;

    if (trimmed.startsWith(">")) continue;

    kept.push(line);
  }

  return kept.join("\n").trim();
}

export interface InboundMessage {
  interactionId: string;
  from: string;
  subject: string;
  body: string;
  at: Date;
}

/**
 * Messages this address sent us since a given moment.
 *
 * Scoped by time rather than by thread: the connector does not record message
 * ids or headers, so there is nothing to thread on. In practice a lead writing
 * to us after we wrote to them is a reply, and treating an unrelated email from
 * the same person as one costs nothing — it is still them talking to us.
 */
export async function findRepliesFrom(
  connectorDb: Connection,
  customerEmail: string,
  since: Date
): Promise<InboundMessage[]> {
  const address = customerEmail.toLowerCase().trim();
  if (!address) return [];

  const candidates = await connectorDb
    .collection("interactions")
    .find({
      type: "Email",
      direction: "Inbound",
      timestamp: { $gt: since },
    })
    .sort({ timestamp: 1 })
    .limit(500)
    .toArray();

  // Matched in memory: `metadata.from` holds several shapes and a regex over
  // the raw field misses "Name <addr>" as often as it matches.
  return candidates
    .filter((message) => addressOf(message.metadata?.from) === address)
    .map((message) => ({
      interactionId: String(message._id),
      from: address,
      subject: String(message.title || ""),
      body: stripQuotedText(String(message.content || "")),
      at: new Date(message.timestamp),
    }))
    .filter((message) => message.body.length > 0);
}

/**
 * Did one of our own people answer this customer by hand?
 *
 * If so the AI stands down permanently on that thread. Without this check the
 * automation and the rep both reply, contradicting each other under the same
 * name — the worst thing this system can do to a customer relationship.
 *
 * The AI's own sends are excluded by the `sentBodies` it is given: those went
 * out through the CRM and come back in this same outbound collection, so
 * without that filter every message the AI sent would look like a rep stepping
 * in and would stop the conversation it had just started.
 */
export async function repRepliedByHand(
  connectorDb: Connection,
  customerEmail: string,
  since: Date,
  sentBodies: string[]
): Promise<{ replied: boolean; at?: Date }> {
  const address = customerEmail.toLowerCase().trim();
  if (!address) return { replied: false };

  const outbound = await connectorDb
    .collection("interactions")
    .find({ type: "Email", direction: "Outbound", timestamp: { $gt: since } })
    .sort({ timestamp: 1 })
    .limit(500)
    .toArray();

  /** Comparable form: whitespace and case removed, first 200 characters. */
  const fingerprint = (text: string) =>
    String(text || "").replace(/\s+/g, " ").trim().toLowerCase().slice(0, 200);

  const ours = new Set(sentBodies.map(fingerprint));

  for (const message of outbound) {
    const recipients = String(message.metadata?.to || "")
      .split(/[,;]/)
      .map(addressOf);

    if (!recipients.includes(address)) continue;
    if (ours.has(fingerprint(message.content))) continue;

    return { replied: true, at: new Date(message.timestamp) };
  }

  return { replied: false };
}

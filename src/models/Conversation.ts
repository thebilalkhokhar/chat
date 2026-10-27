import { Schema, Connection, Model } from "mongoose";
import type { CollectedFields } from "../domain/quoteFields";

/**
 * One qualification conversation: a lead, the rep it belongs to, everything
 * said so far, and what has been learned from it.
 *
 * This is the service's own record and the only thing it writes. The lead in
 * the exhibition database and the mail in the connector database both stay
 * untouched — a conversation points at them and keeps its own state, so
 * replaying, stopping or rewinding one never damages another system's data.
 */

export type ConversationStatus =
  /** Captured, waiting out the delay before the first email. */
  | "pending_first_contact"
  /** The AI has written; the customer's move. */
  | "awaiting_reply"
  /** All six answers are in. The rep prices it from here. */
  | "ready_to_quote"
  /** Stopped without completing — see `stopReason`. */
  | "stopped";

export type StopReason =
  | "max_messages"
  | "max_duration"
  | "rep_replied"
  | "opted_out"
  | "bounced"
  | "manual";

export interface ConversationMessage {
  /** Who wrote it. `rep` means a human sent it, not this service. */
  author: "ai" | "customer" | "rep";
  subject: string;
  body: string;
  at: Date;
  /** The `interactions` document a customer or rep message was read from. */
  interactionId?: string;
  /** Set on an AI message that was composed but not sent, in dry-run. */
  draftOnly?: boolean;
}

export interface IConversation {
  /** `_id` of the lead in the exhibition database. */
  leadId: string;
  /** Zoho CRM lead record, when the lead reached the CRM. */
  zohoLeadId?: string;

  customerEmail: string;
  customerName?: string;
  company?: string;

  /** The rep the mail is sent as — their Zoho grant does the sending. */
  repZohoUserId?: string;
  repEmail: string;
  repName?: string;

  exhibitionSlug?: string;
  exhibitionTitle?: string;

  /**
   * The enquiry as the customer submitted it, from the CRM Description.
   *
   * Read before the first email so the AI never asks for something already
   * stated. A web lead usually arrives with product, quantity and dimensions
   * already in it — asking for those again is the fastest way to look like an
   * automation.
   */
  enquiry?: string;

  status: ConversationStatus;
  stopReason?: StopReason;
  /** Free text for a human: why this stopped, in words. */
  stopNote?: string;

  collected: CollectedFields;
  messages: ConversationMessage[];

  /** How many emails the AI has sent. Checked against the guardrail. */
  aiMessageCount: number;

  /**
   * When the worker should next look at this conversation.
   *
   * While waiting on a customer this is short — a few minutes — because the
   * only way to notice a reply is to look. It is not when the next email goes
   * out; that is `chaseAfterAt`.
   */
  nextActionAt?: Date;

  /**
   * The earliest this may be written to again without a reply.
   *
   * Kept apart from `nextActionAt` because they answer different questions.
   * Sharing one field meant a reply sat unread until the chase fell due — a
   * customer who answered in six minutes would have waited two days.
   */
  chaseAfterAt?: Date;
  lastInboundAt?: Date;
  lastOutboundAt?: Date;

  /**
   * The subject the first email used.
   *
   * Every later message reuses it as `Re: <subject>`. Mail clients group by
   * subject as much as by header, so composing a fresh subject each time —
   * which the model does if left to choose — scattered one conversation across
   * several threads in the customer's inbox.
   */
  threadSubject?: string;

  /** Set when the rep has been told the answers are complete. */
  handedOffAt?: Date;

  /** Last failure, kept so a stuck conversation can be diagnosed. */
  lastError?: string;

  /**
   * Held by the process currently advancing this conversation.
   *
   * The in-process guard against overlapping passes does nothing across two
   * processes, and there are always at least two possible: a rolling deploy
   * overlaps old and new instances, and a developer running the worker locally
   * points at the same database. Both happened, and one customer received the
   * same email twice — each process sent, then each wrote its own count, so
   * the database recorded one send while two had gone out.
   *
   * Claimed atomically before any work, released after. A lock older than
   * `LOCK_TIMEOUT_MS` is treated as abandoned, because a process killed
   * mid-pass would otherwise strand the conversation forever.
   */
  lockedAt?: Date;
  lockedBy?: string;

  createdAt: Date;
  updatedAt: Date;
}

const MessageSchema = new Schema<ConversationMessage>(
  {
    author: { type: String, enum: ["ai", "customer", "rep"], required: true },
    subject: { type: String, default: "" },
    body: { type: String, default: "" },
    at: { type: Date, required: true },
    interactionId: { type: String },
    draftOnly: { type: Boolean },
  },
  { _id: false }
);

const ConversationSchema = new Schema<IConversation>(
  {
    // One conversation per lead: the unique index is what stops a restart or an
    // overlapping poll from starting a second thread to the same customer.
    leadId: { type: String, required: true, unique: true, index: true },
    zohoLeadId: { type: String, index: true },

    customerEmail: { type: String, required: true, lowercase: true, trim: true, index: true },
    customerName: { type: String, default: "" },
    company: { type: String, default: "" },

    repZohoUserId: { type: String, index: true },
    repEmail: { type: String, required: true, lowercase: true, trim: true },
    repName: { type: String, default: "" },

    exhibitionSlug: { type: String },
    exhibitionTitle: { type: String },
    enquiry: { type: String, default: "" },

    status: {
      type: String,
      enum: ["pending_first_contact", "awaiting_reply", "ready_to_quote", "stopped"],
      default: "pending_first_contact",
      index: true,
    },
    stopReason: {
      type: String,
      enum: ["max_messages", "max_duration", "rep_replied", "opted_out", "bounced", "manual"],
    },
    stopNote: { type: String },

    collected: { type: Schema.Types.Mixed, default: {} },
    messages: { type: [MessageSchema], default: [] },

    aiMessageCount: { type: Number, default: 0 },

    nextActionAt: { type: Date, index: true },
    chaseAfterAt: { type: Date },
    lastInboundAt: { type: Date },
    lastOutboundAt: { type: Date },
    threadSubject: { type: String, default: "" },
    handedOffAt: { type: Date },

    lastError: { type: String },
    lockedAt: { type: Date },
    lockedBy: { type: String },
  },
  { timestamps: true }
);

/** The worker's only query: what is due, oldest first. */
ConversationSchema.index({ status: 1, nextActionAt: 1 });

export function conversationModel(connection: Connection): Model<IConversation> {
  return (
    (connection.models.Conversation as Model<IConversation>) ||
    connection.model<IConversation>("Conversation", ConversationSchema)
  );
}

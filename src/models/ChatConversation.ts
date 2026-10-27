import { Schema, Connection, Model } from "mongoose";
import type { CollectedFields } from "../domain/quoteFields";

/**
 * One live chat on the website, and what has been learned from it.
 *
 * Keyed on SalesIQ's `active_conversation_id` rather than on an email address.
 * A visitor arrives anonymous — the first captured chat had no email at all and
 * a name of "Visitor 365140" — and SalesIQ has been seen writing the same person
 * to the CRM twice, once before contact details existed and once after. Keying
 * on anything the visitor supplies would split one conversation in two and lose
 * the half where they said what they wanted.
 *
 * The email side keeps its own `Conversation` collection. The two share the
 * quote fields and the rules about never quoting a price, but nothing else: a
 * chat is answered in seconds by someone still on the page, an email in hours by
 * someone who has walked away.
 */

export type ChatStatus =
  /** The bot is asking and the visitor is answering. */
  | "active"
  /** Every quote field is in. Nancy prices it from here. */
  | "ready_to_quote"
  /** Passed to a human — see `handoffReason`. */
  | "handed_off"
  /** Ended without completing. */
  | "stopped";

export type HandoffReason =
  | "complete"
  | "visitor_asked"
  | "needs_human"
  | "max_turns"
  | "error"
  /**
   * Went quiet with nothing worth a lead: no email, no phone, an incomplete
   * enquiry. Closed out so it stops being re-read by the sweep forever — the
   * distinct reason from "max_turns" is what tells the two apart in the data,
   * since both end the chat the same way but only one was ever going anywhere.
   */
  | "abandoned_empty"
  /**
   * Not here to buy anything — a job seeker, almost always off a paid ad.
   * Answered once and closed, and deliberately never written to the CRM: two of
   * these reached reps as leads reading "Quantity: Im looking job" because they
   * had left an email, which is all the sweep used to check.
   */
  | "not_a_customer"
  /**
   * Working hours, so a person takes it rather than the bot.
   *
   * The chat is offered to every agent in the live pool on the visitor's first
   * reply and whoever accepts it first owns it. Distinct from "visitor_asked",
   * which is somebody who specifically asked for a human — this one is simply
   * what happens by day.
   */
  | "live_agent"
  /**
   * They told us they are done — not interested, never mind, goodbye. Answered
   * once and stopped, not forwarded: a rep pushed into the chat after "no longer
   * interested" is the one thing they asked us not to do. What they did tell us
   * still becomes a note or lead, like any chat that ends with a way to reach them.
   */
  | "declined";

/** Totals the ERP reports for one kind of record (quotes, orders or payments). */
export interface ErpActivity {
  count: number;
  /** As the ERP sends them: a timestamp with an offset, or a bare YYYY-MM-DD day. */
  firstAt: string | null;
  lastAt: string | null;
  amount: number;
}

export interface ErpOutcome {
  checkedAt: Date;
  matched: boolean;
  matchedBy: "email" | "phone" | null;
  /** More than one ERP customer has this email or phone. */
  ambiguous: boolean;
  customerId: number | null;
  customerName: string;
  /** When the ERP customer was created; for an ambiguous match, the ERP picks the oldest. */
  customerCreatedAt?: string | null;
  /** The rep the ERP holds against that customer. */
  customerRep?: string;
  /** True when the customer had not paid before the chat; null when unmatched. */
  isNewCustomer: boolean | null;
  quotes: ErpActivity;
  orders: ErpActivity;
  payments: ErpActivity;
}

/**
 * A file a visitor shared. SalesIQ's link opens without signing in but stops
 * working once the chat is over, so the file is copied to Vercel Blob straight
 * away; see `services/salesiq/attachmentStore.ts`.
 */
export interface ChatAttachment {
  /** SalesIQ's link. */
  url: string;
  name: string;
  /** Our copy in Vercel Blob, once made. Shown in preference to `url`. */
  storedUrl?: string;
  /** Why the copy could not be made, e.g. the link had already expired. Not retried. */
  storeError?: string;
}

export interface ChatMessage {
  /**
   * Who said it — or `system`, which is nobody.
   *
   * A system line is something that happened rather than something anybody
   * typed: the chat being handed to a person, and that person joining. It is
   * shown in the transcript as an event, and kept out of every transcript built
   * for the model or the CRM, because the visitor never saw it.
   *
   * `rep` is a person from the team, after they took the chat over. SalesIQ
   * does not send those to the bot, so they are read back from its API when
   * the chat ends (operatorSync.ts).
   */
  author: "ai" | "visitor" | "system" | "rep";
  text: string;
  /**
   * What the visitor was actually sent, when it was not `text`.
   *
   * The bot reasons and keeps `text` in English; a visitor writing in another
   * language is sent a translation, kept here — see replyLanguage.ts.
   */
  shown?: string;
  /**
   * The line in English, for reps reading a chat in another language — see
   * transcriptEnglish.ts. Equal to `text` once checked and found to need none.
   */
  english?: string;
  at: Date;
  /** Set when the reply was composed but not sent, in dry run. */
  dryRun?: boolean;
  /** SalesIQ's id for a visitor message, when it sends one — how a redelivery is told from a repeat. */
  msgid?: string;
  /** Files sent with the message. `text` still names them, for the CRM and the model. */
  attachments?: ChatAttachment[];
}

export interface IChatConversation {
  /** SalesIQ's id for this chat. The handle everything else hangs off. */
  conversationId: string;
  /** Visitor identifiers, kept for tying a chat back to a CRM lead later. */
  uvid: string;
  uuid: string;
  visitorId: string;

  name: string;
  email: string;
  phone: string;

  /**
   * The rep this chat belongs to, chosen when it opens and never changed.
   *
   * The AI speaks as this person for the whole conversation and the CRM lead is
   * created under them, so the visitor deals with one consistent name and the
   * rep who is told about the enquiry is the one who appeared to take it.
   */
  repEmail: string;
  repName: string;
  /**
   * The name the bot introduced itself by, when that is no longer the owner.
   *
   * Set only when a chat turns out to be another rep's customer part-way
   * through. The visitor has been talking to the first name, so the bot keeps
   * it; `repEmail` and `repName` move to the rep who already has them, so the
   * alerts, the lead and the dashboard all point at one person.
   */
  spokeAs?: string;

  /** Where they were when they started, which is a hint about what they want. */
  landingPageTitle: string;
  currentPageUrl: string;
  /**
   * Where the visit began and what sent them, kept from the first message that
   * carries them. The landing URL keeps the ad parameters (gclid, utm_medium…)
   * that the current page loses once the visitor moves on; together with the
   * channel they decide the chat's traffic source (see domain/trafficSource.ts).
   */
  landingPageUrl?: string;
  referer?: string;
  /** SalesIQ's channel: "website", "whatsapp", "instagram". */
  visitorChannel?: string;
  /** The opening question SalesIQ records separately from the message stream. */
  question: string;
  departmentId: string;

  messages: ChatMessage[];
  collected: CollectedFields;
  /** Anything asked that only a person may answer — prices, lead times. */
  questionsForRep: string[];
  /**
   * The last instant price the ERP gave for this chat, and what was asked for.
   *
   * `key` is the request it answered, so the same job is never priced twice and
   * a changed size or quantity is priced again. `line` is what the customer was
   * told, word for word — the bot may repeat it and nothing else.
   */
  instantPrice?: {
    key: string;
    erpId: number;
    unitCost: number;
    total: number;
    line: string;
    /** Everything the ERP was asked to price — material, micron, option ids — for the rep. */
    forRep?: string;
    at: Date;
  };

  status: ChatStatus;
  handoffReason?: HandoffReason;
  handedOffAt?: Date;
  /** The CRM lead this chat was reconciled to at handoff. */
  zohoLeadId?: string;
  /** Whether SalesIQ was actually told to forward the chat. */
  forwardedToOperator: boolean;
  /**
   * The person who picked the chat up in SalesIQ, once one has.
   *
   * Asking SalesIQ to forward a chat is not the same as somebody taking it, and
   * until this is set nobody has. It is filled in by SalesIQ's chat-event
   * webhook — the bot handler is never told, so without that webhook configured
   * this stays empty however many chats are handed over.
   */
  attenderName?: string;
  attenderEmail?: string;
  attendedAt?: Date;
  /** When what was said after the take-over was read back from SalesIQ (operatorSync.ts). */
  transcriptSyncedAt?: Date;
  /**
   * SalesIQ's own number for the conversation (`active_conversation_id`). A website chat is filed
   * under the visitor's uvid, which SalesIQ's API does not accept, so the take-over sync asks about
   * the chat by this instead (operatorSync.ts). Absent until a message has carried it.
   */
  salesIqConversationId?: string;
  /** When the take-over sync last asked SalesIQ about this chat. */
  takeoverCheckedAt?: Date;
  /**
   * True when this chat created its Zoho lead (rather than matching one the
   * customer already had). Only such a lead moves to a rep who takes the chat
   * over after it was written — see moveLeadToPicker.
   */
  leadCreatedHere?: boolean;
  /** When the sales manager was told about a take-over that clashed with an existing owner. */
  ownerConflictNotifiedAt?: Date;

  /** How many times the bot has spoken. Bounded so it cannot loop forever. */
  aiMessageCount: number;
  /** CRM write attempts, so a permanently failing one is eventually left alone. */
  leadAttempts: number;
  /**
   * When a CRM write was claimed, and by implication that one is running.
   *
   * The lead is written by two paths — the webhook the moment a chat ends, and
   * the worker sweep that retries what did not land — and for the seconds Zoho
   * takes to answer, a conversation looks to the sweep exactly like one that
   * never got its lead. Both wrote. That is the pair of records 1.4 seconds
   * apart on brian@pupoclock.com.
   */
  leadWriteLockAt?: Date | null;
  /**
   * When the rep was last alerted in the ERP about this chat.
   *
   * Set before the call rather than after, so two turns in flight together
   * cannot both raise one, and rolled back if the ERP would not take it — a
   * failed alert is retried on the next thing the visitor says.
   */
  erpNotifiedAt?: Date | null;
  /**
   * How many alerts have gone out for this chat.
   *
   * The count is the claim as well as the record: an alert is raised by
   * incrementing it from the value we read, so a second turn holding the same
   * number matches nothing and stops. It also numbers the chat ids, because the
   * ERP answers a repeated chat_id with 409 rather than a second alert — one
   * per visitor message needs one id per visitor message.
   */
  erpAlerts?: number;
  /** The same pair again, for the WhatsApp group. Counted apart so one channel
   * failing never silences the other. */
  waNotifiedAt?: Date | null;
  waAlerts?: number;
  /**
   * How many times each detail has been asked for.
   *
   * A visitor who does not answer a question is usually not going to, however
   * politely it is put again. Without this the bot asked one visitor for a size
   * six times running while they tried to give it their name and email.
   */
  askedCounts: Record<string, number>;
  /**
   * What the bot asked for last.
   *
   * An attempt is only spent once the visitor has had a go at answering it, and
   * that can only be judged on their next message — so the question has to be
   * remembered until then.
   */
  lastAsked?: string;
  /**
   * They asked for a person and were asked for an address before we hand over.
   *
   * Set for exactly one turn. Whatever they say next, the chat goes to a person
   * — they have already said they want one — so this only records that the
   * address question has been put and must not be put again.
   */
  awaitingHumanContact?: boolean;
  /**
   * When this customer first chatted with us, if this is not that chat.
   *
   * Set when a visitor whose chat had finished comes back, or when the email or
   * number they give belongs to an earlier chat. It is how the bot knows to
   * greet them as somebody it has spoken to, and how the rep reading the lead
   * knows it is a returning customer.
   */
  previousChatAt?: Date;
  /**
   * How many messages the CRM has seen, as of the last write to the lead.
   *
   * A chat can carry on after its lead is written — somebody comes back with
   * "the boxes can also be 2 inches deep" — and those messages used to go
   * nowhere. Anything past this count goes onto the lead as a note. Absent on
   * older chats, which counts as everything seen.
   */
  leadMessageCount?: number;
  /**
   * What the ERP knows about this visitor: whether they are a customer and what
   * they have been quoted, ordered and paid. Looked up by email and phone for the
   * chat funnel and refreshed when it goes stale; see `services/chatFunnel.ts`.
   */
  erpOutcome?: ErpOutcome;

  createdAt: Date;
  updatedAt: Date;
}

const ChatMessageSchema = new Schema<ChatMessage>(
  {
    author: { type: String, enum: ["ai", "visitor", "system", "rep"], required: true },
    text: { type: String, required: true },
    shown: { type: String },
    english: { type: String },
    at: { type: Date, default: Date.now },
    dryRun: { type: Boolean },
    msgid: { type: String },
    attachments: {
      type: [{ _id: false, url: String, name: String, storedUrl: String, storeError: String }],
      default: undefined,
    },
  },
  { _id: false }
);

const ChatConversationSchema = new Schema<IChatConversation>(
  {
    conversationId: { type: String, required: true, unique: true, index: true },
    uvid: { type: String, default: "", index: true },
    uuid: { type: String, default: "" },
    // Indexed, with email and phone: the chat turn looks a customer up by these (the returning
    // visitor, their earlier chat with a lead, a lead being written). Unindexed, each lookup read
    // all 32k chats — 16s after a cold start on 26 Oct — and SalesIQ gave up on the reply.
    visitorId: { type: String, default: "", index: true },

    name: { type: String, default: "" },
    email: { type: String, default: "", index: true },
    phone: { type: String, default: "", index: true },

    repEmail: { type: String, default: "", index: true },
    repName: { type: String, default: "" },
    spokeAs: { type: String },

    landingPageTitle: { type: String, default: "" },
    currentPageUrl: { type: String, default: "" },
    landingPageUrl: { type: String },
    referer: { type: String },
    visitorChannel: { type: String },
    question: { type: String, default: "" },
    departmentId: { type: String, default: "" },

    messages: { type: [ChatMessageSchema], default: [] },
    collected: { type: Schema.Types.Mixed, default: {} },
    questionsForRep: { type: [String], default: [] },
    instantPrice: { type: Schema.Types.Mixed },

    status: {
      type: String,
      enum: ["active", "ready_to_quote", "handed_off", "stopped"],
      default: "active",
      index: true,
    },
    handoffReason: {
      type: String,
      enum: [
        "complete",
        "visitor_asked",
        "needs_human",
        "max_turns",
        "error",
        "abandoned_empty",
        "not_a_customer",
        "live_agent",
        "declined",
      ],
    },
    handedOffAt: { type: Date },
    zohoLeadId: { type: String },
    forwardedToOperator: { type: Boolean, default: false },
    attenderName: { type: String },
    attenderEmail: { type: String },
    attendedAt: { type: Date },
    transcriptSyncedAt: { type: Date },
    salesIqConversationId: { type: String, index: true },
    takeoverCheckedAt: { type: Date },
    leadCreatedHere: { type: Boolean },
    ownerConflictNotifiedAt: { type: Date },

    aiMessageCount: { type: Number, default: 0 },
    leadAttempts: { type: Number, default: 0 },
    leadWriteLockAt: { type: Date, default: null },
    erpNotifiedAt: { type: Date, default: null },
    erpAlerts: { type: Number, default: 0 },
    waNotifiedAt: { type: Date, default: null },
    waAlerts: { type: Number, default: 0 },
    askedCounts: { type: Schema.Types.Mixed, default: {} },
    lastAsked: { type: String, default: "" },
    awaitingHumanContact: { type: Boolean, default: false },
    previousChatAt: { type: Date },
    // No default: absent is how an older chat says the CRM has seen all of it.
    leadMessageCount: { type: Number },
    erpOutcome: { type: Schema.Types.Mixed },
  },
  { timestamps: true, collection: "chat_conversations" }
);

// Recent chats, for the worker's sweeps (take-overs, pending leads).
ChatConversationSchema.index({ createdAt: -1 });

export function chatConversationModel(connection: Connection): Model<IChatConversation> {
  return (
    (connection.models.ChatConversation as Model<IChatConversation>) ||
    connection.model<IChatConversation>("ChatConversation", ChatConversationSchema)
  );
}

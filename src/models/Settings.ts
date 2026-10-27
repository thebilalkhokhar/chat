import { Schema, Connection, Model } from "mongoose";

/**
 * Every setting an admin can change, in one document.
 *
 * These used to live in the environment, which meant changing a guardrail
 * required a redeploy — unacceptable for the things that decide whether a
 * stranger receives an automated email. They live in the database now, are read
 * fresh on every decision, and the environment supplies only the initial values
 * the first time the service starts.
 *
 * There is exactly one of these documents, found by `key: "singleton"`.
 */

export interface IQuoteFieldSetting {
  key: string;
  label: string;
  /** What the AI asks when this is the field it still needs. */
  question: string;
  /** A field can be switched off without changing code. */
  enabled: boolean;
  /** Treated as answered when nobody says otherwise, e.g. SKUs = "1". */
  defaultValue?: string;
}

export interface ISettings {
  key: "singleton";

  officeHours: {
    startHour: number;
    endHour: number;
    /** 0=Sunday … 6=Saturday. Days whose EVENING begins a shift. */
    shiftStartDays: number[];
  };

  eligibility: {
    /** Never contacted, whatever else is set. */
    excludedDomains: string[];
    /**
     * Lead sources that are not enquiries. Matched as lowercase substrings of
     * the CRM `source`, so "newsletter" covers every per-brand variant.
     */
    excludedSources: string[];
    /**
     * CRM tags that mean "never follow this up", matched the same way.
     *
     * Kept apart from `excludedSources` because the source cannot answer this
     * question. A trade show lead arrives under whatever the booth was called
     * that season — "Coffee Fest", "Winter Fair SAN DIEGO 2026", "SFA Show New
     * York" — and 1,388 of the 2,365 tagged ones carry no source at all. The tag
     * is the one field that is on all of them.
     */
    excludedTags: string[];
    /** Empty means every rep. */
    onlyRepEmail: string;
    /** Hand-picked test run; overrides the rep limit by design. */
    onlyLeadEmails: string[];
    /** Work through leads captured before the service started. */
    includeExistingLeads: boolean;
    /**
     * Interpretation A: a lead that arrived while the office was staffed
     * belongs to the colleague who was on shift, so it is never picked up.
     */
    skipCapturedDuringOfficeHours: boolean;
  };

  /**
   * The website chat bot.
   *
   * Separate from `sending` on purpose. Those settings hold an email back until
   * the office empties, because a staffed colleague should answer first. Chat is
   * the opposite: the visitor is on the page now, so the bot always answers.
   */
  chat: {
    /** Master switch for the chat bot alone. */
    enabled: boolean;
    /** Composes and stores replies, sends nothing back to SalesIQ. */
    dryRun: boolean;
    /** Turns the bot may take before handing over regardless of progress. */
    maxAiMessages: number;
    /**
     * Contact details to ask for, once the job details are known.
     *
     * A chat begins anonymous, so without these the lead reaches a rep with no
     * way to answer it. Asked after the quote fields, never before.
     */
    askContactFields: string[];
    /**
     * Alert the assigned rep in the ERP when a chat of theirs starts.
     *
     * Off until the ERP ids below are filled in: the endpoint rejects a user id
     * it does not know, and a switch that only produces 422s is not on.
     */
    notifyRepOfChats: boolean;
    /**
     * The bot answers every chat, day and night. Off, it steps aside during
     * office hours and hands each chat to the live agents on the first reply.
     */
    aiAllHours: boolean;
    /**
     * When to raise it.
     *
     * "first_message" waits until the visitor has typed, once — the widget
     * opening is not an enquiry. "every_message" raises one for every message
     * they send while the bot is still answering, which is what a rep watching
     * for a chat worth taking over actually wants. "chat_open" is the noisiest
     * and fires the moment the widget appears.
     */
    notifyRepOn: "chat_open" | "first_message" | "every_message";
    /**
     * The ERP's own user id for each rep, keyed by their email.
     *
     * The ERP identifies people by an integer of its own — not by email, and not
     * by the Zoho user id its quotes endpoint takes — so the two lists have to
     * be married up by hand. A rep with no id here is never alerted, and that is
     * said in the log rather than passed silently.
     */
    erpUserIds: Record<string, number>;
    /**
     * Also announce the chat in the team's WhatsApp group.
     *
     * The group is one room for everybody, so the message names the rep it
     * belongs to — an alert addressed to everyone is picked up by no one. Timed
     * by the same `notifyRepOn` rule as the ERP alert.
     */
    whatsappEnabled: boolean;
    /** The group or number written to, in the bridge's own form: …@g.us. */
    whatsappChatId: string;
    /**
     * Each rep's own WhatsApp, keyed by their email.
     *
     * The group tells the team; this tells the person. A rep with no number here
     * still hears about their chats in the group, which is where they are
     * easiest to miss — so a missing one is logged rather than passed over.
     */
    whatsappRepNumbers: Record<string, string>;
    /**
     * Where the alert sends the rep. `{chat_id}` is replaced.
     *
     * The ERP requires it even though its own documentation calls it optional,
     * so a blank one falls back to the path from that documentation's example.
     */
    chatUrlTemplate: string;
    /** Said when handing a visitor to a person. */
    handoffMessage: string;
    /**
     * Said to somebody who asks for a person while we still have no address.
     *
     * The hand-off waits one turn for this. A chat forwarded with no email is a
     * transcript: if nobody picks it up before they close the tab there is
     * nothing to write to in the morning, which is when most of these are
     * actually answered.
     */
    humanAskEmailMessage: string;
    /** Said as the chat goes to a person, once we can reach them. */
    humanConnectMessage: string;
    /**
     * Said to somebody who already bought from us and has a problem.
     *
     * They are not a quote to qualify. The script has nothing that helps a
     * customer whose order has not arrived, and running it at them anyway is
     * how a bad experience becomes a worse one — so the chat stops asking about
     * sizes and asks for what a rep needs to find them: name, account, number.
     */
    existingCustomerMessage: string;
    /**
     * Said to somebody looking for a job rather than for packaging.
     *
     * The ads draw them — three in one afternoon off the mylar-bags campaign —
     * and the script has nothing for any of them. Answered once, plainly, and
     * the chat stops: no more questions, and no lead, because a job seeker with
     * an email address is not a lead.
     */
    notACustomerMessage: string;
    /** Said once every quote field is in. */
    completeMessage: string;
    /**
     * Said when SalesIQ reports it could not carry out an action — usually that
     * no operator was free to take a forwarded chat. Without this the visitor is
     * left watching a typing indicator that never resolves.
     */
    failureMessage: string;
    /**
     * The reps chats are shared out between.
     *
     * One is chosen when a chat opens; the AI then speaks as that person and the
     * CRM lead is created under them. A rep without a Zoho sign-in is skipped
     * rather than used, because the lead is written with their own token and
     * there would be nothing to write it with.
     */
    repPool: string[];
    /**
     * The SalesIQ operator the live chat is forwarded to.
     *
     * A SalesIQ identity, which is not the same thing as a CRM one — the two
     * systems have separate user lists and an operator may exist in one and not
     * the other. Kept apart from `leadOwnerEmail` for exactly that reason.
     */
    /**
     * The agents a chat is offered to during working hours.
     *
     * SalesIQ takes a list and gives the chat to whoever accepts first, so this
     * is a pool rather than an assignment — the agent who picks it up becomes
     * the one handling it. Separate from `repPool`, which is who the bot speaks
     * AS; these are the people it hands over TO, and the two lists only happen
     * to overlap.
     */
    liveAgentEmails: string[];
    /** Said to the visitor as the chat is passed to those agents. */
    liveAgentMessage: string;
    /**
     * Who owns new CRM leads, in rotation order — see leadRotation.ts.
     *
     * Exactly three, and the order is the rotation: first, second, third. A
     * different set of people from `liveAgentEmails` on purpose: taking a chat
     * and owning the record are separate jobs, and one agent does the first
     * without ever doing the second.
     */
    crmLeadAgents: string[];
    /**
     * How far through the rotation we are. Advanced once per lead created.
     *
     * Persisted rather than derived from a lead count, because a chat that
     * matches a lead somebody already has never creates one, and counting
     * records would drift out of step with whose turn it actually is.
     */
    leadRotationAt: number;
    /** Whose turn it is to be the next chat's rep. Advanced once per chat opened — see repPool.ts. */
    repPoolAt?: number;
    handoffOperatorEmail: string;
    /**
     * The CRM rep the lead is created under.
     *
     * Must have a Zoho sign-in on file, because the lead is written using their
     * own token. An operator without one can still take the chat; they just
     * cannot be the author of a CRM record.
     */
    leadOwnerEmail: string;
    /**
     * The account that actually writes leads, with the rep named as owner.
     *
     * Needed because the reps' own Zoho profiles lost permission to create
     * leads — see leadWriter() in handoff.ts. Blank means write as the rep.
     */
    leadWriterEmail?: string;
    /** Also create the CRM lead on handoff, not just forward the chat. */
    writeLeadOnHandoff: boolean;
  };

  sending: {
    /**
     * Nothing is sent while the office is staffed. A customer should never get
     * an automated reply at a moment a real person could have answered, so a
     * message that comes due during a shift waits for the office to empty.
     */
    onlySendDuringOfflineHours: boolean;
    firstContactDelayMinutes: number;
    chaseAfterHours: number;
    /**
     * Copied on every email the AI sends, in the open.
     *
     * These are colleagues, so they are deliberately not subject to the
     * internal-domain exclusion: that rule decides who may be *written to* as a
     * lead, and being copied on a rep's own outgoing mail is a different thing.
     * Nothing here is ever treated as a lead, and a reply from one of these
     * addresses is not read as the customer's.
     */
    ccEmails: string[];
  };

  crm: {
    /** Applied to the Zoho lead the first time the AI writes to it. */
    tagLeads: boolean;
    tagName: string;
    /** Files a summary note on the lead after every exchange. */
    writeNotes: boolean;
  };

  guardrails: {
    maxAiMessages: number;
    maxConversationDays: number;
    stopWhenRepReplies: boolean;
    stopOnOptOut: boolean;
    /** Composes and stores, sends nothing. */
    dryRun: boolean;
  };

  /**
   * Facts about the business that the AI may state.
   *
   * The catalogue tells it what is sold; nothing told it where the company is,
   * so asked "where are you based?" it answered "I will get back to you about
   * our location" — safe, and an odd thing for a salesperson to write. These
   * are typed once by somebody who knows them, because inventing an address is
   * the one failure worse than not having one.
   */
  company: {
    /** Free text: address, hours, shipping regions, anything quotable. */
    facts: string;
  };

  ai: {
    provider?: "openai" | "custom";
    model: string;
    openaiApiKey?: string;
    apiKey?: string;
    baseURL?: string;
    /** Steers the writing: "friendly and brief", "formal", and so on. */
    tone: string;
    /** Free text appended to the prompt — house rules, phrases to avoid. */
    extraInstructions: string;
    signOffName: string;
  };

  quoteFields: IQuoteFieldSetting[];

  /** Master switch. Off means the worker looks at nothing at all. */
  enabled: boolean;

  updatedBy?: string;

  /**
   * When the worker last completed a pass, and what it did.
   *
   * Without this there is no way to tell a paused service from a worker that
   * is not running at all — both look identical from the dashboard, and the
   * difference is the whole question when nothing is being sent.
   */
  lastPassAt?: Date;
  lastPassSummary?: string;

  createdAt: Date;
  updatedAt: Date;
}

const QuoteFieldSchema = new Schema<IQuoteFieldSetting>(
  {
    key: { type: String, required: true },
    label: { type: String, required: true },
    question: { type: String, default: "" },
    enabled: { type: Boolean, default: true },
    defaultValue: { type: String, default: "" },
  },
  { _id: false }
);

const SettingsSchema = new Schema<ISettings>(
  {
    key: { type: String, default: "singleton", unique: true, index: true },

    officeHours: {
      startHour: { type: Number, default: 19, min: 0, max: 23 },
      endHour: { type: Number, default: 5, min: 0, max: 23 },
      shiftStartDays: { type: [Number], default: [1, 2, 3, 4, 5] },
    },

    eligibility: {
      excludedDomains: { type: [String], default: ["print247.us", "colorwing.com"] },
      excludedSources: { type: [String], default: ["newsletter", "website visit"] },
      excludedTags: { type: [String], default: ["trade show"] },
      onlyRepEmail: { type: String, default: "" },
      onlyLeadEmails: { type: [String], default: [] },
      includeExistingLeads: { type: Boolean, default: false },
      skipCapturedDuringOfficeHours: { type: Boolean, default: true },
    },

    chat: {
      enabled: { type: Boolean, default: false },
      // Safe by default, the same way email is: a fresh install composes and
      // stores but says nothing to a real visitor until somebody turns it on.
      dryRun: { type: Boolean, default: true },
      // Raised with the contact questions: six job details plus three contact
      // ones cannot fit in eight turns.
      maxAiMessages: { type: Number, default: 12 },
      askContactFields: { type: [String], default: ["name", "email", "phone"] },
      notifyRepOfChats: { type: Boolean, default: false },
      aiAllHours: { type: Boolean, default: true },
      notifyRepOn: {
        type: String,
        enum: ["chat_open", "first_message", "every_message"],
        default: "first_message",
      },
      erpUserIds: { type: Schema.Types.Mixed, default: {} },
      whatsappEnabled: { type: Boolean, default: false },
      whatsappChatId: { type: String, default: "" },
      whatsappRepNumbers: { type: Schema.Types.Mixed, default: {} },
      chatUrlTemplate: { type: String, default: "/admin/chat/{chat_id}" },
      handoffMessage: {
        type: String,
        default: "Let me get a colleague to help you with that — one moment.",
      },
      humanAskEmailMessage: {
        type: String,
        default:
          "Of course. I will connect with you in the morning — could you share your email so I can reach you there?",
      },
      humanConnectMessage: {
        type: String,
        default: "Great, thank you. I will connect with you in the morning.",
      },
      existingCustomerMessage: {
        type: String,
        default:
          "Thank you for reaching out! 😊 I'll make sure the right person from our team gets back to you during business hours.\n\nIn the meantime, please share your name, the account/company name associated with us, and your phone number. We'll pass the details along and make sure someone from the team gets in touch with you soon.",
      },
      notACustomerMessage: {
        type: String,
        default:
          "Thanks for getting in touch! This chat is for custom packaging and printing enquiries, so I'm not able to help with job applications here. For anything about working with us, please email Support@print247.us and the right team will pick it up.",
      },
      completeMessage: {
        type: String,
        // First person: the visitor has been talking to a named rep throughout,
        // so handing them to "a colleague" at the last moment contradicts it.
        default: "Thanks, that is everything I need. I'll get a quote over to you shortly.",
      },
      failureMessage: {
        type: String,
        default: "Thanks for your patience — I have your details and will come back to you shortly.",
      },
      repPool: {
        type: [String],
        default: [
          "alex.kane@print247.us",
          "frank.castle@print247.us",
          "harry.brook@print247.us",
          "jessica.joe@print247.us",
        ],
      },
      liveAgentEmails: {
        type: [String],
        // Brian is `briantylar`, not the house pattern. Harry is the Print247
        // one — there is a second Harry at Colorwing who belongs in neither list.
        default: [
          "frank.castle@print247.us",
          "briantylar@print247.us",
          "harry.brook@print247.us",
          "jessica.joe@print247.us",
        ],
      },
      liveAgentMessage: {
        type: String,
        default: "One moment — I'm bringing a packaging specialist into the chat to help you with this.",
      },
      crmLeadAgents: {
        type: [String],
        // Frank, Brian, Harry — in rotation order. Brian signs in as
        // `briantylar`, not the house pattern. Harry stays on print247.us: the
        // only Harry with a Zoho sign-in is the Colorwing one, who is a
        // different person, and Print247 leads must not go to him.
        default: ["frank.castle@print247.us", "briantylar@print247.us", "harry.brook@print247.us"],
      },
      leadRotationAt: { type: Number, default: 0 },
      repPoolAt: { type: Number, default: 0 },
      handoffOperatorEmail: { type: String, default: "johnhenry.it@print247.us" },
      leadOwnerEmail: { type: String, default: "nancy.wilson@print247.us" },
      leadWriterEmail: { type: String, default: "linda.james@print247.us" },
      writeLeadOnHandoff: { type: Boolean, default: true },
    },

    sending: {
      onlySendDuringOfflineHours: { type: Boolean, default: true },
      firstContactDelayMinutes: { type: Number, default: 15 },
      chaseAfterHours: { type: Number, default: 48 },
      ccEmails: { type: [String], default: [] },
    },

    crm: {
      tagLeads: { type: Boolean, default: true },
      tagName: { type: String, default: "Ai Follow Up" },
      writeNotes: { type: Boolean, default: true },
    },

    guardrails: {
      maxAiMessages: { type: Number, default: 5 },
      maxConversationDays: { type: Number, default: 21 },
      stopWhenRepReplies: { type: Boolean, default: true },
      stopOnOptOut: { type: Boolean, default: true },
      // Safe by default: a fresh install must not email anybody until somebody
      // deliberately turns sending on.
      dryRun: { type: Boolean, default: true },
    },

    company: {
      facts: { type: String, default: "" },
    },

    ai: {
      provider: { type: String, default: "openai" },
      model: { type: String, default: "gpt-5-nano" },
      openaiApiKey: { type: String, default: "" },
      apiKey: { type: String, default: "" },
      baseURL: { type: String, default: "" },
      tone: { type: String, default: "friendly, brief and professional" },
      extraInstructions: { type: String, default: "" },
      signOffName: { type: String, default: "" },
    },

    quoteFields: { type: [QuoteFieldSchema], default: [] },

    enabled: { type: Boolean, default: false },
    updatedBy: { type: String, default: "" },
    lastPassAt: { type: Date },
    lastPassSummary: { type: String, default: "" },
  },
  { timestamps: true, collection: "settings" }
);

export function settingsModel(connection: Connection): Model<ISettings> {
  return (
    (connection.models.Settings as Model<ISettings>) ||
    connection.model<ISettings>("Settings", SettingsSchema)
  );
}

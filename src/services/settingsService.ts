import type { Connection } from "mongoose";
import { config } from "../config/env";
import { QUOTE_FIELDS, DEFAULTED_FIELDS } from "../domain/quoteFields";
import { DEFAULT_COMPANY_FACTS } from "../domain/companyKnowledge";
import { settingsModel, ISettings } from "../models/Settings";

/**
 * Reading and writing the live settings.
 *
 * Cached for a few seconds rather than per-request: the worker consults these
 * on every decision it makes, and hitting Mongo each time would be wasteful —
 * but a guardrail change must take effect quickly, not on the next deploy, so
 * the window is deliberately short.
 *
 * Any write clears the cache immediately, so an admin who saves a change and
 * reloads sees what they actually saved rather than a stale copy.
 */

const CACHE_TTL_MS = 5000;

/**
 * Said to somebody looking for a job rather than for packaging.
 *
 * Here as well as on the schema because it has to reach settings documents that
 * already exist — see the patch below. Points them somewhere real: turning
 * people away with nowhere to go is how a fair answer still reads as a door
 * being shut.
 */
const NOT_A_CUSTOMER_MESSAGE =
  "Thanks for getting in touch! This chat is for custom packaging and printing enquiries, so I'm not able to help with job applications here. For anything about working with us, please email Support@print247.us and the right team will pick it up.";

/**
 * The agents a chat is offered to during working hours.
 *
 * Brian is `briantylar` — no dot, and tylar, not taylor — which is the same
 * address he signs into Zoho with, confirmed by the team. Harry is the Print247
 * one; there is a second Harry at Colorwing who must never appear in either of
 * these lists.
 *
 * Jessica belongs here and nowhere else: she takes live chats and never owns a
 * CRM record, which is the whole reason this list and `crmLeadAgents` are kept
 * apart.
 */
const LIVE_AGENT_EMAILS = [
  "frank.castle@print247.us",
  "briantylar@print247.us",
  "harry.brook@print247.us",
  "jessica.joe@print247.us",
];

const LIVE_AGENT_MESSAGE =
  "One moment — I'm bringing a packaging specialist into the chat to help you with this.";

/**
 * Who owns new CRM leads, in rotation order: Frank, Brian, Harry.
 *
 * Brian is `briantylar` — no dot, and tylar, not taylor. Found by reading the
 * Zoho sign-ins; the house pattern is wrong for him.
 *
 * Harry must stay on print247.us even though no sign-in exists for it yet.
 * There are TWO Harrys — one at Print247 and one at Colorwing — and only the
 * Colorwing one has authorised Zoho. Pointing this slot at colorwing.com would
 * hand Print247 leads to another company's rep, so it stays as it is and the
 * rotation passes the turn over until the Print247 Harry signs in.
 *
 * An address with no sign-in behind it does not fail loudly — the rotation just
 * skips that agent and logs — so check these against the sign-in list whenever
 * the split looks wrong.
 */
const CRM_LEAD_AGENTS = [
  "frank.castle@print247.us",
  "briantylar@print247.us",
  "harry.brook@print247.us",
];

let cached: { value: ISettings; readAt: number } | null = null;

/** First-run values, taken from the environment so an existing .env still counts. */
function seedFromEnvironment(): Partial<ISettings> {
  return {
    key: "singleton",
    officeHours: {
      startHour: config.officeHours.startHour,
      endHour: config.officeHours.endHour,
      shiftStartDays: [...config.officeHours.shiftStartDays],
    },
    eligibility: {
      excludedDomains: [...config.eligibility.excludedDomains],
      excludedSources: [...config.eligibility.excludedSources],
      excludedTags: ["trade show"],
      onlyRepEmail: config.eligibility.onlyRepEmail,
      onlyLeadEmails: [...config.eligibility.onlyLeadEmails],
      includeExistingLeads: config.eligibility.includeExistingLeads,
      skipCapturedDuringOfficeHours: true,
    },
    chat: {
      enabled: config.salesiq.enabled,
      dryRun: config.salesiq.dryRun,
      maxAiMessages: config.salesiq.maxAiMessages,
      askContactFields: [...config.salesiq.askContactFields],
      notifyRepOfChats: false,
      aiAllHours: true,
      notifyRepOn: "first_message",
      erpUserIds: {},
      whatsappEnabled: false,
      whatsappChatId: "",
      whatsappRepNumbers: {},
      chatUrlTemplate: "/admin/chat/{chat_id}",
      handoffMessage: "Let me get a colleague to help you with that — one moment.",
      humanAskEmailMessage:
        "Of course. I will connect with you in the morning — could you share your email so I can reach you there?",
      humanConnectMessage: "Great, thank you. I will connect with you in the morning.",
      existingCustomerMessage:
        "Thank you for reaching out! 😊 I'll make sure the right person from our team gets back to you during business hours.\n\nIn the meantime, please share your name, the account/company name associated with us, and your phone number. We'll pass the details along and make sure someone from the team gets in touch with you soon.",
      notACustomerMessage: NOT_A_CUSTOMER_MESSAGE,
      liveAgentEmails: LIVE_AGENT_EMAILS,
      liveAgentMessage: LIVE_AGENT_MESSAGE,
      crmLeadAgents: CRM_LEAD_AGENTS,
      leadRotationAt: 0,
      completeMessage: "Thanks, that is everything I need. I'll get a quote over to you shortly.",
      failureMessage: "Thanks for your patience — I have your details and will come back to you shortly.",
      repPool: [...config.salesiq.repPool],
      handoffOperatorEmail: config.salesiq.handoffOperatorEmail,
      leadOwnerEmail: config.salesiq.leadOwnerEmail,
      writeLeadOnHandoff: true,
    },
    sending: {
      onlySendDuringOfflineHours: true,
      firstContactDelayMinutes: config.worker.firstContactDelayMinutes,
      chaseAfterHours: config.worker.chaseAfterHours,
      ccEmails: [...config.mail.ccEmails],
    },
    crm: {
      tagLeads: true,
      tagName: "Ai Follow Up",
      writeNotes: true,
    },
    guardrails: {
      maxAiMessages: config.guardrails.maxAiMessages,
      maxConversationDays: config.guardrails.maxConversationDays,
      stopWhenRepReplies: config.guardrails.stopWhenRepReplies,
      stopOnOptOut: config.guardrails.stopOnOptOut,
      dryRun: config.guardrails.dryRun,
    },
    company: {
      facts: DEFAULT_COMPANY_FACTS,
    },
    ai: {
      provider: "openai",
      model: config.openai.model || "gpt-5-nano",
      openaiApiKey: "",
      apiKey: "",
      baseURL: "",
      tone: "friendly, brief and professional",
      extraInstructions: "",
      signOffName: "",
    },
    quoteFields: QUOTE_FIELDS.map((field) => ({
      key: field.key,
      label: field.label,
      question: field.question,
      enabled: true,
      defaultValue: DEFAULTED_FIELDS[field.key] || "",
    })),
    // A fresh install is inert until somebody turns it on deliberately.
    enabled: false,
  };
}

/**
 * Adds any guardrail a running install predates, once, and returns the settings
 * as they now stand.
 */
async function backfillMissingGuardrails(
  Settings: ReturnType<typeof settingsModel>,
  settings: ISettings
): Promise<ISettings> {
  const patch: Record<string, unknown> = {};

  if (!Array.isArray(settings.eligibility?.excludedSources)) {
    patch["eligibility.excludedSources"] = [...config.eligibility.excludedSources];
  }

  // Trade show leads belong to the rep who met the person at the booth, and are
  // not this service's to chase. An install from before the rule has no list at
  // all, which reads as "exclude nothing" and would keep emailing them.
  if (!Array.isArray(settings.eligibility?.excludedTags)) {
    patch["eligibility.excludedTags"] = ["trade show"];
  }

  // The chat bot arrived after this install was already running, so its whole
  // settings block is absent from the stored document. Without this the engine
  // reads `undefined.maxAiMessages` on the first visitor and the reply never
  // comes — the same failure the excluded-sources backfill above exists to stop.
  if (!settings.chat || typeof settings.chat.maxAiMessages !== "number") {
    patch["chat"] = {
      enabled: config.salesiq.enabled,
      dryRun: config.salesiq.dryRun,
      maxAiMessages: config.salesiq.maxAiMessages,
      askContactFields: [...config.salesiq.askContactFields],
      handoffMessage: "Let me get a colleague to help you with that — one moment.",
      humanAskEmailMessage:
        "Of course. I will connect with you in the morning — could you share your email so I can reach you there?",
      humanConnectMessage: "Great, thank you. I will connect with you in the morning.",
      completeMessage: "Thanks, that is everything I need. I'll get a quote over to you shortly.",
      failureMessage: "Thanks for your patience — I have your details and will come back to you shortly.",
      repPool: [...config.salesiq.repPool],
      handoffOperatorEmail: config.salesiq.handoffOperatorEmail,
      leadOwnerEmail: config.salesiq.leadOwnerEmail,
      writeLeadOnHandoff: true,
    };
  }

  // Added after the chat block itself, so an install that already has `chat`
  // still gains the handoff settings rather than silently forwarding nowhere.
  if (settings.chat && !settings.chat.handoffOperatorEmail) {
    patch["chat.handoffOperatorEmail"] = config.salesiq.handoffOperatorEmail;
    patch["chat.writeLeadOnHandoff"] = true;
  }

  // `leadOwnerEmail` was split out of `handoffOperatorEmail` once it turned out
  // the SalesIQ operator taking the chat has no CRM sign-in, and so cannot be
  // the author of the lead. An install from before the split has the operator
  // in both roles, which would fail every lead write.
  if (settings.chat && !settings.chat.leadOwnerEmail) {
    patch["chat.leadOwnerEmail"] = config.salesiq.leadOwnerEmail;
  }

  // The reps' own profiles lost permission to create leads, so the write is
  // made by an admin account with the rep named as owner — see handoff.ts.
  if (settings.chat && settings.chat.leadWriterEmail === undefined) {
    patch["chat.leadWriterEmail"] = config.salesiq.leadWriterEmail;
  }

  // The rep pool replaced a single fixed owner. An install from before it has no
  // pool at all, which would leave every chat without a rep to speak as.
  if (settings.chat && !Array.isArray(settings.chat.repPool)) {
    patch["chat.repPool"] = [...config.salesiq.repPool];
  }

  // Added with the failure handler. An install without it would answer a
  // SalesIQ failure with an empty string and leave the visitor hanging.
  // The closing line was written before the bot spoke as a named rep, so it
  // handed the visitor to "a colleague" after they had been talking to one
  // person throughout. Replaced only when it is still word-for-word the old
  // default — anything an admin has edited is theirs and is left alone.
  const OLD_COMPLETE =
    "Thanks, that is everything I need. A colleague will come back to you shortly with a quote.";
  if (settings.chat && settings.chat.completeMessage === OLD_COMPLETE) {
    patch["chat.completeMessage"] =
      "Thanks, that is everything I need. I'll get a quote over to you shortly.";
  }

  // Added with the contact questions. Without it the engine reads an undefined
  // list, asks for nothing, and files leads with no way to reach anybody.
  if (settings.chat && !Array.isArray(settings.chat.askContactFields)) {
    patch["chat.askContactFields"] = [...config.salesiq.askContactFields];
    // Eight turns was set when there were only six things to ask.
    if (settings.chat.maxAiMessages && settings.chat.maxAiMessages < 12) {
      patch["chat.maxAiMessages"] = 12;
    }
  }

  // Added when the hand-off started asking for an address first. An install
  // without them would forward the chat with an empty message.
  if (settings.chat && !settings.chat.humanAskEmailMessage) {
    patch["chat.humanAskEmailMessage"] =
      "Of course. I will connect with you in the morning — could you share your email so I can reach you there?";
  }

  if (settings.chat && !settings.chat.humanConnectMessage) {
    patch["chat.humanConnectMessage"] = "Great, thank you. I will connect with you in the morning.";
  }

  // Added with the ERP alert. An install without them reads `undefined` for the
  // switch, which is off, and for the id map, which would throw on lookup.
  // The team asked for the bot on every chat, all day. An install from before
  // the switch existed gets it on.
  if (settings.chat && typeof settings.chat.aiAllHours !== "boolean") {
    patch["chat.aiAllHours"] = true;
  }

  if (settings.chat && typeof settings.chat.notifyRepOfChats !== "boolean") {
    patch["chat.notifyRepOfChats"] = false;
    patch["chat.notifyRepOn"] = "first_message";
    patch["chat.erpUserIds"] = {};
    patch["chat.chatUrlTemplate"] = "/admin/chat/{chat_id}";
  }

  // Added with the WhatsApp alert. Off, and with nowhere to send, until set.
  if (settings.chat && typeof settings.chat.whatsappEnabled !== "boolean") {
    patch["chat.whatsappEnabled"] = false;
    patch["chat.whatsappChatId"] = "";
    patch["chat.whatsappRepNumbers"] = {};
  }

  // Added after the group message, when the personal one followed it.
  if (settings.chat && !settings.chat.whatsappRepNumbers) {
    patch["chat.whatsappRepNumbers"] = {};
  }

  /**
   * "auto" is gone, and so are the providers it used to cascade through.
   *
   * It hid which model was really running: under "auto" the dashboard's model
   * was ignored and OPENAI_MODEL decided, so the settings page could say
   * gpt-5-nano while something else answered every chat. Converted to "openai"
   * carrying the model "auto" was actually using, so nothing changes under
   * anyone's feet at the deploy.
   */
  if (settings.ai && (settings.ai as any).provider !== "openai" && (settings.ai as any).provider !== "custom") {
    patch["ai.provider"] = "openai";
    patch["ai.model"] = config.openai.model || settings.ai?.model || "gpt-5-nano";
  }

  // Gemini's model name is the half that bites — "gemini-3.1-flash-lite" sitting
  // in ai.model would be handed straight to OpenAI, which has never heard of it,
  // and 404 every single call. The provider itself is handled above.

  if (settings.ai?.model && /^gemini|^meta\/|^deepseek/i.test(settings.ai.model)) {
    patch["ai.model"] = config.openai.model || "gpt-5-nano";
  }

  // Added when the bot stopped qualifying job seekers as enquiries. Without the
  // patch an existing settings document has no message, and the check that uses
  // it is switched off by an empty string — so the chats this was written for
  // would carry on exactly as they did.
  if (settings.chat && !settings.chat.notACustomerMessage) {
    patch["chat.notACustomerMessage"] = NOT_A_CUSTOMER_MESSAGE;
  }

  // Added when working-hours chats started going to a person instead of the
  // bot. Both have to land, and an empty list or an empty message switches the
  // hand-over off — which on an existing settings document is what they are.
  if (settings.chat && !(settings.chat.liveAgentEmails || []).length) {
    patch["chat.liveAgentEmails"] = LIVE_AGENT_EMAILS;
  }
  if (settings.chat && !settings.chat.liveAgentMessage) {
    patch["chat.liveAgentMessage"] = LIVE_AGENT_MESSAGE;
  }

  // Added when lead ownership stopped following whoever took the chat. An empty
  // list leaves the old behaviour in place rather than dropping leads, so this
  // has to land for the rotation to start.
  if (settings.chat && !(settings.chat.crmLeadAgents || []).length) {
    patch["chat.crmLeadAgents"] = CRM_LEAD_AGENTS;
  }

  // Added when the bot stopped qualifying existing customers as new enquiries.
  if (settings.chat && !settings.chat.existingCustomerMessage) {
    patch["chat.existingCustomerMessage"] =
      "Thank you for reaching out! 😊 I'll make sure the right person from our team gets back to you during business hours.\n\nIn the meantime, please share your name, the account/company name associated with us, and your phone number. We'll pass the details along and make sure someone from the team gets in touch with you soon.";
  }

  if (settings.chat && !settings.chat.failureMessage) {
    patch["chat.failureMessage"] =
      "Thanks for your patience — I have your details and will come back to you shortly.";
  }

  /**
   * A quote field added after this install was already running.
   *
   * `quoteFields` is stored, and the extractor builds its schema from the stored
   * copy — so a field that exists only in code is never read out of a customer's
   * reply and never asked for. `extras` is step five of the bag script; without
   * this backfill the team's own question would silently not be asked.
   */
  if (Array.isArray(settings.quoteFields)) {
    const known = new Set(settings.quoteFields.map((field) => field.key));
    const missing = QUOTE_FIELDS.filter((field) => !known.has(field.key));

    if (missing.length) {
      patch["quoteFields"] = [
        ...settings.quoteFields,
        ...missing.map((field) => ({
          key: field.key,
          label: field.label,
          question: field.question,
          enabled: true,
          defaultValue: DEFAULTED_FIELDS[field.key] || "",
        })),
      ];
    }
  }

  if (!settings.ai || !settings.ai.provider) {
    patch["ai.provider"] = "auto";
  }
  if (!settings.ai?.model) {
    patch["ai.model"] = config.openai.model || "gpt-5-nano";
  }

  if (Object.keys(patch).length === 0) return settings;

  const updated = await Settings.findOneAndUpdate(
    { key: "singleton" },
    { $set: patch },
    { new: true }
  ).lean<ISettings>();

  console.log(`[settings] backfilled missing guardrail(s): ${Object.keys(patch).join(", ")}`);
  return updated || settings;
}

/**
 * The live settings, creating them from the environment on first run.
 *
 * `upsert` rather than find-then-create: two workers booting at once would
 * otherwise race and one would fail on the unique index.
 */
export async function getSettings(connection: Connection, force = false): Promise<ISettings> {
  if (!force && cached && Date.now() - cached.readAt < CACHE_TTL_MS) {
    return cached.value;
  }

  const Settings = settingsModel(connection);

  const settings = await Settings.findOneAndUpdate(
    { key: "singleton" },
    { $setOnInsert: seedFromEnvironment() },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  ).lean<ISettings>();

  // A guardrail added after an install was already running is absent from its
  // stored document: `$setOnInsert` only fires on creation, and a lean read
  // applies no schema defaults. Filled in from the environment rather than left
  // empty, because an unset exclusion list would read as "exclude nothing" and
  // quietly start emailing the very people it was added to protect.
  const backfilled = await backfillMissingGuardrails(Settings, settings);

  cached = { value: backfilled, readAt: Date.now() };
  return backfilled;
}

/** Applies a partial change and returns the whole updated document. */
export async function updateSettings(
  connection: Connection,
  patch: Record<string, unknown>,
  updatedBy: string
): Promise<ISettings> {
  const Settings = settingsModel(connection);

  const updated = await Settings.findOneAndUpdate(
    { key: "singleton" },
    { $set: { ...patch, updatedBy } },
    { new: true, upsert: true }
  ).lean<ISettings>();

  // Cleared, not refreshed: the next read should go to the database so a
  // rejected or coerced value is seen as it was actually stored.
  cached = null;
  return updated;
}

export function clearSettingsCache(): void {
  cached = null;
}

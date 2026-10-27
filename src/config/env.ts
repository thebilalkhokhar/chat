import dotenv from "dotenv";

dotenv.config();

/**
 * Configuration, read once and validated at boot.
 *
 * A worker that runs unattended must fail on the launch pad rather than three
 * hours later mid-conversation, so anything required is checked here and the
 * process refuses to start without it.
 */

function required(name: string): string {
  const value = process.env[name];
  if (!value || !value.trim()) {
    throw new Error(
      `${name} is not set. Copy .env.example to .env and fill it in before starting the worker.`
    );
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : fallback;
}

function number(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw || !raw.trim()) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a number, got "${raw}".`);
  }
  return parsed;
}

function boolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || !raw.trim()) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

/**
 * Wraps a bare base64 key in PEM armour if it arrived without it, so the value
 * copied straight out of the SalesIQ portal can be pasted in as-is.
 */
function normalisePublicKey(raw: string): string {
  const value = raw.trim();
  if (!value) return "";

  // An environment variable cannot hold a real line break, so a pasted PEM
  // arrives with its newlines written as a literal backslash-n. Put them back.
  if (value.includes("BEGIN")) return value.split("\\n").join("\n");

  const body = value.replace(/\s+/g, "").match(/.{1,64}/g)?.join("\n") || "";
  return ["-----BEGIN PUBLIC KEY-----", body, "-----END PUBLIC KEY-----"].join("\n");
}

function getAppBaseUrl(): string {
  const direct = process.env.APP_BASE_URL?.trim();
  if (direct) return direct.replace(/\/+$/, "");
  const railway = process.env.RAILWAY_PUBLIC_DOMAIN?.trim();
  if (railway) {
    const prefixed = railway.startsWith("http://") || railway.startsWith("https://") ? railway : `https://${railway}`;
    return prefixed.replace(/\/+$/, "");
  }
  return "https://lead-follow-up-production.up.railway.app";
}

export const config = {
  /**
   * The public base URL of this application, used for public links (such as mobile chat web views).
   */
  appBaseUrl: getAppBaseUrl(),
  /**
   * One cluster, two databases. Leads and the reps' Zoho grants live in one;
   * the mail the connector has already synced lives in the other. The URI
   * carries a default database, and each connection names the one it wants.
   */
  mongoUri: required("MONGO_URI"),
  leadsDb: optional("LEADS_DB", "zoho_exhibitions_rep_data"),
  connectorDb: optional("CONNECTOR_DB", "zoho_connector"),

  zoho: {
    region: optional("ZOHO_REGION", "com"),
    /** The login client the per-rep refresh tokens were issued to. */
    clientId: required("ZOHO_LOGIN_CLIENT_ID"),
    clientSecret: required("ZOHO_LOGIN_CLIENT_SECRET"),
    /** Used only when a rep's own address is rejected as a sender. */
    fallbackSenderEmail: optional("ZOHO_SENDER_EMAIL", ""),
  },

  auth: {
    /**
     * Signs dashboard sessions. Generated per install; changing it logs
     * everybody out, which is the intended way to revoke every session at once.
     */
    secret: required("AUTH_SECRET"),
  },

  /** Dashboard HTTP port. Railway supplies PORT. */
  port: number("PORT", 3000),

  /**
   * The ERP, which is where quotes actually live.
   *
   * Optional: without it the Quotes tab says so rather than failing. The token
   * is a long-lived bearer, so it belongs in the environment and never in the
   * settings document the dashboard can display.
   */
  erp: {
    baseUrl: optional("ERP_BASE_URL", "https://erp.print247.us").replace(/\/+$/, ""),
    token: optional("ERP_API_TOKEN", ""),
    /**
     * A separate credential from the one above, because the ERP has two doors.
     * It mints the short-lived token the pouch price calculator wants — see
     * erpPricing.ts.
     */
    refreshToken: optional("ERP_REFRESH_TOKEN", ""),
    /** The chat's instant price for flat and stand up pouches. Off switch, not a setting. */
    instantPricing: boolean("ERP_INSTANT_PRICING", true),
  },

  /**
   * Vercel Blob, where files shared in a chat are kept.
   *
   * SalesIQ's own links to them stop working once the chat is over, so each file
   * is copied here while the link still works. Optional: without a token the
   * transcript shows SalesIQ's link for as long as it lasts.
   */
  blob: {
    token: optional("BLOB_READ_WRITE_TOKEN", ""),
  },

  /**
   * The main backend (print247-node), for ecommerce lead figures by traffic
   * source beside the chat funnel. Signs in with an ordinary backend account
   * and only reads. Optional: without the account the page shows chat figures only.
   */
  backend: {
    baseUrl: optional("BACKEND_URL", "https://print247-node.vercel.app").replace(/\/+$/, ""),
    email: optional("BACKEND_EMAIL", ""),
    password: optional("BACKEND_PASSWORD", ""),
  },

  /**
   * The WhatsApp bridge the team's group lives behind.
   *
   * A session id and a key, both credentials, so both belong here rather than in
   * the settings document the dashboard can display. Which group is written to
   * is not a credential and is a setting.
   */
  whatsapp: {
    baseUrl: optional("WHATSAPP_BASE_URL", "").replace(/\/+$/, ""),
    sessionId: optional("WHATSAPP_SESSION_ID", ""),
    apiKey: optional("WHATSAPP_API_KEY", ""),
  },

  /**
   * The model the bot writes with.
   *
   * gpt-5-nano over gpt-4o-mini: cheaper, and answered 1.3-2.2s against
   * gpt-4o-mini's 0.7-1.7s in testing — comparable, not worse — while passing
   * every rule check the chat script depends on: the MOQ only volunteered when
   * asked or under the minimum, size units queried, no quote pre-announced, one
   * question per message. It is a reasoning model and takes a fixed
   * temperature, which aiClient.ts strips before the call rather than every
   * caller needing to know that.
   */
  openai: {
    apiKey: optional("OPENAI_API_KEY", ""),
    baseURL: optional("OPENAI_BASE_URL", "https://api.openai.com/v1"),
    model: optional("OPENAI_MODEL", "gpt-5-nano"),
  },

  /**
   * Addresses copied on every email the AI sends.
   *
   * Seeds the setting of the same name on first run; after that the dashboard
   * owns it. Internal addresses belong here on purpose — being copied on a
   * rep's outgoing mail is not the same as being written to as a lead, so
   * EXCLUDED_EMAIL_DOMAINS does not apply and must not be relaxed for it.
   */
  mail: {
    ccEmails: optional("CC_EMAILS", "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  },

  /**
   * The SalesIQ chat bot.
   *
   * Chat is the one place this service answers somebody who is waiting, so it
   * is deliberately separate from the email settings above: none of the office
   * hours, contact delays or per-rep limits apply to a visitor who has just
   * opened a chat window and asked a question.
   */
  salesiq: {
    /**
     * Shared secret SalesIQ presents on every call to the bot webhook.
     *
     * The webhook cannot use the dashboard's session cookie, so this is the
     * only thing standing between the endpoint and the open internet. Empty
     * means the endpoint rejects everything, which is the right failure: an
     * unauthenticated bot webhook would let anyone spend the OpenAI budget.
     */
    webhookToken: optional("SALESIQ_WEBHOOK_TOKEN", ""),
    /**
     * SalesIQ's RSA public key, for checking the signature it attaches to every
     * event. This — not a shared secret — is how SalesIQ actually proves a call
     * came from it: the portal shows the key and signs each payload with the
     * matching private key.
     *
     * Accepted with or without the PEM armour, because the portal shows the
     * base64 body on its own and pasting exactly what is on screen should work.
     */
    publicKey: normalisePublicKey(optional("SALESIQ_PUBLIC_KEY", "")),
    /**
     * Capture mode: record and answer a request whose signature did not verify,
     * instead of rejecting it.
     *
     * On while the contract is being measured — the signature header's name is
     * one of the unknowns, and rejecting everything unverified would mean
     * capturing nothing and learning nothing. Safe only because this mode calls
     * no model and answers with a fixed string, so an unverified caller costs
     * nothing. It must be off before the bot starts composing real replies.
     */
    captureUnverified: boolean("SALESIQ_CAPTURE_UNVERIFIED", false),
    /**
     * SalesIQ's REST API, for what this plan's webhooks never send: which rep took a
     * chat over, and what was said after they did (operatorSync.ts). A refresh token
     * for a client granted SalesIQ.conversations.READ and SalesIQ.operators.READ —
     * see scripts/salesIqConnect.ts. Empty leaves the sync off.
     */
    apiRefreshToken: optional("SALESIQ_API_REFRESH_TOKEN", ""),
    /**
     * Without a token above, the stored Zoho sign-in that carries SalesIQ access is
     * used; this names whose to try first (any SalesIQ admin).
     */
    apiUserEmail: optional("SALESIQ_API_USER_EMAIL", "support@print247.us"),
    /** The client the token was issued to; defaults to the Zoho login client. */
    apiClientId: optional("SALESIQ_API_CLIENT_ID", ""),
    apiClientSecret: optional("SALESIQ_API_CLIENT_SECRET", ""),
    /** The portal's name in SalesIQ URLs (salesiq.zoho.com/<screen name>/…). */
    screenName: optional("SALESIQ_SCREEN_NAME", "print247usllc"),
    /** Seeds `chat.enabled`. Off until somebody turns the bot on deliberately. */
    enabled: boolean("SALESIQ_ENABLED", false),
    /** Seeds `chat.dryRun`. Composes and stores, says nothing to a visitor. */
    dryRun: boolean("SALESIQ_DRY_RUN", true),
    /** Seeds `chat.maxAiMessages`. */
    maxAiMessages: number("SALESIQ_MAX_AI_MESSAGES", 12),
    /** Seeds `chat.askContactFields`. Blank asks for no contact details at all. */
    askContactFields: optional("SALESIQ_ASK_CONTACT", "name,email,phone")
      .split(",")
      .map((key) => key.trim().toLowerCase())
      .filter(Boolean),
    /**
     * Seeds `chat.handoffOperatorEmail`: the rep a qualified chat is forwarded
     * to, and who the resulting CRM lead is created under. They need a Zoho
     * sign-in on file or the lead cannot be written as them.
     */
    /**
     * Seeds `chat.repPool`: the reps chats are shared between.
     *
     * print247 only. The colorwing operators are deliberately absent — the chat
     * runs on print247.us and a lead from it should not land with another
     * brand's rep.
     */
    repPool: optional(
      "SALESIQ_REP_POOL",
      "frank.castle@print247.us,harry.brook@print247.us,jessica.joe@print247.us,paul.smith@print247.us,ethan.wilson@print247.us,briantylar@print247.us"
    )
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
    handoffOperatorEmail: optional("SALESIQ_HANDOFF_OPERATOR", "johnhenry.it@print247.us").toLowerCase(),
    /**
     * Seeds `chat.leadOwnerEmail`: who the CRM lead is written as.
     *
     * Separate from the operator above because SalesIQ and the CRM keep
     * different user lists. The lead is created with this rep's own token, so
     * this address must have a Zoho sign-in on file; the operator need not.
     */
    leadOwnerEmail: optional("SALESIQ_LEAD_OWNER", "nancy.wilson@print247.us").toLowerCase(),
    /**
     * Seeds `chat.leadWriterEmail`: the account that makes the CRM write, with
     * the chat's rep named as the owner. An admin, because the reps' own
     * profiles are refused `Crm_Implied_Create_Leads`.
     */
    leadWriterEmail: optional("SALESIQ_LEAD_WRITER", "linda.james@print247.us").toLowerCase(),
    /** What the bot says while the integration is still being measured. */
    captureReply: optional(
      "SALESIQ_CAPTURE_REPLY",
      "Thanks for getting in touch! One of our team will be with you shortly."
    ),
  },

  worker: {
    /** How often the loop looks for work. Email is not a real-time medium. */
    pollSeconds: number("WORKER_POLL_SECONDS", 30),
    /** Wait after a lead is captured before the first email. */
    firstContactDelayMinutes: number("FIRST_CONTACT_DELAY_MINUTES", 15),
    /** Wait before chasing a customer who has not replied. */
    chaseAfterHours: number("CHASE_AFTER_HOURS", 48),
  },

  /**
   * The hours the office is staffed, in Pakistan time.
   *
   * The team works 7pm to 5am — night locally, daytime for the customers they
   * serve. This service covers the gap: a lead that arrives while somebody is
   * at a desk belongs to that person, not to an automation.
   */
  officeHours: {
    startHour: number("OFFICE_START_HOUR", 19),
    endHour: number("OFFICE_END_HOUR", 5),
    /**
     * Days whose evening begins a shift, 0=Sunday … 6=Saturday.
     *
     * Monday to Friday. Friday's shift still ends on Saturday morning, so the
     * weekend gap runs Saturday 05:00 to Monday 19:00 — the longest stretch
     * this service is on its own.
     */
    shiftStartDays: optional("OFFICE_SHIFT_DAYS", "1,2,3,4,5")
      .split(",")
      .map((d) => Number(d.trim()))
      .filter((d) => Number.isInteger(d) && d >= 0 && d <= 6),
  },

  /**
   * Who is eligible to receive a conversation at all.
   *
   * Two separate gates, because they fail differently. The domain exclusion
   * stops the service emailing colleagues: the exhibition app is used for
   * internal testing, and several captured "leads" are staff addresses that
   * would otherwise receive AI mail from each other. The rep restriction is a
   * blast radius — while the system is new, only one rep's customers can be
   * written to, so a mistake reaches their leads and nobody else's.
   */
  eligibility: {
    /** Never emailed, whoever captured them. Comma-separated domains. */
    excludedDomains: optional("EXCLUDED_EMAIL_DOMAINS", "print247.us,colorwing.com")
      .split(",")
      .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
      .filter(Boolean),
    /**
     * Sources that mean "this person never asked us anything".
     *
     * A newsletter signup subscribed to a mailing list and a website visit is a
     * page view Zoho logged by itself — neither is an enquiry, and writing to
     * them as the rep who "captured" them would be unprompted cold mail. Held
     * as lowercase substrings of the CRM source so one entry covers every
     * per-brand variant ("Colorwing Newsletter", "Print247 Newsletter",
     * "Newsletter Signup"). Quote requests such as "Website Quote" are real
     * enquiries and deliberately do not match.
     */
    excludedSources: optional("EXCLUDED_LEAD_SOURCES", "newsletter,website visit")
      .split(",")
      .map((sourceName) => sourceName.trim().toLowerCase())
      .filter(Boolean),
    /** Empty means every rep. Set to one address to contain the rollout. */
    onlyRepEmail: optional("ONLY_REP_EMAIL", "").toLowerCase(),
    /**
     * A hand-picked list of addresses to write to, and nothing else.
     *
     * This deliberately overrides the rep restriction, because its purpose is
     * the opposite: naming exact mailboxes for a first end-to-end run, which
     * may well belong to a different rep than the one the rollout is scoped to.
     * The domain exclusions still apply — an internal address stays unreachable
     * however explicitly it is listed.
     */
    onlyLeadEmails: optional("ONLY_LEAD_EMAILS", "")
      .split(",")
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
    /**
     * Leads captured before this service started running.
     *
     * Off, deliberately. The service works on what arrives from now on: a
     * backlog of people captured weeks ago never agreed to be written to by
     * it, and mailing all of them at once on first boot is the single most
     * damaging thing this could do.
     */
    includeExistingLeads: boolean("INCLUDE_EXISTING_LEADS", false),
  },

  /**
   * Limits on an unattended conversation sent under a real person's name.
   *
   * Every one of these is a stop condition, not a preference: the AI writes as
   * a named employee, so the failure mode of getting this wrong is a customer
   * receiving nonsense signed by someone who never saw it.
   */
  guardrails: {
    /** Total emails the AI may send on one thread before handing over. */
    maxAiMessages: number("MAX_AI_MESSAGES", 5),
    /** Give up on a thread entirely after this long, answered or not. */
    maxConversationDays: number("MAX_CONVERSATION_DAYS", 21),
    /** A rep replying by hand takes the thread back permanently. */
    stopWhenRepReplies: boolean("STOP_WHEN_REP_REPLIES", true),
    /** Stop on "remove me", an unsubscribe, or plain irritation. */
    stopOnOptOut: boolean("STOP_ON_OPT_OUT", true),
    /**
     * Nothing is sent; drafts are stored for inspection. The honest way to
     * watch what this would have written before letting it write to customers.
     */
    dryRun: boolean("DRY_RUN", true),
  },
} as const;

export type Config = typeof config;

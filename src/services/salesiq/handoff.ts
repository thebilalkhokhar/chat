import type { Connection } from "mongoose";
import { accessTokenForRep } from "../zohoAuth";
import { upsertChatLead, addLeadTag, addLeadNote, findLeadIdByEmail, findLeadIdByPhone, fillLeadContact, setLeadOwner, fetchLeadOwner, findCustomerLeads, leadStillExists } from "../zohoLead";
import { sendText, chatWebViewUrl } from "../whatsappNotify";
import { sendCliqMessage } from "../cliqNotify";
import { chatConversationModel, IChatConversation } from "../../models/ChatConversation";
import { zohoCredentialModel } from "../../models/ZohoCredential";
import { getSettings } from "../settingsService";
import { otherChatWithLead, otherLeadBeingWritten } from "./sameCustomer";
import { QUOTE_FIELDS, withDefaults } from "../../domain/quoteFields";
import { askedToGoBelowMinimum, MINIMUM_ORDER } from "../../domain/minimumOrder";
import { ownerIndexAt, pickWithBalances } from "../../domain/leadRotation";
import { settingsModel } from "../../models/Settings";
import { isOurEmail, isOurPhone } from "../../domain/ourOwnContacts";
import type { ISettings } from "../../models/Settings";

/**
 * Handing a finished chat to a person.
 *
 * Two things have to happen and they fail independently: SalesIQ forwards the
 * live chat to an operator, and the CRM gets a lead carrying what was learned.
 * The forward is part of the reply to SalesIQ and happens in the request. This
 * file is the other half — the CRM write, which runs after the visitor has been
 * answered because they should never wait on a Zoho round trip.
 *
 * Nothing here throws. A chat that reached a human has succeeded at the thing
 * that matters even if the note failed to file, and losing that hand-off over a
 * cosmetic write would be the wrong trade.
 */

function answersFor(conversation: IChatConversation): string {
  const collected = withDefaults(conversation.collected);
  return QUOTE_FIELDS.map((field) => {
    const value = collected[field.key];
    return `${field.label}: ${value && value.trim() ? value.trim() : "— not given"}`;
  }).join("\n");
}

/**
 * The one thing on a chat that is a decision rather than a detail.
 *
 * A customer who has been told the minimum and asked for the smaller run anyway
 * has been promised we would come back to them on it, and the team does take
 * some of these. Buried in the transcript it is missed — the summary says
 * "Quantity: 200" and reads like any other lead — so it is called out above the
 * answers, where a rep deciding whether to price it will see it.
 */
function belowMinimumLine(conversation: IChatConversation): string[] {
  const said = conversation.messages
    .filter((message) => message.author !== "system")
    .map((message) => ({ fromUs: message.author === "ai", text: message.text }));
  if (!askedToGoBelowMinimum(said)) return [];
  const wanted = String((conversation.collected as Record<string, string>)?.quantity || "").trim();
  return [
    "",
    `NEEDS A DECISION — they were told the ${MINIMUM_ORDER} minimum and asked for a smaller run` +
      `${wanted ? ` (${wanted})` : ""}. They were told we would come back to them on what we can do at that quantity.`,
  ];
}

function transcriptOf(messages: IChatConversation["messages"]): string {
  return messages
    .filter((message) => message.author !== "system")
    .map((message) => `${message.author === "ai" ? "Bot" : message.author === "rep" ? "Rep" : "Visitor"}: ${message.text.trim()}`)
    .join("\n");
}

/** The transcript and answers, written the way a rep would want to read them. */
export function describeForRep(conversation: IChatConversation): string {
  const answers = answersFor(conversation);
  const transcript = transcriptOf(conversation.messages);
  const spokeAs = conversation.spokeAs || conversation.repName;

  const parts = [
    `Website chat, qualified automatically${spokeAs ? ` as ${spokeAs}` : ""}.`,
    ...(conversation.previousChatAt
      ? [
          `Returning customer — first chatted ${new Date(conversation.previousChatAt).toISOString()}` +
            (conversation.spokeAs && conversation.repName ? `, and already ${conversation.repName}'s.` : "."),
        ]
      : []),
    "",
    "What they need:",
    answers,
    ...belowMinimumLine(conversation),
    ...(conversation.instantPrice
      ? [
          "",
          `Instant price shown in chat (ERP price #${conversation.instantPrice.erpId}): ${conversation.instantPrice.line}`,
          ...(conversation.instantPrice.forRep ? [`Priced as: ${conversation.instantPrice.forRep}`] : []),
        ]
      : []),
  ];

  if (conversation.questionsForRep.length) {
    parts.push("", "They asked something needing a person:", ...conversation.questionsForRep.map((q) => `- ${q}`));
  }

  parts.push(
    "",
    `Started: ${conversation.createdAt ? new Date(conversation.createdAt).toISOString() : "unknown"}`,
    `Page: ${conversation.currentPageUrl || "unknown"}`,
    `SalesIQ chat id: ${conversation.conversationId}`,
    "",
    "Transcript:",
    transcript || "(nothing said)"
  );

  return parts.join("\n");
}

/** What the chat said after its lead was written, and the answers as they stand now. */
export function describeFollowUp(conversation: IChatConversation, from: number): string {
  return [
    "The chat carried on after this lead was written.",
    "",
    "New messages:",
    transcriptOf(conversation.messages.slice(from)),
    "",
    "What they need now:",
    answersFor(conversation),
    ...belowMinimumLine(conversation),
    "",
    `SalesIQ chat id: ${conversation.conversationId}`,
  ].join("\n");
}

const PLEASANTRY =
  /^(?:(?:ok(?:ay)?|k|thanks?|thank you|thank u|ty|thx|so much|great|perfect|cool|awesome|sounds good|will do|got it|noted|yes|yep|sure|bye|good ?bye|bye[\s-]bye|good|nice|hi|hello|hey|hiya|howdy|good morning|good afternoon|good evening|good ?night|see (?:you|ya|u)(?: (?:soon|later|then|tomorrow))?|talk (?:to you )?(?:soon|later)|you too|take care|cheers|alright|all good|appreciate it|much appreciated|have a (?:good|great|nice|lovely|blessed) (?:day|night|evening|weekend|one)|👍|🙏|🙂|😊)[\s,.!]*)+$/iu;

/** "Thanks", "ok", "sounds good", "hi" — nothing a rep needs a note about. */
export function isPleasantry(text: string): boolean {
  return PLEASANTRY.test(String(text || "").trim());
}

export interface HandoffOutcome {
  leadOk: boolean;
  zohoLeadId?: string;
  /**
   * What happened: "insert" for a new lead, "matched" for a chat filed onto one
   * the CRM already had, "noted" for later messages added to a chat's own lead,
   * "already-linked" for a conversation that has its lead,
   * "in-flight" for one another writer is holding, "no-contact" for one with
   * neither an email nor a phone number, "visitor-silent" for one where the
   * visitor never typed. The last four did nothing and are not failures.
   */
  action?: string;
  error?: string;
}

/**
 * How long a claimed write is believed to still be running.
 *
 * Long enough for a token refresh, an insert, a tag and a note against a slow
 * Zoho; short enough that a process killed mid-write does not leave the lead
 * unwritten for the rest of the day.
 */
const LEAD_WRITE_LOCK_MS = 3 * 60_000;

/**
 * Who actually writes to the CRM, and who ends up owning what they write.
 *
 * The reps' own tokens stopped being able to create leads on 13 September:
 * Zoho answered every insert with 403 NO_PERMISSION (Crm_Implied_Create_Leads)
 * while their sign-in and their searches carried on working. Fifty-five chats
 * carrying real customers failed twelve times each and were given up on.
 *
 * So the write is made by an account that has the permission, and the rep is
 * named as the Owner — which Zoho accepts from an admin even when that rep
 * could not have created the record themselves. The rep still owns the lead and
 * sees it in their queue; nothing changes for them.
 *
 * Falls back to the rep's own token when no writer is configured or the writer
 * account is unavailable, which leaves things no worse than before.
 */
/** A rep's Zoho id, read from their stored grant — no token refresh needed. */
async function zohoUserIdFor(leadsDb: Connection, email: string): Promise<string | undefined> {
  const address = String(email || "").trim().toLowerCase();
  if (!address) return undefined;
  const cred = (await zohoCredentialModel(leadsDb)
    .findOne({ email: address })
    .select("zohoUserId")
    .lean()) as any;
  return cred?.zohoUserId;
}

/**
 * Whose turn it is to own the next lead — see leadRotation.ts.
 *
 * The position is taken and advanced in one atomic update, so two writers
 * finishing at the same moment get different numbers instead of both reading
 * the same one and handing the same agent two leads.
 *
 * Only called when a lead is actually about to be created. A chat that matches
 * an existing record, or one that turns out to have nobody to write to, must
 * not consume a turn — the agent whose slot it was would simply never see it.
 */
/**
 * Each rep's standing in the lead rotation: +1 per lead they got by taking a
 * chat over, -1 per rotation lead they lost to a rep who took it over. Kept in
 * its own collection, keyed by email (an email cannot be a field name in the
 * settings document).
 */
const BALANCES = "lead_rotation_balance";

export async function adjustLeadBalance(leadsDb: Connection, email: string, delta: number): Promise<void> {
  const key = String(email || "").trim().toLowerCase();
  if (!key || !delta) return;
  await leadsDb.collection(BALANCES).updateOne({ _id: key as any }, { $inc: { balance: delta }, $set: { updatedAt: new Date() } }, { upsert: true });
}

async function leadBalances(leadsDb: Connection): Promise<Record<string, number>> {
  const rows = await leadsDb.collection(BALANCES).find({}).toArray();
  return Object.fromEntries(rows.map((row: any) => [String(row._id), Number(row.balance) || 0]));
}

async function nextLeadOwner(
  leadsDb: Connection,
  settings: ISettings
): Promise<{ email: string; ownerId?: string } | null> {
  const agents = (settings.chat?.crmLeadAgents || []).map((e) => String(e || "").trim()).filter(Boolean);
  if (!agents.length) return null;

  // Who can own a lead at all: a Zoho sign-in on file.
  const ownerIds = new Map<string, string>();
  for (const email of agents) {
    const ownerId = await zohoUserIdFor(leadsDb, email);
    if (ownerId) ownerIds.set(email, ownerId);
    else console.error(`[chat] rotation: no Zoho sign-in for ${email}, passing over them`);
  }
  if (!ownerIds.size) {
    console.error(`[chat] rotation: none of ${agents.join(", ")} can own a lead — falling back`);
    return null;
  }

  const settingsDoc = settingsModel(leadsDb);
  // A place is reserved atomically first, so two leads written at once never
  // read the same position; it is then moved on by however many reps the pick
  // passed, or handed back when an owed lead was paid outside the rotation.
  const taken = await settingsDoc.findOneAndUpdate(
    { key: "singleton" },
    { $inc: { "chat.leadRotationAt": 1 } },
    { new: true, projection: { "chat.leadRotationAt": 1 } }
  );
  const position = Number((taken as any)?.chat?.leadRotationAt ?? 1) - 1;
  const pick = pickWithBalances(position, agents, await leadBalances(leadsDb), (email) => ownerIds.has(email));
  const adjust = (pick.email ? pick.turns : 0) - 1;
  if (adjust !== 0) {
    await settingsDoc.updateOne({ key: "singleton" }, { $inc: { "chat.leadRotationAt": adjust } });
  }
  if (!pick.email) return null;
  for (const email of pick.spent) {
    console.log(`[chat] rotation: ${email} already had a lead from a take-over — passed over once`);
    await adjustLeadBalance(leadsDb, email, -1);
  }
  if (pick.repaid) {
    console.log(`[chat] rotation: ${pick.repaid} was owed a lead — paid back`);
    await adjustLeadBalance(leadsDb, pick.repaid, +1);
  }
  const intended = agents[ownerIndexAt(position, agents.length)];
  if (!pick.repaid && intended && intended.toLowerCase() !== pick.email.toLowerCase() && !pick.spent.length) {
    console.error(`[chat] ${intended} was next in the rotation but has no Zoho sign-in on file — ${pick.email} takes this one`);
  }
  return { email: pick.email, ownerId: ownerIds.get(pick.email) };
}

/**
 * Who the lead belongs to — the person who actually dealt with the customer.
 *
 * The agent who picked the chat up comes first, then the persona the bot ran
 * an off-hours chat as, then the rotation. Each is only used if that person can
 * actually own a record in the CRM; an address with no Zoho sign-in behind it
 * falls through to the next rather than taking the lead nowhere.
 *
 * Only the rotation advances the counter, and only when it is the one used — a
 * chat claimed by its picker must not consume somebody else's turn.
 */
export function ownerCandidates(
  conversation: Pick<IChatConversation, "attenderEmail" | "repEmail" | "handoffReason" | "forwardedToOperator">
): Array<{ email: string; why: string }> {
  const candidates: Array<{ email: string; why: string }> = [];

  /** Whoever SalesIQ recorded as joining the chat. */
  const attender = String(conversation.attenderEmail || "").trim().toLowerCase();
  if (attender) candidates.push({ email: attender, why: "picked the chat up" });

  /**
   * The persona an off-hours chat was run as.
   *
   * Only when the bot actually used a name. A working-hours chat is forwarded
   * to the pool namelessly, and its repEmail is just whichever persona was
   * picked at open — nobody the customer ever heard of, so it must not become
   * the owner.
   */
  const ranAsItself = conversation.handoffReason !== "live_agent" && !conversation.forwardedToOperator;
  const persona = String(conversation.repEmail || "").trim().toLowerCase();
  if (ranAsItself && persona && persona !== attender) {
    candidates.push({ email: persona, why: "the name the bot used" });
  }

  return candidates;
}

/**
 * Who may own a chat lead at all: the names the bot speaks as, the agents who
 * take chats and the lead rotation. Anybody else — Alex and Max, taken out of
 * the chat, or a customer's rep from an older chat — falls through to the
 * rotation instead of being handed the record.
 */
function mayOwnChatLead(email: string, settings: ISettings): boolean {
  const allowed = [
    ...(settings.chat?.repPool || []),
    ...(settings.chat?.liveAgentEmails || []),
    ...(settings.chat?.crmLeadAgents || []),
  ].map((e) => String(e || "").trim().toLowerCase());
  return allowed.includes(email);
}

async function leadOwnerFor(
  leadsDb: Connection,
  settings: ISettings,
  conversation: IChatConversation
): Promise<{ email: string; ownerId: string; why: string } | null> {
  /**
   * A rep who took the chat over owns its lead. They had the conversation, so
   * the follow-up is theirs — and the rotation keeps its turn for the next lead.
   * Known only when SalesIQ's chat-event webhook reports the join (chatEvents.ts).
   */
  const picker = String(conversation.attenderEmail || "").trim().toLowerCase();
  if (picker && mayOwnChatLead(picker, settings)) {
    const ownerId = await zohoUserIdFor(leadsDb, picker);
    if (ownerId) {
      // It counts as their turn: the rotation passes them once.
      await adjustLeadBalance(leadsDb, picker, +1);
      return { email: picker, ownerId, why: "picked the chat up" };
    }
    console.error(`[chat] ${picker} took the chat over but has no Zoho sign-in — using the rotation`);
  }

  /**
   * The rotation first, so new leads are shared out evenly. Owning a lead used
   * to follow whoever handled the chat, which tied a rep's lead count to how
   * many of their visitors happened to leave details: six reps with even chats
   * ended a month on 13 leads against 5. The bot keeps the name it gave the
   * visitor (`spokeAs`); the record and the follow-up go to whoever's turn it is.
   */
  const next = await nextLeadOwner(leadsDb, settings);
  if (next?.ownerId) return { email: next.email, ownerId: next.ownerId, why: "rotation" };

  // Nobody in the rotation can own a record: the person who dealt with the chat does.
  for (const candidate of ownerCandidates(conversation)) {
    if (!mayOwnChatLead(candidate.email, settings)) {
      console.log(`[chat] ${candidate.email} (${candidate.why}) does not own chat leads — skipped`);
      continue;
    }
    const ownerId = await zohoUserIdFor(leadsDb, candidate.email);
    if (ownerId) return { email: candidate.email, ownerId, why: candidate.why };
    console.error(`[chat] ${candidate.email} (${candidate.why}) has no Zoho sign-in — falling back`);
  }
  return null;
}

async function leadWriter(
  leadsDb: Connection,
  settings: ISettings,
  repEmail: string
): Promise<{ accessToken: string; ownerId?: string; wroteAs: string } | { error: string }> {
  const writerEmail = String(settings.chat?.leadWriterEmail || "").trim().toLowerCase();
  const owner = String(repEmail || "").trim().toLowerCase();

  const ownerId = await zohoUserIdFor(leadsDb, owner);

  if (writerEmail && writerEmail !== owner) {
    try {
      const writer = await accessTokenForRep(leadsDb, { email: writerEmail });
      return { accessToken: writer.accessToken, ownerId, wroteAs: writerEmail };
    } catch (error: any) {
      console.error(`[chat] lead writer ${writerEmail} unavailable (${error.message}) — falling back to ${owner}`);
    }
  }

  try {
    const rep = await accessTokenForRep(leadsDb, { email: owner });
    // Their own token makes them the owner by default, and naming it as well is
    // what Zoho refuses from a non-admin.
    return { accessToken: rep.accessToken, wroteAs: owner };
  } catch (error: any) {
    return { error: `no Zoho sign-in for ${owner}: ${error.message}` };
  }
}

/**
 * Writes the chat to the CRM under the rep who will pick it up.
 *
 * The lead is owned by the handoff rep rather than by whoever SalesIQ assigned,
 * so it lands in the queue of the person actually being asked to quote it.
 */
/**
 * A rep took over a chat whose lead was already written: the lead moves to them.
 *
 * The rule is "whoever picks the chat up owns its lead". A lead written before
 * the pick-up went to the round robin, so it is handed over in Zoho and the
 * chat moves with it (alerts, dashboard). Only a lead this chat created moves —
 * a customer who already had a lead keeps their rep, and a rep cannot take a
 * colleague's customer by joining their chat.
 */
export async function moveLeadToPicker(
  leadsDb: Connection,
  conversation: IChatConversation & { save: () => Promise<any> }
): Promise<{ moved: boolean; why: string }> {
  const picker = String(conversation.attenderEmail || "").trim().toLowerCase();
  if (!picker) return { moved: false, why: "nobody recorded as picking it up" };
  if (!conversation.zohoLeadId) return { moved: false, why: "no lead yet — it will be written to the picker" };
  if (!conversation.leadCreatedHere) {
    // The customer's existing lead: theirs if the picker already owns it,
    // otherwise a conflict for the manager — see resolveTakeoverConflict.
    if (String(conversation.repEmail || "").trim().toLowerCase() === picker || conversation.repName === "Support Ecommerce") {
      return { moved: false, why: "the customer's existing lead, already settled" };
    }
    const settingsNow = await getSettings(leadsDb);
    const writerNow = await leadWriter(leadsDb, settingsNow, picker);
    if ("error" in writerNow) return { moved: false, why: writerNow.error };
    const owner = await fetchLeadOwner(conversation.zohoLeadId, writerNow.accessToken);
    if (!owner.ok || !owner.ownerId) return { moved: false, why: owner.error || "could not read the lead's owner" };
    if (owner.ownerId === (await zohoUserIdFor(leadsDb, picker))) return { moved: false, why: "already theirs" };
    if (owner.ownerId !== SUPPORT_ECOMMERCE_ZOHO_ID) {
    await resolveTakeoverConflict(leadsDb, conversation, conversation.zohoLeadId, { name: owner.ownerName || "another rep", since: owner.createdAt }, picker, writerNow.accessToken);
    await conversation.save();
    return { moved: true, why: "conflict — moved to Support Ecommerce" };
    }
    // Support Ecommerce is not a rep: a lead parked there is nobody's customer, so the rep
    // who took the chat gets it like any rotation lead, with no conflict and no WhatsApp.
  }
  if (String(conversation.repEmail || "").trim().toLowerCase() === picker) return { moved: false, why: "already theirs" };

  const settings = await getSettings(leadsDb);
  if (!mayOwnChatLead(picker, settings)) return { moved: false, why: `${picker} does not own chat leads` };
  const ownerId = await zohoUserIdFor(leadsDb, picker);
  if (!ownerId) return { moved: false, why: `no Zoho sign-in for ${picker}` };

  const writer = await leadWriter(leadsDb, settings, picker);
  if ("error" in writer) return { moved: false, why: writer.error };
  const result = await setLeadOwner(conversation.zohoLeadId, ownerId, writer.accessToken);
  if (!result.ok) return { moved: false, why: result.error || "Zoho refused the owner change" };

  // The picker has had their turn; the rep it was taken from is owed one.
  const previousOwner = String(conversation.repEmail || "").trim().toLowerCase();
  await adjustLeadBalance(leadsDb, picker, +1);
  if (previousOwner && previousOwner !== picker) await adjustLeadBalance(leadsDb, previousOwner, -1);

  const owner = (await zohoCredentialModel(leadsDb).findOne({ email: picker }, { fullName: 1 }).lean()) as any;
  if (conversation.aiMessageCount > 0 && !conversation.spokeAs) conversation.spokeAs = conversation.repName;
  conversation.repEmail = picker;
  conversation.repName = owner?.fullName || picker;
  await conversation.save();
  return { moved: true, why: "picked the chat up" };
}

/** Support Ecommerce in Zoho: owns existing leads whose owner is not one of the chat reps. */
export const SUPPORT_ECOMMERCE_ZOHO_ID = process.env.SUPPORT_ECOMMERCE_ZOHO_ID || "6374650000047740075";

/**
 * The owner rule for a customer who already has a lead:
 * - owner is one of the rotation reps → it stays theirs, and the chat moves to
 *   them so the alerts and the dashboard name the right rep;
 * - owner is anybody else (a rep no longer on chat, an old account) → the lead
 *   is handed to Support Ecommerce.
 */
/** Chris, Ecommerce Sales Manager: told whenever a take-over clashes with an existing owner. */
const MANAGER_WHATSAPP = (process.env.MANAGER_WHATSAPP || "18328073429").replace(/\D/g, "") + "@c.us";
/** And on Cliq, where he also works. */
const MANAGER_CLIQ_EMAIL = process.env.MANAGER_CLIQ_EMAIL || "chris.walker@print247.us";

const repLabel = async (leadsDb: Connection, email: string) =>
  (((await zohoCredentialModel(leadsDb).findOne({ email }, { fullName: 1 }).lean()) as any)?.fullName as string) || email;

/**
 * A rep took over the chat of a customer who already belongs to a different rep.
 *
 * Neither of them gets it: the lead goes to Support Ecommerce, no round-robin
 * turn is counted for anyone, and the Ecommerce Sales Manager is sent a
 * WhatsApp saying who had the customer, who took the chat, and where to look,
 * so a person decides. Sent once per chat.
 */
async function resolveTakeoverConflict(
  leadsDb: Connection,
  conversation: IChatConversation & { save?: () => Promise<any> },
  zohoLeadId: string,
  owner: { name: string; since?: Date },
  picker: string,
  accessToken: string
): Promise<void> {
  const moved = await setLeadOwner(zohoLeadId, SUPPORT_ECOMMERCE_ZOHO_ID, accessToken);
  if (!moved.ok) throw new Error(moved.error || "Zoho refused the owner change");

  const pickerName = await repLabel(leadsDb, picker);
  if (conversation.aiMessageCount > 0 && !conversation.spokeAs) conversation.spokeAs = conversation.repName;
  conversation.repEmail = "";
  conversation.repName = "Support Ecommerce";
  console.log(`[chat] lead ${zohoLeadId} is ${owner.name}'s but ${pickerName} took the chat — moved to Support Ecommerce`);

  if (conversation.ownerConflictNotifiedAt) return;
  const customer = [conversation.name, conversation.phone, conversation.email].map((v) => String(v || "").trim()).filter(Boolean).join(" · ");
  const since = owner.since ? ` (lead since ${new Date(owner.since).toISOString().slice(0, 10)})` : "";
  const text = [
    "Lead conflict — moved to Support Ecommerce",
    "",
    `Customer: ${customer || "unknown"}`,
    `Already ${owner.name}'s customer${since}.`,
    `${pickerName} took over their website chat.`,
    "",
    "The lead is now with Support Ecommerce and no round-robin turn was counted for anyone. Please decide who should own it.",
    "",
    `Zoho: https://crm.zoho.com/crm/tab/Leads/${zohoLeadId}`,
    `Chat: ${chatWebViewUrl(conversation.conversationId)}`,
  ].join("\n");
  const [sent, cliq] = await Promise.all([sendText(MANAGER_WHATSAPP, text), sendCliqMessage(leadsDb, MANAGER_CLIQ_EMAIL, text)]);
  if (!sent.ok) console.error(`[chat] could not WhatsApp the sales manager about ${zohoLeadId}: ${sent.error}`);
  if (!cliq.ok) console.error(`[chat] could not Cliq the sales manager about ${zohoLeadId}: ${cliq.error}`);
  // Told on either is told: retrying would repeat the one that did arrive.
  if (sent.ok || cliq.ok) conversation.ownerConflictNotifiedAt = new Date();
}

/**
 * The owner rule for a customer who already has a lead. Returns the lead the chat belongs on.
 *
 * - owned by one of the rotation reps → it stays theirs (see the loop below);
 * - owned by Support Ecommerce, and none of the customer's other leads is a rep's →
 *   it is nobody's customer yet, so it goes through the rotation like a new lead,
 *   and the turn counts. If one of their other leads is a rep's, the chat goes on
 *   that one instead. (SalesIQ creates a lead the moment a chat opens, which is how
 *   a first-time visitor's record ends up with Support Ecommerce: Travis Pranschke,
 *   22 Oct.)
 * - owned by anybody else (a rep no longer on chat, an old account) → handed to
 *   Support Ecommerce.
 */
export async function settleExistingOwner(
  leadsDb: Connection,
  settings: ISettings,
  conversation: IChatConversation,
  zohoLeadId: string,
  accessToken: string
): Promise<string> {
  const owner = await fetchLeadOwner(zohoLeadId, accessToken);
  if (!owner.ok || !owner.ownerId) throw new Error(owner.error || "no owner returned");

  const agents = (settings.chat?.crmLeadAgents || []).map((e) => String(e || "").trim().toLowerCase()).filter(Boolean);

  if (owner.ownerId === SUPPORT_ECOMMERCE_ZOHO_ID) {
    const others = await findCustomerLeads({ email: conversation.email, phone: conversation.phone }, accessToken);
    if (!others.ok) {
      // Not knowing whether a rep already has this customer, it stays put rather than
      // risk handing someone else's customer to the rotation.
      console.error(`[chat] could not look for the other leads of ${zohoLeadId}, left with Support Ecommerce: ${others.error}`);
      return zohoLeadId;
    }
    const agentIds = new Set<string>();
    for (const email of agents) {
      const id = await zohoUserIdFor(leadsDb, email);
      if (id) agentIds.add(id);
    }
    const repsLead = others.leads.find((lead) => lead.id !== zohoLeadId && lead.ownerId && agentIds.has(lead.ownerId));
    if (repsLead) {
      console.log(`[chat] lead ${zohoLeadId} is Support Ecommerce's, but the customer's lead ${repsLead.id} is a rep's — the chat goes on that one`);
      return settleExistingOwner(leadsDb, settings, conversation, repsLead.id, accessToken);
    }

    const turn = await leadOwnerFor(leadsDb, settings, conversation);
    if (!turn) {
      console.error(`[chat] lead ${zohoLeadId} is Support Ecommerce's and nobody in the rotation can own it — left there`);
      return zohoLeadId;
    }
    const moved = await setLeadOwner(zohoLeadId, turn.ownerId, accessToken);
    if (!moved.ok) {
      // A take-over was credited in leadOwnerFor; the lead did not move, so neither does the credit.
      if (turn.why === "picked the chat up") await adjustLeadBalance(leadsDb, turn.email, -1);
      throw new Error(moved.error || "Zoho refused the owner change");
    }
    const cred = (await zohoCredentialModel(leadsDb).findOne({ email: turn.email }, { fullName: 1 }).lean()) as any;
    if (conversation.aiMessageCount > 0 && !conversation.spokeAs) conversation.spokeAs = conversation.repName;
    conversation.repEmail = turn.email;
    conversation.repName = cred?.fullName || turn.email;
    // Given out by the rotation, so a rep who takes the chat over later takes it as with a new lead.
    conversation.leadCreatedHere = true;
    console.log(`[chat] lead ${zohoLeadId} was Support Ecommerce's with no rep's lead for the customer — goes to ${turn.email} (${turn.why})`);
    return zohoLeadId;
  }

  for (const email of agents) {
    if ((await zohoUserIdFor(leadsDb, email)) !== owner.ownerId) continue;
    const picker = String(conversation.attenderEmail || "").trim().toLowerCase();
    if (picker && picker !== email) {
      await resolveTakeoverConflict(leadsDb, conversation, zohoLeadId, { name: owner.ownerName || (await repLabel(leadsDb, email)), since: owner.createdAt }, picker, accessToken);
      return zohoLeadId;
    }
    if (String(conversation.repEmail || "").toLowerCase() !== email) {
      const cred = (await zohoCredentialModel(leadsDb).findOne({ email }, { fullName: 1 }).lean()) as any;
      if (conversation.aiMessageCount > 0 && !conversation.spokeAs) conversation.spokeAs = conversation.repName;
      conversation.repEmail = email;
      conversation.repName = cred?.fullName || email;
    }
    console.log(`[chat] lead ${zohoLeadId} already belongs to ${email} — kept`);
    return zohoLeadId;
  }

  const moved = await setLeadOwner(zohoLeadId, SUPPORT_ECOMMERCE_ZOHO_ID, accessToken);
  if (!moved.ok) throw new Error(moved.error || "Zoho refused the owner change");
  console.log(`[chat] lead ${zohoLeadId} was ${owner.ownerName || owner.ownerId}'s, not a chat rep — moved to Support Ecommerce`);
  return zohoLeadId;
}

export async function handOffToCrm(
  leadsDb: Connection,
  conversationId: string,
  settings: ISettings
): Promise<HandoffOutcome> {
  const ChatConversation = chatConversationModel(leadsDb);

  /**
   * The claim, made in the same operation that reads the conversation.
   *
   * It used to read, check `zohoLeadId`, and then spend several seconds in Zoho
   * before writing the id back. Two writers passing that check in the same
   * window both saw an unwritten conversation and both inserted. Matching on
   * "no lead, and nobody else already writing one" and setting the lock in one
   * atomic update means the second writer matches nothing and stops.
   */
  const conversation = await ChatConversation.findOneAndUpdate(
    {
      conversationId,
      $and: [
        { $or: [{ zohoLeadId: { $exists: false } }, { zohoLeadId: "" }, { zohoLeadId: null }] },
        {
          $or: [
            { leadWriteLockAt: { $exists: false } },
            { leadWriteLockAt: null },
            { leadWriteLockAt: { $lt: new Date(Date.now() - LEAD_WRITE_LOCK_MS) } },
          ],
        },
      ],
    },
    { $set: { leadWriteLockAt: new Date() } },
    { new: true }
  );

  if (!conversation) {
    // Either it has its lead already, somebody else is writing it this second,
    // or there is no such chat. None of those is this call's to fix.
    const now = await ChatConversation.findOne({ conversationId }).select("zohoLeadId").lean();
    if (!now) return { leadOk: false, error: "conversation not found" };
    return now.zohoLeadId
      ? noteWhatIsNew(leadsDb, conversationId, now.zohoLeadId)
      : { leadOk: true, action: "in-flight" };
  }

  /** Hands the write back, so the sweep can try again rather than wait out the lock. */
  const release = async () => {
    conversation.leadWriteLockAt = null;
    await conversation.save();
  };

  /**
   * No email and no phone: nothing a rep can quote against, so nothing is
   * written. Not a failure — there is no retrying a chat into having an
   * address it was never given — so the lock is simply released and the
   * conversation is left exactly as it was.
   *
   * `leadOk: true` on purpose: the caller's write loop treats a false leadOk as
   * something to keep retrying up to the attempt limit, and there is nothing
   * here that another attempt would change.
   *
   * Our own details count as none. A lead carrying Print247's own switchboard
   * number as the way to reach the customer is worse than no lead: a rep rings
   * it and reaches their own office. Five of those were written before anyone
   * noticed, so it is checked here as well as where the details are read —
   * whatever route a value took to get onto the record, it stops at the write.
   */
  const usableEmail = conversation.email?.trim() && !isOurEmail(conversation.email, settings);
  const usablePhone = conversation.phone?.trim() && !isOurPhone(conversation.phone, settings);

  if (!usableEmail && !usablePhone) {
    await release();
    return { leadOk: true, action: "no-contact" };
  }

  /**
   * A visitor who never typed is not an enquiry, even with an address on file: SalesIQ fills in
   * a known visitor's details on a chat they only opened. No lead, no note, and no turn in the
   * lead rotation. Not a failure, for the same reason as no-contact.
   */
  if (!conversation.messages.some((m) => m.author === "visitor" && m.text?.trim())) {
    await release();
    return { leadOk: true, action: "visitor-silent" };
  }

  /**
   * The same customer in another chat, checked before anything goes to the CRM
   * — see sameCustomer.ts. A lead being written for them this minute is waited
   * for, and the next pass adds to it; a lead they already have is added to.
   */
  const beingWritten = await otherLeadBeingWritten(ChatConversation, conversation, LEAD_WRITE_LOCK_MS);
  if (beingWritten) {
    await release();
    return {
      leadOk: false,
      error: `this customer's lead is being written for chat ${beingWritten.conversationId}; will add to it next pass`,
    };
  }

  const earlier = await otherChatWithLead(ChatConversation, conversation);

  // The rep chosen when the chat opened, not a fixed owner: the visitor has been
  // talking to this person by name, so the lead has to arrive under that name or
  // the rep who follows up is not the one who appeared to take the enquiry. The
  // exception is a customer another chat already gave a lead: that lead is its
  // rep's record, and their token is the one sure to reach it.
  const repEmail = (earlier?.repEmail || conversation.repEmail || settings.chat.leadOwnerEmail || "").trim();
  if (!repEmail) {
    await release();
    return { leadOk: false, error: "no rep assigned to this chat and no fallback owner" };
  }

  let writer = await leadWriter(leadsDb, settings, repEmail);
  if ("error" in writer) {
    // Nothing can be written at all. The chat has still been forwarded in
    // SalesIQ, so this is logged, not escalated.
    await release();
    return { leadOk: false, error: writer.error };
  }

  /**
   * The lead this person already has, if the CRM has one.
   *
   * A returning visitor is not a new lead, and neither is somebody who filled in
   * the website form last week. The chat goes onto the record that exists — as a
   * note, so nothing already on it is overwritten — and a second record is never
   * made.
   *
   * A failed search used to insert anyway, on the reasoning that a duplicate can
   * be merged and an enquiry that was never written cannot be recovered. That
   * was true for the failure it was written against — occasional, isolated. It
   * is not true under the load of clearing a large backlog: search calls fail
   * at real volume when hundreds of chats are being processed in a few minutes,
   * and every one of those failures became a duplicate, seven of twenty-one
   * addresses in one fifteen-minute window. A search that fails now means the
   * write is skipped and retried on a later pass — the same retry path a failed
   * insert already goes through — rather than guessing.
   */
  let zohoLeadId = earlier?.zohoLeadId || "";

  /**
   * The earlier chat's lead, only if it is still there.
   *
   * It was taken on trust. A lead deleted in the CRM, or converted to a contact,
   * left the customer's next enquiry being filed onto a record nobody can see:
   * the tag and the note failed against it and the enquiry reached nobody. Gone
   * means the searches below run as for a new customer; not knowing (Zoho slow,
   * a token refused) means trying again on a later pass, as a failed search does.
   */
  if (zohoLeadId) {
    const still = await leadStillExists(zohoLeadId, writer.accessToken);
    if (still === "gone") {
      console.log(`[chat] ${conversation.conversationId}: earlier chat ${earlier?.conversationId}'s lead ${zohoLeadId} is no longer in the CRM — looking again`);
      zohoLeadId = "";
    } else if (still === "unknown") {
      await release();
      return { leadOk: false, error: `could not check the earlier chat's lead ${zohoLeadId}; will retry` };
    }
  }

  let action = zohoLeadId ? "matched" : "insert";

  if (!zohoLeadId && conversation.email?.trim()) {
    // Searched with the writer's token, which sees every rep's leads — a rep
    // searching only their own is how one customer ended up with two records.
    const found = await findLeadIdByEmail(conversation.email, writer.accessToken);
    if (found.ok && found.zohoLeadId) {
      zohoLeadId = found.zohoLeadId;
      action = "matched";
    } else if (!found.ok) {
      await release();
      console.error(`[chat] could not search for ${conversation.email}, will retry: ${found.error}`);
      return { leadOk: false, error: `could not search for an existing lead: ${found.error}` };
    }
  }

  // Phone as well: a customer who only ever gave a number (a quote form, a call
  // logged by hand) is the same customer, in whatever format it was typed.
  if (!zohoLeadId && conversation.phone?.trim() && !isOurPhone(conversation.phone, settings)) {
    const found = await findLeadIdByPhone(conversation.phone, writer.accessToken);
    if (found.ok && found.zohoLeadId) {
      zohoLeadId = found.zohoLeadId;
      action = "matched";
    } else if (!found.ok) {
      await release();
      console.error(`[chat] could not search for ${conversation.phone}, will retry: ${found.error}`);
      return { leadOk: false, error: `could not search for an existing lead by phone: ${found.error}` };
    }
  }

  if (!zohoLeadId) {
    const { firstName, lastName } = splitName(conversation.name);

    /**
     * Who owns it: the lead rotation, so new leads are shared evenly — see
     * leadOwnerFor. Only when nobody in it can own a record does it fall back
     * to whoever dealt with the chat.
     *
     * Taken at the last moment before the insert so a chat that matched an
     * existing lead, or failed its search, does not use up a rotation turn.
     */
    const turn = await leadOwnerFor(leadsDb, settings, conversation);
    if (turn) {
      console.log(`[chat] lead for ${conversation.conversationId} goes to ${turn.email} (${turn.why})`);

      // Without the admin writer, only the owner's own token can make them the owner.
      if (!writer.ownerId && turn.email !== writer.wroteAs) {
        const own = await leadWriter(leadsDb, settings, turn.email);
        if (!("error" in own)) writer = own;
      }
    }

    const result = await upsertChatLead(
      {
        firstName,
        lastName,
        email: conversation.email,
        phone: conversation.phone,
        description: describeForRep(conversation),
        // Named when an admin account is doing the writing: Zoho accepts the
        // assignment from them, and the rep owns a lead they could not have
        // created themselves. Left unset when the rep's own token is in use,
        // because then they are the owner by default and naming it is what Zoho
        // refuses.
        ownerId: turn?.ownerId || writer.ownerId,
      },
      writer.accessToken
    );

    if (!result.ok || !result.zohoLeadId) {
      await release();
      return { leadOk: false, error: result.error || "Zoho did not return a lead id" };
    }

    zohoLeadId = result.zohoLeadId;
    action = result.action || "insert";
    // A lead this chat made, rather than one the customer already had: only
    // these follow a rep who takes the chat over later (moveLeadToPicker).
    if (action === "insert") conversation.leadCreatedHere = true;

    /**
     * The chat follows its lead to the owner, so the alerts, the follow-up and
     * the dashboard all name the rep who has the record. The bot keeps the name
     * it introduced itself by, as when a chat turns out to be another rep's
     * customer (see chatEngine).
     */
    if (turn && turn.email !== String(conversation.repEmail || "").trim().toLowerCase()) {
      const owner = (await zohoCredentialModel(leadsDb).findOne({ email: turn.email }, { fullName: 1 }).lean()) as any;
      if (conversation.aiMessageCount > 0 && !conversation.spokeAs) conversation.spokeAs = conversation.repName;
      conversation.repEmail = turn.email;
      conversation.repName = owner?.fullName || turn.email;
    }
  }

  // A customer who already had a lead: a chat rep's stays theirs, Support Ecommerce's goes
  // through the rotation (unless another of the customer's leads is a rep's, which the chat
  // then goes on), anyone else's goes to Support Ecommerce. Done once, the first time this
  // chat lands on the lead.
  if (action === "matched" && conversation.zohoLeadId !== zohoLeadId) {
    const matchedLeadId = zohoLeadId;
    zohoLeadId = await settleExistingOwner(leadsDb, settings, conversation, matchedLeadId, writer.accessToken).catch((error: any) => {
      console.error(`[chat] could not check the owner of lead ${matchedLeadId}: ${error.message}`);
      return matchedLeadId;
    });
  }

  conversation.zohoLeadId = zohoLeadId;
  conversation.leadMessageCount = conversation.messages.length;
  conversation.leadWriteLockAt = null;
  await conversation.save();

  const tag = await addLeadTag(zohoLeadId, writer.accessToken, settings.crm.tagName);
  if (!tag.ok) console.error(`[chat] could not tag lead ${zohoLeadId}: ${tag.error}`);

  /**
   * A matched lead gets the details this chat learned, if it was missing them.
   *
   * Only reaches Zoho when there is a blank to fill — see fillLeadContact — so
   * a record a rep has already tidied is left exactly as it is. On an insert
   * this is a no-op: the details went on with the record.
   */
  if (action !== "insert") {
    const filled = await fillLeadContact(
      zohoLeadId,
      { email: conversation.email, phone: conversation.phone },
      writer.accessToken
    );
    if (filled.filled.length) {
      console.log(`[chat] added ${filled.filled.join(" and ")} to matched lead ${zohoLeadId}`);
    } else if (!filled.ok) {
      console.error(`[chat] could not fill contact details on lead ${zohoLeadId}: ${filled.error}`);
    }
  }

  /**
   * The note, and on a matched lead it is the whole record of the chat.
   *
   * A new lead carries the same text in its description as well. An existing one
   * deliberately does not: overwriting the description of a record somebody else
   * has been working would lose whatever was already on it.
   *
   * Unchecked, like the tag. The lead exists and the enquiry has reached a rep;
   * a failed note costs detail, not the hand-off.
   */
  const note = await addLeadNote(
    zohoLeadId,
    `Website chat — qualified${(conversation.spokeAs || conversation.repName) ? ` as ${conversation.spokeAs || conversation.repName}` : ""}`,
    describeForRep(conversation),
    writer.accessToken
  );
  if (!note.ok) console.error(`[chat] could not note lead ${zohoLeadId}: ${note.error}`);

  return { leadOk: true, zohoLeadId, action };
}

/**
 * Adds to a chat's lead whatever the chat said after the lead was written.
 *
 * A chat can carry on once its lead exists — a visitor comes back after the
 * closing line with "the boxes can also have a depth of 2 inches", or picks up a
 * chat the sweep had closed — and none of that used to reach the CRM. Claimed
 * with the same lock as the first write, so two writers cannot add it twice. A
 * "thanks" on its own is marked as seen and not noted.
 */
async function noteWhatIsNew(
  leadsDb: Connection,
  conversationId: string,
  zohoLeadId: string
): Promise<HandoffOutcome> {
  const ChatConversation = chatConversationModel(leadsDb);

  const conversation = await ChatConversation.findOneAndUpdate(
    {
      conversationId,
      zohoLeadId,
      $or: [
        { leadWriteLockAt: { $exists: false } },
        { leadWriteLockAt: null },
        { leadWriteLockAt: { $lt: new Date(Date.now() - LEAD_WRITE_LOCK_MS) } },
      ],
      // Absent means an older chat, and an older chat's lead has seen it all.
      $expr: { $gt: [{ $size: "$messages" }, { $ifNull: ["$leadMessageCount", { $size: "$messages" }] }] },
    },
    { $set: { leadWriteLockAt: new Date() } },
    { new: true }
  );

  if (!conversation) return { leadOk: true, zohoLeadId, action: "already-linked" };

  const from = conversation.leadMessageCount ?? conversation.messages.length;
  const worthNoting = conversation.messages
    .slice(from)
    .some((message) => (message.author === "visitor" || message.author === "rep") && !isPleasantry(message.text));

  const done = async () => {
    conversation.leadMessageCount = conversation.messages.length;
    conversation.leadWriteLockAt = null;
    await conversation.save();
  };

  if (!worthNoting) {
    await done();
    return { leadOk: true, zohoLeadId, action: "already-linked" };
  }

  const release = async () => {
    conversation.leadWriteLockAt = null;
    await conversation.save();
  };

  // The same writer as the first write: the note goes on a lead this rep may
  // not be able to touch themselves.
  const settings = await getSettings(leadsDb);
  const writer = await leadWriter(leadsDb, settings, conversation.repEmail);
  if ("error" in writer) {
    await release();
    return { leadOk: false, zohoLeadId, error: writer.error };
  }
  const accessToken = writer.accessToken;

  /**
   * Details the chat picked up since the lead was written.
   *
   * Very often the address itself: people answer the email question last, by
   * which point the lead already exists. Done before the note and not checked
   * afterwards — a lead that gains an email is better off than one that does
   * not, and failing the whole pass over it would cost the note as well.
   */
  const filled = await fillLeadContact(
    zohoLeadId,
    { email: conversation.email, phone: conversation.phone },
    writer.accessToken
  );
  if (filled.filled.length) {
    console.log(`[chat] added ${filled.filled.join(" and ")} to lead ${zohoLeadId} from ${conversation.conversationId}`);
  } else if (!filled.ok) {
    console.error(`[chat] could not fill contact details on lead ${zohoLeadId}: ${filled.error}`);
  }

  const note = await addLeadNote(
    zohoLeadId,
    `Website chat — continued${(conversation.spokeAs || conversation.repName) ? ` as ${conversation.spokeAs || conversation.repName}` : ""}`,
    describeFollowUp(conversation, from),
    accessToken
  );

  if (!note.ok) {
    await release();
    return { leadOk: false, zohoLeadId, error: `could not add the follow-up note: ${note.error}` };
  }

  await done();
  return { leadOk: true, zohoLeadId, action: "noted" };
}

/**
 * Splits a display name, ignoring the placeholder SalesIQ gives an anonymous
 * visitor — "Visitor 365140" is not a person's name and must not become one.
 */
function splitName(name: string): { firstName?: string; lastName: string } {
  const value = String(name || "").trim();
  if (!value || /^visitor\s*\d*$/i.test(value) || /^\d+$/.test(value)) {
    return { lastName: "Website Chat Visitor" };
  }

  const parts = value.split(/\s+/);
  if (parts.length === 1) return { lastName: parts[0] };
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
}

import "dotenv/config";
/**
 * Shares out the chat leads written while the rep picker was broken.
 *
 * From Harry's Zoho sign-in on 24 September until the round-robin fix, the
 * picker handed him nearly every chat — first to "catch up" on all-time counts,
 * then as an echo of that burst through a rolling-day window. Every lead those
 * chats made went to him.
 *
 * This takes every chat lead CREATED in that window (a chat that matched an
 * older lead is left alone — that record was somebody's before) and splits them
 * evenly between Jessica, Frank, Brian and Harry. Nobody else is given one,
 * and a lead already with somebody else (Alex, Nancy...) stays with them.
 * Moves are kept to the minimum: each of the four keeps their own leads up to
 * their share, oldest first, and only the surplus moves.
 *
 *   npm run rebalance:chat-leads                     # dry run: the plan, nothing changed
 *   npm run rebalance:chat-leads -- --apply          # Zoho owner + our chat records
 *   npm run rebalance:chat-leads -- --apply --notify # ...and a WhatsApp for each move
 *   --from=2026-09-24T21:18:09Z --until=2026-09-28T12:00:00Z to change the window
 *
 * Or take every lead one person owns and deal it out to others, one each in turn:
 *
 *   npm run rebalance:chat-leads -- --from=2026-10-02T00:00:00Z \
 *     --move-from=alex.kane@print247.us --to=paul.smith@print247.us,ethan.wilson@print247.us
 */
import { connectLeadsDb, closeConnections } from "../db/connections";
import { chatConversationModel } from "../models/ChatConversation";
import { zohoCredentialModel } from "../models/ZohoCredential";
import { getSettings } from "../services/settingsService";
import { accessTokenForRep } from "../services/zohoAuth";
import { fetchLeadOwner, setLeadOwner } from "../services/zohoLead";
import { chatUrlFor } from "../services/erpChatNotify";
import { chatWebViewUrl, isWhatsAppConfigured, repNumberFor, sendText } from "../services/whatsappNotify";

/** Who the leads are shared between, in the order spare leads are dealt. */
const AGENTS = [
  "jessica.joe@print247.us",
  "frank.castle@print247.us",
  "briantylar@print247.us",
  "harry.brook@print247.us",
];

/**
 * Owners outside the four whose leads are taken anyway. The Colorwing Harry is
 * another company's rep: a Print247 lead under him is wrong whoever gets it.
 * Every other owner — Alex, Nancy and the rest — keeps what they have.
 */
const ALWAYS_MOVE_FROM = ["harry.brook@colorwing.com"];

/** When the Print247 Harry signed into Zoho, which is when the picker started favouring him. */
const DEFAULT_FROM = "2026-09-24T21:18:09Z";

const ZOHO_DELAY_MS = 400;
const WHATSAPP_DELAY_MS = 1500;

/** "frank castle" as Zoho has it stored, read out as "Frank Castle". */
const titleCase = (name: string) => String(name || "").replace(/\b\w/g, (letter) => letter.toUpperCase());

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function dateArg(name: string, fallback: Date): Date {
  const raw = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  const value = raw ? new Date(raw.split("=").slice(1).join("=")) : fallback;
  if (Number.isNaN(value.getTime())) throw new Error(`--${name} is not a date`);
  return value;
}

interface Lead {
  zohoLeadId: string;
  createdAt: Date;
  ownerEmail: string;
  ownerName: string;
  chat: any;
  newOwner?: string;
}

(async () => {
  const apply = process.argv.includes("--apply");
  const notify = process.argv.includes("--notify");
  const from = dateArg("from", new Date(DEFAULT_FROM));
  const until = dateArg("until", new Date());

  const listArg = (name: string) =>
    (process.argv.find((arg) => arg.startsWith(`--${name}=`)) || "")
      .split("=").slice(1).join("=")
      .split(",").map((email) => email.trim().toLowerCase()).filter(Boolean);
  const moveFrom = listArg("move-from")[0] || "";
  const receivers = moveFrom ? listArg("to") : AGENTS;
  if (moveFrom && !receivers.length) throw new Error("--move-from needs --to=<email>,<email>");

  const db = await connectLeadsDb();
  const settings = await getSettings(db, true);
  const ChatConversation = chatConversationModel(db);

  // Everybody receiving has to be able to own a record, or the split is wrong.
  const credentials = await zohoCredentialModel(db).find({ email: { $in: receivers } }).lean();
  const agents = receivers.map((email) => {
    const credential = credentials.find((c: any) => String(c.email).toLowerCase() === email);
    if (!credential) throw new Error(`${email} has no Zoho sign-in — cannot give them leads`);
    return { email, name: credential.fullName || email, zohoUserId: String(credential.zohoUserId) };
  });

  const writerEmail = String(settings.chat?.leadWriterEmail || "").trim();
  if (!writerEmail) throw new Error("no chat.leadWriterEmail — an admin token is needed to reassign leads");
  const { accessToken } = await accessTokenForRep(db, { email: writerEmail });

  // One lead can carry several chats (the same customer came back); the earliest speaks for it.
  const chats = await ChatConversation.find({
    createdAt: { $gte: from, $lte: until },
    zohoLeadId: { $nin: ["", null] },
  })
    .sort({ createdAt: 1 })
    .lean();

  const byLead = new Map<string, any>();
  for (const chat of chats as any[]) if (!byLead.has(chat.zohoLeadId)) byLead.set(chat.zohoLeadId, chat);

  console.log(
    `window ${from.toISOString()} -> ${until.toISOString()}\n` +
      `${chats.length} chat(s) with a lead, ${byLead.size} distinct lead(s). Reading owners from Zoho...\n`
  );

  const leads: Lead[] = [];
  const keptByOthers: string[] = [];
  const olderLeads: string[] = [];
  const unreadable: string[] = [];

  for (const [zohoLeadId, chat] of byLead) {
    const owner = await fetchLeadOwner(zohoLeadId, accessToken);
    await sleep(ZOHO_DELAY_MS);

    if (!owner.ok) {
      unreadable.push(`${zohoLeadId}: ${owner.error}`);
      continue;
    }
    // Made before the window: the chat matched somebody's existing record.
    if (!owner.createdAt || owner.createdAt < from) {
      olderLeads.push(`${zohoLeadId} (${owner.ownerEmail || owner.ownerName})`);
      continue;
    }
    // Already somebody else's — not one of the four, and not a mistake to undo.
    const ownerEmail = owner.ownerEmail || "";
    const inPool = moveFrom
      ? ownerEmail === moveFrom
      : AGENTS.includes(ownerEmail) || ALWAYS_MOVE_FROM.includes(ownerEmail);
    if (!inPool) {
      keptByOthers.push(`${zohoLeadId} (${ownerEmail || owner.ownerName})`);
      continue;
    }

    leads.push({
      zohoLeadId,
      createdAt: owner.createdAt,
      ownerEmail: owner.ownerEmail || "",
      ownerName: owner.ownerName || owner.ownerEmail || "?",
      chat,
    });
  }

  leads.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  // Equal shares; any remainder goes to the first in AGENTS order, so Harry is last to get one.
  const share = new Map(agents.map((agent, i) => [agent.email, Math.floor(leads.length / agents.length) + (i < leads.length % agents.length ? 1 : 0)]));
  const holding = new Map(agents.map((agent) => [agent.email, 0]));
  const toMove: Lead[] = [];

  for (const lead of leads) {
    const owner = lead.ownerEmail;
    if (moveFrom) {
      // Every one of theirs goes, dealt out one at a time in --to order.
      toMove.push(lead);
    } else if (holding.has(owner) && holding.get(owner)! < share.get(owner)!) {
      holding.set(owner, holding.get(owner)! + 1);
    } else {
      toMove.push(lead);
    }
  }

  let turn = 0;
  for (const lead of toMove) {
    if (moveFrom) {
      const agent = agents[turn % agents.length];
      lead.newOwner = agent.email;
      holding.set(agent.email, holding.get(agent.email)! + 1);
      turn += 1;
      continue;
    }
    while (holding.get(agents[turn % agents.length].email)! >= share.get(agents[turn % agents.length].email)!) turn += 1;
    const agent = agents[turn % agents.length];
    lead.newOwner = agent.email;
    holding.set(agent.email, holding.get(agent.email)! + 1);
    turn += 1;
  }

  const before = new Map<string, number>();
  for (const lead of leads) before.set(lead.ownerEmail, (before.get(lead.ownerEmail) || 0) + 1);

  console.log(`${leads.length} lead(s) created in the window.`);
  console.log(`\nnow:   ${[...before].map(([who, n]) => `${who} ${n}`).join(", ")}`);
  console.log(`after: ${agents.map((a) => `${a.email} ${holding.get(a.email)}`).join(", ")}`);
  if (keptByOthers.length) console.log(`\nleft with their owner, not one of the four (${keptByOthers.length}): ${keptByOthers.join(", ")}`);
  if (olderLeads.length) console.log(`\nleft alone, made before the window (${olderLeads.length}): ${olderLeads.join(", ")}`);
  if (unreadable.length) console.log(`\ncould not read (${unreadable.length}), left alone:\n  ${unreadable.join("\n  ")}`);

  console.log(`\n${toMove.length} to move:`);
  for (const lead of toMove) {
    console.log(
      `  ${lead.createdAt.toISOString().slice(0, 16)}  ${lead.zohoLeadId}  ${lead.chat.email || lead.chat.phone || "-"}  ` +
        `${lead.ownerEmail || lead.ownerName} -> ${lead.newOwner}`
    );
  }

  if (!apply) {
    console.log(`\nDry run. Re-run with --apply to move these${notify ? "" : " (add --notify for WhatsApp)"}.`);
    await closeConnections();
    process.exit(0);
  }

  const whatsapp = notify && isWhatsAppConfigured(settings);
  if (notify && !whatsapp) console.log("\nWhatsApp is not configured — moving without messages.");
  const group = String(settings.chat?.whatsappChatId || "").trim();

  console.log("\nmoving...\n");
  let moved = 0;
  const failures: string[] = [];

  for (const lead of toMove) {
    const agent = agents.find((a) => a.email === lead.newOwner)!;

    const result = await setLeadOwner(lead.zohoLeadId, agent.zohoUserId, accessToken);
    await sleep(ZOHO_DELAY_MS);
    if (!result.ok) {
      failures.push(`${lead.zohoLeadId}: ${result.error}`);
      console.log(`  FAILED  ${lead.zohoLeadId}: ${result.error}`);
      continue;
    }

    // Our side follows the CRM, so the dashboard, alerts and a returning visitor
    // all land on the new owner. The bot keeps the name it introduced itself by.
    for (const chat of (await ChatConversation.find({ zohoLeadId: lead.zohoLeadId })) as any[]) {
      if (chat.aiMessageCount > 0 && !chat.spokeAs) chat.spokeAs = chat.repName;
      chat.repEmail = agent.email;
      chat.repName = agent.name;
      await chat.save();
    }

    moved += 1;
    console.log(`  moved   ${lead.zohoLeadId}  ${lead.ownerName} -> ${agent.name}`);

    if (whatsapp) {
      const customer = [lead.chat.name, lead.chat.email, lead.chat.phone].filter((v: string) => String(v || "").trim()).join(" · ");
      const lines = (top: string[]) =>
        [
          ...top,
          ...(customer ? [`Customer: ${customer}`] : []),
          `Web view: ${chatWebViewUrl(lead.chat.conversationId)}`,
          `Open chat: ${chatUrlFor(lead.chat, settings)}`,
        ].join("\n");

      const personal = repNumberFor(settings, agent.email);
      const messages = [
        ...(group
          ? [{
              who: "group",
              to: group,
              text: lines([
                "*Chat lead reassigned*",
                `Reassigned from ${titleCase(lead.ownerName)} to ${titleCase(agent.name)}`,
                `Now assigned to: ${titleCase(agent.name)}`,
              ]),
            }]
          : []),
        ...(personal
          ? [{
              who: agent.email,
              to: personal,
              text: lines([
                "*Chat lead reassigned to you*",
                `This lead was with ${titleCase(lead.ownerName)} and is now yours in Zoho.`,
              ]),
            }]
          : []),
      ];
      for (const message of messages) {
        const sent = await sendText(message.to, message.text);
        if (!sent.ok) console.log(`          WhatsApp to ${message.who} failed: ${sent.status || ""} ${sent.error || ""}`);
        await sleep(WHATSAPP_DELAY_MS);
      }
    }
  }

  console.log(`\ndone: ${moved} moved, ${failures.length} failed`);
  if (failures.length) console.log(`\nfailed:\n  ${failures.join("\n  ")}`);

  await closeConnections();
  process.exit(0);
})().catch(async (error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});

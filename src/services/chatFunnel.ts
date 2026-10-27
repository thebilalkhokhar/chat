import axios from "axios";
import type { Connection } from "mongoose";
import { config } from "../config/env";
import { erpAccessToken } from "./erpAuth";
import { chatConversationModel, type ErpActivity, type ErpOutcome } from "../models/ChatConversation";
import { TRAFFIC_SOURCES, isTrafficSource, trafficSourceOf, type TrafficSource, AD_PLATFORMS, adPlatformOf, type AdPlatform } from "../domain/trafficSource";
import { loadFormLeads, saveFormOutcomes } from "./formLeads";

/**
 * Following a website chat to money: chat → Zoho lead → ERP quote → customer →
 * order → payment.
 *
 * The chat side is our own record. Everything after the lead comes from the ERP's
 * `POST /api/dashboard/lead-outcomes`, which takes a visitor's email, phone and
 * the chat's date and answers with the ERP customer they match and that
 * customer's quotes, orders and payments. A visitor who left neither an email
 * nor a phone cannot be looked up, so they stop at the contact stage.
 *
 * The ERP returns each customer's all-time totals with only the first and last
 * dates, so "quoted after the chat" means the customer's latest quote is on or
 * after the chat day. A customer quoted both before and after counts; one quoted
 * only before does not.
 *
 * Lookups are written onto the chat (`erpOutcome`) and reused for a few hours,
 * so the page does not ask the ERP about the same visitor on every load. Only
 * this app's own `chat_conversations` collection is written; nothing in the ERP
 * changes.
 */

export const STAGES = [
  { key: "opened", label: "Chat opened" },
  { key: "engaged", label: "Visitor wrote something" },
  { key: "contact", label: "Gave an email or phone" },
  { key: "lead", label: "Lead in Zoho" },
  { key: "customer", label: "ERP customer" },
  { key: "quoted", label: "Quoted after the chat" },
  { key: "ordered", label: "Ordered after the chat" },
  { key: "paid", label: "Paid after the chat" },
] as const;

export type StageKey = (typeof STAGES)[number]["key"];

const OUTCOME_TTL_MS = 6 * 60 * 60_000;
const BATCH_SIZE = 500;
const PARALLEL_BATCHES = 2;
const REQUEST_TIMEOUT_MS = 30_000;
/** Day boundaries are Pakistan's, like the rest of this dashboard. Pakistan keeps no daylight saving. */
const PKT_OFFSET = "+05:00";
const DAY_MS = 86_400_000;

/* ---------- date range ---------- */

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;

export interface FunnelRange {
  from: string;
  to: string;
  start: Date;
  /** Exclusive: midnight after `to`. */
  end: Date;
}

const pktDay = (at: Date) => new Date(at.getTime() + 5 * 3_600_000).toISOString().slice(0, 10);

/** Inclusive Pakistan days; the last 30 days when either end is missing or unreadable. */
export function resolveRange(from?: string, to?: string): FunnelRange {
  const today = pktDay(new Date());
  const valid = (day?: string) => Boolean(day && DAY_KEY.test(day) && !Number.isNaN(Date.parse(`${day}T00:00:00${PKT_OFFSET}`)));
  let start = valid(from) ? from! : pktDay(new Date(Date.now() - 29 * DAY_MS));
  let end = valid(to) ? to! : today;
  if (end > today) end = today;
  if (start > end) start = end;
  return {
    from: start,
    to: end,
    start: new Date(`${start}T00:00:00${PKT_OFFSET}`),
    end: new Date(Date.parse(`${end}T00:00:00${PKT_OFFSET}`) + DAY_MS),
  };
}

/* ---------- the ERP lookup ---------- */

interface FunnelChat {
  _id: unknown;
  conversationId: string;
  createdAt: Date;
  name?: string;
  email?: string;
  phone?: string;
  repEmail?: string;
  repName?: string;
  status?: string;
  handoffReason?: string;
  zohoLeadId?: string;
  landingPageTitle?: string;
  /** A website chat, or a quote-form lead from the Zoho connector (see formLeads.ts). */
  kind?: "chat" | "form";
  /** What a form lead asked for. */
  product?: string;
  /** A form lead's page, as a full address. */
  pageUrl?: string;
  currentPageUrl?: string;
  landingPageUrl?: string;
  referer?: string;
  visitorChannel?: string;
  erpOutcome?: ErpOutcome;
}

const emailOf = (chat: FunnelChat) => String(chat.email || "").trim().toLowerCase();
const phoneOf = (chat: FunnelChat) => String(chat.phone || "").trim();
const traceable = (chat: FunnelChat) => Boolean(emailOf(chat) || phoneOf(chat));

function activityOf(raw: any): ErpActivity {
  return {
    count: Number(raw?.count) || 0,
    firstAt: raw?.first_at ? String(raw.first_at) : null,
    lastAt: raw?.last_at ? String(raw.last_at) : null,
    amount: Number(raw?.total_amount) || 0,
  };
}

function outcomeOf(raw: any, checkedAt: Date): ErpOutcome {
  const matched = Boolean(raw?.matched);
  return {
    checkedAt,
    matched,
    matchedBy: raw?.matched_by === "email" || raw?.matched_by === "phone" ? raw.matched_by : null,
    ambiguous: Boolean(raw?.ambiguous),
    customerId: raw?.customer?.id != null ? Number(raw.customer.id) : null,
    customerName: String(raw?.customer?.company_name || ""),
    customerCreatedAt: raw?.customer?.created_at ? String(raw.customer.created_at) : null,
    customerRep: String(raw?.sale_rep?.name || ""),
    isNewCustomer: matched && typeof raw?.is_new_customer === "boolean" ? raw.is_new_customer : null,
    quotes: activityOf(raw?.quotes),
    orders: activityOf(raw?.orders),
    payments: activityOf(raw?.payments),
  };
}

/** One batch of up to 500 chats, retried once on a fresh token if the cached one is refused. */
async function lookUp(batch: FunnelChat[], attempt = 0): Promise<any[]> {
  const bearer = await erpAccessToken(attempt > 0);
  if (!bearer) throw new Error("the ERP refused a token");

  const response = await axios.post(
    `${config.erp.baseUrl}/api/dashboard/lead-outcomes`,
    {
      leads: batch.map((chat) => ({
        lead_ref: chat.conversationId,
        created_at: new Date(chat.createdAt).toISOString(),
        email: emailOf(chat),
        phone: phoneOf(chat),
      })),
    },
    {
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${bearer}` },
      timeout: REQUEST_TIMEOUT_MS,
      validateStatus: () => true,
    }
  );

  if (response.status === 401 && attempt === 0) return lookUp(batch, 1);
  if (response.status !== 200 || response.data?.status !== "success" || !Array.isArray(response.data?.data)) {
    throw new Error(`the ERP answered ${response.status}`);
  }
  return response.data.data;
}

let refreshing: Promise<void> | null = null;

/**
 * Asks the ERP about every chat here whose outcome is missing or stale, and stores
 * the answers on the chats. Concurrent page loads share one round of lookups.
 */
async function refreshOutcomes(chats: FunnelChat[], save: (looked: FunnelChat[]) => Promise<void>): Promise<void> {
  if (refreshing) await refreshing;

  const now = Date.now();
  const stale = chats.filter(
    (chat) => traceable(chat) && (!chat.erpOutcome || now - new Date(chat.erpOutcome.checkedAt).getTime() >= OUTCOME_TTL_MS)
  );
  if (!stale.length) return;

  refreshing = (async () => {
    const batches = Array.from({ length: Math.ceil(stale.length / BATCH_SIZE) }, (_, index) =>
      stale.slice(index * BATCH_SIZE, (index + 1) * BATCH_SIZE)
    );

    for (let index = 0; index < batches.length; index += PARALLEL_BATCHES) {
      const group = batches.slice(index, index + PARALLEL_BATCHES);
      const answers = (await Promise.all(group.map((batch) => lookUp(batch)))).flat();
      const checkedAt = new Date();
      const byRef = new Map(answers.map((row) => [String(row?.lead_ref), row]));

      const looked = group.flat().filter((chat) => {
        const row = byRef.get(chat.conversationId);
        if (row) chat.erpOutcome = outcomeOf(row, checkedAt);
        return Boolean(row);
      });
      if (looked.length) await save(looked);
    }
  })().finally(() => {
    refreshing = null;
  });

  await refreshing;
}

/* ---------- stages ---------- */

/** When an ERP date ends: a bare day counts until that day's last second in Pakistan. */
function endOf(at: string): number {
  return DAY_KEY.test(at) ? Date.parse(`${at}T23:59:59${PKT_OFFSET}`) : Date.parse(at);
}

const after = (activity: ErpActivity | undefined, chat: FunnelChat) =>
  Boolean(activity && activity.count > 0 && activity.lastAt && endOf(activity.lastAt) >= new Date(chat.createdAt).getTime());

/** The stages a chat that the visitor wrote in has reached. */
function stagesOf(chat: FunnelChat): Record<Exclude<StageKey, "opened">, boolean> {
  const outcome = chat.erpOutcome;
  const customer = Boolean(outcome?.matched);
  const form = chat.kind === "form";
  return {
    engaged: !form,
    contact: !form && traceable(chat),
    lead: form || Boolean(chat.zohoLeadId),
    customer,
    quoted: customer && after(outcome?.quotes, chat),
    ordered: customer && after(outcome?.orders, chat),
    paid: customer && after(outcome?.payments, chat),
  };
}

/* ---------- loading ---------- */

const repKey = (chat: { repEmail?: string; repName?: string }) => String(chat.repEmail || "").toLowerCase() || "(none)";

/** A chat as the funnel reads it: whether the visitor wrote anything, and where they came from. */
type FunnelRow = FunnelChat & { kind: "chat" | "form"; engaged: boolean; source: TrafficSource };
type LeadType = "all" | "chat" | "form";
const isLeadType = (value: unknown): value is LeadType => value === "all" || value === "chat" || value === "form";

interface Loaded {
  range: FunnelRange;
  /** Every chat in the range; the ones with `engaged` set carry their ERP outcome. */
  rows: FunnelRow[];
  lookupError: string | null;
}

/** How long a loaded range is reused: the funnel and its list ask for the same chats moments apart. */
const LOADED_TTL_MS = 2 * 60_000;
const MAX_LOADED = 20;
const loaded = new Map<string, { at: number; value: Promise<Loaded> }>();

/**
 * The chats for a range, read once and shared for a couple of minutes. Reading
 * them means reading every transcript in the range, which takes seconds, and
 * the page asks again for every stage clicked and every page turned.
 */
function load(leadsDb: Connection, connectorDb: Connection, range: FunnelRange, rep: string): Promise<Loaded> {
  const key = `${range.from}|${range.to}|${rep}`;
  const hit = loaded.get(key);
  if (hit && Date.now() - hit.at < LOADED_TTL_MS) return hit.value;

  if (loaded.size >= MAX_LOADED) loaded.clear();
  const value = read(leadsDb, connectorDb, range, rep);
  loaded.set(key, { at: Date.now(), value });
  // A failed read is not kept: the next request tries again.
  value.catch(() => loaded.delete(key));
  return value;
}

async function read(leadsDb: Connection, connectorDb: Connection, range: FunnelRange, rep: string): Promise<Loaded> {
  const Chat = chatConversationModel(leadsDb);
  const match: Record<string, unknown> = { createdAt: { $gte: range.start, $lt: range.end } };
  if (rep) match.repEmail = rep;

  // Most chats are opened and never typed in, so they are only counted; the ones
  // with a visitor message are the funnel proper and are read in full.
  const raw = await Chat.aggregate([
    { $match: match },
    {
      $project: {
        conversationId: 1, createdAt: 1, name: 1, email: 1, phone: 1, repEmail: 1, repName: 1, status: 1,
        handoffReason: 1, zohoLeadId: 1, landingPageTitle: 1, erpOutcome: 1,
        currentPageUrl: 1, landingPageUrl: 1, referer: 1, visitorChannel: 1,
        engaged: {
          $gt: [{ $size: { $filter: { input: { $ifNull: ["$messages", []] }, cond: { $eq: ["$$this.author", "visitor"] } } } }, 0],
        },
      },
    },
  ]);
  const chatRows = raw.map((row) => ({ ...row, kind: "chat", source: trafficSourceOf(row) })) as FunnelRow[];
  const formRows = (await loadFormLeads(leadsDb, connectorDb, range, rep)).map((lead) => ({ ...lead, engaged: false })) as FunnelRow[];
  const rows = [...chatRows, ...formRows];

  const chats = chatRows.filter((row) => row.engaged);
  let lookupError: string | null = null;
  if (config.erp.baseUrl && config.erp.refreshToken) {
    try {
      await refreshOutcomes(chats, async (looked) => {
        await chatConversationModel(leadsDb).bulkWrite(
          looked.map((chat) => ({ updateOne: { filter: { _id: chat._id }, update: { $set: { erpOutcome: chat.erpOutcome } } } })) as any,
          { ordered: false }
        );
      });
      await refreshOutcomes(formRows, (looked) => saveFormOutcomes(leadsDb, looked));
    } catch (error: any) {
      // Stored outcomes are still shown; the page says the newest could not be fetched.
      lookupError = `Could not check the ERP: ${error.message}`;
    }
  } else {
    lookupError = "The ERP is not configured. Set ERP_BASE_URL and ERP_REFRESH_TOKEN.";
  }

  return { range, rows, lookupError };
}

/* ---------- what the page asks for ---------- */

/**
 * Money beside the stage counts.
 *
 * `revenue` is new customers' payments only (see addRevenue). The values are
 * every matched lead's ERP totals since the lead came in — quoted, ordered and
 * paid — counted once per customer, because the ERP answers per customer and
 * two leads from one buyer would otherwise count their quotes twice.
 * `openQuoteValue` is what has been quoted to customers who have not ordered yet.
 */
type Values = { quoteValue: number; orderValue: number; paidValue: number; openQuoteValue: number; quotedCustomers: number; orderedCustomers: number };
type Counts = Record<StageKey, number> & { revenue: number } & Values;

const emptyCounts = (): Counts => ({
  opened: 0, engaged: 0, contact: 0, lead: 0, customer: 0, quoted: 0, ordered: 0, paid: 0, revenue: 0,
  quoteValue: 0, orderValue: 0, paidValue: 0, openQuoteValue: 0, quotedCustomers: 0, orderedCustomers: 0,
});

/**
 * A lead's ERP totals, once per customer, under the same rule as the stages:
 * a quote, order or payment counts only when it came after the lead.
 */
function addValues(counts: Counts, seen: Set<number>, row: FunnelRow, stages: ReturnType<typeof stagesOf>) {
  const outcome = row.erpOutcome;
  if (!outcome?.matched || outcome.customerId == null || seen.has(outcome.customerId)) return;
  if (row.kind === "chat" && !row.engaged) return;
  seen.add(outcome.customerId);
  if (stages.quoted) {
    counts.quoteValue += outcome.quotes.amount;
    counts.quotedCustomers++;
    if (!stages.ordered) counts.openQuoteValue += outcome.quotes.amount;
  }
  if (stages.ordered) {
    counts.orderValue += outcome.orders.amount;
    counts.orderedCustomers++;
  }
  if (stages.paid) counts.paidValue += outcome.payments.amount;
}

/** Days from the lead to an ERP event, or null when there was none or the dates are off. */
function daysAfter(row: FunnelRow, at: string | null): number | null {
  if (!at) return null;
  const days = (new Date(at).getTime() - new Date(row.createdAt).getTime()) / DAY_MS;
  return Number.isFinite(days) && days >= 0 ? days : null;
}

const median = (values: number[]): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};

/**
 * Revenue counted once per customer, and only from new customers: an existing
 * customer's ERP total includes everything they paid before the chat.
 */
function addRevenue(counts: Counts, seen: Set<number>, chat: FunnelChat, paid: boolean) {
  const outcome = chat.erpOutcome;
  if (!paid || !outcome?.isNewCustomer || outcome.customerId == null || seen.has(outcome.customerId)) return;
  seen.add(outcome.customerId);
  counts.revenue += outcome.payments.amount;
}

/** Adds one chat to a set of counts: opened always, the later stages when it reached them. */
function count(counts: Counts, seen: Set<number>, row: FunnelRow, valueSeen?: Set<number>) {
  if (row.kind === "chat") {
    counts.opened++;
    if (!row.engaged) return;
  }
  const stages = stagesOf(row);
  for (const [stage, reached] of Object.entries(stages) as [StageKey, boolean][]) if (reached) counts[stage]++;
  addRevenue(counts, seen, row, stages.paid);
  if (valueSeen) addValues(counts, valueSeen, row, stages);
}

type FunnelQuery = { from?: string; to?: string; rep?: string; source?: string; type?: string };

export async function chatFunnel(leadsDb: Connection, connectorDb: Connection, query: FunnelQuery) {
  const range = resolveRange(query.from, query.to);
  const rep = String(query.rep || "").trim().toLowerCase();
  const source = isTrafficSource(query.source) ? query.source : null;
  const type: LeadType = isLeadType(query.type) ? query.type : "all";
  const { rows: everything, lookupError } = await load(leadsDb, connectorDb, range, rep === "all" ? "" : rep);
  const rows = type === "all" ? everything : everything.filter((row) => row.kind === type);

  // Every source side by side, for the row at the top. Worked out before the
  // source filter, so picking one still shows the others to compare against.
  const bySource = new Map(TRAFFIC_SOURCES.map((s) => [s.key, { counts: emptyCounts(), seen: new Set<number>(), valueSeen: new Set<number>(), chatLeads: 0, formLeads: 0 }]));
  for (const row of rows) {
    const entry = bySource.get(row.source)!;
    count(entry.counts, entry.seen, row, entry.valueSeen);
    if (row.kind === "form") entry.formLeads++;
    else if (row.zohoLeadId && row.engaged) entry.chatLeads++;
  }

  const scoped = source ? rows.filter((row) => row.source === source) : rows;
  const leadKinds = { chat: scoped.filter((row) => row.kind === "chat" && row.engaged && row.zohoLeadId).length, form: scoped.filter((row) => row.kind === "form").length };

  // One row per Pakistan day in the range, zeros included, so a quiet day is a dip and not a gap.
  const daily = new Map<string, Counts>();
  for (let at = range.start.getTime(); at < range.end.getTime(); at += DAY_MS) daily.set(pktDay(new Date(at)), emptyCounts());
  const endings = new Map<string, number>();

  const total = emptyCounts();
  const totalSeen = new Set<number>();
  const totalValueSeen = new Set<number>();
  const reps = new Map<string, Counts & { repName: string; seen: Set<number>; valueSeen: Set<number> }>();
  const toQuote: number[] = [];
  const toPayment: number[] = [];

  let ambiguous = 0;
  let newCustomers = 0;
  const newSeen = new Set<number>();
  let oldestCheck: number | null = null;
  for (const row of scoped) {
    const key = repKey(row);
    if (!reps.has(key)) reps.set(key, { ...emptyCounts(), repName: row.repName || row.repEmail || "No rep", seen: new Set(), valueSeen: new Set() });
    const repCounts = reps.get(key)!;
    count(total, totalSeen, row, totalValueSeen);
    count(repCounts, repCounts.seen, row, repCounts.valueSeen);

    // Each stage is counted on the day the chat opened, not the day the quote or payment came.
    const dayCounts = daily.get(pktDay(new Date(row.createdAt)));
    if (dayCounts) count(dayCounts, new Set(), row);
    // A chat nobody typed in has nothing more to count; a form lead always does.
    if (row.kind === "chat" && !row.engaged) continue;

    if (row.kind === "chat") {
      const ending = row.handoffReason || (row.status === "active" ? "still_open" : row.status || "unknown");
      endings.set(ending, (endings.get(ending) ?? 0) + 1);
    }

    const outcome = row.erpOutcome;
    if (outcome?.ambiguous) ambiguous++;
    if (stagesOf(row).paid && outcome?.isNewCustomer && outcome.customerId != null && !newSeen.has(outcome.customerId)) {
      newSeen.add(outcome.customerId);
      newCustomers++;
    }
    if (outcome?.matched) {
      const reached = stagesOf(row);
      const quoteDays = reached.quoted ? daysAfter(row, outcome.quotes.firstAt) : null;
      const paidDays = reached.paid ? daysAfter(row, outcome.payments.firstAt) : null;
      if (quoteDays !== null) toQuote.push(quoteDays);
      if (paidDays !== null) toPayment.push(paidDays);
    }
    if (outcome) {
      const checked = new Date(outcome.checkedAt).getTime();
      oldestCheck = oldestCheck === null ? checked : Math.min(oldestCheck, checked);
    }
  }

  const round = (counts: Counts) => ({
    ...counts,
    revenue: Math.round(counts.revenue),
    quoteValue: Math.round(counts.quoteValue),
    orderValue: Math.round(counts.orderValue),
    paidValue: Math.round(counts.paidValue),
    openQuoteValue: Math.round(counts.openQuoteValue),
  });
  const oneDecimal = (days: number | null) => (days === null ? null : Math.round(days * 10) / 10);
  return {
    from: range.from,
    to: range.to,
    rep: rep || "all",
    source: source || "all",
    type,
    /** How the range's leads split between chats and forms, after the filters. */
    leadKinds,
    lookupError,
    checkedSince: oldestCheck ? new Date(oldestCheck).toISOString() : null,
    stages: STAGES.map((stage) => ({ ...stage, count: total[stage.key] })),
    newCustomers,
    newRevenue: Math.round(total.revenue),
    /** Every matched lead's ERP totals since the lead, once per customer — see addValues. */
    values: (({ quoteValue, orderValue, paidValue, openQuoteValue, quotedCustomers, orderedCustomers }) => ({ quoteValue, orderValue, paidValue, openQuoteValue, quotedCustomers, orderedCustomers }))(round(total)),
    /** Median days from the lead to its first quote and first payment, with how many leads each is over. */
    speed: { leadToQuoteDays: oneDecimal(median(toQuote)), quotedLeads: toQuote.length, leadToPaymentDays: oneDecimal(median(toPayment)), paidLeads: toPayment.length },
    ambiguous,
    /** Each traffic source's funnel, whatever source is selected. */
    sources: TRAFFIC_SOURCES.map((s) => {
      const entry = bySource.get(s.key)!;
      return { ...s, ...round(entry.counts), chatLeads: entry.chatLeads, formLeads: entry.formLeads };
    }),
    /** Per Pakistan day of the chat; revenue is left out, being counted per customer rather than per day. */
    daily: [...daily.entries()].map(([day, counts]) => {
      const { revenue: _revenue, quoteValue: _q, orderValue: _o, paidValue: _p, openQuoteValue: _oq, quotedCustomers: _qc, orderedCustomers: _oc, ...stages } = counts;
      return { day, ...stages };
    }),
    /** How the chats the visitor wrote in came to an end, most common first. */
    endings: [...endings.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    reps: [...reps.entries()]
      .map(([repEmail, counts]) => {
        const { seen: _seen, valueSeen: _valueSeen, repName, ...rest } = counts;
        return { repEmail, repName, ...round(rest) };
      })
      .sort((a, b) => b.paid - a.paid || b.quoted - a.quoted || b.engaged - a.engaged || a.repName.localeCompare(b.repName)),
  };
}

const PAGE_SIZE = 25;
const LISTABLE = new Set<StageKey>(["engaged", "contact", "lead", "customer", "quoted", "ordered", "paid"]);

/** The chats that reached one stage, newest first, with what the ERP knows about each. */
export async function chatFunnelList(
  leadsDb: Connection,
  connectorDb: Connection,
  query: FunnelQuery & { stage?: string; page?: string }
) {
  const range = resolveRange(query.from, query.to);
  const rep = String(query.rep || "").trim().toLowerCase();
  const stage = (LISTABLE.has(query.stage as StageKey) ? query.stage : "engaged") as Exclude<StageKey, "opened">;
  const source = isTrafficSource(query.source) ? query.source : null;
  const type: LeadType = isLeadType(query.type) ? query.type : "all";
  const { rows, lookupError } = await load(leadsDb, connectorDb, range, rep === "all" ? "" : rep);

  const reached = rows
    .filter((row) => (row.kind === "form" || row.engaged) && (type === "all" || row.kind === type) && (!source || row.source === source))
    .filter((chat) => stagesOf(chat)[stage])
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const pages = Math.max(1, Math.ceil(reached.length / PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, Number(query.page) || 1));

  return {
    stage,
    lookupError,
    total: reached.length,
    page,
    pages,
    chats: reached.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE).map((chat) => {
      const stages = stagesOf(chat);
      return {
        conversationId: chat.conversationId,
        createdAt: chat.createdAt,
        name: chat.name || "",
        email: chat.email || "",
        phone: chat.phone || "",
        repName: chat.repName || chat.repEmail || "",
        status: chat.status || "",
        handoffReason: chat.handoffReason || "",
        landingPageTitle: chat.landingPageTitle || "",
        source: chat.source,
        kind: chat.kind,
        product: chat.product || "",
        // Where the lead came in: the form's page, or the page the chat began on.
        pageUrl: (chat.kind === "form" ? chat.pageUrl : chat.landingPageUrl || chat.currentPageUrl) || "",
        zohoLeadId: chat.zohoLeadId || "",
        reached: (Object.keys(stages) as (keyof typeof stages)[]).filter((key) => stages[key]),
        outcome: chat.erpOutcome || null,
      };
    }),
  };
}

/* ---------- the marketing screen (super admin) ---------- */

/**
 * A customer's first payment on or after the lead: the ERP's lead outcome only
 * carries payment totals, so the amount of the first one is read from
 * get-payments. Only paid leads are looked up, a handful a month, cached.
 */
const firstPayments = new Map<string, { at: number; value: Promise<{ amount: number; date: string } | null> }>();

function firstPaymentFor(customerId: number, fromDay: string): Promise<{ amount: number; date: string } | null> {
  const key = `${customerId}|${fromDay}`;
  const hit = firstPayments.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
  const value = (async () => {
    const token = await erpAccessToken();
    if (!token) return null;
    const { data } = await axios.get(`${config.erp.baseUrl}/api/get-payments`, {
      params: { customer_id: customerId, date_from: fromDay },
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      timeout: 15000,
    });
    const rows: any[] = Array.isArray(data?.data) ? data.data : [];
    rows.sort((a, b) => String(a.received_at || a.payment_date).localeCompare(String(b.received_at || b.payment_date)));
    const first = rows[0];
    return first ? { amount: Number(first.amount) || 0, date: String(first.payment_date || first.received_at || "").slice(0, 10) } : null;
  })().catch(() => null);
  firstPayments.set(key, { at: Date.now(), value });
  return value;
}

type MarketingStatus = "lead" | "customer" | "quoted" | "invoiced" | "paid";
const STATUS_ORDER: MarketingStatus[] = ["lead", "customer", "quoted", "invoiced", "paid"];

/**
 * Leads by source, and every lead with what became of it: quoted, invoiced
 * (an ERP order is its invoice), paid — the first payment only, so a repeat
 * order never inflates what marketing brought in. One row per lead, chats and
 * website forms alike.
 */
export async function marketingReport(
  leadsDb: Connection,
  connectorDb: Connection,
  query: { from?: string; to?: string; source?: string; status?: string; type?: string; minQuote?: string; page?: string; size?: string }
) {
  const range = resolveRange(query.from, query.to);
  const { rows, lookupError } = await load(leadsDb, connectorDb, range, "");
  const leads = rows.filter((row) => row.kind === "form" || (row.engaged && row.zohoLeadId));

  // Company names from the Zoho lead records (chats and forms alike), read in one query.
  const zohoIds = leads.map((row) => row.zohoLeadId).filter((id): id is string => Boolean(id));
  const companyRows = zohoIds.length
    ? await connectorDb.collection("leads").find({ zohoLeadId: { $in: zohoIds } }, { projection: { zohoLeadId: 1, company: 1 } }).toArray()
    : [];
  const realCompany = (value: unknown) => {
    const text = String(value || "").trim();
    return /^(n\/?a|na|none|nil|-+|\.+|test|print247 quote|unknown)$/i.test(text) ? "" : text;
  };
  const zohoCompany = new Map(companyRows.map((row: any) => [String(row.zohoLeadId), realCompany(row.company)]));

  const described = await Promise.all(
    leads.map(async (row) => {
      const stages = stagesOf(row);
      const outcome = row.erpOutcome;
      const status: MarketingStatus = stages.paid ? "paid" : stages.ordered ? "invoiced" : stages.quoted ? "quoted" : stages.customer ? "customer" : "lead";
      const first = stages.paid && outcome?.customerId != null ? await firstPaymentFor(outcome.customerId, pktDay(new Date(row.createdAt))) : null;
      return {
        conversationId: row.conversationId,
        createdAt: row.createdAt,
        kind: row.kind,
        source: row.source,
        platform: adPlatformOf({
          pages: [row.pageUrl, row.landingPageUrl, row.currentPageUrl].filter((u): u is string => Boolean(u)),
          referer: row.referer,
          visitorChannel: row.visitorChannel,
          source: row.source,
        }),
        name: row.name || "",
        email: row.email || "",
        phone: row.phone || "",
        // What the customer gave on the lead; otherwise the ERP customer's name.
        company: zohoCompany.get(String(row.zohoLeadId || "")) || (outcome?.matched ? realCompany(outcome.customerName) : ""),
        repName: row.repName || row.repEmail || "",
        product: row.product || "",
        pageUrl: (row.kind === "form" ? row.pageUrl : row.landingPageUrl || row.currentPageUrl) || "",
        zohoLeadId: row.zohoLeadId || "",
        status,
        newCustomer: Boolean(outcome?.isNewCustomer),
        quote: stages.quoted ? { count: outcome!.quotes.count, amount: Math.round(outcome!.quotes.amount), at: outcome!.quotes.firstAt } : null,
        invoice: stages.ordered ? { count: outcome!.orders.count, amount: Math.round(outcome!.orders.amount), at: outcome!.orders.firstAt } : null,
        paid: stages.paid ? { amount: Math.round(first?.amount || 0), at: first?.date || outcome!.payments.firstAt } : null,
        customerId: outcome?.customerId ?? null,
        /** Set on a customer's later leads: the day of their first lead, which carries the amounts. */
        sameCustomerAs: null as string | null,
      };
    })
  );

  const source = isTrafficSource(query.source) ? query.source : null;
  const type = query.type === "chat" || query.type === "form" ? query.type : null;

  // Per source, then the total; each ERP customer's money counted once. The
  // cards follow the source and lead-type filters; the source table follows the
  // lead type, so every source stays visible to compare against.
  const blank = () => ({ leads: 0, chat: 0, form: 0, quoted: 0, quoteValue: 0, invoiced: 0, invoiceValue: 0, paid: 0, paidValue: 0 });
  const totals = blank();
  const bySource = new Map(TRAFFIC_SOURCES.map((s) => [s.key, blank()]));
  const byPlatform = new Map(AD_PLATFORMS.map((p) => [p.key, blank()]));
  const counted = new Map<string, Set<number>>();
  const once = (bucket: string, id: number | null) => {
    if (id == null) return true;
    const set = counted.get(bucket) || counted.set(bucket, new Set()).get(bucket)!;
    if (set.has(id)) return false;
    set.add(id);
    return true;
  };
  for (const lead of described) {
    if (type && lead.kind !== type) continue;
    const inTotals = !source || lead.source === source;
    const scopes: [string, ReturnType<typeof blank>][] = [["all", totals], [lead.source, bySource.get(lead.source)!]];
    if (lead.platform) scopes.push([`p:${lead.platform}`, byPlatform.get(lead.platform)!]);
    for (const [scope, sums] of scopes) {
      if (scope === "all" && !inTotals) continue;
      if (scope.startsWith("p:") && !inTotals) continue;
      sums.leads++;
      sums[lead.kind]++;
      if (lead.quote) { sums.quoted++; if (once(`${scope}q`, lead.customerId)) sums.quoteValue += lead.quote.amount; }
      if (lead.invoice) { sums.invoiced++; if (once(`${scope}i`, lead.customerId)) sums.invoiceValue += lead.invoice.amount; }
      if (lead.paid) { sums.paid++; if (once(`${scope}p`, lead.customerId)) sums.paidValue += lead.paid.amount; }
    }
  }

  // The ERP reports a customer's quote, invoice and payment totals, not a figure
  // per lead, so a customer with two leads showed the same amounts on both and
  // the list added up to more than the cards. Only their first lead in the range
  // keeps the amounts; the later ones keep the tick and point back to it.
  const firstLeadOf = new Map<number, (typeof described)[number]>();
  for (const lead of [...described].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())) {
    if (lead.customerId == null) continue;
    const first = firstLeadOf.get(lead.customerId);
    if (!first) {
      firstLeadOf.set(lead.customerId, lead);
      continue;
    }
    lead.sameCustomerAs = pktDay(new Date(first.createdAt));
    if (lead.quote) lead.quote = { ...lead.quote, amount: 0 };
    if (lead.invoice) lead.invoice = { ...lead.invoice, amount: 0 };
    if (lead.paid) lead.paid = { ...lead.paid, amount: 0 };
  }

  const status = STATUS_ORDER.includes(query.status as MarketingStatus) ? (query.status as MarketingStatus) : null;
  const notQuoted = query.status === "not_quoted";
  const minQuote = Math.max(0, Number(query.minQuote) || 0);
  const listed = described
    .filter((lead) => (!source || lead.source === source) && (!type || lead.kind === type))
    .filter((lead) => (notQuoted ? !lead.quote : !status || STATUS_ORDER.indexOf(lead.status) >= STATUS_ORDER.indexOf(status)))
    // Quote value: leads quoted at least this much (more than $1,000, $5,000, or a typed amount).
    .filter((lead) => !minQuote || (lead.quote !== null && lead.quote.amount >= minQuote))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const size = Math.min(500, Math.max(10, Number(query.size) || 50));
  const pages = Math.max(1, Math.ceil(listed.length / size));
  const page = Math.min(pages, Math.max(1, Number(query.page) || 1));

  // Budget for the range. A source filter keeps the platforms that bring that
  // traffic; the lead-type filter cannot narrow it (spend is per platform, not
  // per chat or form).
  const spend = await spendFor(leadsDb, range);
  const forSource: Record<TrafficSource, AdPlatform[]> = { ppc: ["google", "bing"], messaging: ["meta"], social: ["meta", "linkedin"], organic: [], unknown: [] };
  const totalSpend = source ? forSource[source].reduce((sum, key) => sum + (spend.byPlatform[key] || 0), 0) : spend.total;

  return {
    from: range.from,
    to: range.to,
    lookupError,
    totals: { ...totals, spend: totalSpend },
    budget: { months: spend.months, total: spend.total, typeFiltered: Boolean(type) },
    sources: TRAFFIC_SOURCES.map((s) => ({ key: s.key, label: s.label, ...bySource.get(s.key)! })),
    platforms: AD_PLATFORMS.map((p) => ({ key: p.key, label: p.label, ...byPlatform.get(p.key)!, spend: spend.byPlatform[p.key] || 0 })),
    total: listed.length,
    page,
    pages,
    leads: listed.slice((page - 1) * size, page * size).map(({ customerId: _customerId, ...lead }) => lead),
  };
}

/* ---------- marketing budgets ---------- */

/**
 * What was spent on marketing, entered by hand per month and per source in the
 * marketing view. A range that covers part of a month takes the matching share
 * of that month's budget, by days: 1–15 October counts 15/31 of October.
 */
const BUDGETS = "marketing_budgets";
const MONTH_KEY = /^\d{4}-(0[1-9]|1[0-2])$/;

export type BudgetSources = Partial<Record<AdPlatform, number>>;

export async function listBudgets(leadsDb: Connection, year: number) {
  const rows = await leadsDb.collection(BUDGETS).find({ _id: { $regex: `^${year}-` } as any }).toArray();
  return rows.map((row: any) => ({ month: String(row._id), sources: row.sources || {}, updatedBy: row.updatedBy || "", updatedAt: row.updatedAt || null }));
}

export async function saveBudget(leadsDb: Connection, month: string, sources: Record<string, unknown>, by: string) {
  if (!MONTH_KEY.test(month)) throw new Error("Month must be YYYY-MM");
  const clean: BudgetSources = {};
  for (const platform of AD_PLATFORMS) {
    const value = Number(sources?.[platform.key]);
    if (Number.isFinite(value) && value > 0) clean[platform.key] = Math.round(value * 100) / 100;
  }
  await leadsDb.collection(BUDGETS).updateOne(
    { _id: month as any },
    { $set: { sources: clean, updatedBy: by, updatedAt: new Date() } },
    { upsert: true }
  );
  return { month, sources: clean };
}

/** Spend per source over a range, each month's budget taken in proportion to the days covered. */
async function spendFor(leadsDb: Connection, range: FunnelRange): Promise<{ byPlatform: BudgetSources; total: number; months: number }> {
  const [fromYear, fromMonth] = range.from.split("-").map(Number);
  const [toYear, toMonth] = range.to.split("-").map(Number);
  const keys: string[] = [];
  for (let y = fromYear, m = fromMonth; y < toYear || (y === toYear && m <= toMonth); m === 12 ? (y++, (m = 1)) : m++) {
    keys.push(`${y}-${String(m).padStart(2, "0")}`);
  }
  const rows = await leadsDb.collection(BUDGETS).find({ _id: { $in: keys } as any }).toArray();
  const byPlatform: BudgetSources = {};
  let total = 0;
  for (const row of rows as any[]) {
    const [y, m] = String(row._id).split("-").map(Number);
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const first = `${row._id}-01`;
    const last = `${row._id}-${String(days).padStart(2, "0")}`;
    const start = range.from > first ? range.from : first;
    const end = range.to < last ? range.to : last;
    const covered = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS) + 1;
    const share = Math.max(0, Math.min(1, covered / days));
    for (const [platform, amount] of Object.entries(row.sources || {})) {
      if (!AD_PLATFORMS.some((p) => p.key === platform)) continue;
      const part = Number(amount) * share;
      byPlatform[platform as AdPlatform] = (byPlatform[platform as AdPlatform] || 0) + part;
      total += part;
    }
  }
  for (const key of Object.keys(byPlatform) as AdPlatform[]) byPlatform[key] = Math.round(byPlatform[key]!);
  return { byPlatform, total: Math.round(total), months: rows.length };
}

/**
 * Whole chats through the real engine, the real model and the real ERP, with a
 * simulated customer answering whatever the bot asks.
 *
 * Conversations are written to a throwaway database (`lead_follow_up_e2e_test`)
 * that is dropped at the end, never to the live one. Settings are READ from the
 * live database so the bot behaves as it does in production, with office hours
 * and the live-agent hand-off switched off so the bot handles every chat.
 *
 * Each priced chat writes one price record to the ERP under an "e2e-" chat id.
 *
 *   npm run test:e2e            all scenarios
 *   npm run test:e2e -- gummies  only scenarios whose name contains "gummies"
 */
import mongoose from "mongoose";
import { config } from "../config/env";
import { settingsModel } from "../models/Settings";
import { chatConversationModel } from "../models/ChatConversation";
import { runChatTurn, type IncomingChat } from "../services/salesiq/chatEngine";

// One database per run, so two runs can never drop each other's chats.
const TEST_DB = `lead_follow_up_e2e_${Date.now().toString(36)}`;
const MAX_TURNS = 16;

function uriFor(database: string): string {
  const [beforeQuery, query] = config.mongoUri.split("?");
  return `${beforeQuery.replace(/\/[^/]*$/, "")}/${database}${query ? `?${query}` : ""}`;
}

interface Customer {
  opening: string;
  size?: string;
  gusset?: string;
  finish?: string;
  qty?: string;
  skus?: string;
  zipper?: string;
  material?: string;
  style?: string;
  email?: string;
  name?: string;
  phone?: string;
  /** Said after the first reply, whatever was asked. */
  interrupt?: string;
}

interface Expect {
  priced: boolean;
  productId?: number;
  dimensions?: number[];
  qty?: number;
  /** The bot must not state the 1000 minimum. */
  noMinimum?: boolean;
  /** The bot must state the minimum. */
  minimum?: boolean;
  /** No price before this many visitor messages. */
  noPriceBeforeQtyAsked?: boolean;
}

interface Scenario {
  name: string;
  customer: Customer;
  expect: Expect;
}

const SCENARIOS: Scenario[] = [
  {
    name: "gummies, 4x6 — flat pouch",
    customer: { opening: "mylar bags for gummies", size: "4x6 inches", finish: "matte", qty: "1000", skus: "1", zipper: "yes", material: "no" },
    expect: { priced: true, productId: 36, dimensions: [4, 6], qty: 1000, noMinimum: true },
  },
  {
    name: "coffee, stands on the shelf, 2 measurements — asks the gusset",
    customer: { opening: "I need pouches that stand on the shelf for coffee beans", size: "5x8 inches", gusset: "3", finish: "gloss", qty: "2000", skus: "2", zipper: "zipper only", material: "no" },
    expect: { priced: true, productId: 26, dimensions: [5, 8, 3], qty: 2000 },
  },
  {
    name: "flat bottom, mm",
    customer: { opening: "flat bottom bags please", size: "120 x 200 x 80 mm", finish: "soft touch", qty: "5000 pcs", skus: "1", zipper: "no", material: "nothing special" },
    expect: { priced: true, productId: 25, dimensions: [4.72, 7.87, 3.15], qty: 5000 },
  },
  {
    name: "small run, 300 — priced, no minimum",
    customer: { opening: "stand up pouches 4x6x2 inches", finish: "matte", qty: "300", skus: "1", zipper: "yes", material: "no" },
    expect: { priced: true, productId: 26, dimensions: [4, 6, 2], qty: 300, noMinimum: true },
  },
  {
    name: "kashif — designs answer is not the quantity",
    customer: { opening: "pouch for my gummy", size: "2 by 3", finish: "maat with uv", skus: "5", zipper: "cr zipper", qty: "1000 quantity", material: "no" },
    expect: { priced: true, productId: 36, qty: 1000, noPriceBeforeQtyAsked: true },
  },
  {
    name: "2 count gummy pouch — pack count is not the quantity",
    customer: { opening: "i need 2 count gummy pouch", size: "3 by 4", finish: "gloss", qty: "1500", skus: "1", zipper: "no", material: "no" },
    expect: { priced: true, productId: 36, qty: 1500, noPriceBeforeQtyAsked: true },
  },
  {
    name: "website calculator paste",
    customer: { opening: "bag", size: "W : 4.9 Inch W : 124.46 mm H : 9.1 Inch H : 231.14 mm G : 3.15 Inch G : 80.01 mm", finish: "gloss", qty: "1000", skus: "1", zipper: "yes", material: "methalized" },
    expect: { priced: true, productId: 26, dimensions: [4.9, 9.1, 3.15], qty: 1000 },
  },
  {
    name: "everything at once, asks the price",
    customer: { opening: "how much for 1000 stand up pouches 4x6x2 inches, matte?", skus: "1", zipper: "yes", material: "no", qty: "1000", finish: "matte" },
    expect: { priced: true, productId: 26, dimensions: [4, 6, 2], qty: 1000 },
  },
  {
    name: "2.5 by 3.5 pouch, 60k — every detail asked before the price",
    customer: { opening: "i need 2.5 by 3.5 pouch", qty: "60k", finish: "gloss", skus: "3", zipper: "yes", material: "no" },
    expect: { priced: true, productId: 36, dimensions: [2.5, 3.5], qty: 60000 },
  },
  {
    name: "hammad live chat — stands on the shelf, size given last, gusset before name",
    customer: { opening: "hi, I need mylar bags for my gummies", size: "5x7, one that can stand on the shelf", gusset: "2.5", qty: "500", skus: "2", zipper: "zipper yes, but no tear notch", material: "no", finish: "soft touch" },
    expect: { priced: true, productId: 26, dimensions: [5, 7, 2.5], qty: 500, noMinimum: true },
  },
  {
    name: "'I need 2 count Gummy pouch' — size still asked, not taken from the count",
    customer: { opening: "I need 2 count Gummy pouch", qty: "1500", skus: "3", zipper: "Yes cr zipper", material: "Metalic", finish: "Matt", size: "3x4 inches" },
    expect: { priced: true, productId: 36, dimensions: [3, 4], qty: 1500 },
  },
  {
    name: "mailer boxes — not priced, minimum stated",
    customer: { opening: "mailer boxes 10x8x4 inches", finish: "matte", qty: "500", skus: "1", material: "no" },
    expect: { priced: false, minimum: true },
  },
];

/** What the bot just asked for, read the way a customer would. */
function answerFor(reply: string, c: Customer, used: Set<string>): string {
  // The question only — a price line in front of it mentions matte, sizes and so on.
  const sentences = reply.split(/(?<=[.!?])\s+|\n+/);
  const question = [...sentences].reverse().find((sentence) => sentence.includes("?")) || reply;
  const q = question.toLowerCase();
  const pick = (key: keyof Customer, value?: string) => {
    used.add(key);
    return value ?? "not sure";
  };
  if (/automated assistant|passing your chat|passed your chat/.test(q)) return "";
  if (/gusset|base of the pouch/.test(q)) return pick("gusset", c.gusset);
  if (/email/.test(q)) return pick("email", c.email ?? "e2e.customer@example.com");
  if (/phone|number (?:can|could|should)|reach you/.test(q)) return pick("phone", c.phone ?? "+1 713 555 0147");
  if (/your name|take your name|who am i speaking|may i have your name/.test(q)) return pick("name", c.name ?? "Sam");
  if (/designs?|sku/.test(q)) return pick("skus", c.skus);
  if (/zipper|tear notch/.test(q)) return pick("zipper", c.zipper);
  if (/quantity|how many/.test(q)) return pick("qty", c.qty);
  if (/finish|matte|gloss/.test(q)) return pick("finish", c.finish);
  if (/size|dimension|how big|measure/.test(q)) return pick("size", c.size);
  if (/material|special feature/.test(q)) return pick("material", c.material);
  if (/style|flat pouch|stand-?up/.test(q)) return pick("style", c.style ?? "not sure");
  if (/looking to have made|what are you looking|what can i help/.test(q)) return c.opening;
  return "ok";
}

async function runScenario(db: mongoose.Connection, settings: any, s: Scenario) {
  const id = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const base: IncomingChat = {
    conversationId: id, uvid: "", uuid: "", visitorId: "", name: "", email: "", phone: "",
    landingPageTitle: "Print247", currentPageUrl: "https://print247.us/", question: "", departmentId: "", text: "",
  };

  const log: string[] = [];
  const used = new Set<string>();

  let turn = await runChatTurn(db, base, settings, true);
  log.push(`BOT: ${turn.reply}`);

  let say = s.customer.opening;
  let sent = 0;
  for (let i = 0; i < MAX_TURNS && say; i++) {
    log.push(`YOU: ${say}`);
    turn = await runChatTurn(db, { ...base, text: say, messageId: `${id}-m${i}` }, settings, false);
    sent += 1;
    log.push(`BOT: ${turn.reply}`);
    if (turn.handoff || turn.conversation.status !== "active") break;
    say = i === 0 && s.customer.interrupt ? s.customer.interrupt : answerFor(turn.reply, s.customer, used);
  }

  const convo = await chatConversationModel(db).findOne({ conversationId: id }).lean();
  const aiTexts = (convo?.messages || []).filter((m: any) => m.author === "ai").map((m: any) => m.text);
  const firstPriceAt = (convo?.messages || []).findIndex((m: any) => m.author === "ai" && /^Here[’']s your (?:updated )?estimated pricing:/m.test(m.text));
  const qtyAskedAt = (convo?.messages || []).findIndex((m: any) => m.author === "ai" && /quantity|how many (?!total designs)/i.test(m.text) && !/designs?|sku/i.test(m.text));
  const statedMinimum = aiTexts.some((t: string) => /\bminimum\b|\bmoq\b|1,?000 per/i.test(t));

  const problems: string[] = [];
  const p = convo?.instantPrice as any;
  const e = s.expect;
  let request: any = null;
  try {
    request = p?.key ? JSON.parse(p.key) : null;
  } catch {}

  if (e.priced && !p) problems.push("expected a price, none given");
  if (!e.priced && p) problems.push(`expected no price, got: ${p.line}`);
  if (e.productId && request && request.product_id !== e.productId) problems.push(`product ${request.product_id}, expected ${e.productId}`);
  if (e.dimensions && request && JSON.stringify(request.dimensions) !== JSON.stringify(e.dimensions))
    problems.push(`dimensions ${JSON.stringify(request.dimensions)}, expected ${JSON.stringify(e.dimensions)}`);
  if (e.qty && request && request.qty !== e.qty) problems.push(`qty ${request.qty}, expected ${e.qty}`);
  if (e.noMinimum && statedMinimum) problems.push("stated the 1000 minimum to a priced pouch customer");
  if (e.minimum && !statedMinimum) problems.push("never stated the minimum");
  if (e.noPriceBeforeQtyAsked && firstPriceAt >= 0 && (qtyAskedAt < 0 || firstPriceAt < qtyAskedAt))
    problems.push("priced before the quantity was asked");
  // Any price before the customer gave the expected quantity.
  const prices = aiTexts.filter((t: string) => /^Here[’']s your (?:updated )?estimated pricing:/m.test(t));
  if (e.qty && prices.length && !prices[0].includes(e.qty.toLocaleString("en-US")))
    problems.push(`first price was not for ${e.qty}: ${prices[0].split("\n")[0]}`);
  // Every detail asked before the first price: finish, designs, zipper, material.
  if (firstPriceAt >= 0) {
    // Asked by the bot, or brought up by the customer themselves.
    const before = (convo?.messages || []).slice(0, firstPriceAt);
    const botBefore = before.filter((m: any) => m.author === "ai").map((m: any) => m.text).join(" ");
    const theyBefore = before.filter((m: any) => m.author === "visitor").map((m: any) => m.text).join(" ");
    for (const [label, asked, said] of [
      ["finish", /finish/i, /matte|gloss|soft touch|finish/i],
      ["designs", /designs?|sku/i, /designs?|sku/i],
      ["zipper", /zipper|tear notch/i, /zip|notch/i],
      ["material", /material|special feature/i, /material|metal|clear|foil|holograph/i],
    ] as const) {
      if (!asked.test(botBefore) && !said.test(theyBefore)) problems.push(`priced before asking the ${label}`);
    }
  }
  // Same question twice in a row.
  for (let i = 1; i < aiTexts.length; i++) {
    if (aiTexts[i] === aiTexts[i - 1]) problems.push(`repeated itself: "${aiTexts[i].slice(0, 60)}"`);
  }

  return { name: s.name, log, problems, sent, status: convo?.status, collected: convo?.collected, price: p?.line };
}

(async () => {
  const only = process.argv.slice(2).join(" ").toLowerCase();
  const live = await mongoose.createConnection(uriFor(config.leadsDb), { serverSelectionTimeoutMS: 15000 }).asPromise();
  const stored = await settingsModel(live).findOne({ key: "singleton" }).lean();
  await live.close();
  if (!stored) throw new Error("no settings in the live database");

  const settings: any = JSON.parse(JSON.stringify(stored));
  settings.officeHours = { ...settings.officeHours, shiftStartDays: [] };
  settings.chat = { ...settings.chat, liveAgentEmails: [], dryRun: false };

  const db = await mongoose.createConnection(uriFor(TEST_DB), { serverSelectionTimeoutMS: 15000 }).asPromise();
  let failed = 0;

  try {
    for (const s of SCENARIOS.filter((x) => !only || x.name.toLowerCase().includes(only))) {
      const started = Date.now();
      const r = await runScenario(db, settings, s);
      failed += r.problems.length ? 1 : 0;
      console.log(`\n${"=".repeat(78)}\n${r.problems.length ? "FAIL" : "ok  "}  ${r.name}  (${Math.round((Date.now() - started) / 1000)}s, ${r.sent} messages, ${r.status})`);
      console.log(r.log.map((l) => "   " + l.replace(/\n+/g, " ⏎ ")).join("\n"));
      console.log(`   collected: ${JSON.stringify(r.collected)}`);
      for (const problem of r.problems) console.log(`   !! ${problem}`);
    }
  } finally {
    await db.dropDatabase();
    await db.close();
  }

  console.log(failed ? `\n${failed} scenario(s) with problems` : "\nall scenarios pass");
  process.exit(failed ? 1 : 0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

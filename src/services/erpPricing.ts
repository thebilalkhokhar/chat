import axios from "axios";
import { config } from "../config/env";
import type { CollectedFields } from "../domain/quoteFields";
import { quantityIn } from "../domain/minimumOrder";
import { erpAccessToken } from "./erpAuth";

/**
 * An instant price from the ERP, for the two pouch styles it can price by itself.
 *
 * Everything else still goes to a rep. A flat pouch and a stand up pouch are
 * the ones a customer can be given a real figure for in the chat window, from
 * the same calculator the team uses (`/api/mylar/china-ai-price`), rather than
 * waiting until the morning for a number the ERP already knows.
 *
 * The calculator wants its own ids, not words. What the customer said is mapped
 * onto them here, and anything they have not said takes the house default:
 * PET + MPET + PE at 120 micron, white ink and full colour front, matte.
 *
 * Never throws. A price that does not come back is a turn without a price, not
 * a turn without a reply.
 */

const REQUEST_TIMEOUT_MS = 6_000;

/** The ERP's product ids for the styles priced here. */
export const POUCH_STYLES = {
  flat: { id: 36, name: "flat pouch (lays flat, sealed on 3 sides)", dimensions: 2 },
  standUp: { id: 26, name: "stand-up pouch (stands on its own)", dimensions: 3 },
  flatBottom: { id: 25, name: "flat bottom bag (box-shaped base)", dimensions: 3 },
} as const;

type PouchStyle = (typeof POUCH_STYLES)[keyof typeof POUCH_STYLES];

const DEFAULT_MATERIAL_ID = 55; // PET + MPET + PE
const DEFAULT_MICRON = 120;
/** Every thickness the ERP stocks; anything else is not a real answer. */
const MICRONS = [50, 70, 80, 90, 100, 110, 120, 130, 140, 150, 200];
/** Always the same service, as the team asked. */
const SHIPMENT_SERVICE_ID = 9;

const PRINT_WHITE = 1;
const PRINT_FRONT = 2; // CMYK 4/0
const PRINT_BOTH = 3; // CMYK 4/4
const GLOSS = 5;
const MATTE = 6;
const SOFT_TOUCH = 7;
const WINDOW = 14;
const STANDARD_ZIPPER = 80;
const TEAR_NOTCH = 85;
const HANG_HOLE = 91;
const CR_ZIPPER = 81;
const HOT_FOIL = 11;
const EMBOSSING = 199;
const SPOT_UV = 289;

const MATERIAL_NAMES: Record<number, string> = {
  53: "PET + White PE",
  54: "PET + Clear PE",
  55: "PET + MPET + PE",
  56: "PET + Alu Foil + PE",
  65: "PET + Holographic PET + PE",
  157: "PE",
};

export interface PriceRequest {
  product_id: number;
  material_id: number;
  /** Inches, in the ERP's order: width, height, and the gusset where there is one. */
  dimensions: number[];
  micron: number;
  qty: number;
  no_of_sku: number;
  finishing_ids: number[];
  shipment_service_id: number;
}

export interface PriceResult {
  erpId: number;
  unitCost: number;
  total: number;
}

/** A bag or pouch of some kind — the only thing these two styles can be. */
const A_BAG = /\b(bags?|pouch(es)?|mylar|sachets?|zip ?lock|ziploc)\b/i;

/**
 * Another product that happens to be a bag, and is priced differently.
 *
 * A paper bag or a mailer priced as a pouch is the wrong bag at the wrong
 * price, so any mention of one leaves the chat to a rep.
 */
const ANOTHER_BAG =
  /\b(center[\s-]*seal|centre[\s-]*seal|inner[\s-]*pocket|side[\s-]*gusset|quad[\s-]*seal|pillow|paper\s+(bags?|pouch(es)?)|kraft|mailers?|courier|bubble|poly[\s-]*mailer|film|roll[\s-]*stock|on\s+(a\s+)?rolls?|rolls?\s+of|carry|shopping|tote|custom[\s-]*shaped?|die[\s-]*cut|spout|valves?)\b/i;

/**
 * No printing at all. The calculator always prices full colour, so a plain
 * bag priced here would be quoted for print nobody asked for.
 */
const PLAIN = /\b(plain|blank|unprinted|no\s+print(ing)?|without\s+(any\s+)?print(ing)?|not\s+printed|stock\s+bags?)\b/i;

/**
 * A flat bottom bag — the box-shaped one, ERP product 25. Checked before the
 * other two: "flat bottom" says flat, and it is not a flat pouch.
 */
const FLAT_BOTTOM =
  /\b(flat[\s-]*bottom|flat[\s-]*base|box[\s-]*(bottom|pouch|shaped)|block[\s-]*bottom|square[\s-]*bottom|(8|eight)[\s-]*side[\s-]*seal)/i;

/** How customers describe a pouch that stands up. None of them say "stand up pouch" by name. */
const STANDS_UP =
  /\bstand\s*-?\s*up\b|\bstandup\b|\bstanding\s+(pouch(es)?|bags?)\b|\b(that|which|to|can|will|should)\s+(can\s+)?stand\b(?!\s+out)|\b(has|have|needs?)\s+to\s+stand\b(?!\s+out)|\b(won'?t|doesn'?t|does\s+not|will\s+not|not)\s+(fall|tip)\s+over\b|\bdoy\s*-?\s*pack|\bstand(s|ing)?\s+(on|up|upright|by itself|on (its|their) own)\b|\bupright\b|\bself[\s-]*standing\b|\bsits?\s+on\s+(a|the)?\s*shel|\bwith\s+a\s+(bottom|base)\b|\bbottom\s+gusset\b|\bgusset(ed)?\b/i;

/** And one that does not. Checked first, so "doesn't need to stand up" is not read as standing. */
const LIES_FLAT =
  /\b(don'?t|doesn'?t|do not|does not|no need to|not)\s+(need\s+to\s+)?stand\b|\bno\s+gusset\b|\blays?\s+flat\b|\blay[\s-]*flat\b|\b(3|three)[\s-]*side[\s-]*(seal|sealed)\b|\bsachets?\b/i;

/**
 * "Flat" about the bag, and not taken back. "Flat pouches", "the flat one", or
 * "flat" as the whole answer — never "flat rate shipping", "a flat price", or
 * "I don't want it flat".
 */
const SAYS_FLAT =
  /(?<!(?:\bnot|\bno|\bnever|n['’]t)\s+(?:\w+\s+){0,2})\bflat\b(?:(?=[\s-]+(?:pouch|pouches|bags?|ones?|style|type|mylar|sachets?|zip))|(?=\s*(?:please|pls|one)?\s*[.!]?\s*$))/i;

const readsFlat = (text: string) =>
  LIES_FLAT.test(text) || SAYS_FLAT.test(text.trim().replace(/^(?:the\s+|a\s+|just\s+)/i, ""));

/** Our own style question, so "the first one" can be read against it. */
const ASKED_THE_STYLE = /\bflat\b[^?]*\bstand\s*-?\s*up\b/i;

export interface ChatLine {
  author: string;
  text: string;
}

/** The style their own words point to, latest first. Null when they never said. */
function styleTheySaid(product: string, messages: ChatLine[]): PouchStyle | null {
  let said: PouchStyle | null = null;
  let lastFromUs = "";

  const read = (text: string) => {
    if (FLAT_BOTTOM.test(text)) said = POUCH_STYLES.flatBottom;
    else if (readsFlat(text)) said = POUCH_STYLES.flat;
    else if (STANDS_UP.test(text)) said = POUCH_STYLES.standUp;
  };

  read(product);

  for (const message of messages) {
    if (message.author !== "visitor") {
      lastFromUs = message.text;
      continue;
    }
    const text = message.text;
    // "the first one" to "Flat, Standup or which one?" — the order we listed them in.
    if (ASKED_THE_STYLE.test(lastFromUs) && /^\W*(the\s+)?(first|1st)\b/i.test(text)) said = POUCH_STYLES.flat;
    else if (ASKED_THE_STYLE.test(lastFromUs) && /^\W*(the\s+)?(second|2nd)\b/i.test(text)) said = POUCH_STYLES.standUp;
    else if (ASKED_THE_STYLE.test(lastFromUs) && /^\W*(the\s+)?(third|3rd|last)\b/i.test(text)) said = POUCH_STYLES.flatBottom;
    else read(text);
  }

  return said;
}

/** Our question about how many, and not the one about designs. */
const ASKS_THE_QUANTITY = /\bquantity\b|\bhow many\b(?![^?]*\b(designs?|skus?|sku['’]?s|artworks?|variants?|versions?|flavou?rs?)\b)/i;

/**
 * The quantity on file is one the customer gave as a quantity.
 *
 * The read fills the quantity from anything that looks like one. Asked "How
 * many total designs or SKUs do you have?", a customer answered "5", the read
 * put 5 in the quantity as well, and the chat was priced at five bags — $4.74
 * each — before anybody had asked how many they wanted. A price goes out only
 * on a number they gave in answer to the quantity question, or wrote as an
 * order in their own words.
 */
export function quantityGivenByThem(quantity: string | undefined, messages: ChatLine[]): boolean {
  const n = quantityIn(quantity);
  if (n === null) return false;

  let lastFromUs = "";
  for (const message of messages) {
    if (message.author !== "visitor") {
      lastFromUs = message.text;
      continue;
    }
    const text = withoutSizes(message.text);
    const numbers = numbersIn(text);
    if (!numbers.includes(n)) continue;

    if (ASKS_THE_QUANTITY.test(lastFromUs)) return true;
    // The order word next to the number — "1000 pouches", "qty 500" — not
    // anywhere in the message, or "4x6 pouches, 1000 of them" reads "pouches"
    // as belonging to the 1000.
    if (orderWordBeside(text, n)) return true;
  }
  return false;
}

/** Sizes taken out — "4x6", "4 x 6 x 2 inch", "4 by 6" — so their numbers are not read as a quantity. */
function withoutSizes(text: string): string {
  return String(text || "").replace(
    /\d+(?:\.\d+)?\s*(?:["”″]|in(?:ch(?:es)?)?|mm|cm)?\s*(?:[x×*]|by)\s*\d+(?:\.\d+)?(?:\s*(?:["”″]|in(?:ch(?:es)?)?|mm|cm)?\s*(?:[x×*]|by)\s*\d+(?:\.\d+)?)?\s*(?:["”″]|in(?:ch(?:es)?)?|mm|cm)?/gi,
    " "
  );
}

function numbersIn(text: string): (number | null)[] {
  return [...text.matchAll(/\d[\d,.]*\s*(?:k\b|thousand\b)?/gi)].map((m) => quantityIn(m[0]));
}

/** "1000 pouches", "qty: 500", "2k", "5,000 pcs" — the number written as an order. */
function orderWordBeside(text: string, n: number): boolean {
  for (const m of text.matchAll(/(\d[\d,.]*)\s*(k\b|thousand\b)?/gi)) {
    if (quantityIn(m[0]) !== n || m.index === undefined) continue;
    if (m[2]) return true;
    const before = text.slice(Math.max(0, m.index - 14), m.index);
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 40);
    // "2 count gummy pouch", "10 ct", "5-pack" — how many go inside, never the order.
    if (/^\s*-?\s*(count|ct|pack|pk|per|pieces?\s+(per|in|each))\b/i.test(after)) continue;
    // Nor a number inside a word or an address — "e2e.customer@…".
    if (/[\w@.]$/.test(text.slice(0, m.index)) && !/\s$/.test(text.slice(0, m.index))) continue;
    if (/\b(qty|quantity|quantities|order)\b[\s:of]*$/i.test(before)) return true;
    // "1,000 stand up pouches" — a few describing words may sit in between.
    if (/^\s*(?:[a-z-]+\s+){0,3}?(qty|quantity|pcs|pieces|units|bags|pouch(?:es)?|thousand)\b/i.test(after)) return true;
  }
  return false;
}

/** Our question about designs or SKUs. */
const ASKS_THE_DESIGNS = /\b(designs?|skus?|sku['’]?s|artworks?|variants?)\b[^.!]*\?/i;

/**
 * The quantity on file is really their answer to the designs question.
 *
 * "5" to "How many total designs or SKUs do you have?" went into both fields,
 * and with a quantity on file the bot never asked how many they wanted. True
 * when every message carrying that number was a reply to the designs question
 * and did not say it was an order.
 */
export function quantityIsTheDesignCount(quantity: string | undefined, messages: ChatLine[]): boolean {
  const n = quantityIn(quantity);
  if (n === null) return false;

  let lastFromUs = "";
  let found = false;
  for (const message of messages) {
    if (message.author !== "visitor") {
      lastFromUs = message.text;
      continue;
    }
    const text = withoutSizes(message.text);
    if (!numbersIn(text).includes(n)) continue;
    if (!ASKS_THE_DESIGNS.test(lastFromUs) || orderWordBeside(text, n)) return false;
    found = true;
  }
  return found;
}

/**
 * A bag the ERP prices here, at any quantity — so the 1000 minimum is not put
 * to them. Decided on the bag alone, before the size is in: a customer who
 * says "500 pouches" first must not be told the minimum and then priced at 500.
 */
export function minimumWaivedFor(collected: CollectedFields, messages: ChatLine[] = []): boolean {
  return isConfigured() && couldBeAPouch(collected.product, messages);
}

/** A bag that could be one of the styles, and is not some other bag, a box or a label. */
function couldBeAPouch(product: string | undefined, messages: ChatLine[]): boolean {
  const named = String(product || "");
  const everything = [named, ...messages.filter((m) => m.author === "visitor").map((m) => m.text)].join("\n");
  if (!A_BAG.test(everything) || ANOTHER_BAG.test(everything) || PLAIN.test(everything)) return false;
  // "Box pouch" and "box bottom" are bags; a box on its own is not.
  return !/\b(box(es)?(?![\s-]*(pouch|bottom|shaped))|cartons?|labels?|stickers?)\b/i.test(named);
}

/**
 * The style question, as the bot asked it for a while. No longer sent — the
 * size decides — but chats that have it are still read against it, so "the
 * first one" still means a flat pouch.
 */
export const STYLE_QUESTION =
  "Got it. Which style would you like: a flat pouch that lays flat, a stand-up pouch that stands on its own, " +
  "or a flat bottom bag with a box-shaped base?";

/**
 * Which of the two styles the customer means, or null.
 *
 * Customers never use the ERP's names. They ask for "mylar bags for gummies"
 * or "smell proof pouches", so the style is read from how they describe it —
 * "one that stands on the shelf", "lays flat" — and, when they never say, from
 * the size, which is how the ERP itself tells the two apart: a stand-up pouch
 * is width x height x gusset, a flat pouch is width x height and nothing else.
 */
export function pouchStyleFor(
  product?: string,
  messages: ChatLine[] = [],
  measurements = 0
): PouchStyle | null {
  if (!couldBeAPouch(product, messages)) return null;

  const said = styleTheySaid(String(product || ""), messages);
  if (said) return said;

  // Otherwise the size says it, as the team reads it: two measurements is a
  // flat pouch, three is a stand-up. No question — the customer has already
  // answered it by how they gave the size, and the price line names the style
  // so they can correct it.
  if (measurements >= 3) return POUCH_STYLES.standUp;
  if (measurements === 2) return POUCH_STYLES.flat;
  return null;
}

/**
 * A size pasted from our own website calculator, each side named and given twice:
 * "W : 4.9 Inch W : 124.46 mm H : 9.1 Inch H : 231.14 mm G : 3.15 Inch G : 80.01 mm".
 *
 * Six numbers, which read as six measurements — or as several sizes — and the
 * chat went unpriced. One value per side, the inch one where both are given,
 * in the ERP's order: width, height, then the gusset. Null when it is not
 * written this way.
 */
function labelledDimensions(text: string): number[] | null {
  const found: Record<string, number> = {};
  // The colon is optional: "W 4 H 6 G 2" and "width 4 inch, height 6 inch" too.
  const pattern = /\b(w|h|g|width|height|gusset|depth)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(inch(?:es)?|in\b|"|mm|cm)?/gi;

  for (const [, rawSide, rawValue, rawUnit] of text.matchAll(pattern)) {
    // Depth is what some people call the gusset.
    const side = rawSide.toLowerCase() === "depth" ? "g" : rawSide[0].toLowerCase();
    const unit = (rawUnit || "in").toLowerCase();
    const inches =
      unit === "mm" ? Number(rawValue) / 25.4 : unit === "cm" ? Number(rawValue) / 2.54 : Number(rawValue);
    // An inch value wins over a converted one; otherwise the first given stands.
    if (found[side] === undefined || unit.startsWith("in") || unit === '"') found[side] = inches;
  }

  if (found.w === undefined || found.h === undefined) return null;
  return [found.w, found.h, ...(found.g !== undefined ? [found.g] : [])].map((n) => Math.round(n * 100) / 100);
}

/** "4 x 6 x 2 in", "100x150mm", "4\" x 6\"", as inches — or null when it cannot be read. */
export function dimensionsInInches(sizes?: string): number[] | null {
  let text = String(sizes || "").toLowerCase();

  const labelled = labelledDimensions(text);
  if (labelled) return labelled;

  // Capacities are not dimensions: a 12oz pouch has no width to price. Beside a
  // real size — "7x10 for 1oz" — the capacity is dropped and the size kept.
  const capacity = /\d+(?:\.\d+)?\s*(?:oz|ounces?|ml|g|grams?|lbs?|kg)(?![a-z])/g;
  const hasASize = /\d\s*["”″]?\s*(?:x|×|\*|by)\s*\d/.test(text);
  if (/(?<![a-z])(oz|ounces?|ml|g|grams?|lbs?|kg)(?![a-z])/.test(text)) {
    if (!hasASize) return null;
    text = text.replace(capacity, " ");
  }

  const numbers = (text.match(/\d+(?:\.\d+)?/g) || []).map(Number).filter((n) => n > 0);
  // More than three is more than one size — "4x6 and 5x8" — and a rep prices those.
  if (!numbers.length || numbers.length > 3) return null;

  const factor = /(?<![a-z])(mm|millimet)/.test(text) ? 1 / 25.4 : /(?<![a-z])(cm|centimet)/.test(text) ? 1 / 2.54 : 1;
  return numbers.map((n) => Math.round(n * factor * 100) / 100);
}

function materialFor(material?: string): number {
  const text = String(material || "").toLowerCase();
  if (/holograph/.test(text)) return 65;
  if (/\bfoil\b|\balu(minium|minum)?\b/.test(text)) return 56;
  if (/\bclear\b(?!\s*window)/.test(text)) return 54;
  if (/\bwhite\b/.test(text)) return 53;
  return DEFAULT_MATERIAL_ID;
}

function micronFor(material?: string): number {
  const match = String(material || "").toLowerCase().match(/(\d{2,3})\s*(?:microns?|mic\b|µ|um\b)/);
  const value = match ? Number(match[1]) : NaN;
  return MICRONS.includes(value) ? value : DEFAULT_MICRON;
}

/** "no tear notch", "without a window" — taken out before looking for what they do want. */
const DECLINED_EXTRA =
  /\b(no|without|not|don'?t\s+(want|need)|skip)\s+(an?\s+|the\s+|any\s+)?(zipper|zip|tear\s*-?\s*notch|notch|window|hang\s*-?\s*hole)s?\b/g;

function finishingFor(collected: CollectedFields): number[] {
  const finishes = String(collected.finishes || "").toLowerCase();
  const extras = String(collected.extras || "").toLowerCase().replace(DECLINED_EXTRA, " ");
  const both = `${finishes} ${extras}`;

  const printing = /both sides|double[- ]sided|front and back|4\/4/.test(finishes) ? PRINT_BOTH : PRINT_FRONT;
  const coating = /soft[- ]?touch|velvet/.test(finishes)
    ? SOFT_TOUCH
    : /\bgloss|\bshiny\b|\bshine\b/.test(finishes)
      ? GLOSS
      : MATTE;

  const ids = [PRINT_WHITE, printing, coating];

  // "matte with uv" — the UV people add to a bag is spot UV.
  if (/spot[\s-]*uv|\buv\b/.test(both)) ids.push(SPOT_UV);
  if (/foil[\s-]*(stamp|logo|print)|hot[\s-]*foil/.test(both)) ids.push(HOT_FOIL);
  if (/emboss/.test(both)) ids.push(EMBOSSING);

  // "yes" to "Do you want me to add a zipper and tear notch?" is both.
  const saidYes = /^(yes|yeah|yep|sure|ok|okay|please|both)\b/.test(extras.trim());
  const childResistant = /child[\s-]*(resistant|proof|safe)|\bcr\b/.test(both);
  if (childResistant) ids.push(CR_ZIPPER);
  else if (saidYes || /zip/.test(extras)) ids.push(STANDARD_ZIPPER);
  if (saidYes || /tear/.test(extras)) ids.push(TEAR_NOTCH);
  if (/window/.test(extras)) ids.push(WINDOW);
  if (/hang/.test(extras)) ids.push(HANG_HOLE);

  return ids;
}

const SKU_WORDS: Record<string, number> = {
  one: 1, single: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

/** "2", "3 designs", "two" — one when it cannot be read, as the chat assumes. */
function skuCount(value?: string): number {
  const text = String(value || "").toLowerCase();
  const digits = Number.parseInt(text.match(/\d+/)?.[0] || "", 10);
  if (Number.isInteger(digits) && digits > 0) return digits;
  const word = text.match(/\b(one|single|two|three|four|five|six|seven|eight|nine|ten)\b/)?.[1];
  return word ? SKU_WORDS[word] : 1;
}

/**
 * What to send the calculator, or null when this chat cannot be priced yet.
 *
 * Needs the style, a readable size with every measurement the style takes, and
 * a quantity. Any quantity: the team wants small runs priced too, and the ERP
 * prices them — its own example is a run of 100.
 */
export function priceRequestFor(collected: CollectedFields, messages: ChatLine[] = []): PriceRequest | null {
  const dimensions = dimensionsInInches(collected.sizes);
  if (!dimensions) return null;

  const style = pouchStyleFor(collected.product, messages, dimensions.length);
  if (!style || dimensions.length < style.dimensions) return null;

  const qty = quantityIn(collected.quantity);
  if (!qty || qty < 1) return null;

  const skus = skuCount(collected.skus);

  return {
    product_id: style.id,
    material_id: materialFor(collected.material),
    dimensions: dimensions.slice(0, style.dimensions),
    micron: micronFor(collected.material),
    qty,
    no_of_sku: Number.isInteger(skus) && skus > 0 ? skus : 1,
    finishing_ids: finishingFor(collected),
    shipment_service_id: SHIPMENT_SERVICE_ID,
  };
}

/**
 * They want a pouch that stands, and gave only width and height.
 *
 * A stand-up pouch cannot be priced without its gusset — the fold at the
 * bottom that lets it stand — so the bot asks for it rather than guessing one
 * or pricing the flat pouch they did not ask for.
 */
export function needsGusset(collected: CollectedFields, messages: ChatLine[] = []): boolean {
  const dimensions = dimensionsInInches(collected.sizes);
  return (
    Boolean(dimensions && dimensions.length === 2) &&
    // A flat bottom bag has one too — width, height and gusset in the ERP.
    (pouchStyleFor(collected.product, messages, 2)?.dimensions || 0) === 3
  );
}

/** How many times the bot has asked for the gusset. Twice is the limit, as for any detail. */
export function gussetAsks(messages: ChatLine[]): number {
  return messages.filter((m) => m.author !== "visitor" && ASKS_THE_GUSSET.test(m.text)).length;
}

/** Either wording of the gusset question below. */
export const ASKS_THE_GUSSET = /\bgusset\b|\bbase of the pouch\b/i;

function unitOf(text: string): "mm" | "cm" | "in" | "" {
  const t = text.toLowerCase();
  if (/(?<![a-z])(mm|millimet)/.test(t)) return "mm";
  if (/(?<![a-z])(cm|centimet)/.test(t)) return "cm";
  if (/(?<![a-z])(in|inch|inches)(?![a-z])|["”″]/.test(t)) return "in";
  return "";
}

const PER_INCH = { mm: 25.4, cm: 2.54, in: 1 } as const;

/** The gusset question, in their unit. The second asking is worded differently, never repeated. */
export function gussetQuestion(sizes: string | undefined, askedBefore: number): string {
  const example = { mm: "50 mm", cm: "5 cm", in: "2 inches", "": "2 inches" }[unitOf(String(sizes || ""))];
  return askedBefore === 0
    ? "Got it. How deep should the bottom gusset be? " +
        `That's the fold at the bottom that lets it stand, for example ${example}.`
    : `One more measurement and I can price it: roughly how deep should the base of the pouch be, for example ${example}?`;
}

/**
 * Their answer to the gusset question, written onto the size as the third
 * measurement — "4x6 in" and "2" become "4x6 x 2 in". Converted into the size's
 * own unit when they answer in a different one. Null when there is no number.
 */
export function withGusset(sizes: string, answer: string): string | null {
  const match = String(answer || "").match(/(\d+(?:\.\d+)?)\s*(mm|millimet\w*|cm|centimet\w*|inch(?:es)?|in\b|["”″])?/i);
  if (!match) return null;

  let value = Number(match[1]);
  const theirs = unitOf(match[0]);
  const ours = unitOf(sizes);
  if (theirs && ours && theirs !== ours) {
    value = Math.round((value / PER_INCH[theirs]) * PER_INCH[ours] * 100) / 100;
  }

  // Straight after the last measurement, however the two were joined. It used to
  // look for "4x6" exactly, and "4.6 inch * 9.1" — the word between the number
  // and the star — matched nothing, so the answer was dropped and the gusset
  // asked for again.
  // A size written with labels gets a labelled gusset, which is how it is read back.
  if (labelledDimensions(sizes.toLowerCase())) return `${sizes} gusset ${value}`;

  const last = [...sizes.matchAll(/\d+(?:\.\d+)?["”″]?/g)].pop();
  if (!last || last.index === undefined) return null;
  const at = last.index + last[0].length;
  return `${sizes.slice(0, at)} x ${value}${sizes.slice(at)}`;
}

/** Two requests that would price the same are the same key, so nothing is priced twice. */
export function priceKey(request: PriceRequest): string {
  return JSON.stringify(request);
}

function money(value: number, digits: number): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** What the customer reads. Every figure is the ERP's; nothing here is estimated. */
/** Plural, customer-facing: what they will read the style as. */
const STYLE_SINGULAR: Record<number, string> = {
  36: "Flat pouch",
  26: "Stand-up pouch",
  25: "Flat bottom bag",
};

/** The options on the request, in the words a customer uses. */
const OPTION_NAMES: Array<[number, string]> = [
  [PRINT_BOTH, "printed both sides"],
  [CR_ZIPPER, "CR zipper"],
  [STANDARD_ZIPPER, "zipper"],
  [TEAR_NOTCH, "tear notch"],
  [WINDOW, "window"],
  [HANG_HOLE, "hang hole"],
  [SPOT_UV, "spot UV"],
  [HOT_FOIL, "foil stamping"],
  [EMBOSSING, "embossing"],
];

/** How the estimate opens, so the chat and the closing line can recognise it. */
export const ESTIMATE_OPENING = /^Here['’]s your (?:updated )?estimated pricing:/m;

/**
 * What the customer reads: an estimate, laid out so it can be read at a glance.
 *
 * It used to be one sentence — "Price: $0.23 each, $1,136 total for 1,000
 * stand-up pouches per design (5 designs), …" — which never said it was an
 * estimate, and made the customer work out that it was 5,000 bags, and why
 * 5,000 × $0.23 is not $1,136. Now: what it is, how many in all, the unit
 * price exact enough to multiply, and the total.
 *
 * The film, micron and print are the house defaults and go on the rep's lead,
 * not into the chat.
 */
export function describePrice(request: PriceRequest, price: PriceResult, updated = false): string {
  const coating = request.finishing_ids.includes(GLOSS)
    ? "gloss"
    : request.finishing_ids.includes(SOFT_TOUCH)
      ? "soft touch"
      : "matte";
  const options = OPTION_NAMES.filter(([id]) => request.finishing_ids.includes(id)).map(([, name]) => name);
  const what = [
    `${STYLE_SINGULAR[request.product_id]}, ${request.dimensions.join(" x ")} in`,
    coating,
    ...options,
  ].join(", ");

  const bags = request.qty * request.no_of_sku;
  const quantity =
    request.no_of_sku > 1
      ? `${bags.toLocaleString("en-US")} (${request.qty.toLocaleString("en-US")} each of ${request.no_of_sku} designs)`
      : bags.toLocaleString("en-US");

  // Three decimals under a dollar, so unit × quantity comes out at the total.
  const unit = money(price.unitCost, price.unitCost < 1 ? 3 : 2);
  const total = Number.isInteger(price.total) ? money(price.total, 0) : money(price.total, 2);

  return [
    `Here's your ${updated ? "updated " : ""}estimated pricing:`,
    `• ${what}`,
    `• Quantity: ${quantity}`,
    `• Unit price: ${unit}`,
    `• Estimated total: ${total}`,
    "",
    "Your final quote will confirm this.",
  ].join("\n");
}

/** The long version, for the rep: everything the ERP was asked to price. */
export function describePriceForRep(request: PriceRequest, price: PriceResult): string {
  const style = Object.values(POUCH_STYLES).find((s) => s.id === request.product_id)!;
  return (
    `${request.qty} x ${request.no_of_sku} SKU ${style.name}, ${request.dimensions.join(" x ")} in, ` +
    `${MATERIAL_NAMES[request.material_id] || `material ${request.material_id}`} ${request.micron} micron, ` +
    `finishing ids ${request.finishing_ids.join(",")}, shipping ${request.shipment_service_id}: ` +
    `$${price.unitCost} each, $${price.total} total.`
  );
}

export function isConfigured(): boolean {
  return Boolean(config.erp.instantPricing && config.erp.baseUrl && config.erp.refreshToken);
}

/** The ERP's price for one request, retried once on a fresh token if the cached one is refused. */
export async function fetchPrice(request: PriceRequest, chatId: string, attempt = 0): Promise<PriceResult | null> {
  if (!isConfigured()) return null;

  const bearer = await erpAccessToken(attempt > 0);
  if (!bearer) return null;

  try {
    const response = await axios.post(
      `${config.erp.baseUrl}/api/mylar/china-ai-price`,
      { ...request, chat_id: chatId },
      {
        headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${bearer}` },
        timeout: REQUEST_TIMEOUT_MS,
        validateStatus: () => true,
      }
    );

    if (response.status === 401 && attempt === 0) return fetchPrice(request, chatId, 1);

    const data = response.data;
    const unitCost = Number(data?.final_unit_cost);
    const total = Number(data?.total_price);

    if (response.status !== 200 || data?.status !== "success" || !(unitCost > 0) || !(total > 0)) {
      console.warn(
        `[pricing] no price for ${chatId}: ${response.status} ${JSON.stringify(data?.errors || data?.message || "").slice(0, 200)}`
      );
      return null;
    }

    return { erpId: Number(data.id), unitCost, total };
  } catch (error: any) {
    console.warn(`[pricing] could not reach the ERP for ${chatId}: ${error.message}`);
    return null;
  }
}

/**
 * Where a chat's visitor came from: paid ads, organic website traffic, social,
 * or a messaging channel (WhatsApp, Instagram).
 *
 * The paid and social rules are the main backend's (`isPpcTraffic` and
 * `isSocialTraffic` in backend/controller/zohoAnalyticsController.js), so a chat
 * and a CRM lead from the same visit land in the same bucket. One addition:
 * `utm_medium=pmax` and `demand_gen` count as paid. Those are Google Ads
 * campaign types and are a third of the paid chats, though nearly all of them
 * also carry a `gclid` or `gad_source` that the backend's rule already catches.
 */

export type TrafficSource = "ppc" | "organic" | "social" | "messaging" | "unknown";

export const TRAFFIC_SOURCES: { key: TrafficSource; label: string }[] = [
  { key: "ppc", label: "PPC (paid ads)" },
  { key: "organic", label: "Website organic" },
  { key: "social", label: "Social" },
  { key: "messaging", label: "WhatsApp & Instagram" },
  /** Form leads from sites whose quote form does not record where the visitor came from. */
  { key: "unknown", label: "Source not recorded" },
];

export const isTrafficSource = (value: unknown): value is TrafficSource =>
  TRAFFIC_SOURCES.some((source) => source.key === value);

const PAID_MEDIUM = /[?&]utm_medium=(cpc|ppc|paid|paid[-_]search|paidsearch|pmax|demand[-_]gen)(&|$)/;
const SOCIAL_UTM_SOURCES = ["facebook", "instagram", "twitter", "linkedin", "tiktok", "youtube", "pinterest", "snapchat", "reddit"];
/** Short forms the site's own links use (utm_source=fb, utm_source=ig). */
const SOCIAL_UTM_SHORT = ["fb", "ig"];
const SOCIAL_REFERERS = /^https?:\/\/([a-z0-9-]+\.)*(facebook\.com|instagram\.com|t\.co|twitter\.com|x\.com|linkedin\.com|lnkd\.in|tiktok\.com|youtube\.com|pinterest\.com|reddit\.com)(\/|$)/;

/** Paid traffic by the backend's rule: ad click ids, a paid utm_medium, or a /deals landing page. */
export function isPaidUrl(url: string): boolean {
  const u = String(url || "").toLowerCase();
  if (!u) return false;
  return (
    PAID_MEDIUM.test(u) ||
    /[?&]gclid=/.test(u) ||
    /[?&]gad_source=/.test(u) ||
    /[?&](gbraid|wbraid)=/.test(u) ||
    /[?&]msclkid=/.test(u) ||
    u.includes("/deals")
  );
}

/** Organic social by the backend's rule: a social utm_source on an unpaid medium, or a Facebook click id. */
export function isSocialUrl(url: string): boolean {
  const u = String(url || "").toLowerCase();
  if (!u) return false;
  const source = u.match(/[?&]utm_source=([^&]+)/);
  if (source && !PAID_MEDIUM.test(u)) {
    const value = decodeURIComponent(source[1]);
    if (SOCIAL_UTM_SOURCES.some((s) => value.includes(s)) || SOCIAL_UTM_SHORT.includes(value)) return true;
  }
  return /[?&]fbclid=/.test(u) && !PAID_MEDIUM.test(u);
}

export interface TrafficClues {
  /** SalesIQ's channel: "website", "whatsapp", "instagram"… Absent on chats from before it was kept. */
  visitorChannel?: string;
  landingPageUrl?: string;
  currentPageUrl?: string;
  referer?: string;
}

export function trafficSourceOf(clues: TrafficClues): TrafficSource {
  const channel = String(clues.visitorChannel || "").toLowerCase();
  const pages = [clues.landingPageUrl, clues.currentPageUrl].filter((url): url is string => Boolean(url));

  if (channel && channel !== "website") return "messaging";
  // Before the channel was kept, a chat with no page at all came from WhatsApp or Instagram.
  if (!channel && pages.length === 0) return "messaging";

  if (pages.some(isPaidUrl)) return "ppc";
  if (pages.some(isSocialUrl) || SOCIAL_REFERERS.test(String(clues.referer || "").toLowerCase())) return "social";
  return "organic";
}

/**
 * The ad platforms a monthly budget is entered for. Meta covers Facebook,
 * Instagram and WhatsApp (click-to-WhatsApp and Instagram ads are bought there).
 */
export type AdPlatform = "google" | "bing" | "meta" | "linkedin";

export const AD_PLATFORMS: { key: AdPlatform; label: string }[] = [
  { key: "google", label: "Google" },
  { key: "bing", label: "Bing" },
  { key: "meta", label: "Meta (Facebook, Instagram, WhatsApp)" },
  { key: "linkedin", label: "LinkedIn" },
];

export const isAdPlatform = (value: unknown): value is AdPlatform => AD_PLATFORMS.some((p) => p.key === value);

/**
 * Which platform a lead came through, from its click ids, utm_source, referrer
 * and SalesIQ channel. Null when nothing names one (organic search with no
 * referrer, a form with no page): those leads count in the totals, not against
 * any platform's budget. A paid click with no platform named is Google, the
 * only search platform besides Bing that the ads run on.
 */
export function adPlatformOf(clues: { pages: string[]; referer?: string; visitorChannel?: string; source: TrafficSource }): AdPlatform | null {
  const text = clues.pages.map((u) => String(u || "").toLowerCase()).join(" ");
  const referer = String(clues.referer || "").toLowerCase();
  const channel = String(clues.visitorChannel || "").toLowerCase();
  const utm = text.match(/[?&]utm_source=([^&\s]+)/)?.[1] || "";

  const paid = clues.source === "ppc";
  // Search platforms only for paid clicks: an organic Google or Bing visit is not ad spend.
  if (/msclkid=/.test(text) || (paid && (/bing/.test(utm) || /bing\.com/.test(referer)))) return "bing";
  if (/linkedin|lnkd/.test(utm) || /linkedin\.com|lnkd\.in/.test(referer)) return "linkedin";
  if (
    channel === "whatsapp" || channel === "instagram" || channel === "facebook" || channel === "messenger" ||
    /fbclid=/.test(text) || /^(fb|ig|facebook|instagram|meta|whatsapp)$/.test(utm) ||
    /facebook\.com|instagram\.com|fb\.me|wa\.me|whatsapp/.test(referer + " " + text) ||
    clues.source === "messaging"
  ) return "meta";
  if (/gclid=|gbraid=|wbraid=|gad_source=/.test(text)) return "google";
  if (paid) return "google";
  return null;
}

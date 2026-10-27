/**
 * Turning a lead's Description into something readable.
 *
 * This field is where the enquiry actually lives. For a web lead it is a JSON
 * blob written by the storefront — product, quantity, dimensions, the
 * customer's own message, and a great deal that is nobody's business here:
 * landing page URLs, campaign ids, click identifiers. For a lead typed in by a
 * rep it is a paragraph of prose.
 *
 * Both become plain lines the model can read. The tracking noise is dropped,
 * because handing it to the model wastes the context and invites it to mention
 * a `gclid` to a customer.
 */

/** Keys that describe the enquiry rather than how the visitor was tracked. */
const MEANINGFUL_KEYS = new Set([
  "product",
  "product_type",
  "productType",
  "quantity",
  "dimensions",
  "size",
  "sizes",
  "material",
  "stock",
  "finish",
  "finishes",
  "lamination",
  "colours",
  "colors",
  "printing",
  "skus",
  "message",
  "note",
  "notes",
  "comments",
  "requirements",
  "description",
]);

/** Tracking and plumbing: never shown to the model. */
const NOISE_KEYS = new Set([
  "iscampaignpage",
  "pageurl",
  "landingpage",
  "trafficsource",
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "gclid",
  "gad_source",
  "gad_campaignid",
  "referrer",
  "useragent",
  "ip",
]);

function labelOf(key: string): string {
  return key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase())
    .trim();
}

/** `{width, height, length, unit}` reads better as `16 x 2 x 22 inch`. */
function renderDimensions(value: any): string {
  if (!value || typeof value !== "object") return String(value ?? "");

  const parts = [value.length, value.width, value.height, value.depth]
    .filter((part) => part !== undefined && part !== null && String(part).trim() !== "")
    .map((part) => String(part).trim());

  if (parts.length === 0) return "";

  const unit = value.unit ? ` ${String(value.unit).trim()}` : "";
  return `${parts.join(" x ")}${unit}`;
}

/** `matt_lamination` is what the form stores; `matt lamination` is English. */
function humanise(value: string): string {
  const text = String(value).trim();
  // Left alone if it looks like a real sentence or a measurement.
  if (/\s/.test(text) || !/[_-]/.test(text)) return text;
  return text.replace(/[_-]+/g, " ");
}

function renderValue(key: string, value: any): string {
  if (value === null || value === undefined) return "";

  if (/dimension|size/i.test(key) && typeof value === "object" && !Array.isArray(value)) {
    return renderDimensions(value);
  }

  if (Array.isArray(value)) {
    return value.filter(Boolean).map((item) => humanise(String(item))).join(", ");
  }

  if (typeof value === "object") return "";

  return humanise(String(value));
}

/**
 * The enquiry as lines of text, or an empty string when there is nothing in it.
 *
 * Unknown keys are kept rather than dropped: a storefront can add a field at
 * any time, and losing a real answer is far worse than showing one extra line.
 * Only the known-noise keys are removed.
 */
export function describeEnquiry(description: string | undefined): string {
  const raw = String(description || "").trim();
  if (!raw) return "";

  // Prose, not JSON — used as-is.
  if (!raw.startsWith("{") && !raw.startsWith("[")) return raw;

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Malformed JSON is still the customer's words; better shown than dropped.
    return raw;
  }

  if (!parsed || typeof parsed !== "object") return raw;

  const lines: string[] = [];

  /**
   * Nested groups are flattened, not printed as JSON.
   *
   * Storefronts collect the interesting answers inside a sub-object —
   * `attributeOptions` holds the finish, the material, the core diameter. Dumped
   * as raw JSON on one line those answers were technically present and
   * practically invisible: the model asked the customer for a material that was
   * sitting in the enquiry all along.
   *
   * One level only. Deeper than that is structure nobody typed.
   */
  const emit = (key: string, value: any, depth: number) => {
    if (NOISE_KEYS.has(key.toLowerCase())) return;

    // Contact details are already on the lead; repeating them here only gives
    // the extractor another chance to read an email address as an answer.
    if (/^(email|phone|mobile|company|name|first_?name|last_?name)$/i.test(key)) return;

    const isGroup =
      value && typeof value === "object" && !Array.isArray(value) && !/dimension|size/i.test(key);

    if (isGroup && depth === 0) {
      for (const [innerKey, innerValue] of Object.entries(value)) {
        emit(innerKey, innerValue, depth + 1);
      }
      return;
    }

    const rendered = renderValue(key, value);
    if (rendered) lines.push(`${labelOf(key)}: ${rendered}`);
  };

  for (const [key, value] of Object.entries(parsed)) emit(key, value, 0);

  return lines.join("\n");
}

/** True when there is anything worth showing the model. */
export function hasEnquiryDetail(description: string | undefined): boolean {
  return describeEnquiry(description).length > 0;
}

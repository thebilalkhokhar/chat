import axios from "axios";
import { config } from "../config/env";

/**
 * Quotes from the ERP, which is where they actually live.
 *
 * The Zoho connector mirrors quotes too, but without an owner on any of the
 * seventeen thousand and without a single line item, so it can answer "how
 * many" and nothing else. The ERP returns the rep, the product, the material,
 * the dimensions and the quantity tiers — the things anyone opening this page
 * is looking for.
 *
 * The endpoint demands a `zoho_crm_user_id` and returns 422 without one, so
 * there is no "everything" call; a view across reps is several calls fanned
 * out. That is why results are cached briefly.
 */

export interface QuoteLine {
  product: string;
  material: string;
  /** As given: `[5,5,5]`, sometimes with a null for an unset side. */
  dimension: (number | null)[];
  skuNames: string[];
  /** The three quantity tiers a customer is priced at. */
  quantities: number[];
  prices: (number | null)[];
}

export interface ErpQuote {
  rfqId: number;
  reference: string;
  jobName: string;
  statusOrder: number;
  createdAt: string;
  quotedAt: string | null;
  customer: string;
  repName: string;
  repZohoUserId: string;
  lines: QuoteLine[];
}

/** Values the ERP reports; `quoted_at` is what says a price exists. */
export function describeStatus(quote: ErpQuote): string {
  if (quote.quotedAt) return "Quoted";
  return quote.statusOrder === 0 ? "New" : "In progress";
}

function normalise(raw: any): ErpQuote {
  const details = Array.isArray(raw.details) ? raw.details : [];

  return {
    rfqId: Number(raw.rfq_id),
    reference: String(raw.rfq_ref || ""),
    jobName: String(raw.job_name || ""),
    statusOrder: Number(raw.status_order ?? 0),
    createdAt: String(raw.created_at || ""),
    quotedAt: raw.quoted_at ? String(raw.quoted_at) : null,
    customer: String(raw.customer?.name || ""),
    repName: String(raw.sale_representative?.name || ""),
    repZohoUserId: String(raw.sale_representative?.zoho_crm_user_id || ""),
    lines: details.map((line: any) => ({
      product: String(line.product_name || ""),
      material: String(line.material_name || ""),
      dimension: Array.isArray(line.dimension) ? line.dimension : [],
      skuNames: Array.isArray(line.sku_name) ? line.sku_name.map(String) : [],
      // Three parallel single-element arrays in the response, which read far
      // better as one list of tiers.
      quantities: [line.sku_qty1, line.sku_qty2, line.sku_qty3]
        .map((tier) => (Array.isArray(tier) ? tier[0] : tier))
        .filter((value) => value !== null && value !== undefined)
        .map(Number),
      prices: [line.final_price1, line.final_price2, line.final_price3].map((price) =>
        price === null || price === undefined ? null : Number(price)
      ),
    })),
  };
}

export function isConfigured(): boolean {
  return Boolean(config.erp.baseUrl && config.erp.token);
}

/**
 * One rep's quotes.
 *
 * The rep filter is applied here as well as being sent. Asked for one rep the
 * endpoint returned six quotes belonging to three different people — whether
 * that is a bug or a house account seeing everything, a page that says "Linda's
 * quotes" must not list somebody else's.
 */
export async function quotesForRep(
  zohoUserId: string,
  options: { strict?: boolean } = {}
): Promise<ErpQuote[]> {
  if (!isConfigured() || !zohoUserId) return [];

  const response = await axios.get(`${config.erp.baseUrl}/api/exhibition-quotes`, {
    params: { zoho_crm_user_id: zohoUserId },
    headers: {
      Authorization: `Bearer ${config.erp.token}`,
      "Content-Type": "application/json",
    },
    timeout: 20000,
    validateStatus: () => true,
  });

  if (response.status !== 200 || !response.data?.success) return [];

  const quotes = (response.data.data || []).map(normalise);

  return options.strict === false
    ? quotes
    : quotes.filter((quote: ErpQuote) => quote.repZohoUserId === zohoUserId);
}

/**
 * Quotes across several reps, de-duplicated.
 *
 * Fanned out a few at a time rather than all at once: this is somebody else's
 * ERP and twenty-two simultaneous requests is not a reasonable thing to do to
 * it. A rep whose call fails is skipped, so one bad response does not empty the
 * whole page.
 */
export async function quotesForReps(zohoUserIds: string[]): Promise<ErpQuote[]> {
  const found = new Map<number, ErpQuote>();
  const batchSize = 4;

  for (let i = 0; i < zohoUserIds.length; i += batchSize) {
    const batch = zohoUserIds.slice(i, i + batchSize);

    const results = await Promise.all(
      batch.map((id) => quotesForRep(id).catch(() => [] as ErpQuote[]))
    );

    // Keyed by rfq id: the same quote can come back from more than one call.
    for (const quotes of results) {
      for (const quote of quotes) found.set(quote.rfqId, quote);
    }
  }

  return [...found.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

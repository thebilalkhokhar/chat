import { waitUntil } from "@vercel/functions";

/**
 * Work that runs after the reply has gone out — the rep alerts, the Zoho lead
 * write, copying chat files.
 *
 * On a long-running server (Railway, local) a promise left running simply
 * finishes. On Vercel the function is frozen the moment the response is sent,
 * so unregistered work is cut off half way: an alert never sent, a lead never
 * written. `waitUntil` keeps the function alive until it settles. Outside
 * Vercel it is a no-op, so the same code runs everywhere.
 */
export function afterResponse(work: Promise<unknown>): void {
  if (!process.env.VERCEL) return;
  try {
    waitUntil(work);
  } catch (error: any) {
    console.error("[server] could not register work to finish after the response:", error.message);
  }
}

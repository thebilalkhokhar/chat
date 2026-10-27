import axios from "axios";
import mongoose from "mongoose";

/**
 * Logs every database query and outgoing HTTP call that takes longer than SLOW_MS.
 *
 * Since 22:21 UTC on 23 Oct, some chat turns in production take 30–140 seconds —
 * the ones where the visitor's email or phone becomes known — while the same turn
 * run locally against the same data takes about 4. SalesIQ gives up after ~10s and
 * shows the visitor the failure message. Nothing in the logs said what the turn was
 * waiting on; this names it. Cheap enough to leave on: one timestamp per call.
 */

const SLOW_MS = 3000;
let installed = false;

export function installSlowCallLog(): void {
  if (installed) return;
  installed = true;

  mongoose.plugin((schema) => {
    schema.pre(/.*/ as any, function (this: any) {
      this.__startedAt = Date.now();
    });
    schema.post(/.*/ as any, function (this: any) {
      const took = Date.now() - (this.__startedAt || Date.now());
      if (took < SLOW_MS) return;
      // A slow save reports once, for the document, not once per embedded message in it.
      if (typeof this.ownerDocument === "function" && this.ownerDocument() !== this) return;
      const model = this.model?.modelName || this.constructor?.modelName || "?";
      const op = this.op || this.constructor?.name || "save";
      console.warn(`[slow] mongo ${model}.${op} ${took}ms`);
    });
  });

  // The OpenAI client and some services use fetch rather than axios.
  const originalFetch = globalThis.fetch;
  if (originalFetch) {
    globalThis.fetch = (async (input: any, init?: any) => {
      const startedAt = Date.now();
      const url = String(typeof input === "string" ? input : input?.url || "").split("?")[0];
      try {
        const response = await originalFetch(input, init);
        const took = Date.now() - startedAt;
        if (took >= SLOW_MS) console.warn(`[slow] fetch ${init?.method || "GET"} ${url} ${took}ms (${response.status})`);
        return response;
      } catch (error: any) {
        const took = Date.now() - startedAt;
        if (took >= SLOW_MS) console.warn(`[slow] fetch ${init?.method || "GET"} ${url} ${took}ms (${error?.name || "error"})`);
        throw error;
      }
    }) as typeof fetch;
  }

  axios.interceptors.request.use((request) => {
    (request as any).__startedAt = Date.now();
    return request;
  });
  const done = (config: any, outcome: string) => {
    const took = Date.now() - (config?.__startedAt || Date.now());
    if (took >= SLOW_MS) {
      const url = String(config?.url || "").split("?")[0];
      console.warn(`[slow] http ${String(config?.method || "").toUpperCase()} ${url} ${took}ms (${outcome})`);
    }
  };
  axios.interceptors.response.use(
    (response) => {
      done(response.config, String(response.status));
      return response;
    },
    (error) => {
      done(error?.config, error?.code || error?.response?.status || "error");
      return Promise.reject(error);
    }
  );
}

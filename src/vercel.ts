import type { IncomingMessage, ServerResponse } from "http";
import type { Express } from "express";
import { config } from "./config/env";
import { connectLeadsDb, connectConnectorDb } from "./db/connections";
import { createApi } from "./server/api";
import { tick } from "./worker";
import { installSlowCallLog } from "./server/slowCallLog";

// Names whatever a slow chat turn is waiting on — see slowCallLog.ts.
installSlowCallLog();

/**
 * Entry points for Vercel.
 *
 * On Railway `main.ts` runs one process: the dashboard and webhooks on a port,
 * and the worker polling every 30 seconds. Vercel has no long-running process,
 * so the two are split:
 *
 * - `app` serves every HTTP request (dashboard, API, SalesIQ webhooks). The
 *   database connections and the Express app are built once per warm instance
 *   and reused.
 * - `cron` runs one worker pass — follow-up emails, pending chat leads, chat
 *   files — when Vercel Cron calls /api/cron/worker (every minute, see
 *   vercel.json). It only answers Vercel's own cron, by CRON_SECRET.
 */

let ready: Promise<Express> | null = null;

function appOnce(): Promise<Express> {
  if (!ready) {
    ready = (async () => createApi(await connectLeadsDb(), await connectConnectorDb()))();
    // A failed start (database unreachable) must not be cached for the instance's life.
    ready.catch(() => {
      ready = null;
    });
  }
  return ready;
}

export async function app(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const express = await appOnce();
  express(req as any, res as any);
}

export async function cron(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const secret = process.env.CRON_SECRET || "";
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) {
    res.statusCode = 401;
    res.end("Unauthorised");
    return;
  }
  const startedAt = Date.now();
  try {
    await tick(await connectLeadsDb(), await connectConnectorDb());
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, tookMs: Date.now() - startedAt, pollSeconds: config.worker.pollSeconds }));
  } catch (error: any) {
    console.error("[cron] worker pass failed:", error.message);
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: error.message }));
  }
}

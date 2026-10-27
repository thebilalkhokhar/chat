import express, { Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";
import path from "path";
import { Types } from "mongoose";
import type { Connection } from "mongoose";
import { getSettings, updateSettings } from "../services/settingsService";
import { findEligibleLeads } from "../services/leadSource";
import { conversationModel } from "../models/Conversation";
import { zohoCredentialModel } from "../models/ZohoCredential";
import {
  SESSION_COOKIE,
  createSessionToken,
  verifySessionToken,
  verifyCredentials,
  AdminSession,
} from "../services/auth";
import { isOfficeHours, pakistanStamp } from "../domain/officeHours";
import { sanitiseSettingsPatch } from "./validate";
import { createSalesIqWebhook, handleSalesIqProbe } from "../services/salesiq/webhook";
import { createSalesIqEventsWebhook } from "../services/salesiq/chatEvents";
import { salesIqCaptureModel } from "../models/SalesIqCapture";
import { quotesForRep, quotesForReps, isConfigured as erpConfigured, describeStatus } from "../services/erpQuotes";
import { loadRepDirectory } from "../services/leadSource";
import { chatConversationModel } from "../models/ChatConversation";
import { renderChatViewHtml } from "./chatView";
import { addEnglishTranscript } from "../services/salesiq/transcriptEnglish";
import { chatFunnel, chatFunnelList, resolveRange, marketingReport, listBudgets, saveBudget } from "../services/chatFunnel";
import { leadChannels } from "../services/backendAnalytics";

/**
 * The dashboard HTTP surface.
 *
 * Every route that reads or changes anything requires a session. The settings
 * exposed here decide whether strangers receive automated email, so there is no
 * such thing as a harmless unauthenticated endpoint in this file.
 *
 * The one route without a session is the SalesIQ webhook, which cannot carry a
 * cookie: it is authenticated by a shared secret instead, reads no settings and
 * changes none, and rejects every request that does not present the token.
 */
export function createApi(leadsDb: Connection, connectorDb: Connection) {
  const app = express();

  // The raw bytes are kept because an RSA signature is over exactly what was
  // sent: re-serialising the parsed object would reorder keys and change
  // whitespace, and the signature would never verify again. Only the SalesIQ
  // webhook reads it.
  app.use(
    express.json({
      limit: "256kb",
      verify: (req, _res, buf) => {
        (req as any).rawBody = Buffer.from(buf);
      },
    })
  );
  app.use(cookieParser());

  const sessionOf = (req: Request): AdminSession | null =>
    verifySessionToken((req as any).cookies?.[SESSION_COOKIE]);

  const adminOf = (req: Request): AdminSession => (req as any).admin;

  /** Any signed-in account, manager included. Only the chat funnel is open to this. */
  function requireSignedIn(req: Request, res: Response, next: NextFunction): void {
    const session = sessionOf(req);
    if (!session) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    (req as any).admin = session;
    next();
  }

  /** An admin. A manager is refused here even when calling the API directly, not just hidden in the page. */
  function requireAdmin(req: Request, res: Response, next: NextFunction): void {
    const session = sessionOf(req);
    if (!session) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    if (session.role !== "admin") {
      res.status(403).json({ error: "This account cannot use the admin tools" });
      return;
    }
    (req as any).admin = session;
    next();
  }

  // ---- auth ----

  app.post("/api/login", async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
      res.status(400).json({ error: "Email and password required" });
      return;
    }

    const session = await verifyCredentials(leadsDb, String(email), String(password));

    // The same message for a wrong address and a wrong password, so the form
    // cannot be used to discover which admin accounts exist.
    if (!session) {
      res.status(401).json({ error: "Incorrect email or password" });
      return;
    }

    res.cookie(SESSION_COOKIE, createSessionToken(session), {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 12 * 60 * 60 * 1000,
    });
    res.json({ ok: true, admin: session });
  });

  app.post("/api/logout", (_req, res) => {
    res.clearCookie(SESSION_COOKIE);
    res.json({ ok: true });
  });

  app.get("/api/me", (req, res) => {
    const session = sessionOf(req);
    if (!session) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    res.json({ admin: session });
  });

  // ---- settings ----

  app.get("/api/settings", requireAdmin, async (_req, res) => {
    res.json(await getSettings(leadsDb, true));
  });

  app.put("/api/settings", requireAdmin, async (req, res) => {
    try {
      const patch = sanitiseSettingsPatch(req.body || {});
      if (Object.keys(patch).length === 0) {
        res.status(400).json({ error: "Nothing recognised to update" });
        return;
      }
      res.json(await updateSettings(leadsDb, patch, adminOf(req).email));
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  // ---- what those settings actually do ----

  app.get("/api/preview", requireAdmin, async (_req, res) => {
    const settings = await getSettings(leadsDb);
    const { eligible, rejected, scanned } = await findEligibleLeads(leadsDb, connectorDb);

    const byReason = new Map<string, number>();
    for (const item of rejected) {
      byReason.set(item.reason, (byReason.get(item.reason) || 0) + 1);
    }

    res.json({
      now: {
        pakistan: pakistanStamp(new Date()),
        officeStaffed: isOfficeHours(new Date(), settings.officeHours),
      },
      scanned,
      eligible: eligible.map((lead) => ({
        email: lead.email,
        fullName: lead.fullName,
        company: lead.company,
        repEmail: lead.repEmail,
        source: lead.source,
        status: lead.status,
        capturedPakistan: pakistanStamp(lead.capturedAt),
      })),
      rejected: [...byReason.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((a, b) => b.count - a.count),
    });
  });

  app.get("/api/stats", requireAdmin, async (_req, res) => {
    const Conversation = conversationModel(leadsDb);
    const settings = await getSettings(leadsDb);

    const dayAgo = new Date(Date.now() - 86_400_000);

    const [total, byStatus, leadCount, repCount, newestInbound, inboundLastDay] = await Promise.all([
      Conversation.countDocuments(),
      Conversation.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
      connectorDb.collection("leads").countDocuments(),
      zohoCredentialModel(leadsDb).countDocuments({ refreshToken: { $nin: ["", null] } }),
      // How current the connector's mailbox sync is. A total count of every
      // email ever synced says nothing useful; what matters is whether new mail
      // is still arriving, because a stalled sync means customer replies stop
      // being seen and every conversation hangs without any error appearing.
      connectorDb
        .collection("interactions")
        .find({ type: "Email", direction: "Inbound" })
        .sort({ timestamp: -1 })
        .limit(1)
        .toArray(),
      connectorDb
        .collection("interactions")
        .countDocuments({ type: "Email", direction: "Inbound", timestamp: { $gte: dayAgo } }),
    ]);

    const newestAt = newestInbound[0]?.timestamp ? new Date(newestInbound[0].timestamp) : null;
    const syncAgeHours = newestAt ? (Date.now() - newestAt.getTime()) / 3_600_000 : null;

    // How long since the loop last completed a pass. A dashboard that is up
    // while the worker is dead looks identical to one that is simply idle, and
    // that ambiguity is exactly what makes "why is nothing sending" hard.
    const lastPassAt = settings.lastPassAt ? new Date(settings.lastPassAt) : null;
    const passAgeSeconds = lastPassAt ? (Date.now() - lastPassAt.getTime()) / 1000 : null;

    res.json({
      worker: {
        lastPassAt,
        lastPassSummary: settings.lastPassSummary || "",
        ageSeconds: passAgeSeconds === null ? null : Math.round(passAgeSeconds),
        // Three missed polls is generous; beyond that the process is not there.
        alive: passAgeSeconds !== null && passAgeSeconds < 240,
      },
      enabled: settings.enabled,
      dryRun: settings.guardrails.dryRun,
      officeStaffed: isOfficeHours(new Date(), settings.officeHours),
      pakistanTime: pakistanStamp(new Date()),
      conversations: {
        total,
        byStatus: Object.fromEntries(byStatus.map((row: any) => [row._id, row.n])),
      },
      leads: leadCount,
      repsWithZohoGrant: repCount,
      replySync: {
        /** Hours since the most recent inbound email was synced. */
        ageHours: syncAgeHours === null ? null : Number(syncAgeHours.toFixed(1)),
        inboundLastDay,
        // Six hours of silence on a mailbox that normally sees hundreds of
        // messages a day means the sync has stopped, not that nobody wrote.
        healthy: syncAgeHours !== null && syncAgeHours < 6,
      },
    });
  });

  /**
   * The conversation list, as the dashboard reads it.
   *
   * Summaries only. The messages are the bulk of a conversation, and two
   * hundred full transcripts is megabytes of email bodies for a table that
   * shows one line of each; the detail route below serves the thread when a row
   * is actually opened.
   *
   * The status counts come back alongside, against the same search but ignoring
   * the chosen status, so a filter can say how many it is hiding. Without that,
   * an empty table is ambiguous — nothing matched, or the wrong pill is on.
   */
  app.get("/api/conversations", requireAdmin, async (req, res) => {
    const Conversation = conversationModel(leadsDb);

    const status = String(req.query.status || "all").trim();
    const rep = String(req.query.rep || "all").trim().toLowerCase();
    const search = String(req.query.search || "").trim();
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 25));

    const base: Record<string, unknown> = {};
    if (rep && rep !== "all") base.repEmail = rep;
    if (search) {
      const pattern = new RegExp(search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      base.$or = [
        { customerEmail: pattern },
        { customerName: pattern },
        { company: pattern },
        { repEmail: pattern },
        { repName: pattern },
        { enquiry: pattern },
        { exhibitionTitle: pattern },
      ];
    }

    const filter = status && status !== "all" ? { ...base, status } : base;

    const [total, rows, byStatus] = await Promise.all([
      Conversation.countDocuments(filter),
      Conversation.aggregate([
        { $match: filter },
        { $sort: { updatedAt: -1 } },
        { $skip: (page - 1) * limit },
        { $limit: limit },
        {
          $addFields: {
            messageCount: { $size: { $ifNull: ["$messages", []] } },
            lastMessage: { $arrayElemAt: [{ $ifNull: ["$messages", []] }, -1] },
          },
        },
        { $project: { messages: 0 } },
      ]),
      Conversation.aggregate([{ $match: base }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
    ]);

    res.json({
      total,
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
      byStatus: Object.fromEntries(byStatus.map((row: any) => [row._id, row.n])),
      conversations: rows.map((row: any) => ({
        ...row,
        lastMessage: row.lastMessage
          ? {
              author: row.lastMessage.author,
              subject: row.lastMessage.subject || "",
              at: row.lastMessage.at,
              draftOnly: Boolean(row.lastMessage.draftOnly),
              preview: String(row.lastMessage.body || "").replace(/\s+/g, " ").slice(0, 200),
            }
          : null,
      })),
    });
  });

  /**
   * Every rep, the leads they hold, and what is owed on each.
   *
   * "Which rep has what, and what falls due next" is the one question a list
   * sorted by date cannot answer: a rep holding forty stopped threads and a rep
   * holding forty live ones look identical in it.
   *
   * Registered above `/:id` deliberately — Express matches in order, and the
   * parameter route would otherwise swallow "by-rep" and look it up as an id.
   */
  app.get("/api/conversations/by-rep", requireAdmin, async (_req, res) => {
    const countOf = (value: string) => ({ $sum: { $cond: [{ $eq: ["$status", value] }, 1, 0] } });

    const rows = await conversationModel(leadsDb).aggregate([
      {
        $group: {
          _id: "$repEmail",
          repName: { $first: "$repName" },
          total: { $sum: 1 },
          pendingFirstContact: countOf("pending_first_contact"),
          awaitingReply: countOf("awaiting_reply"),
          readyToQuote: countOf("ready_to_quote"),
          stopped: countOf("stopped"),
          aiMessages: { $sum: "$aiMessageCount" },
          // Only a live conversation still owes a follow-up. A stopped one keeps
          // whatever `nextActionAt` it had when it stopped, and letting that
          // through would show a rep a due date for mail that will never be sent.
          nextActionAt: {
            $min: { $cond: [{ $eq: ["$status", "stopped"] }, null, "$nextActionAt"] },
          },
          lastActivityAt: { $max: "$updatedAt" },
        },
      },
      { $sort: { total: -1 } },
    ]);

    res.json(
      rows.map((row: any) => ({
        repEmail: row._id || "",
        repName: row.repName || "",
        total: row.total,
        pendingFirstContact: row.pendingFirstContact,
        awaitingReply: row.awaitingReply,
        readyToQuote: row.readyToQuote,
        stopped: row.stopped,
        aiMessages: row.aiMessages || 0,
        nextActionAt: row.nextActionAt || null,
        lastActivityAt: row.lastActivityAt || null,
      }))
    );
  });

  /**
   * The connector's copy of the lead a conversation was opened from.
   *
   * A conversation stores only what it needed to write the first email. Who
   * captured the lead, when, under which source and tags, and the phone number
   * nobody emailed all live in the connector — and that is most of what a human
   * wants when they open a thread and ask why it says what it says.
   *
   * Never fatal: a missing or unreadable lead leaves the transcript perfectly
   * readable, so this returns null rather than failing the whole request.
   */
  async function leadBehind(leadId: string) {
    if (!leadId || !Types.ObjectId.isValid(leadId)) return null;
    try {
      const doc = await connectorDb.collection("leads").findOne({ _id: new Types.ObjectId(leadId) });
      if (!doc) return null;
      return {
        email: doc.email || "",
        fullName: [doc.firstName, doc.lastName].filter(Boolean).join(" ").trim(),
        company: doc.company || "",
        phone: doc.phone || doc.mobile || "",
        source: doc.source || "",
        status: doc.status || "",
        tags: Array.isArray(doc.tags) ? doc.tags : [],
        description: doc.description || "",
        zohoLeadId: doc.zohoLeadId || "",
        capturedAt: doc.createdAt || null,
        capturedPakistan: doc.createdAt ? pakistanStamp(new Date(doc.createdAt)) : "",
      };
    } catch {
      return null;
    }
  }

  /** One conversation in full: every message, and the CRM lead behind it. */
  app.get("/api/conversations/:id", requireAdmin, async (req, res) => {
    if (!Types.ObjectId.isValid(String(req.params.id))) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    const conversation = await conversationModel(leadsDb).findById(req.params.id).lean();
    if (!conversation) {
      res.status(404).json({ error: "Not found" });
      return;
    }

    res.json({ ...conversation, lead: await leadBehind(String(conversation.leadId || "")) });
  });

  /** Stops a running conversation by hand. */
  app.post("/api/conversations/:id/stop", requireAdmin, async (req, res) => {
    const updated = await conversationModel(leadsDb)
      .findByIdAndUpdate(
        req.params.id,
        {
          $set: {
            status: "stopped",
            stopReason: "manual",
            stopNote: "Stopped by " + adminOf(req).email,
            nextActionAt: null,
          },
        },
        { new: true }
      )
      .lean();

    if (!updated) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(updated);
  });

  /** A visual week, so the office-hours setting can be checked at a glance. */
  app.get("/api/office-hours/grid", requireAdmin, async (_req, res) => {
    const settings = await getSettings(leadsDb);

    // Any Monday works; only the weekday and hour are consulted. Pakistan is
    // UTC+5 year-round, so local hour H is (H-5) UTC on the same day.
    const monday = Date.UTC(2026, 7, 24);

    const grid = Array.from({ length: 7 }, (_, day) =>
      Array.from({ length: 24 }, (_, hourOfDay) => {
        const at = new Date(monday + day * 86400000 + (hourOfDay - 5) * 3600000);
        return isOfficeHours(at, settings.officeHours) ? 1 : 0;
      })
    );

    res.json({ days: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"], grid });
  });

  /**
   * Quotes, from the ERP rather than the Zoho mirror.
   *
   * The connector's copy carries no owner on any of its seventeen thousand
   * records and no line items at all, so it can say how many quotes exist and
   * nothing about them. The ERP returns the rep, the product, the material, the
   * dimensions and the quantity tiers.
   *
   * That endpoint requires a rep id — it answers 422 without one — so a view
   * across everybody is several calls fanned out, and the result is filtered
   * and paged here.
   */
  app.get("/api/quotes", requireAdmin, async (req, res) => {
    if (!erpConfigured()) {
      res.json({ configured: false, total: 0, page: 1, pages: 1, quotes: [], reps: [] });
      return;
    }

    const search = String(req.query.search || "").trim().toLowerCase();
    const repId = String(req.query.rep || "").trim();
    const status = String(req.query.status || "all").trim();
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));

    const directory = await loadRepDirectory(leadsDb);
    const reps = [...directory.entries()].map(([id, rep]) => ({
      id,
      email: rep.email,
      name: rep.fullName || rep.email,
    }));

    let quotes;
    try {
      quotes =
        repId && repId !== "all"
          ? await quotesForRep(repId)
          : await quotesForReps(reps.map((rep) => rep.id));
    } catch (error: any) {
      res.status(502).json({ error: `The ERP did not answer: ${error.message}` });
      return;
    }

    if (status !== "all") {
      quotes = quotes.filter((quote) => describeStatus(quote).toLowerCase() === status.toLowerCase());
    }

    if (search) {
      // Matched in memory because the ERP offers no search parameter, and the
      // result of one rep's call is small enough that it does not matter.
      quotes = quotes.filter((quote) =>
        [
          quote.reference,
          quote.jobName,
          quote.customer,
          quote.repName,
          ...quote.lines.flatMap((line) => [line.product, line.material]),
        ]
          .join(" ")
          .toLowerCase()
          .includes(search)
      );
    }

    const total = quotes.length;
    const pageItems = quotes.slice((page - 1) * limit, page * limit);

    res.json({
      configured: true,
      total,
      page,
      pages: Math.max(1, Math.ceil(total / limit)),
      reps: reps.sort((a, b) => a.name.localeCompare(b.name)),
      quotes: pageItems.map((quote) => ({
        ...quote,
        status: describeStatus(quote),
      })),
    });
  });

  // ---- chat funnel: website chat → Zoho lead → ERP quote → order → payment ----

  const funnelQuery = (req: Request) => ({
    from: String(req.query.from || ""),
    to: String(req.query.to || ""),
    rep: String(req.query.rep || ""),
    source: String(req.query.source || ""),
    type: String(req.query.type || ""),
    stage: String(req.query.stage || ""),
    page: String(req.query.page || ""),
  });

  // The marketing view: leads, source and what each became, for super admins (and admins).
  /** The marketing view: super admins (who see only this) and admins. */
  function requireMarketing(req: Request, res: Response, next: NextFunction): void {
    const session = sessionOf(req);
    if (!session) {
      res.status(401).json({ error: "Not signed in" });
      return;
    }
    if (session.role !== "admin" && session.role !== "super_admin") {
      res.status(403).json({ error: "This account cannot see the marketing view" });
      return;
    }
    (req as any).admin = session;
    next();
  }

  // Monthly marketing budgets, entered by hand per source.
  app.get("/api/marketing/budgets", requireMarketing, async (req, res) => {
    const year = Number((req.query as any).year) || new Date().getFullYear();
    res.json({ year, months: await listBudgets(leadsDb, year) });
  });

  app.put("/api/marketing/budgets/:month", requireMarketing, async (req, res) => {
    try {
      res.json(await saveBudget(leadsDb, String(req.params.month), (req.body || {}).sources || {}, adminOf(req).email));
    } catch (error: any) {
      res.status(400).json({ error: error.message });
    }
  });

  app.get("/api/marketing", requireMarketing, async (req, res) => {
    try {
      const q = req.query as Record<string, string>;
      res.json(await marketingReport(leadsDb, connectorDb, { from: q.from, to: q.to, source: q.source, status: q.status, type: q.type, minQuote: q.minQuote, page: q.page, size: q.size }));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/chat-funnel", requireSignedIn, async (req, res) => {
    try {
      res.json(await chatFunnel(leadsDb, connectorDb, funnelQuery(req)));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  /** All ecommerce leads by traffic source, from the main backend, for the funnel's dates. */
  app.get("/api/chat-funnel/lead-channels", requireSignedIn, async (req, res) => {
    const range = resolveRange(String(req.query.from || ""), String(req.query.to || ""));
    res.json(await leadChannels(range.from, range.to));
  });

  app.get("/api/chat-funnel/chats", requireSignedIn, async (req, res) => {
    try {
      res.json(await chatFunnelList(leadsDb, connectorDb, funnelQuery(req)));
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/reps", requireAdmin, async (_req, res) => {
    const reps = await zohoCredentialModel(leadsDb)
      .find({}, { email: 1, fullName: 1, zohoUserId: 1, updatedAt: 1, refreshToken: 1 })
      .sort({ email: 1 })
      .lean();

    // The tokens themselves never reach a browser — only whether one exists.
    res.json(
      reps.map((rep) => ({
        email: rep.email,
        fullName: rep.fullName,
        zohoUserId: rep.zohoUserId,
        hasGrant: Boolean(rep.refreshToken),
        lastSignIn: rep.updatedAt,
      }))
    );
  });

  // ---- salesiq chat bot ----

  // Mounted above the static handler so the catch-all cannot answer a webhook
  // call with the dashboard's HTML, and outside `requireAdmin` because SalesIQ
  // has no session to present. Its own token check is inside the handler.
  app.post("/webhooks/salesiq", createSalesIqWebhook(leadsDb));
  app.get("/webhooks/salesiq", handleSalesIqProbe);

  // SalesIQ's chat events — a separate webhook from the bot's, configured in
  // Settings → Developers → Webhooks, and the only way we are ever told that a
  // rep picked a chat up. See chatEvents.ts.
  app.post("/webhooks/salesiq/events", createSalesIqEventsWebhook(leadsDb));
  app.get("/webhooks/salesiq/events", (_req, res) =>
    res.json({ ok: true, service: "lead-follow-up", endpoint: "salesiq-chat-events" })
  );

  /** The captured requests, newest first. How phase one gets read. */
  app.get("/api/salesiq/captures", requireAdmin, async (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const captures = await salesIqCaptureModel(leadsDb)
      .find({})
      .sort({ receivedAt: -1 })
      .limit(limit)
      .lean();
    res.json({ count: captures.length, captures });
  });

  // ---- public chat web view ----

  /**
   * Mobile-responsive web view for inspecting a live chat transcript.
   * Opened by sales reps and team members from WhatsApp notifications.
   */
  app.get("/chat-view/:id", async (req, res) => {
    const id = String(req.params.id || "").trim();
    const ChatConversation = chatConversationModel(leadsDb);

    const conversation = await ChatConversation.findOne({
      $or: [
        { conversationId: id },
        { visitorId: id },
        ...(Types.ObjectId.isValid(id) ? [{ _id: id }] : []),
      ],
    }).lean();

    // A chat in another language gets English under each line, translated once and kept.
    if (conversation) {
      try {
        await addEnglishTranscript(leadsDb, conversation as any, await getSettings(leadsDb));
      } catch (error: any) {
        console.error("[chat-view] English transcript skipped:", error.message);
      }
    }

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(renderChatViewHtml(conversation, id));
  });

  /** Public JSON endpoint for live polling in the chat web view */
  app.get("/api/public/chats/:id", async (req, res) => {
    const id = String(req.params.id || "").trim();
    const ChatConversation = chatConversationModel(leadsDb);

    const conversation = await ChatConversation.findOne({
      $or: [
        { conversationId: id },
        { visitorId: id },
        ...(Types.ObjectId.isValid(id) ? [{ _id: id }] : []),
      ],
    }).lean();

    if (!conversation) {
      res.status(404).json({ ok: false, error: "Not found" });
      return;
    }

    res.json({ ok: true, conversation });
  });

  // ---- static dashboard ----

  app.use(express.static(path.join(__dirname, "public")));

  // A catch-all middleware rather than `app.get("*")`: Express 5 parses route
  // strings with path-to-regexp v6, where a bare "*" is a syntax error. An
  // unmatched /api path must still 404 as JSON rather than being handed the
  // dashboard HTML, which would leave a fetch parsing markup as JSON.
  app.use((req, res) => {
    if (req.path.startsWith("/api/")) {
      res.status(404).json({ error: "No such endpoint" });
      return;
    }
    res.sendFile(path.join(__dirname, "public", "index.html"));
  });

  return app;
}

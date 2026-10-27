import crypto from "crypto";
import type { Request, Response } from "express";
import type { Connection } from "mongoose";
import { config } from "../../config/env";
import { salesIqCaptureModel } from "../../models/SalesIqCapture";
import { chatConversationModel } from "../../models/ChatConversation";
import { isComplete } from "../../domain/quoteFields";
import { getSettings } from "../settingsService";
import { runChatTurn, noteHandedToAPerson, IncomingChat } from "./chatEngine";
import { storeChatAttachments } from "./attachmentStore";
import { handOffToCrm } from "./handoff";
import { afterResponse } from "../../server/afterResponse";
import { notifyRepOfChat, shouldNotifyRep } from "../erpChatNotify";
import { whatsAppRepAlert, shouldWhatsApp } from "../whatsappNotify";

/**
 * The SalesIQ bot webhook, in capture mode.
 *
 * Zoho's public documentation gives the handler names and the general shape of
 * a reply, but not the request body, the headers, or how long SalesIQ waits
 * before giving up on us. That last one decides whether a model call can happen
 * inside the request at all, so it is the thing phase one exists to measure.
 *
 * Everything specific to SalesIQ's contract lives in this file. When a captured
 * payload contradicts an assumption below, this is the only file that changes.
 */

/**
 * The greeting for a chat SalesIQ opened without saying who it is.
 *
 * About one trigger in seventy carries no uvid, no visitor id, nothing to file a
 * conversation under — 113 in one week — and those got the holding line. With
 * no record there is no rep's name to keep, so this names nobody; whoever
 * answers their first message introduces themselves then.
 */
const GREETING_WITHOUT_AN_ID = "Hi, nice to meet you! What are you looking to have made?";

/**
 * How a reply is shaped.
 *
 * Zoho's own examples disagree: the scripting docs show `replies` as an array
 * of plain strings, the Zia examples as objects with a `text` key. Which one
 * the webhook platform accepts is not stated anywhere public, so it is written
 * once, here, and corrected the moment a real exchange shows which renders.
 *
 * If a visitor sees the bot connect but say nothing, this is the first thing to
 * change.
 */
function buildReply(texts: string[]): Record<string, unknown> {
  return {
    action: "reply",
    replies: texts.map((text) => ({ text })),
  };
}

/**
 * Hands the live chat to a person.
 *
 * `operators` names the rep directly rather than using `department`, which
 * routes to whoever in that department happens to be free. A qualified chat is
 * being handed to a named person who is expecting it, and the CRM lead is
 * created under that same name — the two must not disagree about who owns it.
 *
 * `replies` is sent with the forward so the visitor is told what is happening;
 * without it the chat goes quiet while it waits to be picked up.
 */
/**
 * Hands the chat to one operator, or offers it to several.
 *
 * SalesIQ takes a list, and with more than one the chat goes to whoever accepts
 * it first — which is what makes the working-hours pool work without us having
 * to pick an agent or track who is free.
 */
function buildForward(texts: string[], operators: string | string[]): Record<string, unknown> {
  const list = (Array.isArray(operators) ? operators : [operators])
    .map((email) => String(email || "").trim())
    .filter(Boolean);

  return {
    action: "forward",
    operators: list,
    replies: texts.map((text) => ({ text })),
  };
}

/**
 * Headers worth keeping, minus anything that carries a credential.
 *
 * Signature headers are deliberately not redacted. A signature is derived from
 * the payload rather than being a reusable secret, and reading one is the whole
 * point of this phase — redacting it would hide the answer we are looking for.
 */
const REDACTED = new Set([
  "authorization",
  "cookie",
  "x-webhook-token",
  "proxy-authorization",
]);

function safeHeaders(headers: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = REDACTED.has(key.toLowerCase()) ? "[redacted]" : value;
  }
  return out;
}

/**
 * Header names a signature might arrive under.
 *
 * Live traffic settled this: SalesIQ sends `x-siqsignature`, which none of the
 * documented-looking guesses would have matched. The others are kept only until
 * a capture actually verifies against the public key — the name is confirmed,
 * the digest and encoding are not.
 */
const SIGNATURE_HEADERS = [
  "x-siqsignature",
  "x-salesiq-signature",
  "x-zoho-signature",
  "salesiq-signature",
  "x-signature",
  "signature",
];

export interface VerificationResult {
  verified: boolean;
  /** Which header carried the signature, once one verifies. */
  signatureHeader: string;
  /** Why it did not verify, for the capture log. */
  detail: string;
}

/**
 * Checks SalesIQ's RSA signature over the exact bytes received.
 *
 * Both SHA-256 and SHA-1 are attempted because the digest is not documented
 * either, and an unverified-but-genuine call is indistinguishable from a forged
 * one if the only reason it failed was the wrong hash.
 */
export function verifySalesIqSignature(req: Request): VerificationResult {
  const publicKey = config.salesiq.publicKey;
  if (!publicKey) {
    return { verified: false, signatureHeader: "", detail: "no SALESIQ_PUBLIC_KEY configured" };
  }

  const raw: Buffer | undefined = (req as any).rawBody;
  if (!raw || raw.length === 0) {
    return { verified: false, signatureHeader: "", detail: "no raw body captured" };
  }

  const present = SIGNATURE_HEADERS.filter((name) => req.headers[name]);
  if (present.length === 0) {
    return { verified: false, signatureHeader: "", detail: "no recognised signature header" };
  }

  for (const name of present) {
    const signature = String(req.headers[name]);
    for (const encoding of ["base64", "hex"] as const) {
      for (const algorithm of ["RSA-SHA256", "RSA-SHA1"]) {
        try {
          if (crypto.verify(algorithm, raw, publicKey, Buffer.from(signature, encoding))) {
            return { verified: true, signatureHeader: `${name} (${algorithm}, ${encoding})`, detail: "" };
          }
        } catch {
          // A malformed key or unusable algorithm — keep trying the rest.
        }
      }
    }
  }

  return {
    verified: false,
    signatureHeader: present.join(", "),
    detail: "signature present but did not verify against the public key",
  };
}

/**
 * A shared secret, if one was configured.
 *
 * SalesIQ signs rather than presenting a token, so this is not how a real call
 * authenticates. It is kept so the endpoint can still be exercised by hand
 * without forging a signature.
 */
export function hasValidToken(req: Request): boolean {
  const expected = config.salesiq.webhookToken;
  if (!expected) return false;

  const bearer = String(req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  return [
    bearer,
    String(req.headers["x-webhook-token"] || ""),
    String((req.query as Record<string, unknown>).token || ""),
  ].some((candidate) => safeEqual(candidate, expected));
}

function safeEqual(a: string, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  let differing = 0;
  for (let i = 0; i < a.length; i += 1) differing |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return differing === 0;
}

/**
 * Which handler fired.
 *
 * Live traffic confirmed `handler`, carrying "trigger" when a chat opens and
 * "message" when the visitor types. The other key names are kept as a fallback
 * in case a handler we have not seen yet names itself differently.
 */
function readHandler(body: any): string {
  return String(body?.handler || body?.event || body?.type || body?.operation || "");
}

/**
 * The visitor, as SalesIQ describes them.
 *
 * Field names taken from real captures rather than documentation. The chat is
 * keyed on `active_conversation_id`; `uvid` is kept as a fallback because the
 * opening `trigger` payload carries no conversation id at all.
 */
export function readIncoming(body: any): IncomingChat {
  const visitor = body?.visitor || {};
  const name = [visitor.first_name, visitor.last_name].filter(Boolean).join(" ").trim() || visitor.name || "";

  return {
    // `uvid` first, and this order matters. A `trigger` payload never carries
    // `active_conversation_id` — only `message` does — so preferring the
    // conversation id gave the same chat two different keys: the opening turn
    // filed under the uvid, every later turn under the conversation id. That is
    // precisely the split-in-two this is meant to prevent. The uvid is the one
    // identifier present on both, and it holds steady across a session.
    conversationId: String(visitor.uvid || visitor.active_conversation_id || visitor.visitor_id || ""),
    uvid: String(visitor.uvid || ""),
    salesIqConversationId: String(visitor.active_conversation_id || ""),
    uuid: String(visitor.uuid || ""),
    visitorId: String(visitor.visitor_id || ""),
    name: String(name),
    email: String(visitor.email || ""),
    phone: String(visitor.phone || visitor.contact_number || ""),
    landingPageTitle: String(visitor.landing_page_title || visitor.current_page_title || ""),
    currentPageUrl: String(visitor.current_page_url || ""),
    landingPageUrl: String(visitor.landing_page_url || ""),
    referer: String(visitor.referer || ""),
    visitorChannel: String(visitor.channel || ""),
    question: String(visitor.question || ""),
    departmentId: String(visitor.department_id || ""),
    ...readMessage(body),
  };
}

/**
 * What the visitor sent: their words, and whether a file came with them.
 *
 * A photo arrives as a message with no text — `type: "file"` or `"files"` with
 * the attachment alongside, or on Instagram the literal text "File Shared". It
 * was read as an empty message and answered as a turn, which put the next
 * question on top of the one still waiting. A WhatsApp caption rides along in
 * `meta.comments`.
 */
export function readMessage(body: any): Pick<IncomingChat, "text" | "sharedFile" | "fileNames" | "files" | "messageId"> {
  const message = body?.message || {};
  const attachments: any[] = Array.isArray(body?.attachments) ? body.attachments : [];
  const typed = String(message.text || "");
  const placeholder = /^file shared$/i.test(typed.trim());

  const sharedFile = placeholder || attachments.length > 0 || /^files?$/i.test(String(message.type || ""));
  const caption = Object.values(message.meta?.comments || {})
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .trim();

  const files = sharedFileLinks(message, attachments);
  const named = attachments.map((attachment) => String(attachment?.name || "").trim()).filter(Boolean);

  return {
    text: placeholder ? caption : typed || (sharedFile ? caption : ""),
    sharedFile,
    fileNames: named.length ? named : files.map((file) => file.name),
    files,
    messageId: String(message.msgid || ""),
  };
}

/**
 * The links to the files in a website-chat message.
 *
 * SalesIQ sends them in `message.meta.urls`, keyed by an id, and the name only
 * inside the link (`file_name=`) or in the parallel `attachments` list. The
 * links open without signing in, so the chat view can show the files as they
 * are. Instagram and WhatsApp send the bare text "File Shared" and no link at
 * all, so those stay a named placeholder.
 */
export function sharedFileLinks(message: any, attachments: any[] = []): { url: string; name: string }[] {
  const urls = message?.meta?.urls;
  if (!urls || typeof urls !== "object") return [];

  return Object.values(urls)
    .filter((url): url is string => typeof url === "string" && /^https:\/\//i.test(url))
    .map((url, index) => {
      let name = "";
      try {
        name = new URL(url).searchParams.get("file_name") || "";
      } catch {
        // An unreadable link keeps the name from the attachments list, if any.
      }
      return { url, name: name || String(attachments[index]?.name || "").trim() || "file" };
    });
}

/**
 * Records the request and answers it.
 *
 * Never throws. A visitor is waiting on the other end of this call, and an
 * unhandled error would leave them looking at a bot that connected and then
 * said nothing at all — so a failure to store the capture is logged and the
 * reply still goes out.
 */
export function createSalesIqWebhook(leadsDb: Connection) {
  const Capture = salesIqCaptureModel(leadsDb);

  return async function handleSalesIqWebhook(req: Request, res: Response): Promise<void> {
    const startedAt = Date.now();

    const verification = verifySalesIqSignature(req);
    const tokenPresented = hasValidToken(req);

    // A genuine call proves itself by its signature. The other two ways in
    // exist for this phase only: a hand-run test with the shared secret, and
    // capture mode, which accepts an unverified call so the signature header
    // can be identified at all. Capture mode costs nothing — no model runs and
    // the reply is a fixed string — but it must be off before phase two.
    const allowed = verification.verified || tokenPresented || config.salesiq.captureUnverified;

    if (!allowed) {
      console.warn(`[salesiq] rejected: ${verification.detail}`);
      res.status(401).json({ error: "Unauthorised" });
      return;
    }

    const handler = readHandler(req.body);

    // What to say. The bot answers only when it is switched on and the payload
    // is one it understands; anything else falls back to the holding line, so an
    // unrecognised handler leaves a visitor with a courtesy rather than silence.
    let replyTexts = [config.salesiq.captureReply];
    let reply: Record<string, unknown> | null = null;
    /** Set when the CRM write should run after the visitor has been answered. */
    let crmHandoff: { conversationId: string; settings: any } | null = null;
    /** Set when the visitor shared files, which are copied before SalesIQ's links expire. */
    let storeFilesFor: string | null = null;
    /** Set when this chat's rep still has to be told it is live. */
    let repAlert: { conversationId: string; settings: any } | null = null;
    /** And the same for the team's WhatsApp group, decided separately. */
    let groupAlert: { conversationId: string; settings: any } | null = null;
    /** SalesIQ's conversation number for this chat, kept after the reply — see below. */
    let conversationNumber: { conversationId: string; number: string } | null = null;

    try {
      const settings = await getSettings(leadsDb);
      const incoming = readIncoming(req.body);
      if (incoming.conversationId && /^\d+$/.test(incoming.salesIqConversationId || "")) {
        conversationNumber = { conversationId: incoming.conversationId, number: incoming.salesIqConversationId! };
      }
      if (incoming.files?.length && incoming.conversationId) storeFilesFor = incoming.conversationId;

      const CLOSE_HANDLERS = new Set([
        "closed",
        "chat_closed",
        "end",
        "chat_end",
        "visitor_left",
        "missed",
        "operator_closed",
        "visitor_closed",
        "session_end",
        "session_closed",
        "complete",
        "completed",
      ]);

      // SalesIQ calls this when an action of ours could not be carried out —
      // most often `operators_not_available`, meaning nobody was free to take a
      // forwarded chat. It is NOT a conversation turn, and feeding it to the
      // engine is what caused a runaway: the forward failed, the failure came
      // back here, the engine completed the chat again and forwarded again.
      if (handler === "failure") {
        const cause = req.body?.cause || {};
        console.error(`[chat] SalesIQ could not complete our action: ${cause.code} ${cause.desc}`);
        reply = buildReply([settings.chat.failureMessage]);
      } else if (CLOSE_HANDLERS.has(handler.toLowerCase()) && incoming.conversationId) {
        // Visitor left or chat ended: if we have an email or phone, create the lead immediately
        const ChatConversation = chatConversationModel(leadsDb);
        // Its own id first. A returning visitor also has earlier chats under the
        // same uvid or visitor id, set aside with "~" in their id, and those are
        // not the one closing.
        const conversation =
          (await ChatConversation.findOne({ conversationId: incoming.conversationId })) ||
          (incoming.uvid || incoming.visitorId
            ? await ChatConversation.findOne({
                conversationId: { $not: /~/ },
                $or: [
                  ...(incoming.uvid ? [{ uvid: incoming.uvid }] : []),
                  ...(incoming.visitorId ? [{ visitorId: incoming.visitorId }] : []),
                ],
              }).sort({ updatedAt: -1 })
            : null);

        if (conversation) {
          if (incoming.name && !conversation.name) conversation.name = incoming.name;
          if (incoming.email && !conversation.email) conversation.email = incoming.email;
          if (incoming.phone && !conversation.phone) conversation.phone = incoming.phone;

          const hasContact = Boolean(
            conversation.email?.trim() || conversation.phone?.trim() || isComplete(conversation.collected || {})
          );

          if (hasContact && !conversation.zohoLeadId && conversation.status !== "stopped") {
            conversation.status = "stopped";
            conversation.handedOffAt = new Date();
            conversation.handoffReason = conversation.handoffReason || "visitor_asked";
            await conversation.save();

            if (settings.chat.writeLeadOnHandoff) {
              crmHandoff = { conversationId: conversation.conversationId, settings };
              console.log(
                `[chat] visitor left/chat closed; created CRM lead for ${conversation.conversationId} (${conversation.email || conversation.phone || "collected enquiry"})`
              );
            }
          }
        }
        reply = buildReply([]);
      } else if (settings.chat.enabled && incoming.conversationId) {
        const turn = await runChatTurn(leadsDb, incoming, settings, handler === "trigger", startedAt);

        // Decided here, sent below: the rep's alert is worth a few hundred
        // milliseconds of somebody else's ERP, and the visitor is not the one
        // who should pay them.
        if (shouldNotifyRep(turn.conversation, settings)) {
          repAlert = { conversationId: incoming.conversationId, settings };
        }

        if (shouldWhatsApp(turn.conversation, settings)) {
          groupAlert = { conversationId: incoming.conversationId, settings };
        }

        // Dry run composes and stores the reply but must not say it out loud,
        // and must not forward a real visitor to a real person either.
        if (settings.chat.dryRun) {
          console.log(
            `[chat] DRY RUN would have said: ${turn.reply}` +
              (turn.handoff ? `  and forwarded to ${settings.chat.handoffOperatorEmail} (${turn.handoff})` : "")
          );
        } else if (turn.handoff) {
          // A completed chat is not forwarded. The visitor has been talking to a
          // named rep the whole way through, so being pushed to somebody else at
          // the end reads as a hand-off they did not ask for — and forwarding to
          // a rep who happens to be offline fails outright. The lead lands in
          // that rep's CRM queue instead, which is where they will look.
          //
          // Neither is somebody who is not a customer. They have been answered
          // and the chat is over: putting a job seeker in front of a rep live is
          // the same waste as putting them in the CRM.
          if (turn.handoff === "complete" || turn.handoff === "not_a_customer" || turn.handoff === "declined") {
            reply = buildReply([...(turn.before || []), turn.reply]);
          } else {
            // By day the chat is offered to the whole live pool and the first
            // agent to accept it owns it. Every other hand-off still goes to
            // one person: the rep the visitor has been speaking to by name.
            const pool = (settings.chat.liveAgentEmails || []).map((e) => String(e || "").trim()).filter(Boolean);
            const operators =
              turn.handoff === "live_agent" && pool.length
                ? pool
                : [turn.conversation.repEmail || settings.chat.handoffOperatorEmail];

            reply = buildForward([turn.reply], operators);
            console.log(`[chat] forwarding ${incoming.conversationId} to ${operators.join(", ")} (${turn.handoff})`);

            // Noted in the transcript so the chat viewer does not simply go
            // quiet at the hand-off with no sign that anyone was called.
            await noteHandedToAPerson(turn.conversation as any, operators.join(", ")).catch((error: any) =>
              console.error("[chat] could not note the hand-over:", error.message)
            );
          }

          // No CRM write for somebody who is not buying anything. Two of these
          // became leads reading "Quantity: Im looking job" purely because they
          // had left an email address.
          if (settings.chat.writeLeadOnHandoff && turn.handoff !== "not_a_customer") {
            crmHandoff = { conversationId: incoming.conversationId, settings };
          }
        } else if (turn.silent) {
          // Nothing to say — the second and later photos of a burst. Said with
          // an empty reply rather than by falling through to the holding line,
          // which would answer every attachment with "one of our team will be
          // with you shortly".
          reply = buildReply([]);
        } else if (turn.reply) {
          replyTexts = [...(turn.before || []), turn.reply];
        }
      } else if (settings.chat.enabled && !settings.chat.dryRun && handler === "trigger") {
        replyTexts = [GREETING_WITHOUT_AN_ID];
      }
    } catch (error: any) {
      // The visitor is waiting. A broken turn costs them the bot's help, not a
      // silent chat window.
      console.error("[chat] turn failed, falling back to the holding reply:", error.message);
    }

    if (!reply) reply = buildReply(replyTexts);
    res.json(reply);

    // SalesIQ's conversation number, kept on the chat so the take-over sync can ask SalesIQ about
    // a website chat, which is filed under the visitor's uvid (see operatorSync.ts). After the
    // reply, and only written when it is new.
    if (conversationNumber) {
      const { conversationId, number } = conversationNumber;
      chatConversationModel(leadsDb)
        .updateOne({ conversationId, salesIqConversationId: { $ne: number } }, { $set: { salesIqConversationId: number } })
        .catch((error: any) => console.error("[chat] could not keep the SalesIQ conversation number:", error.message));
    }
    const tookMs = Date.now() - startedAt;

    // After the answer, never inside it: writing a lead means several Zoho
    // round trips, and a visitor must not sit watching a typing indicator while
    // the CRM is updated.
    if (repAlert) {
      afterResponse(
        notifyRepOfChat(leadsDb, repAlert.conversationId, repAlert.settings)
          .then((outcome) => {
            if (outcome.sent) {
              console.log(`[chat] rep alerted in the ERP for ${repAlert!.conversationId} (${outcome.status})`);
            } else if (outcome.skipped) {
              console.log(`[chat] no rep alert for ${repAlert!.conversationId}: ${outcome.skipped}`);
            }
          })
          .catch((error) => console.error("[chat] rep alert threw:", error.message))
      );
    }

    if (groupAlert) {
      afterResponse(
        whatsAppRepAlert(leadsDb, groupAlert.conversationId, groupAlert.settings)
          .then((outcome) => {
            if (outcome.sent) {
              // Which of the two landed, not a status code: this call is two
              // messages now, and "sent" without saying to whom cannot answer the
              // only question worth asking — did the rep's phone get it?
              const went = (outcome.delivered || []).join(" + ") || "nobody";
              const missed = outcome.error ? `, failed: ${outcome.error}` : "";
              console.log(`[chat] WhatsApp for ${groupAlert!.conversationId} → ${went}${missed}`);
            } else if (outcome.skipped) {
              console.log(`[chat] no WhatsApp for ${groupAlert!.conversationId}: ${outcome.skipped}`);
            }
          })
          .catch((error) => console.error("[chat] WhatsApp alert threw:", error.message))
      );
    }

    if (storeFilesFor) {
      afterResponse(
        storeChatAttachments(leadsDb, storeFilesFor)
          .then((outcome) => {
            if (outcome.stored || outcome.failed) {
              console.log(`[chat] files for ${storeFilesFor}: kept ${outcome.stored}, not kept ${outcome.failed}`);
            } else if (outcome.skipped) {
              console.log(`[chat] files for ${storeFilesFor} not copied: ${outcome.skipped}`);
            }
          })
          .catch((error) => console.error("[chat] copying files threw:", error.message))
      );
    }

    if (crmHandoff) {
      afterResponse(
        handOffToCrm(leadsDb, crmHandoff.conversationId, crmHandoff.settings)
          .then((outcome) => {
            console.log(
              outcome.leadOk
                ? `[chat] ${outcome.zohoLeadId ? `lead ${outcome.zohoLeadId}` : "no lead"} ` +
                  `(${outcome.action}) for ${crmHandoff!.conversationId}`
                : `[chat] lead write failed for ${crmHandoff!.conversationId}: ${outcome.error}`
            );
          })
          .catch((error) => console.error("[chat] lead write threw:", error.message))
      );
    }

    const how = verification.verified
      ? `signed via ${verification.signatureHeader}`
      : tokenPresented
        ? "shared token"
        : `UNVERIFIED (${verification.detail})`;

    console.log(
      `[salesiq] ${req.method} handler=${handler || "(none)"} ${tookMs}ms ${how} ` +
        `keys=${Object.keys(req.body || {}).join(",") || "(empty body)"}`
    );

    try {
      await Capture.create({
        receivedAt: new Date(startedAt),
        method: req.method,
        path: req.originalUrl.split("?")[0],
        headers: safeHeaders(req.headers as Record<string, unknown>),
        query: { ...req.query, token: req.query.token ? "[redacted]" : undefined },
        body: req.body,
        handler,
        reply,
        tookMs,
        verified: verification.verified,
        signatureHeader: verification.signatureHeader,
        verificationDetail: verification.detail,
        rawBody: ((req as any).rawBody as Buffer | undefined)?.toString("utf8") || "",
      });
    } catch (error: any) {
      console.error("[salesiq] captured request could not be stored:", error.message);
    }
  };
}

/**
 * Answers the check SalesIQ makes when a webhook URL is saved.
 *
 * Whether it verifies with a GET at all is unconfirmed, so this exists to keep
 * a verification attempt from being served the dashboard HTML by the catch-all
 * and being recorded as a failure for reasons that have nothing to do with us.
 */
export function handleSalesIqProbe(_req: Request, res: Response): void {
  res.json({ ok: true, service: "lead-follow-up", endpoint: "salesiq-webhook" });
}

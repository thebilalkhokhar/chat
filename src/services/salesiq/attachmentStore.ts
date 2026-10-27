import type { Connection } from "mongoose";
import { put } from "@vercel/blob";
import { config } from "../../config/env";
import { chatConversationModel, type ChatAttachment } from "../../models/ChatConversation";

/**
 * Keeping the files a visitor shares.
 *
 * SalesIQ links a shared photo with an address that opens without signing in —
 * until the chat is over. Of 120 links stored from past chats, every one
 * answered "The attachment has been expired", one of them two and a half hours
 * after it was sent. So each file is downloaded the moment it arrives and put in
 * Vercel Blob, and the transcript shows that copy.
 *
 * Runs after the visitor has been answered, never inside the reply: a 4 MB
 * photo can take seconds to move. A copy that did not happen (a restart, a
 * timeout) is retried by the worker while the link might still work.
 */

// SalesIQ serves files slowly: a 4 MB photo took 20 seconds in testing.
const DOWNLOAD_TIMEOUT_MS = 120_000;
/** Bigger than any photo seen in a chat; a cap so one odd upload cannot fill memory. */
const MAX_BYTES = 50 * 1024 * 1024;
/** How long after a file arrives the worker keeps trying to copy it. */
const RETRY_WINDOW_MS = 2 * 60 * 60_000;

// SalesIQ labels a JPEG as image/png, so the type comes from the name where it can.
const TYPES: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", jfif: "image/jpeg", avif: "image/avif", heif: "image/heif",
  tif: "image/tiff", tiff: "image/tiff", png: "image/png", gif: "image/gif", webp: "image/webp",
  heic: "image/heic", bmp: "image/bmp", svg: "image/svg+xml", pdf: "application/pdf",
  ai: "application/postscript", eps: "application/postscript", psd: "image/vnd.adobe.photoshop",
  zip: "application/zip", doc: "application/msword", xls: "application/vnd.ms-excel",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function isConfigured(): boolean {
  return Boolean(config.blob.token);
}

function contentTypeOf(name: string, fallback: string | null): string {
  const extension = name.toLowerCase().split(".").pop() || "";
  return TYPES[extension] || fallback || "application/octet-stream";
}

/** A name safe to use as part of a Blob path. */
const safeName = (name: string) => name.replace(/[^\w.\-]+/g, "_").slice(-120) || "file";

/** Copies one file to Blob: its address there, or why it could not be copied. */
async function copy(conversationId: string, file: ChatAttachment): Promise<{ storedUrl?: string; storeError?: string }> {
  const response = await fetch(file.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!response.ok) {
    // "The attachment has been expired" — final, so it is recorded rather than retried.
    const detail = (await response.text().catch(() => "")).slice(0, 160);
    return { storeError: `SalesIQ answered ${response.status}${detail ? `: ${detail}` : ""}` };
  }

  const size = Number(response.headers.get("content-length") || 0);
  if (size > MAX_BYTES) return { storeError: `file is ${Math.round(size / 1024 / 1024)} MB, over the limit` };
  const body = Buffer.from(await response.arrayBuffer());
  if (body.length > MAX_BYTES) return { storeError: `file is ${Math.round(body.length / 1024 / 1024)} MB, over the limit` };

  const blob = await put(`chat-attachments/${safeName(conversationId)}/${safeName(file.name)}`, body, {
    access: "public",
    // A random suffix keeps the address unguessable; the transcript links to it directly.
    addRandomSuffix: true,
    contentType: contentTypeOf(file.name, response.headers.get("content-type")),
    token: config.blob.token,
  });
  return { storedUrl: blob.url };
}

/**
 * Copies every file in one chat that has not been copied or given up on.
 * Writes each result to its own attachment, so a message arriving meanwhile is
 * never overwritten by a stale copy of the chat.
 */
export async function storeChatAttachments(
  leadsDb: Connection,
  conversationId: string
): Promise<{ stored: number; failed: number; skipped?: string }> {
  if (!isConfigured()) return { stored: 0, failed: 0, skipped: "BLOB_READ_WRITE_TOKEN is not set" };

  const Chat = chatConversationModel(leadsDb);
  const chat = await Chat.findOne({ conversationId }, { messages: 1 }).lean();
  if (!chat) return { stored: 0, failed: 0, skipped: "chat not found" };

  let stored = 0;
  let failed = 0;
  for (const [m, message] of chat.messages.entries()) {
    for (const [a, file] of (message.attachments || []).entries()) {
      if (file.storedUrl || file.storeError || !file.url) continue;

      let result: { storedUrl?: string; storeError?: string };
      try {
        result = await copy(conversationId, file);
      } catch (error: any) {
        // A timeout or Blob being unreachable is not final: leave it for the worker.
        console.warn(`[chat] could not copy ${file.name} for ${conversationId}: ${error.message}`);
        failed++;
        continue;
      }

      const path = `messages.${m}.attachments.${a}`;
      // Messages are only ever appended, so the index is stable; the URL guard makes sure of it.
      await Chat.updateOne(
        { _id: chat._id, [`${path}.url`]: file.url },
        { $set: result.storedUrl ? { [`${path}.storedUrl`]: result.storedUrl } : { [`${path}.storeError`]: result.storeError } }
      );
      if (result.storedUrl) stored++;
      else {
        failed++;
        console.warn(`[chat] ${file.name} for ${conversationId} not kept: ${result.storeError}`);
      }
    }
  }
  return { stored, failed };
}

/**
 * The worker's sweep: chats with files that arrived recently and were never
 * copied. After the retry window the link is assumed dead and left alone.
 */
export async function storePendingAttachments(leadsDb: Connection): Promise<{ stored: number; notes: string[] }> {
  if (!isConfigured()) return { stored: 0, notes: [] };

  const since = new Date(Date.now() - RETRY_WINDOW_MS);
  const chats = await chatConversationModel(leadsDb)
    .find({ updatedAt: { $gte: since }, "messages.attachments.url": { $exists: true } }, { conversationId: 1, messages: 1 })
    .lean();

  let stored = 0;
  const notes: string[] = [];
  for (const chat of chats) {
    const pending = chat.messages.some(
      (message) =>
        new Date(message.at).getTime() >= since.getTime() &&
        (message.attachments || []).some((file) => !file.storedUrl && !file.storeError)
    );
    if (!pending) continue;

    const result = await storeChatAttachments(leadsDb, chat.conversationId);
    stored += result.stored;
    if (result.stored || result.failed) notes.push(`chat ${chat.conversationId}: kept ${result.stored} file(s), ${result.failed} not kept`);
  }
  return { stored, notes };
}

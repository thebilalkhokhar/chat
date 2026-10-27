import type { IChatConversation, ChatMessage, ChatAttachment } from "../models/ChatConversation";
import { englishFor } from "../services/salesiq/transcriptEnglish";

function escapeHtml(text: string | null | undefined): string {
  if (!text) return "";
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function formatDateTime(date: Date | string | null | undefined): string {
  if (!date) return "";
  const d = new Date(date);
  if (isNaN(d.getTime())) return "";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
}

function statusBadgeHtml(status: string, handoffReason?: string): string {
  switch (status) {
    case "active":
      return `
        <span class="status-badge status-active">
          <span class="status-pulse"></span>
          Active Chat
        </span>`;
    case "ready_to_quote":
      return `
        <span class="status-badge status-ready">
          <svg class="status-icon" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clip-rule="evenodd"/></svg>
          Ready to Quote
        </span>`;
    case "handed_off":
      const reasonLabel = handoffReason ? ` (${handoffReason.replace(/_/g, " ")})` : "";
      return `
        <span class="status-badge status-handoff">
          <svg class="status-icon" viewBox="0 0 20 20" fill="currentColor"><path d="M9 6a3 3 0 11-6 0 3 3 0 016 0zM17 6a3 3 0 11-6 0 3 3 0 016 0zM12.93 17c.046-.327.07-.66.07-1a6.97 6.97 0 00-1.5-4.33A5 5 0 0119 16v1h-6.07zM6 11a5 5 0 015 5v1H1v-1a5 5 0 015-5z"/></svg>
          Handed Off${escapeHtml(reasonLabel)}
        </span>`;
    case "stopped":
      return `
        <span class="status-badge status-stopped">
          <svg class="status-icon" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8 7a1 1 0 00-1 1v4a1 1 0 001 1h4a1 1 0 001-1V8a1 1 0 00-1-1H8z" clip-rule="evenodd"/></svg>
          Ended
        </span>`;
    default:
      return `<span class="status-badge status-stopped">${escapeHtml(status)}</span>`;
  }
}

// Formats a browser can show inline. HEIC and TIFF open only in some, but still read better as a picture than a download.
const IMAGE_NAME = /\.(jpe?g|jfif|png|webp|avif|gif|svg|bmp|heic|heif|tiff?)$/i;
const SHARED_FILE_NOTE = /\[shared (?:a file|\d+ files)(?::\s*([^\]]+))?\]/gi;

/**
 * Files that came with a link: images shown as they are, anything else as a link
 * to download. The links are SalesIQ's own and open without signing in.
 */
function renderLinkedAttachments(attachments: ChatAttachment[], rawText: string): string {
  let html = `<div class="attachment-cards">`;
  for (const file of attachments) {
    // Our copy in Vercel Blob when there is one; SalesIQ's own link stops working after the chat.
    const url = escapeHtml(file.storedUrl || file.url);
    const name = escapeHtml(file.name || "file");
    const gone = !file.storedUrl && Boolean(file.storeError);
    if (IMAGE_NAME.test(file.name || "")) {
      html += `
        <a class="attachment-image${gone ? " expired" : ""}" href="${url}" target="_blank" rel="noopener noreferrer" title="${name}">
          <img src="${url}" alt="${name}" loading="lazy" onerror="this.parentNode.classList.add('expired')">
          <span class="attachment-expired">Image no longer available from SalesIQ<br><small>${name}</small></span>
        </a>`;
    } else {
      html += `
        <a class="attachment-card attachment-link" href="${url}" target="_blank" rel="noopener noreferrer" download="${name}">
          <div class="attachment-icon-box icon-box-doc">
            <svg class="attachment-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="12" x2="12" y2="18"/><polyline points="9 15 12 18 15 15"/></svg>
          </div>
          <div class="attachment-info">
            <span class="attachment-label">Download file</span>
            <span class="attachment-name">${name}</span>
          </div>
        </a>`;
    }
  }
  html += `</div>`;

  const caption = rawText.replace(SHARED_FILE_NOTE, "").trim();
  if (caption) html += `<div class="attachment-caption">${escapeHtml(caption).replace(/\n/g, "<br>")}</div>`;
  return html;
}

function renderMessageContent(rawText: string, linked?: ChatAttachment[]): string {
  if (linked?.length) return renderLinkedAttachments(linked, rawText || "");
  if (!rawText) return "";

  const sharedFileRegex = /\[shared (?:a file|\d+ files)(?::\s*([^\]]+))?\]/gi;
  if (!sharedFileRegex.test(rawText)) {
    return escapeHtml(rawText).replace(/\n/g, "<br>");
  }

  // Extract all attachments
  const attachments: Array<{ name: string; isImage: boolean }> = [];
  const partsRegex = /\[shared (?:a file|\d+ files)(?::\s*([^\]]+))?\]/gi;
  let match: RegExpExecArray | null;
  while ((match = partsRegex.exec(rawText)) !== null) {
    const fileListStr = match[1];
    if (fileListStr) {
      const files = fileListStr.split(",").map((s) => s.trim()).filter(Boolean);
      for (const f of files) {
        const isImage = /\.(jpe?g|png|webp|gif|svg|bmp)$/i.test(f);
        attachments.push({ name: f, isImage });
      }
    } else {
      attachments.push({ name: "Shared File", isImage: false });
    }
  }

  const remainingText = rawText.replace(partsRegex, "").trim();

  let html = "";
  if (attachments.length > 0) {
    html += `<div class="attachment-cards">`;
    for (const att of attachments) {
      const iconSvg = att.isImage
        ? `<svg class="attachment-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`
        : `<svg class="attachment-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`;

      html += `
        <div class="attachment-card">
          <div class="attachment-icon-box ${att.isImage ? "icon-box-image" : "icon-box-doc"}">
            ${iconSvg}
          </div>
          <div class="attachment-info">
            <span class="attachment-label">${att.isImage ? "Image Attachment" : "File Attachment"}</span>
            <span class="attachment-name" title="${escapeHtml(att.name)}">${escapeHtml(att.name)}</span>
          </div>
        </div>`;
    }
    html += `</div>`;
  }

  if (remainingText) {
    html += `<div class="attachment-caption">${escapeHtml(remainingText).replace(/\n/g, "<br>")}</div>`;
  }

  return html;
}

export function renderChatViewHtml(
  conversation: IChatConversation | null,
  conversationId: string
): string {
  if (!conversation) {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>Chat Not Found | Print247</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0f172a;
      --card: #1e293b;
      --text: #f8fafc;
      --text-muted: #94a3b8;
      --accent: #3b82f6;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
      background: var(--bg);
      color: var(--text);
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 1.5rem;
    }
    .not-found-card {
      background: var(--card);
      border: 1px solid rgba(255,255,255,0.1);
      border-radius: 1.25rem;
      padding: 2.5rem 2rem;
      max-width: 440px;
      width: 100%;
      text-align: center;
      box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5);
    }
    .icon {
      width: 64px;
      height: 64px;
      background: rgba(59, 130, 246, 0.1);
      color: var(--accent);
      border-radius: 50%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      margin-bottom: 1.25rem;
    }
    h1 { font-size: 1.35rem; font-weight: 700; margin-bottom: 0.5rem; }
    p { color: var(--text-muted); font-size: 0.95rem; line-height: 1.5; margin-bottom: 1.5rem; }
    .chat-id { font-family: monospace; background: rgba(0,0,0,0.3); padding: 0.25rem 0.5rem; border-radius: 0.375rem; color: #cbd5e1; }
  </style>
</head>
<body>
  <div class="not-found-card">
    <div class="icon">
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/></svg>
    </div>
    <h1>Conversation Not Found</h1>
    <p>No chat session exists for ID: <br><span class="chat-id">${escapeHtml(conversationId)}</span></p>
  </div>
</body>
</html>`;
  }

  const customerName = conversation.name?.trim() || "Website Visitor";
  const customerEmail = conversation.email?.trim();
  const customerPhone = conversation.phone?.trim();
  const repName = conversation.repName?.trim() || conversation.repEmail || "Sales Team";
  // Only ever set by SalesIQ's chat-event webhook — a rep who has actually
  // taken the chat, as distinct from the rep it was assigned to.
  const attender = conversation.attenderName?.trim() || conversation.attenderEmail?.trim() || "";
  const repEmail = conversation.repEmail?.trim();
  const startedAt = formatDateTime(conversation.createdAt);
  const collected = conversation.collected || {};
  const status = conversation.status || "active";
  const pageUrl = conversation.currentPageUrl || conversation.landingPageTitle || "";

  // Collect specs tags
  const specPills: Array<{ label: string; value: string }> = [];
  if (collected.product) specPills.push({ label: "Product", value: collected.product });
  const sizeVal = collected.sizes || (collected as any).size;
  if (sizeVal) specPills.push({ label: "Size", value: sizeVal });
  if (collected.quantity) specPills.push({ label: "Quantity", value: String(collected.quantity) });
  const finishVal = collected.finishes || (collected as any).finish;
  if (finishVal) specPills.push({ label: "Finish", value: finishVal });
  if (collected.skus) specPills.push({ label: "SKUs / Designs", value: String(collected.skus) });
  if (collected.material) specPills.push({ label: "Material", value: collected.material });
  if (collected.extras) specPills.push({ label: "Extras", value: collected.extras });

  const messagesHtml = conversation.messages
    .map((msg: ChatMessage) => {
      const timeLabel = formatDateTime(msg.at);

      /**
       * Something that happened, not something anybody said.
       *
       * The hand-off and a rep joining are the two moments the viewer used to
       * show nothing at all: the transcript simply stopped, and a reader could
       * not tell a chat somebody had taken from one nobody ever answered.
       */
      if (msg.author === "system") {
        const joined = /joined the chat/i.test(msg.text);
        return `
        <div class="event-row">
          <span class="event-pill ${joined ? "event-joined" : "event-handover"}">
            <svg class="event-icon" viewBox="0 0 20 20" fill="currentColor">${
              joined
                ? `<path d="M10 9a3 3 0 100-6 3 3 0 000 6zM6 8a2 2 0 11-4 0 2 2 0 014 0zM1.49 15.326a.78.78 0 01-.358-.442 3 3 0 014.308-3.516 6.484 6.484 0 00-1.905 3.959c-.023.222-.014.442.025.654a4.97 4.97 0 01-2.07-.655zM16.44 15.98a4.97 4.97 0 002.07-.654.78.78 0 00.357-.442 3 3 0 00-4.308-3.516 6.484 6.484 0 011.907 3.96 2.32 2.32 0 01-.026.652zM5.304 16.19a.844.844 0 01-.277-.71 5 5 0 019.947 0 .843.843 0 01-.277.71A6.975 6.975 0 0110 18a6.974 6.974 0 01-4.696-1.81z"/>`
                : `<path fill-rule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm1-11a1 1 0 10-2 0v3.586L7.707 9.293a1 1 0 00-1.414 1.414l3 3a1 1 0 001.414 0l3-3a1 1 0 00-1.414-1.414L11 10.586V7z" clip-rule="evenodd"/>`
            }</svg>
            ${escapeHtml(msg.text)}
            <span class="event-time">${escapeHtml(timeLabel)}</span>
          </span>
        </div>`;
      }

      const isVisitor = msg.author === "visitor";
      // A rep's own words, after they took the chat over, are not the bot's.
      const authorLabel = isVisitor ? customerName : msg.author === "rep" ? (conversation.attenderName || "Sales rep") : `${repName} (AI)`;
      // A line in another language shows as it was sent, with the English beneath it:
      // the bot's own English for a translated reply, a translation for anything else.
      const contentHtml = renderMessageContent(msg.shown || msg.text, msg.attachments);
      const english = englishFor(msg);
      const originalHtml = english
        ? `<div class="bubble-original"><span>English</span>${escapeHtml(english)}</div>`
        : "";
      const dryRunTag = msg.dryRun ? `<span class="dry-run-tag">Dry Run</span>` : "";

      return `
        <div class="message-row ${isVisitor ? "row-visitor" : "row-ai"}" data-msgid="${escapeHtml(msg.msgid || "")}">
          <div class="message-bubble ${isVisitor ? "bubble-visitor" : "bubble-ai"}">
            <div class="bubble-header">
              <span class="bubble-author">${escapeHtml(authorLabel)}</span>
              ${dryRunTag}
              <span class="bubble-time">${escapeHtml(timeLabel)}</span>
            </div>
            <div class="bubble-text">${contentHtml}</div>
            ${originalHtml}
          </div>
        </div>`;
    })
    .join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <title>Live Chat: ${escapeHtml(customerName)} | Print247</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-gradient: linear-gradient(180deg, #0b1120 0%, #0f172a 100%);
      --surface: #1e293b;
      --surface-elevated: #283548;
      --surface-border: rgba(255, 255, 255, 0.08);
      --surface-border-subtle: rgba(255, 255, 255, 0.04);
      --text-primary: #f8fafc;
      --text-secondary: #94a3b8;
      --text-muted: #64748b;
      --accent-blue: #3b82f6;
      --accent-blue-hover: #2563eb;
      --accent-indigo: #6366f1;
      --bubble-ai: linear-gradient(135deg, #1d4ed8 0%, #2563eb 100%);
      --bubble-ai-text: #ffffff;
      --bubble-visitor: #334155;
      --bubble-visitor-text: #f1f5f9;
      --success: #10b981;
      --warning: #f59e0b;
      --safe-bottom: env(safe-area-inset-bottom, 16px);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; -webkit-tap-highlight-color: transparent; }

    body {
      font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif;
      background: var(--bg-gradient);
      color: var(--text-primary);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      line-height: 1.45;
    }

    /* Container */
    .app-container {
      max-width: 820px;
      width: 100%;
      margin: 0 auto;
      display: flex;
      flex-direction: column;
      min-height: 100vh;
      box-shadow: 0 0 50px rgba(0,0,0,0.5);
      background: #0f172a;
    }

    /* Header Bar */
    .header-bar {
      position: sticky;
      top: 0;
      z-index: 40;
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      background: rgba(15, 23, 42, 0.88);
      border-bottom: 1px solid var(--surface-border);
      padding: 0.875rem 1.25rem;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 0.75rem;
    }

    .brand-section {
      display: flex;
      align-items: center;
      gap: 0.625rem;
    }

    .brand-logo {
      width: 34px;
      height: 34px;
      background: linear-gradient(135deg, #2563eb 0%, #7c3aed 100%);
      border-radius: 0.625rem;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #fff;
      font-weight: 800;
      font-size: 1rem;
      box-shadow: 0 4px 10px rgba(37, 99, 235, 0.35);
    }

    .brand-title {
      font-size: 0.95rem;
      font-weight: 700;
      color: #ffffff;
      letter-spacing: -0.01em;
    }

    .brand-subtitle {
      font-size: 0.75rem;
      color: var(--text-secondary);
    }

    /* Status Badges */
    .status-badge {
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
      padding: 0.3rem 0.65rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: 0.01em;
    }

    .status-active {
      background: rgba(16, 185, 129, 0.15);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.3);
    }

    .status-pulse {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #10b981;
      box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7);
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0.7); }
      70% { box-shadow: 0 0 0 7px rgba(16, 185, 129, 0); }
      100% { box-shadow: 0 0 0 0 rgba(16, 185, 129, 0); }
    }

    .status-ready {
      background: rgba(59, 130, 246, 0.15);
      color: #60a5fa;
      border: 1px solid rgba(59, 130, 246, 0.3);
    }

    .status-handoff {
      background: rgba(245, 158, 11, 0.15);
      color: #fbbf24;
      border: 1px solid rgba(245, 158, 11, 0.3);
    }

    .status-stopped {
      background: rgba(148, 163, 184, 0.15);
      color: #94a3b8;
      border: 1px solid rgba(148, 163, 184, 0.3);
    }

    .status-icon {
      width: 14px;
      height: 14px;
    }

    /* Customer Info & Specs Card */
    .overview-card {
      background: var(--surface);
      margin: 1rem 1.25rem 0.5rem;
      border-radius: 1rem;
      border: 1px solid var(--surface-border);
      padding: 1.125rem;
      box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.3);
    }

    .overview-top {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 1rem;
      flex-wrap: wrap;
      margin-bottom: 0.875rem;
    }

    .customer-info h2 {
      font-size: 1.15rem;
      font-weight: 700;
      color: #fff;
      display: flex;
      align-items: center;
      gap: 0.5rem;
    }

    .contact-links {
      display: flex;
      gap: 0.875rem;
      flex-wrap: wrap;
      margin-top: 0.35rem;
      font-size: 0.825rem;
    }

    .contact-link {
      color: var(--accent-blue);
      text-decoration: none;
      display: inline-flex;
      align-items: center;
      gap: 0.3rem;
      font-weight: 500;
    }

    .contact-link:hover {
      text-decoration: underline;
    }

    .rep-tag {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--surface-border);
      padding: 0.35rem 0.65rem;
      border-radius: 0.5rem;
      font-size: 0.775rem;
      color: var(--text-secondary);
      display: inline-flex;
      align-items: center;
      gap: 0.375rem;
    }

    .rep-tag strong {
      color: var(--text-primary);
    }

    .rep-tag-live {
      border-color: rgba(16, 185, 129, 0.35);
      background: rgba(16, 185, 129, 0.12);
      color: #6ee7b7;
      margin-left: 0.5rem;
    }

    .rep-tag-live strong {
      color: #a7f3d0;
    }

    /* Specs Grid */
    .specs-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(130px, 1fr));
      gap: 0.5rem;
      padding-top: 0.75rem;
      border-top: 1px solid var(--surface-border-subtle);
    }

    .spec-item {
      background: rgba(15, 23, 42, 0.5);
      border: 1px solid var(--surface-border);
      padding: 0.5rem 0.65rem;
      border-radius: 0.5rem;
    }

    .spec-label {
      font-size: 0.675rem;
      color: var(--text-muted);
      text-transform: uppercase;
      font-weight: 700;
      letter-spacing: 0.04em;
    }

    .spec-val {
      font-size: 0.825rem;
      font-weight: 600;
      color: #e2e8f0;
      margin-top: 0.15rem;
      word-break: break-word;
    }

    .page-source {
      margin-top: 0.625rem;
      font-size: 0.75rem;
      color: var(--text-muted);
      display: flex;
      align-items: center;
      gap: 0.35rem;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .page-source a {
      color: #94a3b8;
      text-decoration: none;
    }
    .page-source a:hover { text-decoration: underline; color: #cbd5e1; }

    /* Chat Messages Timeline */
    .chat-timeline {
      flex: 1;
      padding: 1.25rem;
      display: flex;
      flex-direction: column;
      gap: 1rem;
      overflow-y: auto;
    }

    .message-row {
      display: flex;
      flex-direction: column;
      width: 100%;
      animation: fadeIn 0.25s ease-out;
    }

    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(6px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .row-visitor {
      align-items: flex-start;
    }

    .row-ai {
      align-items: flex-end;
    }

    .message-bubble {
      max-width: 82%;
      padding: 0.75rem 1rem;
      border-radius: 1.125rem;
      font-size: 0.925rem;
      line-height: 1.45;
      box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.2);
      word-break: break-word;
    }

    .bubble-visitor {
      background: var(--bubble-visitor);
      color: var(--bubble-visitor-text);
      border-bottom-left-radius: 0.25rem;
      border: 1px solid rgba(255, 255, 255, 0.05);
    }

    .bubble-ai {
      background: var(--bubble-ai);
      color: var(--bubble-ai-text);
      border-bottom-right-radius: 0.25rem;
      box-shadow: 0 4px 14px rgba(37, 99, 235, 0.35);
    }

    .bubble-header {
      display: flex;
      align-items: center;
      gap: 0.5rem;
      margin-bottom: 0.25rem;
      font-size: 0.725rem;
      opacity: 0.85;
    }

    .bubble-author {
      font-weight: 700;
    }

    .bubble-time {
      font-size: 0.675rem;
      opacity: 0.75;
    }

    /* Something that happened: the hand-off, and a rep arriving. */
    .event-row {
      display: flex;
      justify-content: center;
      width: 100%;
      animation: fadeIn 0.25s ease-out;
    }

    .event-pill {
      display: inline-flex;
      align-items: center;
      gap: 0.4rem;
      max-width: 100%;
      padding: 0.3rem 0.7rem;
      border-radius: 999px;
      border: 1px solid var(--surface-border);
      background: rgba(255, 255, 255, 0.04);
      color: var(--text-secondary);
      font-size: 0.72rem;
      font-weight: 600;
      text-align: center;
    }

    .event-joined {
      border-color: rgba(16, 185, 129, 0.35);
      background: rgba(16, 185, 129, 0.12);
      color: #6ee7b7;
    }

    .event-handover {
      border-color: rgba(245, 158, 11, 0.3);
      background: rgba(245, 158, 11, 0.1);
      color: #fcd34d;
    }

    .event-icon {
      width: 13px;
      height: 13px;
      flex-shrink: 0;
    }

    .event-time {
      opacity: 0.7;
      font-weight: 500;
    }

    .dry-run-tag {
      background: rgba(0, 0, 0, 0.25);
      padding: 0.1rem 0.35rem;
      border-radius: 0.25rem;
      font-size: 0.65rem;
      text-transform: uppercase;
      letter-spacing: 0.03em;
    }

    .bubble-text {
      white-space: pre-wrap;
    }

    .bubble-original {
      margin-top: 8px;
      padding-top: 8px;
      border-top: 1px dashed currentColor;
      opacity: .7;
      font-size: .85em;
      white-space: pre-wrap;
    }
    .bubble-original span {
      display: block;
      font-size: .75em;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: .04em;
      margin-bottom: 2px;
    }

    /* Attachment Cards */
    .attachment-cards {
      display: flex;
      flex-direction: column;
      gap: 0.4rem;
      margin-bottom: 0.25rem;
    }

    .attachment-card {
      display: inline-flex;
      align-items: center;
      gap: 0.65rem;
      background: rgba(15, 23, 42, 0.55);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 0.625rem;
      padding: 0.45rem 0.75rem;
      max-width: 100%;
      text-align: left;
    }

    .attachment-icon-box {
      width: 32px;
      height: 32px;
      border-radius: 0.4rem;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }

    .icon-box-image {
      background: rgba(59, 130, 246, 0.25);
      color: #60a5fa;
    }

    .icon-box-doc {
      background: rgba(168, 85, 247, 0.25);
      color: #c084fc;
    }

    .attachment-icon {
      width: 18px;
      height: 18px;
    }

    .attachment-info {
      display: flex;
      flex-direction: column;
      min-width: 0;
      overflow: hidden;
    }

    .attachment-label {
      font-size: 0.65rem;
      text-transform: uppercase;
      font-weight: 700;
      letter-spacing: 0.04em;
      opacity: 0.75;
      line-height: 1.1;
    }

    .attachment-name {
      font-size: 0.825rem;
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 260px;
      line-height: 1.3;
    }

    .attachment-image {
      display: block;
      max-width: min(280px, 100%);
      border-radius: 0.625rem;
      overflow: hidden;
      border: 1px solid rgba(255, 255, 255, 0.12);
      background: rgba(15, 23, 42, 0.35);
    }

    .attachment-image img {
      display: block;
      width: 100%;
      height: auto;
      max-height: 320px;
      object-fit: cover;
    }

    /* SalesIQ links stop working once the chat is over; say so instead of showing a broken image. */
    .attachment-image .attachment-expired { display: none; }
    /* The bubble keeps the visitor's line breaks; the markup inside a card must not. */
    .attachment-cards { white-space: normal; }
    .attachment-image { color: inherit; text-decoration: none; }
    .attachment-image.expired { pointer-events: none; padding: 0.6rem 0.8rem; height: auto; }
    .attachment-image.expired img { display: none; }
    .attachment-image.expired .attachment-expired { display: block; font-size: 0.8rem; opacity: 0.8; }
    .attachment-image.expired .attachment-expired small { opacity: 0.75; }

    .attachment-link {
      color: inherit;
      text-decoration: none;
    }

    .attachment-link:hover {
      border-color: rgba(255, 255, 255, 0.3);
    }

    .attachment-caption {
      margin-top: 0.35rem;
      font-size: 0.925rem;
      line-height: 1.45;
    }

    /* Actions Bottom Bar */
    .actions-bar {
      position: sticky;
      bottom: 0;
      background: rgba(15, 23, 42, 0.92);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border-top: 1px solid var(--surface-border);
      padding: 0.75rem 1.25rem calc(0.75rem + var(--safe-bottom));
      display: flex;
      gap: 0.75rem;
      align-items: center;
      justify-content: space-between;
    }

    .action-btn {
      flex: 1;
      padding: 0.65rem 0.875rem;
      border-radius: 0.625rem;
      font-size: 0.825rem;
      font-weight: 600;
      font-family: inherit;
      border: 1px solid var(--surface-border);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 0.4rem;
      transition: all 0.15s ease;
      text-decoration: none;
      color: #fff;
    }

    .btn-secondary {
      background: var(--surface);
    }
    .btn-secondary:hover {
      background: var(--surface-elevated);
      border-color: rgba(255,255,255,0.15);
    }

    .btn-primary {
      background: var(--accent-blue);
      border-color: var(--accent-blue);
    }
    .btn-primary:hover {
      background: var(--accent-blue-hover);
    }

    /* Toast */
    .toast {
      position: fixed;
      bottom: 80px;
      left: 50%;
      transform: translateX(-50%) translateY(20px);
      background: #10b981;
      color: #ffffff;
      padding: 0.5rem 1rem;
      border-radius: 9999px;
      font-size: 0.825rem;
      font-weight: 600;
      box-shadow: 0 10px 15px -3px rgba(0,0,0,0.4);
      opacity: 0;
      pointer-events: none;
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      z-index: 100;
    }
    .toast.show {
      transform: translateX(-50%) translateY(0);
      opacity: 1;
    }

    @media (max-width: 640px) {
      .overview-card {
        margin: 0.75rem 0.875rem 0.25rem;
        padding: 0.875rem;
      }
      .chat-timeline {
        padding: 0.875rem;
        gap: 0.75rem;
      }
      .message-bubble {
        max-width: 90%;
        font-size: 0.875rem;
      }
    }
  </style>
</head>
<body>
  <div class="app-container">
    <!-- Top Bar -->
    <header class="header-bar">
      <div class="brand-section">
        <div class="brand-logo">P</div>
        <div>
          <div class="brand-title">Print247 Live Chat</div>
          <div class="brand-subtitle">ID: ${escapeHtml(conversation.conversationId)}</div>
        </div>
      </div>
      <div>
        ${statusBadgeHtml(status, conversation.handoffReason)}
      </div>
    </header>

    <!-- Overview Card -->
    <section class="overview-card">
      <div class="overview-top">
        <div class="customer-info">
          <h2>
            <svg width="18" height="18" viewBox="0 0 20 20" fill="currentColor" style="color: var(--accent-blue);"><path fill-rule="evenodd" d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z" clip-rule="evenodd"/></svg>
            ${escapeHtml(customerName)}
          </h2>
          <div class="contact-links">
            ${
              customerEmail
                ? `<a href="mailto:${escapeHtml(customerEmail)}" class="contact-link">
                    <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor"><path d="M2.003 5.884L10 9.882l7.997-3.998A2 2 0 0016 4H4a2 2 0 00-1.997 1.884z"/><path d="M18 8.118l-8 4-8-4V14a2 2 0 002 2h12a2 2 0 002-2V8.118z"/></svg>
                    ${escapeHtml(customerEmail)}
                  </a>`
                : `<span style="color: var(--text-muted);">No email provided</span>`
            }
            ${
              customerPhone
                ? `<a href="tel:${escapeHtml(customerPhone)}" class="contact-link">
                    <svg width="14" height="14" viewBox="0 0 20 20" fill="currentColor"><path d="M2 3a1 1 0 011-1h2.153a1 1 0 01.986.836l.74 4.435a1 1 0 01-.54 1.06l-1.548.773a11.037 11.037 0 006.105 6.105l.774-1.548a1 1 0 011.059-.54l4.435.74a1 1 0 01.836.986V17a1 1 0 01-1 1h-2C7.82 18 2 12.18 2 5V3z"/></svg>
                    ${escapeHtml(customerPhone)}
                  </a>`
                : ""
            }
          </div>
        </div>

        <div class="rep-tag">
          <span>Assigned Rep:</span>
          <strong>${escapeHtml(repName)}</strong>
        </div>
        ${
          attender
            ? `<div class="rep-tag rep-tag-live">
          <span>In the chat:</span>
          <strong>${escapeHtml(attender)}</strong>
        </div>`
            : ""
        }
      </div>

      ${
        specPills.length > 0
          ? `<div class="specs-grid">
              ${specPills
                .map(
                  (s) => `
                <div class="spec-item">
                  <div class="spec-label">${escapeHtml(s.label)}</div>
                  <div class="spec-val">${escapeHtml(s.value)}</div>
                </div>`
                )
                .join("")}
            </div>`
          : ""
      }

      ${
        pageUrl
          ? `<div class="page-source">
              <span>Origin:</span>
              <a href="${escapeHtml(pageUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(pageUrl)}</a>
            </div>`
          : ""
      }
    </section>

    <!-- Chat Stream -->
    <main class="chat-timeline" id="chatTimeline">
      ${
        conversation.messages.length === 0
          ? `<div style="text-align: center; color: var(--text-muted); margin: auto;">No messages in this chat yet.</div>`
          : messagesHtml
      }
    </main>

    <!-- Bottom Actions -->
    <footer class="actions-bar">
      <button class="action-btn btn-secondary" id="copyBtn" onclick="copyTranscript()">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
        Copy Chat
      </button>

      ${
        customerPhone
          ? `<a href="tel:${escapeHtml(customerPhone)}" class="action-btn btn-primary">
              <svg width="15" height="15" viewBox="0 0 20 20" fill="currentColor"><path d="M2 3a1 1 0 011-1h2.153a1 1 0 01.986.836l.74 4.435a1 1 0 01-.54 1.06l-1.548.773a11.037 11.037 0 006.105 6.105l.774-1.548a1 1 0 011.059-.54l4.435.74a1 1 0 01.836.986V17a1 1 0 01-1 1h-2C7.82 18 2 12.18 2 5V3z"/></svg>
              Call
            </a>`
          : customerEmail
          ? `<a href="mailto:${escapeHtml(customerEmail)}" class="action-btn btn-primary">
              <svg width="15" height="15" viewBox="0 0 20 20" fill="currentColor"><path d="M2.003 5.884L10 9.882l7.997-3.998A2 2 0 0016 4H4a2 2 0 00-1.997 1.884z"/><path d="M18 8.118l-8 4-8-4V14a2 2 0 002 2h12a2 2 0 002-2V8.118z"/></svg>
              Email
            </a>`
          : ""
      }
    </footer>
  </div>

  <div class="toast" id="toast">Transcript copied to clipboard!</div>

  <script>
    // Auto-scroll to bottom of conversation
    function scrollToBottom() {
      const el = document.getElementById('chatTimeline');
      if (el) el.scrollTop = el.scrollHeight;
    }
    window.addEventListener('load', scrollToBottom);

    // Copy readable transcript
    function copyTranscript() {
      // Events as well as messages, in the order they happened: a copied
      // transcript should show where the chat was handed over too.
      const messages = Array.from(document.querySelectorAll('.message-row, .event-row')).map(row => {
        if (row.classList.contains('event-row')) {
          const pill = row.querySelector('.event-pill');
          const when = pill?.querySelector('.event-time')?.textContent?.trim() || '';
          const what = (pill?.textContent || '').replace(when, '').trim();
          return '[' + when + '] -- ' + what + ' --';
        }
        const author = row.querySelector('.bubble-author')?.textContent?.trim() || '';
        const time = row.querySelector('.bubble-time')?.textContent?.trim() || '';
        const text = row.querySelector('.bubble-text')?.textContent?.trim() || '';
        return '[' + time + '] ' + author + ':\\n' + text;
      });

      const customer = ${JSON.stringify(customerName)};
      const email = ${JSON.stringify(customerEmail || "N/A")};
      const phone = ${JSON.stringify(customerPhone || "N/A")};
      const rep = ${JSON.stringify(repName)};

      const header = 'Print247 Chat Transcript\\n' +
        'Customer: ' + customer + ' (Email: ' + email + ', Phone: ' + phone + ')\\n' +
        'Assigned Rep: ' + rep + '\\n' +
        '----------------------------------------\\n\\n';

      const fullText = header + messages.join('\\n\\n');

      navigator.clipboard.writeText(fullText).then(() => {
        showToast('Transcript copied to clipboard!');
      }).catch(() => {
        showToast('Could not copy transcript');
      });
    }

    function showToast(msg) {
      const t = document.getElementById('toast');
      t.textContent = msg;
      t.classList.add('show');
      setTimeout(() => t.classList.remove('show'), 2200);
    }

    // Auto-poll if active
    const conversationId = ${JSON.stringify(conversation.conversationId)};
    const isChatActive = ${JSON.stringify(status === "active")};

    if (isChatActive) {
      let lastCount = ${conversation.messages.length};
      setInterval(async () => {
        try {
          const res = await fetch('/api/public/chats/' + encodeURIComponent(conversationId));
          if (!res.ok) return;
          const data = await res.json();
          if (data && data.conversation && data.conversation.messages) {
            if (data.conversation.messages.length > lastCount) {
              // Reload page or dynamically update messages
              location.reload();
            }
          }
        } catch (e) {}
      }, 4000);
    }
  </script>
</body>
</html>`;
}

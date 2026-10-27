import { isOfficeHours, isOfflineHours, nextOfflineWindowStart, pakistanStamp } from "./officeHours";
import type { ISettings } from "../models/Settings";

/**
 * Deciding whether an email may leave right now.
 *
 * Separate from whether a lead is *eligible*: a lead can be perfectly eligible
 * and still have to wait, because a colleague is on shift and should get the
 * chance to answer first. Eligibility is about who; this is about when.
 *
 * Kept apart from the worker so the rule can be tested on its own and shown in
 * the dashboard without running anything.
 */

export interface SendDecision {
  /** May this be sent at this moment? */
  allowed: boolean;
  /** Why not, phrased for a human reading a log or a conversation record. */
  reason?: string;
  /** When to try again. Absent when it may go now. */
  retryAt?: Date;
}

export interface SendContext {
  /** The customer's address — decides whether the clock applies at all. */
  toEmail: string;
  settings: ISettings;
  at?: Date;
}

function isTestAddress(email: string, settings: ISettings): boolean {
  const address = String(email || "").toLowerCase().trim();
  if (!address) return false;

  const domain = address.split("@")[1] || "";
  // Never an exemption for a colleague, however explicitly they are listed.
  if (settings.eligibility.excludedDomains.includes(domain)) return false;

  return settings.eligibility.onlyLeadEmails.includes(address);
}

export function canSendNow(context: SendContext): SendDecision {
  const { toEmail, settings } = context;
  const at = context.at ?? new Date();

  if (!settings.enabled) {
    return { allowed: false, reason: "the service is paused" };
  }

  // Repeated from the eligibility rules on purpose. A colleague's address
  // should be refused by every gate it reaches, not only the first one — and
  // asked in isolation, this function was answering "yes, send" for a staff
  // address, which reads as permission whether or not anything upstream would
  // have stopped it.
  const domain = String(toEmail || "").toLowerCase().trim().split("@")[1] || "";
  if (settings.eligibility.excludedDomains.includes(domain)) {
    return { allowed: false, reason: `internal domain (${domain}) is never written to` };
  }

  // A named test address ignores the clock entirely. Office hours exist to keep
  // an automation away from customers a colleague is already handling; nobody
  // is handling a test mailbox, and the restriction would otherwise mean the
  // system can only be exercised between 5am and 7pm on weekdays.
  if (isTestAddress(toEmail, settings)) {
    return { allowed: true };
  }

  if (settings.sending.onlySendDuringOfflineHours && isOfficeHours(at, settings.officeHours)) {
    const retryAt = nextOfflineWindowStart(at, settings.officeHours);
    return {
      allowed: false,
      reason: `the office is staffed (${pakistanStamp(at)} PKT) — holding until ${pakistanStamp(retryAt)}`,
      retryAt,
    };
  }

  return { allowed: true };
}

/** Convenience for logs and the dashboard. */
export function describeSendWindow(settings: ISettings, at: Date = new Date()): string {
  if (!settings.sending.onlySendDuringOfflineHours) return "sending at any hour";
  return isOfflineHours(at, settings.officeHours)
    ? `sending allowed (nobody in, ${pakistanStamp(at)} PKT)`
    : `holding (office staffed, ${pakistanStamp(at)} PKT)`;
}

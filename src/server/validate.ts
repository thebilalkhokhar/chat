/**
 * Turning a browser's JSON into a safe database update.
 *
 * Only fields named here are accepted, and each is coerced into the shape the
 * settings document expects. Passing the request body to `$set` directly would
 * let anyone signed in write arbitrary keys — including ones that quietly
 * change how the worker behaves — so nothing unrecognised survives this.
 */

const hour = (value: unknown, fallback: number): number => {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : fallback;
};

const bounded = (value: unknown, fallback: number, max: number): number => {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= max ? Math.round(n) : fallback;
};

const list = (value: unknown): string[] =>
  (Array.isArray(value) ? value : String(value ?? "").split(","))
    .map((item) => String(item).trim().toLowerCase())
    .filter(Boolean);

export function sanitiseSettingsPatch(body: Record<string, any>): Record<string, unknown> {
  const patch: Record<string, unknown> = {};

  if (body.officeHours) {
    const o = body.officeHours;
    patch["officeHours.startHour"] = hour(o.startHour, 19);
    patch["officeHours.endHour"] = hour(o.endHour, 5);
    patch["officeHours.shiftStartDays"] = (Array.isArray(o.shiftStartDays) ? o.shiftStartDays : [])
      .map((d: unknown) => Number(d))
      .filter((d: number) => Number.isInteger(d) && d >= 0 && d <= 6);
  }

  if (body.eligibility) {
    const e = body.eligibility;

    if (e.excludedDomains !== undefined) {
      // The one rule protecting colleagues from being emailed by this system.
      // It is never allowed to become empty, however the form is submitted.
      const domains = list(e.excludedDomains).map((d) => d.replace(/^@/, ""));
      if (domains.length === 0) {
        throw new Error("At least one excluded domain is required, or colleagues will be emailed.");
      }
      patch["eligibility.excludedDomains"] = domains;
    }

    if (e.excludedSources !== undefined) {
      // Unlike the domain rule this may be emptied deliberately — it is a
      // judgement about which sources count as enquiries, not a protection for
      // colleagues — so it is stored as given.
      patch["eligibility.excludedSources"] = list(e.excludedSources);
    }

    if (e.excludedTags !== undefined) {
      // Same judgement, on the field that can actually answer it: a show lead
      // rarely carries a usable source, but it always carries the tag.
      patch["eligibility.excludedTags"] = list(e.excludedTags);
    }

    if (e.onlyRepEmail !== undefined) {
      patch["eligibility.onlyRepEmail"] = String(e.onlyRepEmail).trim().toLowerCase();
    }
    if (e.onlyLeadEmails !== undefined) {
      patch["eligibility.onlyLeadEmails"] = list(e.onlyLeadEmails);
    }
    if (e.includeExistingLeads !== undefined) {
      patch["eligibility.includeExistingLeads"] = Boolean(e.includeExistingLeads);
    }
    if (e.skipCapturedDuringOfficeHours !== undefined) {
      patch["eligibility.skipCapturedDuringOfficeHours"] = Boolean(e.skipCapturedDuringOfficeHours);
    }
  }

  if (body.chat) {
    const c = body.chat;
    if (c.enabled !== undefined) patch["chat.enabled"] = Boolean(c.enabled);
    if (c.dryRun !== undefined) patch["chat.dryRun"] = Boolean(c.dryRun);
    if (c.maxAiMessages !== undefined) {
      // Bounded low as well as high: a bot allowed one turn cannot ask anything
      // before handing over, which looks broken rather than cautious.
      const turns = Number(c.maxAiMessages);
      patch["chat.maxAiMessages"] = Number.isFinite(turns) ? Math.min(Math.max(Math.round(turns), 2), 20) : 8;
    }
    if (c.handoffMessage !== undefined) patch["chat.handoffMessage"] = String(c.handoffMessage).trim();
    if (c.completeMessage !== undefined) patch["chat.completeMessage"] = String(c.completeMessage).trim();
    if (c.leadWriterEmail !== undefined) {
      patch["chat.leadWriterEmail"] = String(c.leadWriterEmail).trim().toLowerCase().slice(0, 200);
    }
    if (c.handoffOperatorEmail !== undefined) {
      patch["chat.handoffOperatorEmail"] = String(c.handoffOperatorEmail).trim().toLowerCase();
    }
    if (c.askContactFields !== undefined) {
      // Only the three the engine knows how to ask for; anything else would be
      // stored, never asked, and look like a setting that quietly does nothing.
      const allowed = ["name", "email", "phone"];
      patch["chat.askContactFields"] = list(c.askContactFields)
        .map((key) => key.toLowerCase())
        .filter((key) => allowed.includes(key));
    }
    if (c.repPool !== undefined) {
      patch["chat.repPool"] = list(c.repPool).map((email) => email.toLowerCase());
    }
    if (c.failureMessage !== undefined) {
      patch["chat.failureMessage"] = String(c.failureMessage).trim();
    }
    if (c.aiAllHours !== undefined) {
      patch["chat.aiAllHours"] = Boolean(c.aiAllHours);
    }
    if (c.writeLeadOnHandoff !== undefined) {
      patch["chat.writeLeadOnHandoff"] = Boolean(c.writeLeadOnHandoff);
    }
  }

  if (body.sending) {
    const s = body.sending;
    if (s.onlySendDuringOfflineHours !== undefined) {
      patch["sending.onlySendDuringOfflineHours"] = Boolean(s.onlySendDuringOfflineHours);
    }
    if (s.firstContactDelayMinutes !== undefined) {
      patch["sending.firstContactDelayMinutes"] = bounded(s.firstContactDelayMinutes, 15, 10080);
    }
    if (s.chaseAfterHours !== undefined) {
      patch["sending.chaseAfterHours"] = bounded(s.chaseAfterHours, 48, 2160);
    }
    if (s.ccEmails !== undefined) {
      // Anything without an "@" is dropped rather than rejected: a trailing
      // comma in the form should not fail the save. The cap is there because
      // Zoho refuses an oversized recipient list and the whole send would fail.
      patch["sending.ccEmails"] = list(s.ccEmails)
        .filter((address) => address.includes("@"))
        .slice(0, 10);
    }
  }

  if (body.crm) {
    const c = body.crm;
    if (c.tagLeads !== undefined) patch["crm.tagLeads"] = Boolean(c.tagLeads);
    if (c.writeNotes !== undefined) patch["crm.writeNotes"] = Boolean(c.writeNotes);
    if (c.tagName !== undefined) {
      const tag = String(c.tagName).trim().slice(0, 40);
      // An empty tag name would have Zoho reject every tag call, so tagging is
      // switched off rather than left on with nothing to apply.
      if (!tag) throw new Error("Tag name cannot be empty. Switch tagging off instead.");
      patch["crm.tagName"] = tag;
    }
  }

  if (body.guardrails) {
    const g = body.guardrails;
    if (g.maxAiMessages !== undefined) {
      patch["guardrails.maxAiMessages"] = bounded(g.maxAiMessages, 5, 50);
    }
    if (g.maxConversationDays !== undefined) {
      patch["guardrails.maxConversationDays"] = bounded(g.maxConversationDays, 21, 365);
    }
    if (g.stopWhenRepReplies !== undefined) {
      patch["guardrails.stopWhenRepReplies"] = Boolean(g.stopWhenRepReplies);
    }
    if (g.stopOnOptOut !== undefined) {
      patch["guardrails.stopOnOptOut"] = Boolean(g.stopOnOptOut);
    }
    if (g.dryRun !== undefined) {
      patch["guardrails.dryRun"] = Boolean(g.dryRun);
    }
  }

  if (body.company && body.company.facts !== undefined) {
    patch["company.facts"] = String(body.company.facts).slice(0, 4000);
  }

  if (body.ai) {
    const a = body.ai;
    if (a.provider !== undefined) {
      const p = String(a.provider).trim().toLowerCase();
      // Only two now: OpenAI, or a custom endpoint. An older page still posting
      // "auto" means OpenAI.
      patch["ai.provider"] = p === "custom" ? "custom" : "openai";
    }
    if (a.model !== undefined) patch["ai.model"] = String(a.model).trim().slice(0, 80);
    if (a.openaiApiKey !== undefined) patch["ai.openaiApiKey"] = String(a.openaiApiKey).trim().slice(0, 200);
    if (a.apiKey !== undefined) patch["ai.apiKey"] = String(a.apiKey).trim().slice(0, 200);
    if (a.baseURL !== undefined) patch["ai.baseURL"] = String(a.baseURL).trim().slice(0, 200);
    if (a.tone !== undefined) patch["ai.tone"] = String(a.tone).trim().slice(0, 300);
    if (a.extraInstructions !== undefined) {
      patch["ai.extraInstructions"] = String(a.extraInstructions).slice(0, 4000);
    }
    if (a.signOffName !== undefined) {
      patch["ai.signOffName"] = String(a.signOffName).trim().slice(0, 80);
    }
  }

  if (Array.isArray(body.quoteFields)) {
    patch["quoteFields"] = body.quoteFields.slice(0, 20).map((field: any) => ({
      key: String(field.key || "").trim().slice(0, 40),
      label: String(field.label || "").trim().slice(0, 60),
      question: String(field.question || "").trim().slice(0, 300),
      enabled: Boolean(field.enabled),
      defaultValue: String(field.defaultValue || "").trim().slice(0, 60),
    }));
  }

  if (body.enabled !== undefined) patch["enabled"] = Boolean(body.enabled);

  return patch;
}

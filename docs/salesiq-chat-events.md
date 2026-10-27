# Showing "a rep joined the chat"

The chat viewer — `https://lead-follow-up-production.up.railway.app/chat-view/<chat id>`, the link in every rep alert — now shows two events in the transcript:

- **Chat handed to Jessica Joe — waiting for them to join.** (amber) — the bot asked SalesIQ for a person.
- **Sarah Blake joined the chat.** (green) — somebody actually took it. The header also gains an **In the chat: Sarah Blake** tag.

The first one works today with no setup. The second needs five minutes in SalesIQ, because **the bot webhook is never told that an operator joined**.

## Why the extra webhook is needed

Every callback SalesIQ has ever made to this service is one of three handlers — `trigger`, `message`, `failure` — and none of them carries an operator. Once a rep picks a chat up, the bot is dropped from the conversation: we are told neither that they joined nor what they typed. SalesIQ's *chat event* webhook is a separate feature that does carry it.

## Setting it up

1. SalesIQ → **Settings → Developers → Webhooks** → add a webhook.
2. URL:

   ```
   https://lead-follow-up-production.up.railway.app/webhooks/salesiq/events?token=<SALESIQ_WEBHOOK_TOKEN>
   ```

   The token is the same `SALESIQ_WEBHOOK_TOKEN` already set in Railway. Without it the endpoint answers **401** — check it by opening the URL with `GET`, which should return `{"ok":true,…}`.
3. Subscribe to the **chat** events — whatever the account offers along the lines of *attended / answered / picked up / transferred*. Extra events do no harm: anything that does not name an operator is recorded and shown to nobody.
4. Have a rep pick up one test chat, then open that chat's viewer link. The green line should be there.

## If the line does not appear

Zoho publishes no schema for these payloads, so the reader in [`src/services/salesiq/chatEvents.ts`](../src/services/salesiq/chatEvents.ts) tries every plausible spelling of the chat id and the attender. Every call is stored whole either way:

```
GET /api/salesiq/captures?limit=20      (admin session required)
```

Events are filed under `handler: "event:<name>"` and the `reply` field says what was done with it — for example `{"applied":false,"why":"no chat found for …"}`. One real capture is enough to correct the reader; that file is the only one that changes.

## What it does not do

A rep joining is **recorded and displayed only**. It does not stop the bot, and it does not change the chat's status — SalesIQ normally stops routing to the bot once a human takes over. If the events show that is not true in practice, silencing the bot on a join is a two-line change.

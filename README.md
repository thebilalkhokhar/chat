# lead-follow-up

An AI email conversation that qualifies an exhibition lead until there is
enough information to quote, then hands it to the rep.

A lead is captured at a stand. This service writes to them as the rep who
captured them, reads their reply, and keeps asking until it knows six things:

| Field | Notes |
|---|---|
| Product | mylar bags, folding carton, rigid box, labels … |
| Material | kraft, 350gsm SBS, matte BOPP … |
| Sizes | any format the customer gives |
| Finishes / Lamination | matte, gloss, spot UV, foil, none |
| Quantity | per SKU |
| Number of SKUs | defaults to 1 — never blocks a quote |

When all six are known the conversation stops and the rep is told. The service
never sends a price.

## Why it needs no webhook and no mail server

Everything it depends on already exists, on one MongoDB cluster:

- `zoho_exhibitions_rep_data.leads` — captured leads
- `zoho_exhibitions_rep_data.zohocredentials` — each rep's Zoho OAuth grant,
  which is what lets mail be sent *as them*
- `zoho_connector.interactions` — every email the Zoho connector has already
  synced from the org's mailboxes, inbound and outbound

So replies are read from a collection that is already kept current (verified:
newest synced message was 0h old), and mail is sent through the CRM's own
`send_mail` action. This service polls; it does not receive.

The connector database is treated as read-only. It belongs to another system.

## Safety

The service writes to strangers under a real employee's name, so the rules
about who may be contacted are deliberately strict and all live in one
function, `rejectionReason()` in `src/services/leadSource.ts`.

Before doing anything else, run:

```
npx ts-node --transpile-only src/scripts/whoWouldGetMail.ts
```

It prints exactly who would receive an email and, for everyone else, which rule
excluded them. If that list is not what you expect, do not start the worker.

- `EXCLUDED_EMAIL_DOMAINS` — colleagues, never contacted, cannot be overridden
- `EXCLUDED_LEAD_SOURCES` — sources that are not enquiries (newsletter signups,
  logged website visits). Nobody on these asked to be written to. Matched as
  substrings of the CRM source, so `newsletter` covers every brand's variant;
  quote requests such as "Website Quote" are enquiries and are not excluded
- `ONLY_REP_EMAIL` — blast radius: one rep's leads only
- `ONLY_LEAD_EMAILS` — a hand-picked run; deliberately ignores the rep limit so
  a specific test mailbox can be reached whoever captured it
- `DRY_RUN` — composes and stores emails without sending

`CC_EMAILS` is a separate thing and does not go through those rules: it is a
visible CC on every email the AI sends, so the team can watch a thread as the
customer sees it. Internal addresses belong there — being copied on a rep's
outgoing mail is not being written to as a lead, and `EXCLUDED_EMAIL_DOMAINS`
must never be relaxed to achieve it. A reply from a copied colleague is not read
as the customer's. Like every other setting it is seeded from the environment
only on first run; on an install already going, `npm run set:cc` applies it once
and the dashboard owns it after that.

Conversation limits: at most `MAX_AI_MESSAGES` (5) emails per thread, a
`MAX_CONVERSATION_DAYS` (21) cap, an immediate stop if the rep replies by hand,
and an immediate stop on opt-out.

## The SalesIQ chat bot

A second conversation surface, for the live chat on the print247 website. It
shares the qualifying brain with email — the same six fields, the same rule
against ever quoting a price — but none of the email guardrails: a visitor with
a chat window open is present and waiting, so office hours, contact delays and
the per-rep limit do not apply. Qualified chats go to Nancy Wilson.

The bot asks for one detail at a time and hands over when the visitor asks for
a person, when all six answers are in, or when it runs out of turns. It is
controlled from the dashboard's **Website chat** tab, and starts off and in dry
run: it composes and stores what it would say while the visitor still sees only
the holding message. Read those in the database before letting it speak.

The contract below was measured from live traffic, not documentation:

| | |
|---|---|
| Signature header | `x-siqsignature`, RSA-SHA256, base64 |
| Handlers | `trigger` when a chat opens, `message` when the visitor types |
| Visitor text | `message.text` |
| Conversation key | `visitor.active_conversation_id` |
| Reply shape | `{"action":"reply","replies":[{"text":"..."}]}` |

A chat is keyed on the conversation id rather than an email address because a
visitor arrives anonymous — the first capture had no email and the name
"Visitor 365140" — and SalesIQ has been seen writing the same person to the CRM
twice, before and after contact details existed.

### Capture mode

Kept for diagnosing a payload that does not behave. Zoho documents the bot handler names and
the shape of a reply, but not the request body or how long SalesIQ waits for an
answer — and that timeout decides whether a model call can happen inside the
request at all. So the webhook answers with a fixed holding message and writes
down exactly what it was sent:

```
npx ts-node --transpile-only src/scripts/salesiqCaptures.ts
```

Everything specific to Zoho's contract is in `src/services/salesiq/webhook.ts`,
including the one function that shapes a reply. If the bot connects but says
nothing, that function is the first thing to change.

To point a Zobot at it:

1. SalesIQ → Settings → Bot → add a bot on the **Webhooks** platform
2. Webhook URL: `https://lead-follow-up-production.up.railway.app/webhooks/salesiq`
3. Turn on **Secure your webhook** and copy the public key it shows
4. Put that key in Railway as `SALESIQ_PUBLIC_KEY` — the bare base64 from the
   portal is fine, the PEM armour is added for you

SalesIQ does not send a shared secret. It signs every event with RSA and
publishes the matching public key, so that signature — checked against the exact
bytes received — is how a genuine call proves itself. `SALESIQ_WEBHOOK_TOKEN`
remains only so the endpoint can be exercised by hand without forging one.

While `SALESIQ_CAPTURE_UNVERIFIED` is on, a request whose signature does not
verify is still answered and recorded, with the reason logged. That is how the
signature header gets identified in the first place, and it is safe only because
capture mode runs no model and replies with a fixed string. **Turn it off before
the bot composes real replies.**

## Scripts

| Command | Does |
|---|---|
| `smoke.ts` | Refreshes real reps' Zoho grants and checks mail sync freshness |
| `whoWouldGetMail.ts` | Who is eligible right now, and why everyone else is not |
| `eligible.ts` | Lead counts by owning rep |
| `matchcheck.ts` | Whether inbound mail can be tied back to a lead |
| `salesiqCaptures.ts` | What SalesIQ actually sent to the chat webhook |

## Running

```
cp .env.example .env     # fill in, or copy from the exhibitions app
npm run dev              # worker, with reload
npm run build && npm start
```

Deploys to Railway as a single always-on worker. No Redis: the job queue is in
MongoDB, because the volume is a few emails a day and a second service is not
worth keeping alive for that.

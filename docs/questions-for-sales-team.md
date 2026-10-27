# Questions for the sales team

What the bot says is being decided by defaults nobody chose. These are the decisions only the team can make.
Write the answer under each question, in the words you'd want a customer to read.

**Open** = still needed. **Done** = answered and in the code already.
Last checked against the running code and live settings: **14 September 2026**.

---

## A. Office hours — what the bot promises

### ✅ A2 / A3 — DONE
The closing line now follows **US Central (Texas) time**, four versions, in the team's own words:

| When (Texas time) | What it says |
|---|---|
| Weekdays 9:00am – 3:30pm | …market competitive pricing… **within today** |
| Weekdays 3:30pm – 6:00pm | …**within today if possible; otherwise, first thing tomorrow morning** |
| Weekdays 6:00pm – 9:00am | …**within our business hours** |
| Saturday & Sunday | …**by Monday morning** |

Two notes: the wording lives in the code, so changing it needs a deploy — say if you'd rather edit it on the
dashboard. And the same four lines are used at 2am as at 7pm, since 6pm–9am is one window.

### ❗ Still open — the other four messages still say "in the morning" at every hour

These were never made time-aware, so at 10am Texas time a customer is told someone will reach them "in the morning":

**A4. Handing over.** Now: *"Let me check on that and come back to you shortly."*

> On shift:
>
> Off shift / weekend:

**A5. They ask for a person.** Now: *"Of course. I will connect with you in the morning — could you share your email
so I can reach you there?"* then *"Great, thank you. I will connect with you in the morning."*

> On shift:
>
> Off shift / weekend:

**A6. Existing customer with a problem.** Now promises somebody will get back to them *"during business hours"*.

> On shift:
>
> Off shift / weekend:

**A1. Confirm the working week** for those messages. Same Texas windows as the closing line, or the Pakistan
shift (7pm–5am PKT, Mon–Fri) the rest of the service uses?

> Answer:

**A7. Should the bot ever say when the team is next in** — "we're back Monday morning"? If yes, in whose time?

> Answer:

---

## B. Minimum order

### ✅ B2 (partly) and E3 — DONE
Banners never get the 1000 minimum: **pull-up, roll-up, pop-up, retractable, backdrop, X-stand, step-and-repeat**.
Asked their minimum, a banner customer is told there isn't one. Plain, unprinted orders are never asked how many
designs or SKUs they have.

**B2b. Still open:** do **feather flags, teardrop flags, rigid signs, business cards, other print collateral** also
have no minimum?

> Answer:

**B1.** *"Our MOQ is 1000 per size and if you have multiple designs then we can do 500 each."* When does the 500 apply
— from two designs upward, or as a minimum total?

> Answer:

**B3.** Plain, unprinted boxes or bags: is the minimum **per size only**, since there are no designs?
(The live facts don't mention this, so the bot still says "per size and per design".)

> Answer:

**B4.** They're under the minimum and say **no**. Keep collecting, offer something, or hand to a rep?

> Answer:

---

## C. Products with no script — OPEN, and the bot invents questions

Still only **bags, boxes and labels**. Anything else and the bot makes its own questions up — that's how a banner
customer was asked for a "soft touch finish".

**C1. Banners / pull-up stands.** Your questions, in your words and order. My guess: size, single or double sided,
finish, stand included, quantity, artwork ready.

> Answer:

**C2. Which finishes do banners come in?**

> Answer:

**C3.** Should the bot quote **business cards, signs, print collateral** at all? If not, what should it say?

> Answer:

---

## D. What the bot may say — OPEN, and now urgent

Four days of live chats: **62 customer questions, 30 got no answer** — the bot acknowledged and asked its next
question. I've fixed the mechanics (a reply that answers nothing is rewritten), but for anything the facts don't
cover I have no answer to give it.

**D0. Price questions — the most common of all.** "How much for 1000?" now gets:
*"I can't price it here — your quote will carry the pricing."* Is that the wording you want?

> Answer:

**D0b. "Can you do X?"** — soft touch and embossed, a custom die-cut, white ink, a reference photo they've sent.
What may the bot say? Options: "yes, we can" / "I'll include that in your quote" / something of yours:

> Answer:

**D1. Rush orders.** The facts say *"10-12 business days but I will have to check the production slot and will update
you first thing in the morning."* The bot speaks as the rep, so "I will check" means nobody checks. May it say
10–12 business days, subject to a slot?

> Answer:

**D2. Turnaround 12–15 business days** — from the order, or from artwork approval?

> Answer:

**D3. Samples.** Do you send physical samples? What may the bot promise?

> Answer:

**D4. Shipping.** Do you quote DDP to the US? What may it say about shipping and carriers?

> Answer:

**D5. Setup, tooling or plate fees.** Standard answer, or always wait for the quote?

> Answer:

**D6. Performance questions** — food safe, freezer safe, adhesive safe on cosmetics, waterproof. The bot says nothing
today. Do you want an approved line?

> Answer:

**D7. Free design support**, in-house team — may the bot offer it?

> Answer:

**D8. Payment.** ACH, wire, Zelle, card links with a 3% fee — still correct?

> Answer:

---

## E. What the bot collects

### ✅ E3 — DONE (plain orders are never asked for designs/SKUs)

**E1. The name.** It asks, and gives up after two tries. Do reps need it, or is an email or phone enough?

> Answer:

**E2. The phone number.** Required, or optional once there's an email?

> Answer:

**E4. Delivery location.** The bot must not ask for an address. Would a city/state help, or is it noise?

> Answer:

**E5.** Anything a rep always needs that the bot never asks for?

> Answer:

---

## F. Who gets the lead

### ✅ F1 — DONE
A customer who comes back on another channel goes to the rep who already has them, and gets one lead, not two.

**F2. Harry — still broken, and costing leads.** The rep list has `harry.brook@print247.us`, but his Zoho sign-in is
`harry.brook@colorwing.com`. Chats assigned to him **can never write a lead**. Remove him from the rotation, or have
him sign in with the print247 address?

> Answer:

**F3. Existing customers with a problem.** A particular person or queue, or the chat's own rep?

> Answer:

---

## Not a question — two things that need doing

- **45 chats have no Zoho lead** and never will: each tried 12 times, failed, and is now permanently skipped.
  Real customers are in there. They can be re-driven once we know why the writes failed on 13 September —
  the Railway log line beginning `GAVE UP on the CRM lead` names the reason.
- **Harry's chats** (F2) are part of that same loss.

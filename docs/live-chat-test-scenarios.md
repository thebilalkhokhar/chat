# Live chat test scenarios

Test script for the website chat bot on print247.us, for the code deployed in `0fa9b7b` ("all fixed").
Record results in [live-chat-test-checklist.csv](live-chat-test-checklist.csv).

---

## Before you start — read this

**1. These tests are live.** The chat is not in dry run. Every test chat will:
- alert the rep on **WhatsApp and the ERP** after your first message,
- write a **CRM lead** in Zoho once you give an email or phone number,
- in T22, T23 and T25, **forward the chat** to a real rep in SalesIQ.

Tell the reps you are testing, and when the bot asks for your name, answer **`TEST <your name>`** so every test lead is easy to spot.

**2. Use a test email per scenario**, like `yourname+t01@gmail.com`, `yourname+t02@gmail.com`. The same email in two chats is treated as the same customer (that is T35), so only reuse one when a scenario says so.

**3. Every scenario needs a new visitor.** The bot remembers a browser for 3 hours and continues its last chat. Between scenarios, **close every incognito window** and open a fresh one (incognito windows share one session while any of them is open), or switch to another browser. Scenarios marked *same window* continue in the window you already have.

**4. Judge the meaning, not the exact words.** The bot writes its own replies, so wording changes each time. Lines marked **exact** are fixed text and must match word for word.

**5. Clean up afterwards.** In Zoho, search leads for `TEST` and your test emails and delete them.

---

## Checks for every single reply

Apply these to **every** scenario. Any one of them failing is a fail.

| # | Must hold in every chat |
|---|---|
| U1 | The rep introduces themselves **once**, at the start, and the **same name** all the way through |
| U2 | **One question per message** — never "what size and quantity?" |
| U3 | **Never asks again** for something you already answered |
| U4 | **No prices**, no ranges, no "roughly", no delivery date for your order |
| U5 | Never says **"I'll confirm"**, "I'll check", "let me find out", "I'll get back to you" |
| U6 | Never says **"One of our team will be with you shortly."** |
| U7 | Never asks for an **email, phone or name you already gave** |
| U8 | No asterisks, bullet points, markdown or the word **"THIS."** in capitals |
| U9 | Never says "I'll prepare / send you the quote" **in the middle** of the questions |

---

## A. Full quote

### T01 — Mylar bags, start to finish
| You type | Bot should |
|---|---|
| *(open the chat)* | Greet with a name: "Hi, I'm …" |
| `I need custom mylar bags` | Acknowledge and ask one question (often your email) |
| your test email | Take it, move on |
| `4x6 inches` | Ask the next thing (style) |
| `stand up` | Ask the finish |
| `matte` | Ask the quantity |
| `5000` | **No minimum mentioned.** Ask designs/SKUs |
| `2 designs` | Ask about zipper / tear notch |
| `yes, zipper and tear notch` | Ask about material or features |
| `no special material` | Ask your name |
| `TEST Priya` | Ask your phone |
| `+1 555 201 7788` | **exact:** `I will get you a quote in the morning and we will go from there.` |

Also check: no question repeated, no second introduction, the rep gets one alert.

### T02 — After the chat has finished *(same window as T01, within 3 hours)*
| You type | Bot should |
|---|---|
| `thanks` | **exact:** `You're welcome — talk soon.` |
| `The bags can also be 5x7 inches` | **exact:** `I will get you a quote in the morning and we will go from there.` |
| `ok` | **exact:** `Great — talk soon.` or `You're welcome — talk soon.` — never the same line twice in a row |

After: the T01 lead in Zoho has a new note titled **"Website chat — continued"** mentioning 5x7. Still **one** lead, not two.

---

## B. Minimum order

### T03 — Under the minimum
| You type | Bot should |
|---|---|
| `custom stickers` | Ask a question |
| `3x3 inches` | Ask the next thing |
| `matte` | Ask the quantity |
| `80` | Say the minimum is **1000 per size** and ask whether that works |
| `no` | **Not** repeat the minimum; carry on with a question |

### T04 — Asks for the MOQ
| You type | Bot should |
|---|---|
| `What is your MOQ?` | Give it: **1000 per size, 500 each if multiple designs**, then one question |

### T05 — One banner (the original bug)
| You type | Bot should |
|---|---|
| `A pop up banner` | Ask a question |
| your test email | Move on |
| `33.5 inches X 80 inches` | Move on |
| `One sided` | Move on |
| `standard gloss` | Ask the quantity |
| `1` | **Never** mention 1000, MOQ or a minimum — now or anywhere in the chat |

### T06 — Banner customer asks the minimum
| You type | Bot should |
|---|---|
| `pull up banner` | Ask a question |
| `what is your minimum order?` | Say **there is no minimum** for banners (one, two or more). **Never 1000.** |

### T07 — Quantity over the minimum
| You type | Bot should |
|---|---|
| `custom mailer boxes` then answer normally, with quantity `5000` | Never mention a minimum |

---

## C. Questions about the company

Each in a fresh window. The key fact must be in the reply, followed by one question.

| ID | You type | Reply must contain |
|---|---|---|
| T08 | `Where are you located?` | **Houston, Tx** |
| T09 | `How long does it take?` | **12-15 business days**, production and delivery |
| T10 | `What payment methods do you accept?` | **ACH, Wire transfer, Zelle**; card links with a **3%** fee |
| T11 | `Do you guys print in house?` | **In-house** (manufactured in the United States) |
| T12 | `Can you do a rush order?` | **10-12 business days** for rush |
| T13 | `How much for 5000 boxes?` | **No price and no range.** Says pricing comes with the quote, then asks a question |

### T14 — Long enquiry full of questions (chat #4457)
Paste this as your first message:

```
We are sourcing a manufacturer for a complete retail kit and would like a quote. The kit includes custom kiss-cut sticker sheets, soft-touch or premium matte finish, removable adhesive. We'd like your quote to cover sticker sheets, printed card, envelope, collation and packing. To scope pricing, please confirm: Can you produce and assemble the complete kit in-house? Minimum order quantity. Unit pricing at 1,000 / 5,000 / 10,000 units. Tooling or setup fees. Sample lead time and production lead time. Shipping terms to the U.S. and whether you quote DDP. Best regards, TEST Sara
```

| Then | Bot should |
|---|---|
| First reply | Contain **1000 per size** (MOQ), **12-15 business days**, and **in-house** — in that one reply. Say pricing/fees/samples/shipping come with the quote. **Not** "I'll confirm". |
| Answer the rest: your email, `2000, 5000, and 10000`, `1000`, `yes complete kit`, `ddp`, `inches`, `i don't know` | **Never** ask the same question twice in a row after you answered it. Never ask "inches, cm or mm?" before you have given a size. |
| After | The Zoho lead is named **TEST Sara** (or has no name) — **never** a rep's name like Jessica or Frank |

---

## D. Product rules

### T15 — Plain box, no printing
| You type | Bot should |
|---|---|
| `I need boxes shipped to Berlin MD. Please provide bulk pricing.` | Ask a question, no price |
| `This is just for a no design plain white box for now. I have a sticker and need these asap.` | Carry on |
| Answer everything else normally (`10x8x4 inches`, `1000`, `matte`, `mailer style`…) | **Never** ask how many designs or SKUs |

### T16 — Size without a unit
The bot works the unit out from the numbers instead of asking. It says how it read it, so a wrong guess costs one word to fix.

| You type | Bot should |
|---|---|
| `labels` then `50x30` | Say it back as **50x30 mm** and move to the next question. **Never** ask inches/cm/mm |
| (lead) | Size reads `50x30 mm (assumed)` — the marker tells the rep we worked it out |
| `cm` (correcting it) | Lead becomes `50x30 cm`, with no marker |

| Product and size | Read as |
|---|---|
| `labels` `50x30` | mm |
| `labels` `4x6` | inches |
| `custom mailer boxes` `10x8x4` | inches |
| `boxes` `250x200x100` | mm |
| `mylar bags` `6 x 9` | inches |
| `pull-up banner` `3x6` | feet |
| `retractable banner` `33x81` | inches |

### T17 — Size with a unit
| You type | Bot should |
|---|---|
| `stickers` then `50x30mm` | **Not** ask for the unit |

### T17b — Capacity instead of dimensions *(chat #4667.1)*
Paste this as one first message, exactly as written:

```
Hi.
I'm interested in custom Mylar bags. Big enough to hold 28 grams of product.
Quantity: 500
I don't have a design yet. Do y'all do designing?
```

| Bot must | Bot must **never** |
|---|---|
| Say the minimum — 500 is below 1,000 | Ask whether `28 grams` is in **inches, cm or mm** |
| Answer that design support is free / in-house | Ask `Do y'all do designing?` back at them |
| Ask one next question | Ignore the design question |

Same check with `2 ounces`, `1 pound`, `500 ml`, `1 liter`, `2 kilos` — none of them is a missing unit.

### T18 — "What is a standard size?"
| You type | Bot should |
|---|---|
| `Boxes for knit kits` | Ask the box size |
| `What is a standard package size` | Say there is **no standard size** — it is made to fit what goes inside — and ask what goes in it / how big it is. **Not** just repeat the size question. Never make up sizes. |

### T18b — "No idea" to the size *(chat 948557000003933021)*
| You type | Bot should |
|---|---|
| `box` → give an email → when asked the size: `no idea` | Say **there is no standard size** — it is made to fit what goes inside — and ask **what is going inside and roughly how big**. Never "Thanks." and the next question |
| `no idea` again | Move on to the next question. **Not** say the same thing twice |

Same for `not sure`, `don't know`, `no clue`, `you tell me`, `whatever you recommend`.
`not sure, maybe 4x6` is an answer, not a shrug — that one is taken as the size.

### T18c — Indigo's chat, end to end *(c3fe62ea…-0)*
Four faults in one real chat. Type these in order:

| You type | Bot must | Bot must **never** |
|---|---|---|
| `Soap boxes and labels` | Ask the next question | |
| your email | | |
| `3.5x2.5x1 1/8` | Say it back as **inches** | Ask inches/cm/mm |
| `Matte` | | |
| `I like rustic like brown 300` | State the 1,000 minimum. Lead shows **Quantity: 300** | Store the whole sentence as the quantity |
| `For how much?` | Say pricing comes with the quote | |
| `What are my options` | **List what we make** — rigid, corrugated, folding cartons, mailers, labels, pouches | Answer with "Nice to meet you." or a name question |
| `Indigo` | | |
| `Please send it to my email` | **Finish the chat** | Ask for a phone number again |

On the lead afterwards: no field reads `none` for anything she was actually asked — an unanswered question is `not specified`.

### T19 — Finish typo
| You type | Bot should |
|---|---|
| `labels` → `3x3 inches` → when asked the finish: `glass` | Say **gloss**. The word "glass" never appears in the bot's reply |

### T20 — Boxes get no bag questions
| You type | Bot should |
|---|---|
| `custom mailer boxes` and answer everything | **Never** ask about a zipper, tear notch, or Flat/Standup bag style |

### T21 — What goes inside, not what we make
| You type | Bot should |
|---|---|
| `I sell coffee` | Suggest what we'd make for it (pouches/bags), not treat "coffee" as the product |

### T40 — Gibberish or a mistype (chat #4465)
| You type | Bot should |
|---|---|
| `Q as the Ty of` | Say it didn't catch that and ask **what you are looking to have made**. **Never** repeat your words back ("Got it — Q as the Ty of"), and **never** move on to asking for your email |
| `mylar bags` | Carry on normally from there |

Check afterwards: the chat record has **no product** saved from the gibberish.

### T39 — Asking something after the quote is promised
Finish any chat first (T01 works), then keep typing in the same window.

| You type | Bot should |
|---|---|
| `did you email me` | Say it **hasn't gone out yet** and when it will. **Never** the closing line again |
| `answer me did you email me` | A different answer, not a copy of the one before |
| `ok thanks` | **exact:** `You're welcome — talk soon.` |
| `The boxes can also be 2 inches deep` | Take the detail — the closing line is not repeated word for word, and it reaches the rep as a note on the lead |

**Must never** claim it has already emailed or sent anything: it hasn't.

### T38 — Two label sizes, 15 SKUs (chat #4461)
Answer plainly and watch what it asks **after** the script is done.

| You type | Bot should |
|---|---|
| `Labels for 3ML vials (small)- 1.75"x 0.75"` *(new line)* `10 ML vials (large) 2.5"x 1.25"` | Take both sizes, ask one question |
| your test email | Move on |
| `Matte` | Ask the quantity |
| `500` | Say the minimum is 1000 per size and per design |
| `1000` | Ask designs/SKUs |
| `15` | Ask about material or features — **not** how to organise the SKUs |
| `No` | Ask your name or phone, then finish |

**Must never ask** about: a digital proof, artwork, file naming, a PDF or approval link, how the quote is grouped or laid out, a delivery address, a shipping method or a carrier. A rep sorts those out after the quote.

**Must finish** within roughly 12 messages — no loop of extra questions.

### T37 — Just says hi
Open the chat on the **home page** (print247.us), and again on a **boxes page** in a fresh window.

| You type | Bot should |
|---|---|
| `Hi` (home page) | Ask **what you are looking to have made** — boxes, bags or labels. **Never** a size, finish or quantity question, and never assume boxes from the page |
| `hello` (a boxes page) | Same — ask what you want made |
| `I need boxes 4x6x2 inches` (fresh window) | **Not** ask what you want made — you just said it |

---

## E. People and hand-over

### T22 — Asks for a person, no email yet
| You type | Bot should |
|---|---|
| `Can I speak to a real person please` | **exact:** `Of course. I will connect with you in the morning — could you share your email so I can reach you there?` |
| your test email | **exact:** `Great, thank you. I will connect with you in the morning.` — chat is forwarded to a rep, and a lead is written with your email |

### T23 — Asks for a person and gives an email together
| You type | Bot should |
|---|---|
| `custom boxes` | Ask a question |
| `can I talk to someone? my email is yourname+t23@gmail.com` | **exact:** `Great, thank you. I will connect with you in the morning.` straight away — no second email request. Lead written. |

### T24 — An email with "agent" or "human" in it
| You type | Bot should |
|---|---|
| `custom pouches` → when asked your email: `agent.test+t24@gmail.com` | **Not** hand you over — carry on with the next question |

### T25 — Existing customer with a problem
| You type | Bot should |
|---|---|
| `I purchased labels from you guys and I haven't received them yet` | Reply starting **exact:** `Thank you for reaching out! 😊 I'll make sure the right person from our team gets back to you` — and ask for name, account and phone. **No** quote questions. |
| `TEST Sam, Acme Candles, 555-201-3344` | Hand over to a person |

### T26 — Email inside a sentence
| You type | Bot should |
|---|---|
| `custom pouches` → `sure, my email is Test.User+t26@Gmail.com thanks` | Never ask for your email again |

### T27 — Rep's name in your message
| You type | Bot should |
|---|---|
| `custom boxes for candles` → `thanks <the rep's name>, email is yourname+t27@gmail.com` | Lead is **not** named after the rep |

---

## F. Chat behaviour

### T28 — Photo while a question is waiting
| You do | Bot should |
|---|---|
| `mylar bags`, wait for the size question, then **send one photo only** (no text) | **One** reply, saying it has the image and the team will review it with the quote |
| `4x6 inches` | Carry on normally |

### T28b — Several photos at once *(the six-reply bug — chat 948557000003933019)*
| You do | Bot should |
|---|---|
| Run a chat right through to the closing message ("Thank you for sharing the project details…"), then **drag in 4–6 photos together** | **Exactly one** reply: `Thanks, I've got that — I've added it to your request.` |
| | The closing paragraph is **never** said a second time, and there is **no** reply at all to photos 2–6 |
| Check the transcript in SalesIQ | **Every** photo is there — the bot goes quiet, it does not drop them |

### T28c — Several photos mid-chat
| You do | Bot should |
|---|---|
| `custom boxes`, then send **3 photos in a row** before answering anything else | One reply to the first photo, and **nothing** for the other two |
| `10x8x4 inches` | Carry on normally, with the question it asked still standing |

### T29 — Photo when the bot asked for one
| You do | Bot should |
|---|---|
| `custom boxes`, answer until it asks the **box style or a reference image**, then send a photo | Move on to the next question |

### T30 — Same word twice
| You type | Bot should |
|---|---|
| `labels` → `50x30` → `inches` → `inches` again | The second `inches` gets its **own** reply, not a copy of the one before |

### T31 — Pause mid-chat
| You do | Bot should |
|---|---|
| `custom boxes`, give your email, then **wait 5 minutes**, then `10x8x4 inches` | Carry on the same chat — **never** "One of our team will be with you shortly." |

### T32 — Open, leave, come back
| You do | Bot should |
|---|---|
| Open the chat, type nothing, wait 5 minutes, reload the page and open the chat again | The **same rep name** greets you, not a different one |

### T33 — Two messages fast
| You type | Bot should |
|---|---|
| `custom boxes` and `for candles` back to back, as fast as you can | Two sensible replies, not the same question twice |

### T34 — Same customer, two channels
| You do | Bot should |
|---|---|
| Finish a chat on the website with email `yourname+t34@gmail.com`. Then, from WhatsApp/Instagram or another browser, start a new chat and give **the same email** | Still **one** lead in Zoho. The second chat is added to it as a note. The alert goes to the **first** chat's rep. |

### T35 — Returning next day *(optional)*
| You do | Bot should |
|---|---|
| Use the T01 browser again **3+ hours later** | Greet you as returning ("Hi, it's … again") with the **same rep** |

### T36 — Turn limit *(optional, long)*
| You do | Bot should |
|---|---|
| Keep answering `not sure` until the bot has sent 20 messages | **exact:** `Let me check on that and come back to you shortly.` and hand over |

---

## G. After testing — check the CRM and dashboard

| Check | Expected |
|---|---|
| Every test chat that gave an email or phone | Has **one** lead in Zoho, under the chat's rep |
| Lead names | `TEST …` or blank — never Alex, Frank, Max, Jessica or Harry |
| Sizes on leads (T16) | Include the unit, e.g. `50x30 mm` |
| T02 lead | Has a "Website chat — continued" note |
| T34 | One lead only, with a second note |
| Clean-up | Delete every `TEST` lead and test email |

---

## If something fails

Note the scenario ID, the time, and copy the chat transcript from SalesIQ into the Notes column of the checklist. The chat record is in the database under the visitor's SalesIQ id, so the exact turn can be looked up.

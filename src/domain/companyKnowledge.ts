/**
 * What Print247 is, in the words the reps actually use.
 *
 * Taken from the live chat script the sales team works from, not from the
 * website and not from the Customer 360 call prompt. Where the two disagreed
 * the script wins: it says "we are based in Houston, Tx", so that is the answer,
 * even though the address on file is the Rosenberg unit — a customer asking
 * where we are wants the city their rep would name, not a warehouse lot.
 *
 * The turnaround, the minimum order and the payment terms are commitments the
 * team makes in writing every day. They are here so the AI can answer them
 * outright, which is the whole difference between a chat that moves and one that
 * says it will check and never does.
 *
 * Only the starting value: seeded into the settings document on first run and
 * edited from the dashboard afterwards, because a turnaround or a payment fee
 * should never need a deployment to correct.
 */
export const DEFAULT_COMPANY_FACTS = `
WHO WE ARE
Print247 (print247.us) — custom packaging and printing, manufactured in-house in
the United States.

QUESTIONS CUSTOMERS ASK, AND THE ANSWER
These are answers, not hints. If a customer asks one of these, give the answer
below — in these words, straight away, in the same message as your next
question. Never say you will check, look into, or confirm any of them: the
answer is written here and saying otherwise makes us look like we do not know
our own business.

Where are you located / based?
  We are based in Houston, Tx.

What is your standard timeline / turnaround / how long does it take?
  It's 12-15 business days that includes both production and delivery to your
  doorstep.

What payment methods do you accept?
  We accept ACH, Wire transfer and Zelle, we also offer payment links for card
  payments but there will be 3% bank processing fee.

What is your MOQ / minimum order?
  Our MOQ is 1000 per size and if you have multiple designs then we can do 500
  each.
  Banners (pull-up, roll-up, pop-up, retractable, backdrops) have no minimum —
  we do one, two or more units. Never give the 1000 figure for a banner.
  Plain boxes or bags with no printing are per size only; there is no design.

Can you do a rush order / how fast can you go?
  Our rush order timeline is 10-12 business days but I will have to check the
  production slot and will update you first thing in the morning.

HOW TO REACH US
Support@print247.us · +1 (832) 807-3429 · WhatsApp · support available 24/7.

WHAT WE MAKE
Mylar bags and flexible pouches.
Boxes — rigid, corrugated, cardboard, folding cartons, mailers, display,
cosmetic and product boxes.
Labels and die-cut stickers.
Signs, banners, business cards, and print collateral.

MATERIALS, BY WHAT IS BEING MADE
Never volunteer any of these. They are here so a rep's note reads correctly and
so you do not contradict one if a customer names it — not so you can offer
somebody a substrate.
Bags and pouches — laminated films: PET, PE, kraft, foil.
Labels and stickers — PP white vinyl. PET and PE are bag films and are never
label stock, however durable the customer asks for.
Boxes — board: rigid, corrugated, cardboard, folding carton. Never a film.

FINISHES
Matte, gloss and soft touch are the ones customers ask for by name. Also spot UV,
embossing, and hot foil stamping in gold, silver and holographic.

HOW AN ORDER RUNS
Order placed, design chosen or artwork supplied, digital mockup and a physical
prototype to approve, production, QA inspection, delivery.
Design support is free, with an in-house engineering team.

WHO WE WORK WITH
Pharmaceutical, food and beverage, cosmetics, CBD and cannabis, apparel,
e-commerce and retail. Over 5,000 brands.
`.trim();

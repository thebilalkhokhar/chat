/**
 * Somebody in the chat window who is not here to buy packaging.
 *
 * Three chats in one afternoon, all off the same Google PMax mylar-bags
 * campaign, all people looking for work: "Looking for a work from home jobs.
 * I'm over 60 and retired just need to keep busy.", "Looking home paking job",
 * "Looking for a job". The script has nothing for any of them, so it ran anyway
 * — one was asked three times what they wanted made, another was asked their
 * box size after typing "You xant understand .im looking job".
 *
 * Two of the three left an email, which is the only thing the lead sweep checks
 * before writing to the CRM, so two reps were handed leads reading
 * "Product: home packing job, Quantity: Im looking job". A job seeker with an
 * email address is not a lead; they are a person in the wrong window.
 *
 * Checked in code rather than left to the writer for the same reason the human
 * request and the existing customer are: the model mostly gets it, and the
 * times it does not are the times somebody is being talked at by a machine that
 * plainly is not listening.
 */

/**
 * Looking for work.
 *
 * The word "job" alone is not enough and never can be — "job lot", "a rush job",
 * "the job is 5000 pouches" are all customers — so every branch here needs the
 * word to sit next to looking, wanting, applying or hiring.
 */
const WANTS_A_JOB =
  /\b(?:looking|look|searching|search|hunting|need|needs|needed|want|wanted|apply|applying|application|interested)\b[^.?!]{0,30}\b(?:for\s+)?(?:a\s+|any\s+|some\s+)?(?:job|jobs|work|employment|vacancy|vacancies|position|hiring|career)\b|\b(?:job|work|employment)\s+(?:opportunit|openings?|vacanc|application)|\b(?:are|you)\s+(?:you\s+)?hiring\b|\bany\s+(?:job|work|vacanc|opening)/i;

/**
 * Work-from-home and packing-at-home enquiries.
 *
 * Their own phrasing, and it collides with ours: "home packing job" reads to a
 * reader as a packing product. It is not — it is somebody asking to be paid to
 * pack things at home, which we do not offer.
 */
const WANTS_TO_WORK_FROM_HOME =
  /\b(?:work|working|job|jobs)\s+(?:from|at)\s+home\b|\bwork\s*from\s*home\b|\bhome\s*(?:based\s*)?(?:packing|packaging|assembly)\s*(?:job|jobs|work)\b|\b(?:packing|packaging|assembly)\s+(?:job|jobs|work)\b/i;

/** A CV arriving in a sales chat. */
const SENDING_A_CV = /\b(?:my\s+)?(?:cv|resume|résumé|curriculum vitae)\b/i;

/**
 * A customer sentence that outranks all of the above.
 *
 * Somebody who names what they are buying is a customer whatever else is in
 * their message — "I need a job done: 5000 mylar bags" is an order. Nothing is
 * turned away on a word when the enquiry itself is sitting right there.
 */
const IS_REALLY_AN_ENQUIRY =
  /\b(?:quote|quotation|pricing|price|order|mylar|pouch(?:es)?|bags?|boxe?s?|labels?|stickers?|packaging|banners?|cartons?|mailers?|sleeves?|print(?:ing|ed)?)\b/i;

/** They are here about a job, not about packaging. */
export function isLookingForWork(text: string): boolean {
  const said = String(text || "").trim();
  if (!said) return false;
  if (WANTS_A_JOB.test(said) || WANTS_TO_WORK_FROM_HOME.test(said) || SENDING_A_CV.test(said)) {
    return !IS_REALLY_AN_ENQUIRY.test(said);
  }
  return false;
}

/**
 * The same question asked of the whole chat, not just this message.
 *
 * "Looking for a job" then "Both" then an email address: only the first message
 * says what is going on, and by the time the lead is written it is four turns
 * back. Anything the visitor has said counts, and one customer sentence
 * anywhere clears the whole chat — somebody who asks about a job and then asks
 * for 5000 bags is a customer who changed the subject.
 */
export function chatIsAboutAJob(visitorMessages: string[]): boolean {
  const said = visitorMessages.map((text) => String(text || "").trim()).filter(Boolean);
  if (!said.length) return false;
  if (said.some((text) => IS_REALLY_AN_ENQUIRY.test(text))) return false;
  return said.some((text) => isLookingForWork(text));
}

/**
 * Somebody selling to us, or asking to be paid to promote us.
 *
 * Packaging factories in China ("Dear Purchasing manager, I am Glen from Dongen
 * Packing Co.,ltd"), a converter offering its print capacity, a parent asking
 * whether their son could advertise our products on his Instagram. The script
 * asked each of them what size they wanted, and the last one became a rep's lead.
 *
 * Not cleared by IS_REALLY_AN_ENQUIRY the way a job seeker is: a supplier's pitch
 * is full of "mylar pouches" and "packaging" because that is what they sell. So
 * only wording a buyer would not use is here — a customer saying "we are a
 * manufacturer of candles" is not caught, a factory saying "we are one of the
 * leading packing companies" is.
 */
const PITCHING_TO_US =
  /\bdear\s+(?:purchasing|procurement|buyer|sir|madam|sir\/madam)\b|\bpurchasing\s+manager\b|\bco\.?,?\s*ltd\b|\b(?:we|our company)\s+(?:are|is)\s+(?:one of the leading|a leading|a professional)\b|\bwe\s+(?:operate|run|own)\s+an?\s+[\w\s-]{0,30}(?:converting|printing|manufacturing|production)\s+(?:facility|factory|plant)\b|\b(?:our|my)\s+(?:factory|company)\s+(?:can|could)\s+(?:produce|supply|offer|provide)\b|\bbusiness\s+opportunit(?:y|ies)\b|\bdecision[\s-]?maker\b|\bsponsor(?:ship|ed|ing)?\b|\binfluencer\b|\bbrand\s+ambassador\b|\b(?:advertise|promote)\s+(?:your|ur)\s+(?:products?|brand|company)\b/i;

/** They are here to sell to us or promote us, not to buy. */
export function chatIsAPitch(visitorMessages: string[]): boolean {
  return visitorMessages.some((text) => PITCHING_TO_US.test(String(text || "")));
}

/** Said to a supplier, a partnership request or a promotion offer. */
export const PITCH_MESSAGE =
  "Thanks for getting in touch! This chat is for custom packaging and printing quotes, so I'm not able to help with supplier, partnership or promotion requests here. Please email Support@print247.us and the right team will pick it up.";

/** Not here to buy packaging, for either reason. */
export function chatIsNotACustomer(visitorMessages: string[]): boolean {
  return chatIsAboutAJob(visitorMessages) || chatIsAPitch(visitorMessages);
}

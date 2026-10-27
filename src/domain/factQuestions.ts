/**
 * Questions the company facts answer, and whether a reply answered them.
 *
 * The prompt says to answer these from the facts, straight away. A customer
 * whose enquiry asked for the minimum order, the lead time and whether we
 * manufacture in-house was asked for her quantity instead — in the live chat,
 * and again when the turn was replayed with an explicit instruction to answer.
 * So it is checked here, the way the size unit and the minimum are: the topic
 * is found in what they wrote, and the reply has to contain what answers it.
 *
 * Only the topics the facts cover. A price, fees, samples or shipping terms go
 * in the quote, and there is nothing in a reply to check that for.
 */

import { SENTENCE_BREAK, isQuestionSentence } from "./repeatedQuestion";

interface FactTopic {
  topic: string;
  /** They asked about it. */
  asked: RegExp;
  /** The reply says the thing that answers it. */
  answered: RegExp;
  /** The question line in the company facts whose answer this is. */
  factLine?: RegExp;
  /**
   * The reply states this fact outright. Stricter than `answered`, because it
   * decides that something was said unprompted: "based on your kit" is not
   * where we are based.
   */
  volunteered?: RegExp;
}

const TOPICS: FactTopic[] = [
  {
    topic: "the minimum order",
    asked:
      /\b(moq|minimum (?:order|quantit|run|for|to start|on|is|are)|min\.? (?:order|quantit|run)|smallest (?:order|run|quantit)|least (?:amount|order|quantit)|same for (?:stickers|labels|boxes|bags|pouches)|how many (?:to start|minimum)|minimum\b)/i,
    answered: /\b(moq|minimum|1,?000|500)\b/i,
    factLine: /\b(moq|minimum)\b/i,
    volunteered: /\bmoq\b|\bminimum (?:order|is|of|run)\b/i,
  },
  {
    topic: "the turnaround",
    // "how quickly could you ship them out" and "by Friday?" are this question
    // too, and went unanswered in live chats.
    asked:
      /\b(lead ?times?|turn ?around|production time|how long (does|will|would|to)|timeline|how soon|how fast|how quickly|when (can|could|will) (you|i|we)|by (mon|tue|wed|thur|thu|fri|sat|sun)\w*day?\b|rush|urgent|asap)\b/i,
    answered: /\bbusiness days\b/i,
    factLine: /\b(turnaround|timeline|how long)\b/i,
    volunteered: /\bbusiness days\b/i,
  },
  {
    topic: "where we are",
    asked:
      /\b(where are you|where is print247|where('?s| is) (your|the) (company|office|factory|headquarters)|located|location|based (in|out))\b/i,
    answered: /\b(based|located|houston)\b/i,
    factLine: /\b(located|based)\b/i,
    volunteered: /\bhouston\b|\bbased in\b|\blocated in\b/i,
  },
  {
    topic: "whether we make it in-house",
    asked: /\b(in[- ]?house|outsourc|your own factory|manufacture (it|them|this) yourselves)/i,
    answered: /\bin[- ]?house\b/i,
  },
  {
    topic: "what we make",
    // "What are my options" is this question, and was asked twice in a row
    // without ever being answered — the words have to sit next to each other
    // for the first pattern, and there they do not.
    asked:
      /\b(?:what|which) (?:boxes|bags|pouches|stickers|labels|packaging|products?|styles?|options?|types?)\b.*\b(?:you (?:have|make|offer|do|provide)|do you (?:have|make|offer|do|provide)|are available)\b|\bwhat (?:kind|type|sort|style) of (?:boxes|bags|pouches|packaging|products?)\b|\bwhat (?:are|is|were) (?:my|the|our|your|there) (?:other )?(?:options?|choices?)\b|\bwhat options\b|\bwhat (?:do|can|could) you (?:offer|make|do|produce|provide|give)\b|\bwhat else (?:do|can) you\b|\bwhat are the choices\b/i,
    answered: /\b(mailer|rigid|corrugated|shipping|folding|carton|stand[- ]?up|pouch|pouches|mylar|labels?|stickers?|custom)\b/i,
  },
  {
    topic: "how to send or upload logo / artwork",
    asked:
      /\b(?:how (?:do (?:i|you)|can (?:i|we)|should i)|where (?:do (?:i|we)|can (?:i|we)|should i))\b.*\b(?:get|send|upload|share|provide|attach|submit)\b.*\b(?:logo|artwork|files?|images?|design|photo)\b|\bhow do you get (?:my|our) (?:logo|artwork|design|file)\b|\bcan i (?:upload|send|share|attach) (?:my )?(?:logo|artwork|file|design|image)\b/i,
    answered: /\b(?:upload|attach|send|share|email|review)\b.*\b(?:logo|artwork|chat|email|quote|file)\b/i,
  },
  {
    topic: "samples or proofs",
    asked: /\b(?:can (?:i|we) (?:get|have|order) (?:a )?(?:samples?|proofs?)|do you (?:provide|send|do) (?:samples?|proofs?)|physical samples?|digital proofs?)\b/i,
    answered: /\b(?:sample|proof|include|quote|team|rep)\b/i,
  },
  {
    topic: "design assistance / dielines",
    // "I don't have a design yet. Do y'all do designing?" matched none of the
    // first wording of this and went unanswered, so the spoken forms are here
    // too: "do you do designing", "can you guys design it", "design services".
    asked:
      /\b(?:design (?:support|services?|help|assistance|team|work)|dielines?|templates?|designing|graphic design|can (?:you|u|y'?all|yall) (?:guys )?design|do (?:you|u|y'?all|yall) (?:guys )?(?:do|offer|provide|handle|have)[^.?!]{0,25}design|help with (?:design|artwork))\b/i,
    // Not the bare word "design": the minimum is quoted as "1000 per size and
    // per design", which satisfied the old check and let a reply that said
    // nothing about designing count as an answer. This has to be us saying we
    // do it.
    answered:
      /\b(?:design support|in-?house (?:design|engineering|art)|design team|we (?:can|do|offer|provide|have)[^.?!]{0,30}design|dielines?|templates?)\b/i,
  },
  {
    topic: "payment",
    asked:
      /\b(payment methods?|how (can|do) (i|we) pay|pay (by|with|via|invoice)|credit card|accept (cards?|paypal|ach|wire|zelle))\b/i,
    answered: /\b(ach|wire|zelle|payment link)\b/i,
    factLine: /\bpayment\b/i,
    volunteered: /\b(ach|zelle|wire transfer|processing fee)\b/i,
  },
];

/**
 * A message that is nothing but the name of something we publish an answer for.
 *
 * "Moq" — typed on its own, in answer to "how many total designs or SKUs do you
 * have?", by a customer who wanted the figure before committing to anything. It
 * is a question, but with no question mark and no question word nothing saw one:
 * the reply was "Got it." and the next item on the script, the minimum was never
 * given, and "MOQ" went onto the lead as the number of designs.
 *
 * Deliberately narrow. A few words, no digits, and the whole message has to be
 * the topic — "minimum 500" is somebody telling us what they want, not asking.
 */
export function asksBareFactTopic(text: string): string | null {
  const said = String(text || "")
    .trim()
    .replace(/[?.!,;:\s]+$/, "");
  if (!said || /\d/.test(said)) return null;
  if (said.split(/\s+/).length > 3) return null;
  return TOPICS.find((topic) => topic.asked.test(said))?.topic || null;
}

/**
 * Facts a reply recites that nobody asked about.
 *
 * Told to answer a visitor's question from ABOUT US, the writer once answered
 * "What is a standard package size" with the whole block — "About us: We are
 * based in Houston, Tx; standard timeline 12-15 business days; we accept ACH...;
 * MOQ is 1000 per size" — and asked nothing. The minimum is exempt when the
 * quantity is under it, because then saying it is the job.
 */
export function factsVolunteered(visitorSaid: string[], reply: string, options: { minimumDue?: boolean } = {}): string[] {
  const asked = visitorSaid.map((text) => String(text || "")).join("\n");
  return TOPICS.filter(
    (topic) =>
      topic.volunteered &&
      topic.volunteered.test(String(reply || "")) &&
      !topic.asked.test(asked) &&
      !(topic.topic === "the minimum order" && options.minimumDue)
  ).map((topic) => topic.topic);
}

/** The reply without the sentences that recite those facts. */
export function withoutVolunteeredFacts(reply: string, topics: string[]): string {
  const patterns = TOPICS.filter((topic) => topics.includes(topic.topic) && topic.volunteered).map(
    (topic) => topic.volunteered!
  );
  return String(reply || "")
    .split(SENTENCE_BREAK)
    .filter((sentence) => !patterns.some((pattern) => pattern.test(sentence)))
    .join(" ")
    .trim();
}

/**
 * The facts' own answers to topics a reply left out, the first sentence of each.
 *
 * For when a rewrite still did not answer them — in a replay of #4457 the
 * rewrite gave the turnaround and in-house, and dropped the minimum. The first
 * sentence only: some answers carry notes for the writer underneath ("Never
 * give the 1000 figure for a banner") that are not for the customer.
 */
export function answersFromFacts(
  topics: string[],
  facts: string,
  options: { banner?: boolean; pricedBags?: boolean } = {}
): string[] {
  const lines = String(facts || "").split(/\r?\n/);

  return topics.flatMap((name) => {
    if (name === "the minimum order" && options.banner) {
      return ["Banners have no minimum — we make one, two or more."];
    }
    // Bags priced instantly at any quantity — see erpPricing.ts.
    if (name === "the minimum order" && options.pricedBags) {
      return ["We can do small runs of these bags, and the price covers the quantity you want."];
    }

    if (name === "whether we make it in-house") {
      const said = lines.join(" ").replace(/\s+/g, " ").match(/manufactured in-house([^.,;—]*)/i);
      return said ? [`We manufacture in-house${said[1].trimEnd()}.`] : [];
    }

    // The facts answer this under HOW AN ORDER RUNS rather than as a question,
    // so it is taken from the sentence rather than from a Q&A block.
    if (name === "design assistance / dielines") {
      const said = lines.join(" ").replace(/\s+/g, " ").match(/design support[^.]*\./i);
      return [said ? said[0].trim() : "Yes — our in-house design team can do the artwork for you."];
    }

    const topic = TOPICS.find((candidate) => candidate.topic === name);
    if (!topic?.factLine) return [];

    const at = lines.findIndex((line) => line.trim().endsWith("?") && topic.factLine!.test(line));
    if (at < 0) return [];

    const answer: string[] = [];
    for (const line of lines.slice(at + 1)) {
      if (!line.trim() || !/^\s/.test(line)) break;
      answer.push(line.trim());
    }

    const first = answer.join(" ").split(SENTENCE_BREAK)[0]?.trim();
    return first ? [first] : [];
  });
}

/** The answers put in front of the reply's question, after its acknowledgement. */
export function withAnswersBeforeQuestion(reply: string, answers: string[]): string {
  const sentences = String(reply || "").split(SENTENCE_BREAK);
  const at = sentences.findIndex((sentence) => sentence.includes("?"));
  if (at < 0) return [...sentences, ...answers].join(" ");
  return [...sentences.slice(0, at), ...answers, ...sentences.slice(at)].join(" ");
}

/**
 * The fact topics they asked about that the reply leaves unanswered.
 *
 * Only the part of the reply that is not itself a question counts as the
 * answer. Asked "Do you guys print in house?", the writer replied "Do you want
 * us to print in house for boxes, bags, or labels?" — the words were there and
 * nothing had been answered.
 */
export function factQuestionsUnanswered(visitorText: string, reply: string): string[] {
  const statements = String(reply || "")
    .split(SENTENCE_BREAK)
    .filter((sentence) => !isQuestionSentence(sentence))
    .join(" ");

  return TOPICS.filter(
    (topic) => topic.asked.test(String(visitorText || "")) && !topic.answered.test(statements)
  ).map((topic) => topic.topic);
}

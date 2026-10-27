import { createChatCompletion } from "../aiClient";
import { isPlaceholderValue, DEFAULTED_FIELDS, extractSkusInText, type CollectedFields } from "../../domain/quoteFields";
import {
  repeatsTheQuestion,
  questionIn,
  fieldsAskedAbout,
  isQuestionSentence,
  questionSentences,
  SENTENCE_BREAK,
} from "../../domain/repeatedQuestion";
import {
  factQuestionsUnanswered,
  answersFromFacts,
  withAnswersBeforeQuestion,
  factsVolunteered,
  withoutVolunteeredFacts,
} from "../../domain/factQuestions";
import { visitorIsAsking, asksWhatIsUsual, saysTheyDoNotKnow } from "../../domain/askAttempts";
import {
  asksAboutPrice,
  answersAboutPrice,
  parrotsTheirQuestion,
  PRICING_COMES_WITH_THE_QUOTE,
} from "../../domain/visitorQuestions";
import type { ISettings, IQuoteFieldSetting } from "../../models/Settings";
import type { ChatMessage } from "../../models/ChatConversation";
import {
  describeScripts,
  isBagFamily,
  isBannerFamily,
  wantsPlainPackaging,
  asksAboutTheQuote,
} from "../../domain/salesScript";
import { sizeMissingUnit, alreadyAskedTheUnit, sizeIsACapacity } from "../../domain/sizeUnit";
import {
  answerToTheMinimum,
  belowMinimum,
  minimumAlreadyStated,
  minimumApplies,
  MINIMUM_ORDER,
} from "../../domain/minimumOrder";

export interface ChatComposeContext {
  visitorName: string;
  /** The rep the AI is speaking as. First name only. */
  repName: string;
  /** They have chatted with us before, so the opening is not an introduction to a stranger. */
  returning?: boolean;
  /**
   * They have chatted with us before, but with a rep who is no longer in the
   * rotation. Welcomed back, and introduced to the rep they have now — never
   * "Hi, it's Alex again" to somebody who has only ever spoken to Max.
   */
  returningToNewRep?: boolean;
  /** Their latest message asks us things, which this reply has to answer. */
  visitorAsking?: boolean;
  /**
   * A size whose unit we worked out this turn rather than asking for it.
   *
   * Set only on the turn it was decided, so the reply says which way it read
   * them once and never brings it up again.
   */
  assumedSize?: string;
  /** Their latest message says nothing usable — a mistype, random words. */
  unclear?: boolean;
  /**
   * The enquiry is finished and a rep is writing the quote; they have asked
   * something since. This reply answers it and asks for nothing.
   */
  afterTheQuote?: boolean;
  /** A photo or file was shared by the visitor in this turn. */
  sharedFile?: boolean;
  /** The files' names, if provided by SalesIQ. */
  fileNames?: string[];
  /** The contact details we already hold, so the reply never asks for one of them again. */
  contact?: { name?: string; email?: string; phone?: string };
  /**
   * When the reply has to be back with SalesIQ, as a timestamp. A rewrite is
   * skipped past it and the reply is put right in code instead.
   */
  replyBy?: number;
  settings: ISettings;
  fields: IQuoteFieldSetting[];
  collected: CollectedFields;
  /**
   * A contact detail to ask for instead of a script question.
   *
   * The engine decides this, not the model: contact details are asked only once
   * the job is understood, and leaving the moment to the writer had it opening
   * with "can I take your email?".
   */
  ask?: {
    label: string;
    question: string;
    /**
     * Asked part-way through rather than at the end.
     *
     * The closing ask can say the job is done and it only remains to send the
     * quote. An early one cannot: it interrupts the script, so it has to be
     * brief, give its reason, and hand the script straight back.
     */
    early?: boolean;
  };
  companyFacts?: string;
  /**
   * Details already asked for twice without an answer.
   *
   * The one bound left on the writer's own choice of question. Somebody who has
   * ignored a question twice will not answer it the third time, and a chat that
   * keeps circling back to it never reaches the things they would have answered.
   */
  givenUp?: string[];
  /**
   * True while we have neither an email nor a phone number.
   *
   * Both are asked for and only one is needed, but with neither the whole
   * conversation reaches nobody — so the writer is told to make that ask count
   * rather than drop it in as one more question on the list.
   */
  needsAnyContact?: boolean;
  /**
   * The ERP's instant price for a flat or stand up pouch — see erpPricing.ts.
   *
   * `coming`: the engine is putting a price in front of this very reply, so the
   * writer must not say pricing comes later. `line`: the price they were already
   * given, the only figure the writer may ever repeat.
   */
  instantPrice?: { coming?: boolean; line?: string };
  /**
   * A bag priced instantly at any quantity, so the 1000 minimum is never put to
   * them — a price for 500 followed by "our minimum is 1000" takes it back.
   */
  minimumWaived?: boolean;
  messages: ChatMessage[];
  /** What they were reading when they opened the chat. */
  pageTitle: string;
  /** The opening question SalesIQ recorded, if any. */
  question: string;
  questionsForRep: string[];
}

export interface ChatReply {
  /** What to send. */
  reply: string;
  /**
   * Which detail it just asked for, named back to us.
   *
   * Feeds the attempt counter, so a detail nobody will answer is eventually let
   * go rather than chased for the whole conversation.
   */
  asked: string;
}

/**
 * The bot telling the customer it is off to write their quote.
 *
 * Forbidden in the rules and said anyway — twice in one peptide box chat, both
 * times mid-script, so the visitor was told the quote was being prepared and
 * then asked two more questions. The engine decides when a chat is finished and
 * sends the closing line itself; a reply that pre-empts it is either a lie or a
 * chat that ends in the wrong place.
 *
 * Matched narrowly on purpose. Asking where to send a quote is not this, and
 * that ask has to keep working: it is the one that gets us an address.
 */
// Straight and curly apostrophes both: the model writes "I’ll" as often as
// "I'll", and the straight-only version let every curly one through.
const ANNOUNCES_THE_QUOTE =
  /\b(?:i['’]?ll|i will|let me|i['’]?m going to|i am going to|we['’]?ll|we will)\b[^.!?]{0,40}\b(?:prepare|preparing|put together|work up|draw up|start|get|send|have)\b[^.!?]{0,30}\bquote\b|\bquote (?:is|will be) (?:ready|prepared|on its way|coming)\b|\bthat['’]?s (?:everything|all) (?:i|we) need\b/i;

/**
 * The bot promising to go and find something out.
 *
 * "I’ll confirm in-house assembly for sticker sheets, card, envelope..." — said
 * to a customer whose questions the company facts answered, and nobody was
 * going to confirm anything. Either the facts answer it or it goes in the quote.
 */
const PROMISES_TO_CHECK =
  /\b(?:i['’]?ll|i will|let me|we['’]?ll|we will|i['’]?m going to)\s+(?:\w+\s+){0,2}?(?:confirm|check|look into|find out|verify|double-check|get back to you)\b/i;

/**
 * The script's questions in the team's order, for a reply that has to be put
 * right in code. Per field rather than per family: which family applies is the
 * model's call, and a replacement only has to be a question still unanswered.
 */
/**
 * What a rewrite needs to be worth starting: one more model call, which ran
 * 1.0 to 1.7 seconds in testing and 3.3 on a bad one.
 */
const REWRITE_MS = 2500;

/**
 * A reply stating a minimum order. "No minimum" is not one.
 *
 * Checked on banner chats: told banners have none, the writer answered "what is
 * your minimum order?" on a pull-up banner chat with "Our MOQ is 1000 per size"
 * in testing.
 */
const MINIMUM_STATED = /\b1,?000\b|\bmoq\b|\bminimum (?:order |run )?(?:is|of)\b/i;

/**
 * The bot refusing to go on without something. Only a way to reach them is
 * needed, and not even that to keep talking: "I can’t proceed without your name
 * to send the quote" was said to a visitor who did not want to give one.
 */
const REFUSES_TO_GO_ON = /\bcan(?:not|['’]t)\s+(?:proceed|continue|go ahead|move forward)\b/i;

/**
 * The bot giving itself a name.
 *
 * The team asked for this to stop: by day the person who picks the chat up is
 * whoever accepts it first, so being greeted by one name and answered by
 * another reads as being passed around. The prompt no longer carries a name
 * anywhere — not in the persona, not in the transcript labels — but a chat that
 * ran before this change has "Hi, I'm Frank" in its own history, and a model
 * reading that will copy it.
 *
 * Matched on a capitalised word after an introduction, which is what a name
 * looks like and what "I'm happy to help" or "I'm with the team" does not.
 */
// Case is spelled out rather than using the `i` flag: the phrase has to match
// however it is capitalised, but the NAME must stay capital-sensitive or every
// "I'm happy to help" is read as an introduction to somebody called Happy.
const INTRODUCES_BY_NAME =
  /\b(?:[Ii]['’]?m|[Ii] am|[Tt]his is|[Ii]t['’]?s|[Mm]y name is|[Nn]ame['’]?s)\s+(?!With\b|Print247\b)([A-Z][a-z]{1,15})\b/;

/** Whether a reply names itself — exported so the rule can be proved. */
export function introducesByName(reply: string): boolean {
  return INTRODUCES_BY_NAME.test(String(reply || ""));
}

/** The same sentence with the introduction taken out. */
export function withoutTheName(reply: string): string {
  return String(reply || "")
    .split(SENTENCE_BREAK)
    .map((sentence) =>
      INTRODUCES_BY_NAME.test(sentence)
        ? sentence
            // "Hi, I'm Frank." on its own goes entirely; "Hi, I'm Frank, what
            // are you after?" keeps the question.
            .replace(
              /(?:\b[Hh]i|\b[Hh]ello|\b[Hh]ey)?[,!\s]*\b(?:[Ii]['’]?m|[Ii] am|[Tt]his is|[Ii]t['’]?s|[Mm]y name is|[Nn]ame['’]?s)\s+[A-Z][a-z]{1,15}\b(?:\s+again)?[.,!]?\s*/,
              ""
            )
            .trim()
        : sentence
    )
    .filter(Boolean)
    .join(" ")
    .trim();
}

/**
 * Asking whether the quote or an email has arrived yet.
 *
 * "did you email me", then "answer me did you email me" — answered with "I'll
 * include prices, lead times and customization in your quote" and then with the
 * closing line again. Neither says the one thing they asked: it has not been
 * sent yet.
 */
const ASKS_IF_IT_ARRIVED =
  /\b(did|have) you (e-?mail|sent|send)\b|\bany(thing)? (yet|come through)\b|\bnot receiv|\bhaven'?t (got|received)\b|\bwhere('?s| is) (the|my) (quote|email)\b|\bis (the|my) quote (ready|sent|done)\b/i;

/** A reply that answers it: not yet, and when. */
const SAYS_IT_HAS_NOT_GONE =
  /\bnot (yet|been sent|gone)\b|\bhasn'?t (gone|been sent|arrived)\b|\bno(t)? yet\b|\bin the morning\b|\bshortly\b|\bstill (being )?(prepar|writ|work)/i;

const NOT_SENT_YET = "Not yet — the quote has not gone out. You will have it in the morning.";

/** A reply that answers "what is standard?" rather than putting the question back. */
const ANSWERS_WHAT_IS_USUAL =
  /\bno (?:single |one )?standard\b|\bnot standard\b|\bdepends\b|\bmade to fit\b|\bfit what\b|\bgoes inside\b|\bcustom\b|\bany size\b/i;

const NO_STANDARD_SIZE = "There is no standard size — everything is made to fit what goes inside.";
const NO_STANDARD_ANSWER = "There is no standard one — it depends on the job.";

/** Either of those, already said. */
const SAYS_NO_STANDARD = /\bno standard\b|\bmade to fit\b|\bgoes inside\b/i;

/**
 * A sentence that is nothing but politeness.
 *
 * "Thanks Indigo.", "Nice to meet you.", "Thanks for clarifying." — none of
 * them tells the customer anything. Counted as content, they let a reply that
 * ignores the question pass for one that answered it. "Got it, you're looking
 * for labels." is not this: it says what was understood.
 */
const JUST_A_COURTESY =
  /^(?:got it|great|perfect|thanks?|thank you|understood|sure|noted|nice to meet you|good to meet you|pleasure|awesome|excellent|no problem|of course|absolutely|certainly|okay|ok)\b(?:\s+(?:for|to)\b[^.?!]*|\s+[A-Z][\w'’-]*)?[\s,.!?—-]*$/i;

/** What to ask instead of the size, when they cannot give one. */
const WHAT_GOES_INSIDE = "What is going inside, and roughly how big is that?";

/**
 * A reply that actually asks it.
 *
 * Saying there is no standard size and then asking about the finish is not
 * answering them — it drops the size and carries on, which is the thing being
 * fixed. The sentence being present is not enough; the question has to be this
 * one.
 */
const ASKS_WHAT_GOES_INSIDE =
  /go(?:es|ing)? inside|what (?:will|are) you (?:packing|putting|filling)|what will it hold|what (?:is|are) (?:it|they|these) for|what goes in/i;

/**
 * Something we make, named in their own words. Only used to tell whether a
 * product has been mentioned at all, never to decide which one.
 */
const PRODUCT_WORDS =
  /\b(box(es)?|bags?|pouch(es)?|mylar|labels?|stickers?|decals?|banners?|cartons?|mailers?|packaging|sachets?|rolls?|tins?|jars?|cups?|sleeves?|tubes?|cards?|signs?|envelopes?|kits?|packets?|wraps?|film)\b/i;

/** What people type for a finish, and what we make. See normaliseFinish. */
const FINISH_TYPOS: Array<[string, string]> = [
  ["glass", "gloss"],
  ["matt", "matte"],
  ["softtouch", "soft touch"],
];

const SCRIPT_ORDER: Array<{ key: keyof CollectedFields; question: string }> = [
  { key: "product", question: "What are you looking to have made — boxes, bags or labels?" },
  { key: "sizes", question: "What size are you looking for?" },
  { key: "finishes", question: "What finish do you prefer: matte, gloss or soft touch?" },
  { key: "quantity", question: "What quantity are you looking to order for your first run?" },
  { key: "skus", question: "How many total designs or SKU's do you have?" },
  { key: "extras", question: "Do you want me to add a zipper and tear notch?" },
  { key: "material", question: "Do you have any specific material or special features in mind?" },
];

/** The same, sentence by sentence, for when it will not take the hint. */
function withoutTheAnnouncement(reply: string): string {
  return reply
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !ANNOUNCES_THE_QUOTE.test(sentence))
    .join(" ")
    .trim();
}

/**
 * The chat so far, with our side labelled "You" and never by a name.
 *
 * The surest way to stop the bot giving itself a name is for no name to reach
 * it: told in the rules not to use one but shown a transcript labelled "Frank:"
 * on every line, it will eventually sign one. The rep is still recorded on the
 * conversation for the CRM — it simply never appears in the prompt.
 */
function transcriptOf(messages: ChatMessage[]): string {
  const said = messages.filter((message) => message.author !== "system");
  if (said.length === 0) return "(nothing said yet)";
  return said
    .map((message) => `${message.author === "ai" ? "You" : message.author === "rep" ? "Sales rep" : "Visitor"}: ${message.text.trim()}`)
    .join("\n");
}

/**
 * The next thing to say.
 *
 * Returns plain text — SalesIQ renders no markdown, so anything decorative
 * arrives as literal asterisks in the visitor's chat window.
 */
/**
 * A scrap of sentence left hanging after the question.
 *
 * "Could I have your phone number in case we need to check anything? to send
 * the quote over." — a lowercase fragment with no question of its own, stuck
 * on after the question mark. It reads as broken, so it goes; the question stays.
 */
const NICE_TO_MEET = /\b(?:it['’]s\s+)?(?:nice|great|good|lovely|pleasure)\s+(?:to\s+)?meet(?:ing)?\s+you\b(?:,\s*[A-Z][\w'’-]*)?\s*[.!]?\s*/gi;

/**
 * "Nice to meet you" once, and only once we know who they are.
 *
 * It was said while asking for the name — "Nice to meet you. Could I take your
 * name?" — and then again when the name came, "Nice to meet you, Laurie.": two
 * greetings a message apart, the first to nobody. The opening hello may keep
 * it; after that it goes out only with their name, and only the first time.
 */
export function withoutRepeatedGreeting(
  reply: string,
  botSaid: string[],
  knowTheirName: boolean,
  isOpening = false
): string {
  const text = String(reply || "");
  if (isOpening || !new RegExp(NICE_TO_MEET.source, "i").test(text)) return text;

  const saidBefore = botSaid.some((earlier) => new RegExp(NICE_TO_MEET.source, "i").test(earlier));
  if (knowTheirName && !saidBefore) return text;

  const stripped = text
    // "Great, nice meeting you! What size?" keeps its "Great." as a sentence.
    .replace(new RegExp(`,\\s*${NICE_TO_MEET.source}`, "gi"), ". ")
    .replace(NICE_TO_MEET, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  // Whatever now opens the message starts with a capital.
  return stripped ? stripped[0].toUpperCase() + stripped.slice(1) : text;
}

/** A price question on a bag we price instantly: it comes in this chat, shortly. */
export const PRICE_HERE_SHORTLY = "I can give you the exact price right here — I just need a couple more details first.";

export function withoutDanglingTail(reply: string): string {
  // A field label the writer copied from its instructions — "Phone: ", "Email: ".
  const text = String(reply || "").replace(
    /(^|[.!?\n]\s*)(?:phone|email|name)\s*:\s*\??\s*(\S)/gi,
    (_all, before: string, first: string) => `${before}${first.toUpperCase()}`
  );
  const at = text.lastIndexOf("?");
  if (at < 0) return text;
  const tail = text.slice(at + 1).trim();
  if (!tail || !/^[a-z]/.test(tail)) return text;

  // Only when a whole question stands before it. "Phone: ? what number can I
  // reach you at" has nothing before the mark, and cutting there left "Phone: ?".
  const start = Math.max(text.lastIndexOf(".", at), text.lastIndexOf("!", at), text.lastIndexOf("\n", at)) + 1;
  const questionWords = text.slice(start, at).trim().split(/\s+/).filter(Boolean).length;
  return questionWords >= 4 ? text.slice(0, at + 1) : text;
}

export async function composeChatReply(context: ChatComposeContext): Promise<ChatReply> {
  const { settings, fields, collected } = context;

  const known = fields.filter((field) => collected[field.key as keyof CollectedFields]);
  const isOpening = !context.messages.some((message) => message.author === "ai");

  /**
   * A size with numbers and no unit, which we have not queried yet.
   *
   * Decided here rather than left to the rules below, because a size sitting in
   * "already known" is a question the writer has been told never to ask again —
   * so being told to ask it has to come from somewhere the writer cannot read
   * past.
   */
  /**
   * They have named something the bag list does not cover.
   *
   * Said outright rather than left to the rule above, because the moment it goes
   * wrong is the moment the model has nothing left to ask and reaches for the
   * nearest unanswered question.
   */
  const bagQuestionsDoNotApply =
    Boolean(collected.product) && !isBagFamily(collected.product);

  const botSaid = context.messages
    .filter((message) => message.author === "ai")
    .map((message) => message.text);

  const lastFromVisitor = [...context.messages].reverse().find((message) => message.author === "visitor");
  const lastFromBot = [...context.messages].reverse().find((message) => message.author === "ai");

  const needsSizeUnit = sizeMissingUnit(collected.sizes) && !alreadyAskedTheUnit(botSaid);

  /**
   * We asked the size and they said they do not know.
   *
   * The same situation as being asked what is standard, arrived at from the
   * other direction, and owed the same answer: there is no standard size, so
   * say what decides it and ask what is going in the box. On any other field a
   * shrug is a usable answer — a customer with no view on the finish is quoted
   * the one we would use — but nobody can quote a box with no size, and
   * "Size: no idea" is what reached a rep.
   *
   * Once. Somebody who still cannot say after being told is not helped by
   * hearing it again.
   */
  const theirLast = [...context.messages].reverse().find((message) => message.author === "visitor");
  const ourLast = [...context.messages].reverse().find((message) => message.author === "ai");
  const stuckOnTheSize = Boolean(
    theirLast &&
      ourLast &&
      saysTheyDoNotKnow(theirLast.text) &&
      fieldsAskedAbout(questionIn(ourLast.text)).includes("sizes") &&
      !botSaid.some((text) => SAYS_NO_STANDARD.test(text))
  );

  /**
   * They have said what goes in the box, not how big it is.
   *
   * "custom cookie boxes to fit 6, 12 and 24 cookies" is a customer being as
   * precise as they can be: they know the contents, and the box is our job to
   * work out. Asked for a box size anyway, the bot put their own words back in
   * brackets — "What box size are you looking for? (6, 12, and 24 cookies per
   * box)" — which asks and answers in one breath and moves nothing forward.
   *
   * The useful question is how big one of the things going inside is, because
   * that is the number a rep can actually size a box from.
   */
  const sizeGivenAsContents = Boolean(
    !String(collected.sizes || "").trim() &&
      context.messages.some((message) => message.author === "visitor" && sizeIsACapacity(message.text))
  );

  /**
   * A quantity below what we can make, which nobody has told them about yet.
   *
   * Worked out here rather than left to the rules below, for the same reason the
   * size unit is: the writer follows that rule most of the time, and a customer
   * who names eighty and is thanked for it has been accepted for an order that
   * cannot be produced.
   */
  const quantityTooLow =
    !context.minimumWaived &&
    minimumApplies(collected.product) &&
    belowMinimum(collected.quantity) &&
    !minimumAlreadyStated(botSaid);

  /**
   * The minimum was put to them, and they have just asked for the smaller run.
   *
   * The other half of the exchange above, and until now there was no other
   * half. Offered the choice, a customer answered "yes smaller" and the next
   * message asked about materials — the question they had answered vanished,
   * and the exception the team would have considered never reached anybody.
   *
   * Mutually exclusive with quantityTooLow by construction: this needs the
   * minimum already said, that one needs it unsaid.
   */
  const askedForSmaller =
    !context.minimumWaived &&
    minimumApplies(collected.product) &&
    minimumAlreadyStated(botSaid) &&
    Boolean(lastFromVisitor) &&
    answerToTheMinimum(lastFromVisitor!.text, lastFromBot?.text || "") === "smaller";

  /**
   * Banners have no minimum, so it is never raised — not even when asked. Read
   * from their own words too, while the product has not been recorded yet.
   */
  const isBanner =
    isBannerFamily(collected.product) ||
    (!collected.product && context.messages.some((message) => message.author === "visitor" && isBannerFamily(message.text)));

  /**
   * Plain, unprinted packaging: no design, so no designs or SKUs to count.
   *
   * Decided in code because the script lists the SKU question for every family,
   * and the writer asked it straight after being told the box was plain.
   */
  const visitorWords = [
    context.question,
    ...context.messages.filter((message) => message.author === "visitor").map((message) => message.text),
  ];
  const isPlain = wantsPlainPackaging(visitorWords);

  /**
   * Whether anything we make has been named yet — recorded, or in their words.
   *
   * A visitor on the home page, titled "Custom Packaging Boxes, Mylar Bags &
   * Stickers", said "Hi" and was asked "what size are you looking for for your
   * boxes?". The page named three things; the visitor had named none.
   */
  const productNamed =
    Boolean(collected.product && !isPlaceholderValue(collected.product)) ||
    visitorWords.some((text) => PRODUCT_WORDS.test(String(text || "")));

  const visitorHasSpoken =
    context.messages.some((message) => message.author === "visitor") ||
    Boolean(context.question?.trim());

  /**
   * We asked "boxes, bags or labels?" and they answered with something else.
   *
   * "Do you print invitations?" got the question three times running: nothing they
   * said was a product we make, so the line above kept telling the writer to ask it.
   */
  const askedWhatToMake = (text: string) => /\bboxes,?\s+bags,?\s+(?:or|and)\s+labels\b/i.test(text);
  const productQuestionAnswered = context.messages.some(
    (message, index) =>
      message.author === "ai" &&
      askedWhatToMake(message.text) &&
      context.messages
        .slice(index + 1)
        .some((later) => later.author === "visitor" && !/^(?:hi|hello|hey|ok(?:ay)?|thanks?|thank you|yes|yeah|sure)\W*$/i.test(later.text.trim()) && !/\?\s*$/.test(later.text.trim()))
  );

  /**
   * A name, but only when the bot is seeing the chat through itself.
   *
   * Off-hours there is nobody to hand to, so the bot runs the whole
   * conversation as one person — "Hi, I'm Frank" — and the lead is written
   * under that same name, which is how a customer who rings back gets the rep
   * they spoke to.
   *
   * During working hours it opens namelessly, because the chat is passed to
   * whoever accepts it first. Being greeted by Frank and answered by Brian
   * reads as being passed around, or as having been lied to.
   *
   * The engine decides which by blanking `repName` during office hours; this
   * file only reads it. Either way the voice is first person and a person —
   * "I" and "we", never "our team will" or "the assistant".
   */
  const who = context.repName
    ? `You are ${context.repName}, a sales representative at Print247, a printing and packaging company. You are answering the live chat on the website.`
    : "You are a sales representative at Print247, a printing and packaging company. You are answering the live chat on the website.";

  const rules = [
    who,
    `Tone: ${settings.ai.tone}.`,
    "",
    "Your job is to find out what the visitor needs so a quote can be prepared.",
    "You are a person having a conversation, not a form. Read what they say, use",
    "it, and ask the next sensible thing.",
    "",
    "THE SCRIPT — what the team asks, in their order, in their words:",
    "",
    describeScripts({ stateMoq: false }),
    "",
    "How to use it:",
    "- Work out from the conversation which of the three they are buying, then",
    "  work down that list. If you cannot tell yet, find that out first: ask what",
    "  they are looking to have made.",
    "- What they are packing is not what they are buying. 'Food', 'burger',",
    "  'pizza', 'coffee' say what goes inside. Reason from it — someone selling",
    "  pizza needs pizza boxes, someone packing coffee needs pouches — and put",
    "  that to them rather than making them work it out.",
    "- Skip anything they have already told you. Never ask twice for something",
    "  you already have.",
    "- The three lists do not mix. Ask only from the list for what they are",
    "  buying. The zipper and the tear notch are on the bags list and nowhere",
    "  else — a box has no zipper and a label has no tear notch — and the bag",
    "  style question is not a box question however few you have left to ask.",
    "- Running out of questions on their list is not a reason to borrow one from",
    "  another. Ask nothing rather than ask something that does not apply.",
    "- Something that is not a box, a bag or a label — invitations, cards, flyers,",
    "  jars, bottles, clothing — is still their answer. Never ask \"boxes, bags or",
    "  labels?\" again once they have said what they want, and never ask a bag or a",
    "  label question about it: no \"bag size\" for jars, no \"label size\" for an",
    "  invitation. Say you will check with the team whether we can make it, then",
    "  ask its size, then the quantity.",
    "- Plain packaging — plain, blank, unprinted, no print, no design — has no",
    "  artwork, so there are no designs or SKUs to count. Never ask how many",
    "  designs or SKUs a plain order has.",
    "- Ask ONE thing per message, then stop and wait for their answer. Never two",
    "  questions in a message, never a second message before they have replied.",
    "  Two questions at once get one answer and the other is lost for good.",
    "- Use their own words to make a question concrete. Once you know it is",
    "  pizza, 'What size are the pizza boxes — 10, 12, 14 inch?' beats 'What box",
    "  size are you looking for?'.",
    "- When they tell you a unit, use THEIR unit. A customer who answers \"cm\"",
    "  has said centimetres, and reading 4 3/8 back to them as \"4.375 inches\" is",
    "  not a tidier way of writing it down, it is a different size and a wrong",
    "  quote. Convert nothing. Repeat the number and the unit they gave.",
    "- Never say back a finish, style or material we do not make. Somebody",
    "  choosing between matte, gloss and soft touch who types \"glass\" means",
    "  gloss, and \"matt\" means matte — take it as the option they were picking",
    "  from and say it back the way we write it. Repeating their typo tells them",
    "  we sell something we do not.",
    "- Otherwise keep the team's wording, and never turn a question into a yes/no.",
    "  'What label size are you looking for?' must not become 'Are you looking",
    "  for a specific label size?' — that can be answered 'yes' and tells us",
    "  nothing.",
    "- If they answer something other than what you asked, take it, say so, and",
    "  come back round to what is still missing.",
    "",
    "QUANTITY — ask it plainly, and say nothing about a minimum:",
    "- \"What quantity are you looking to order for your first run?\" is the whole",
    "  question. Do not attach a minimum to it. Do not mention an MOQ, a minimum",
    "  order or a per-size figure of your own accord, at any point.",
    "- Exactly two things put it on the table, and nothing else does:",
    "  1. They ask about it. Then give the figure from the written answers below,",
    "     plainly, and carry on with your next question.",
    "  2. They name a quantity under 1000. Then say so, give the minimum and ask",
    "     what they would like to do — still opening by taking in what they said:",
    "     \"Thanks. For a first run our minimum is 1000 per size and per design —",
    "     would that work for you?\"",
    "- Below 1000 is the only number that triggers it. 1000 or more is a quantity",
    "  we can take: acknowledge it and move on to the next question. Never",
    "  volunteer the minimum to somebody who has already cleared it.",
    "- Banners — pull-up, roll-up, pop-up, retractable, backdrops — have NO",
    "  minimum. We make one, two or more. Any quantity is fine: acknowledge it",
    "  and move on. Never mention 1000 or a minimum for a banner.",
    "- Say the minimum once per chat, at most. If you have already said it, never",
    "  say it again — if they say it does not work, cannot meet 1000, or stick to a smaller number,",
    "  acknowledge that (\"Understood, I've noted that.\") and ALWAYS proceed to collect all remaining",
    "  details (size, finish/material, artwork/files) and contact details (email/phone).",
    "  Never drop, abandon, or stop a conversation because of a low quantity request; our team will review their full inquiry.",
    "- The number of designs or SKUs is a SEPARATE question from quantity. Never",
    "  ask for SKUs in the same message as quantity. Never ask for designs or",
    "  SKUs if the customer already told you or if you already asked it earlier in the chat.",
    "",
    "SIZES — a number with no unit is not an answer:",
    "- If they give bare numbers — \"50x30\", \"3.5 x 3.5 x 6\", \"12oz\" is fine —",
    "  ask whether that is inches, cm or mm before you move on. A size a rep",
    "  cannot read is the same as no size at all.",
    "",
    "Hard rules:",
    "- Never state or estimate a price, a discount or a delivery date. Not a",
    "  range, not 'roughly'. A rep prices it.",
    "- Never send a sentence you have already sent in this chat. If they did not",
    "  answer, ask again a different way, with an example of the kind of answer",
    "  you need.",
    "- Every message after your first has two parts, in this order: a few words",
    "  taking in what they just said — strictly acknowledging their IMMEDIATE LAST message",
    "  (e.g., if they just gave their name 'Asad', say 'Thanks Asad.' or 'Nice to meet you, Asad.'; if they gave finish 'gloss', say 'Got it, gloss finish.'; if they said 'no', say 'Understood.').",
    "  CRITICAL: NEVER look backward to repeat a detail from 2 or 3 turns ago (e.g. never repeat 'Noted, 25000' or 'Noted, gloss finish' when they just gave their name or answered 'no').",
    "  Never repeat the exact same acknowledgment phrase you used in previous messages.",
    "- One or two short sentences, under 25 words — except when you are answering",
    "  their questions or giving one of the written answers below, which go out",
    "  complete, every clause.",
    "- Plain text only. No markdown, no bullet points, no emoji.",
    "- Always write your reply in English, whatever language the visitor writes in.",
    "  Read and understand their language, but answer in English: your reply is",
    "  translated into their language before they see it, and an English one is",
    "  what that translation needs.",
    "- No greeting after the first message, and no sign-off, ever.",
    "- Never say the quote is ready, that you have everything, or that a person",
    "  is taking over. You are not told when the chat ends; something else",
    "  decides that.",
    "- Never say you will prepare, put together, work up, start or send a quote.",
    "  Not \"I'll prepare the quote\", not \"I'll get that quote over to you\", not",
    "  at the end and not in passing. Said while you are still asking questions",
    "  it tells the customer you are finished when you are not, and the closing",
    "  line is not yours to write. The one exception is a message where you have",
    "  been told to ask where to send it — there, and only there, you may say",
    "  what the address is for.",
    "",
    "You have no product catalogue, no options list and no price list.",
    "- Never name a material, film, laminate, substrate, thickness or product",
    "  code. Not PET, not PE, not micron figures, not board weights. Those are a",
    "  rep's answer, given after seeing the job.",
    "- Never say how a product performs. Not waterproof, not weatherproof, not",
    "  dishwasher or freezer safe, not food safe, not durable, not eco-friendly,",
    "  not scratch or fade resistant. Asked whether stickers survive a shower or",
    "  which finish is greenest, the honest answer is that it is confirmed with their quote —",
    "  you have no specification in front of you, and a customer who orders on the",
    "  strength of a claim nobody checked is a complaint waiting to happen.",
    "  Answer with what you do have: that comes with the quote, and here is my question.",
    "- Never invent a product style or a list of options. The script's questions",
    "  name the choices you may offer; nothing else does.",
    "- Never ask about the quote itself: a digital proof, artwork or file names,",
    "  a PDF or an approval link, how the quote is laid out or grouped, a",
    "  delivery address, a shipping method or a carrier. A rep sorts all of that",
    "  out once they have the job. Your questions are the script's and the",
    "  contact details, and nothing else.",
    "- SHARED FILES & PHOTOS: If the visitor shares a file, photo, screenshot, or artwork (or asks about a photo/file they sent, such as what material it is or whether we can make it), acknowledge that you have received it and that you / our team will review the attached file/photo directly with their quote. Then continue with your qualification question.",
    "- ALWAYS SPEAK IN THE FIRST PERSON as a sales rep. Never speak in the third person (never say 'They want to know...' or 'The visitor asked...').",
    "",
    ...(context.repName
      ? [
          `- You are ${context.repName}. Speak as yourself, in the first person.`,
          `- Introduce yourself by name ONLY in your first message, e.g. "Hi, I'm ${context.repName}." Never again.`,
        ]
      : [
          "- NEVER give yourself a name and never introduce yourself by one. Not in",
          "  your first message, not ever. No \"Hi, I'm ...\", no sign-off with a name.",
          "  If they ask who they are speaking to, say you are with the Print247 team",
          "  and carry straight on with your question.",
          "- Speak as yourself, in the first person — \"I\" and \"we\".",
        ]),
    "- Never call yourself a bot, an assistant, or an AI.",
    "- Never refer to 'our team' or 'a colleague' as somebody else handling",
    "  this. It is you.",
  ];

  if (context.companyFacts?.trim()) {
    rules.push(
      "",
      "ABOUT US — you may state these and nothing beyond them:",
      context.companyFacts.trim(),
      "",
      "If they ask something these answer, answer it — straight away, in these",
      "words, in the same message as your next question. Never say you will",
      "check, look into or confirm any of them. What you genuinely do not have —",
      "a price, fees or a date for THIS order, and anything these do not cover —",
      "you say you will include in their quote."
    );
  }

  if (settings.ai.extraInstructions?.trim()) {
    rules.push("", "House rules:", settings.ai.extraInstructions.trim());
  }

  const situation = [
    context.visitorName ? `Visitor: ${context.visitorName}` : "The visitor has not given a name.",
    context.pageTitle ? `Page they opened the chat from: ${context.pageTitle}` : "",
    context.question ? `They opened the chat with: ${context.question}` : "",
    "",
    // Said plainly because it was got wrong twice. Several of our pages name
    // boxes, bags and stickers together, and a visitor on the home page was
    // asked what size labels he wanted before typing a word.
    "The page title is a weak hint and nothing more. Several of our pages name",
    "boxes, bags and stickers together, so it does not tell you what they want.",
    "Their own words do.",
    "",
    isOpening
      ? context.returning
        ? context.repName
          ? "This is your FIRST reply in this chat, but they have chatted with you before. Greet " +
            `them as somebody you know — "Hi, it's ${context.repName} again." — not as a stranger.`
          : "This is your FIRST reply in this chat, but they have chatted with us before. Greet them " +
            'as somebody we know — "Welcome back!" — not as a stranger. Give no name, yours or anyone else\'s.'
        : context.returningToNewRep
          ? context.repName
            ? "This is your FIRST reply. They have chatted with us before, but with a colleague — never " +
              `with you. Introduce yourself by name and welcome them back: "Hi, I'm ${context.repName} — ` +
              'welcome back." Never say "again" and never suggest you have spoken before.'
            : "This is your FIRST reply. They have chatted with us before. Welcome them back without " +
              'suggesting you personally spoke to them: "Welcome back." Never say "again", and give no name.'
          : context.repName
            ? "This is your FIRST reply. Introduce yourself by name."
            : "This is your FIRST reply. Say hello and go straight to your question. Do not give a name."
      : context.repName
        ? "The chat is already going. Do not reintroduce yourself."
        : "The chat is already going. Do not introduce yourself and do not give a name.",
    visitorHasSpoken
      ? ""
      : "They have not typed anything — the chat opened on its own, so you do not " +
        "know what they want. Say hello and ask, openly, what they are looking to " +
        "have made. Do not ask a script question and do not assume a product.",
    visitorHasSpoken && !productNamed && productQuestionAnswered
      ? "You have already asked what they want made and they answered with something " +
        "other than a box, bag or label. Do not ask \"boxes, bags or labels?\" again. Take " +
        "what they said as the item, say you will check with the team whether we can make " +
        "it, and ask its size."
      : visitorHasSpoken && !productNamed
        ? "They have not said what they want made yet — a greeting or a question is not " +
          "that. Ask what they are looking to have made: boxes, bags or labels. Do not " +
          "guess it from the page, and do not ask about a size, finish or quantity yet."
        : "",
    "",
    known.length
      ? `Already known — never ask for these again:\n${known
          .map((f) => `  ${f.label}: ${collected[f.key as keyof CollectedFields]}`)
          .join("\n")}`
      : "Nothing known yet.",
    "",
    context.givenUp?.length
      ? `Asked twice already with no answer — let these go and never raise them again: ${context.givenUp.join(", ")}`
      : "",
    bagQuestionsDoNotApply
      ? `They are buying ${collected.product}, not bags. The zipper, the tear notch ` +
        "and the bag style are not part of this job — never raise any of them. If " +
        "their list is finished, ask nothing from another one."
      : "",
    // No capitalised "THIS" in these: the writer read "Say THIS" as words to say
    // and a banner customer got a message opening "THIS. For a first run...".
    // Not a refusal. The team does go under the minimum for some jobs, and a
    // customer told flatly that their number cannot be made closes the window
    // and is gone — the one outcome a chat has no way back from. So the
    // minimum is still said, because a rep cannot be handed a number nobody
    // answered, but it is said as a condition to work around rather than a
    // door being shut.
    quantityTooLow
      ? `The quantity they gave — "${collected.quantity}" — is below our minimum of ${MINIMUM_ORDER} ` +
        `per size${isPlain ? "" : " and per design"}. Your next message does only this: take in ` +
        "what they said, say we can look at it for them, give the minimum plainly, and ask " +
        "whether they would like to go ahead at that or have us see what we can do on the " +
        "smaller run. Never tell them we cannot make their number or that it is too small. " +
        "Do not promise the smaller run outright and do not put a price on it — a rep settles " +
        "that. Do not thank them for the quantity, do not move on to another question, and do " +
        "not start collecting contact details until the minimum has been put to them."
      : "",
    sizeGivenAsContents
      ? "They have told you what goes in the box — how many fit — and not what the box " +
        "measures. That is not them dodging the size question: they know the contents and " +
        "expect us to work out the box. Never treat their count as a size, never repeat it " +
        "back to them in brackets, and never ask whether it is inches, cm or mm. Ask instead " +
        "roughly how big one of the items going inside is, so the box can be sized around it."
      : "",
    askedForSmaller
      ? "They have been told the minimum and have asked for the smaller run anyway. That " +
        "is a real request and the team does take some of them — do not talk them back up " +
        "to the minimum, do not repeat it at them, and do not say no. Say in one short " +
        "sentence that you will put the quantity to the team and come back to them on what " +
        "can be done at it, without promising it and without naming a price, then carry on " +
        "with your next question."
      : "",
    isBanner
      ? `They are buying ${collected.product} — a banner. Banners have no minimum order: ` +
        "we make one, two or more. Whatever quantity they give is fine. Never mention " +
        "1000, an MOQ or any minimum — and if they ask, the answer is that there is no " +
        "minimum on banners."
      : "",
    isPlain
      ? "They want it plain — no printing, no artwork. There are no designs or SKUs, " +
        "so never ask how many designs or SKUs they have. Skip that question entirely." +
        (quantityTooLow || minimumAlreadyStated(botSaid) ? "" : " If a minimum comes up, it is per size only.")
      : "",
    // Told, not asked. The unit question costs a message the customer did not
    // need to spend; saying how it was read costs nothing and invites a
    // one-word correction.
    context.assumedSize
      ? `They gave their size as bare numbers and you have taken it as "${context.assumedSize.replace(/\s*\(assumed\)/, "")}". ` +
        "Say that back in passing — one short clause, as a statement — and then ask your next " +
        "question. Do NOT ask them to confirm the unit, and do not ask whether it is inches, cm or mm."
      : "",
    needsSizeUnit
      ? `The size they gave — "${collected.sizes}" — is numbers with no unit, so nobody can quote it. ` +
        "Your next message asks only whether that is inches, cm or mm. Take in what " +
        "they said first, then ask. It is the only question this message." +
        // "Do y'all do designing?" went unanswered because this rule takes the
        // whole message. One question of ours does not cancel one of theirs.
        (context.visitorAsking
          ? " They have asked you something as well: answer that first, in one short " +
            "sentence, and then ask the unit. Their question is not skipped."
          : "")
      : "",
    // "no idea" to the size question was answered with "Thanks." and the finish
    // question, and the lead went to the rep reading "Size: no idea".
    stuckOnTheSize
      ? "You asked their size and they have told you they do not know. Do not thank " +
        "them for it and do not move on to another question. There is no standard " +
        "size — everything is made to fit what goes inside — so say that, and ask " +
        "what is going in it and roughly how big that is. Never invent a size or " +
        "offer a list of sizes."
      : "",
    // "Q as the Ty of" was recorded as the product and read back to them:
    // "Got it — Q as the Ty of. What is the best email to send the quote to?"
    context.unclear
      ? "Their last message says nothing you can use — a mistype, or words that do not " +
        "mean anything here. Do not repeat it back, do not guess what it meant, and take " +
        "nothing from it. Say you did not catch that and ask what they are looking to " +
        "have made, in plain words."
      : "",
    context.minimumWaived
      ? "These bags are priced at any quantity, so there is NO minimum order for them. Never mention " +
        "a minimum, an MOQ or 1000 per size, even if their quantity is small. If they ask about a " +
        "minimum, say we can do small runs of these bags and the price covers the quantity they want.\n" +
        // The size decides the style — two measurements flat, three stand-up —
        // so the script's style question is a message spent on nothing.
        "Do NOT ask what style of bag they want (flat, stand-up or any other) — we work that out from " +
        "their size. Skip that question in the script entirely."
      : "",
    context.instantPrice?.coming
      ? "Our pricing system is putting their price in this same message, just before your words. " +
        "Do not mention price, cost, figures or the quote at all, and do not say pricing comes later. " +
        "The price opens the message, so do not open with thanks or an acknowledgement either — " +
        "write only your next question."
      : context.instantPrice?.line
        ? `Earlier in this chat our pricing system gave them this price: "${context.instantPrice.line}" ` +
          "If they ask about price, you may repeat exactly those figures and say the final quote confirms it. " +
          "This is the one exception to the rule on prices: never give any other figure, and never " +
          "estimate for a different quantity, size or option."
        : "",
    // "did you email me" answered with the closing line, twice, word for word.
    context.afterTheQuote
      ? "Their enquiry is finished and the quote is being written for them. Answer what " +
        "they just asked, in one or two short sentences, and ask them nothing. You have " +
        "not sent them anything yourself: if they ask whether the quote or an email has " +
        "arrived, say it has not gone out yet and when it will. Never repeat the closing " +
        "line word for word."
      : "",
    context.ask?.early
      ? `Ask for this now, and nothing else — ${context.ask.label}: ${context.ask.question}\n` +
        "Acknowledge what they just told you first, then ask it and say why in the " +
        "same breath: so you can get the quote over to them even if they have to " +
        "go. Do not ask a script question in this message. Pick the script back " +
        "up in your next one."
      : context.ask
      ? `Acknowledge ONLY their immediate last response directly first:
- If they gave their name (e.g. "Asad", "Dave"), say "Thanks [Name]." or "Nice to meet you, [Name]." — NEVER repeat a specification from earlier turns!
- If they gave an email/phone, acknowledge it directly ("Got it, email noted.").
- If they said "no" / "none", say "Understood." — NEVER repeat an old detail!
- If they provided or updated a job detail (like finish, size, or material), acknowledge that specific choice directly.
- If they mentioned having a logo, artwork, or custom design (e.g. "I have a specific logo", "make it rustic"), acknowledge it directly ("Got it, we can include your logo / design on the bags.").
Then ask ONLY for ${context.ask.label}: ${context.ask.question}\n` +
        // Only when it is true. Told this and, two lines on, never to say it,
        // the writer did both: "…in case we need to check anything? to send the
        // quote over."
        (context.needsAnyContact ? "Say briefly why you need it: to send the quote over." : "") +
        (context.needsAnyContact
          ? ""
          : "\nThey have already given you a way to reach them, so this one is a " +
            "nicety, not a requirement. Ask for it plainly and never say you need it " +
            "to send the quote — that is not true, and it reads as a demand.") +
        (context.needsAnyContact
          ? "\nThey have given no email and no phone number, so right now there is " +
            "no way to send them anything. This is the ask that matters. Make it " +
            "easy — say the quote is ready to go and ask where to send it, and " +
            "that either an email or a phone number is fine, whichever suits " +
            "them. Do not demand both."
          : "")
      : "Pick the next unanswered question from the right script and ask it.",
    context.sharedFile
      ? `\nThe visitor just shared a file or photo${context.fileNames?.length ? ` (${context.fileNames.join(", ")})` : ""}. ` +
        "Acknowledge that you received their image/file and that you / our team will review the artwork/specifications with their quote, then ask your one question."
      : "",
    // Answered here, not parked. Framed as "needing a person", a customer's
    // questions about the minimum and the turnaround — both written answers —
    // were left for a rep, and she was asked for her quantity instead.
    context.visitorAsking
      ? "\nTheir last message asks you things. Answer them directly in the first person in this message, before " +
        "whatever else it has to do, one short sentence each:\n" +
        "- Anything ABOUT US covers — the minimum order, the turnaround, where we are, " +
        "that we manufacture in-house, payment — answer in those words.\n" +
        "- If they asked what products, styles, or boxes/bags we make or have (e.g. 'what boxes you have', 'what styles do you do'): State what we make (for boxes: custom mailer boxes, rigid boxes, corrugated shipping boxes, folding cartons, and product boxes; for bags: stand-up pouches, flat-bottom bags, and mylar bags; for stickers: die-cut stickers & labels). Then ask what style they are interested in or what they are packaging.\n" +
        "- If they asked how to send, upload, or share their logo, artwork, file, or design (e.g. 'How do you get my logo', 'where do I send my design'): Say they can upload/attach their logo or artwork right here in the chat, or email it over, and our team will review it directly with their quote.\n" +
        "- If they asked about a photo, image or artwork they shared (e.g. what material is in the photo, or if we can make that style/design), acknowledge the file directly and say we will review the attached photo/artwork on the quote.\n" +
        "- If they asked about samples, proofs, dielines or templates (e.g. 'Can I get a sample?', 'do you provide digital proofs?'): Say we provide digital dielines and sample/proof options will be included directly with their quote.\n" +
        "- If they asked about design assistance or custom artwork (e.g. 'Can you design it for me?', 'I need help with artwork'): Say our in-house design team can assist with the design/layout and we will include design support details in their quote.\n" +
        // Asked "What is a standard package size" in answer to the size
        // question, the bot asked for the size again as if nothing was said.
        "- What is standard, or what you would recommend, for a size, dimension, or package size you are asking " +
        "them: there is no standard, everything is made to fit what goes inside. Say that, then ask what will go in it and roughly how big " +
        "it is. If they do not know, that is fine — move on, and the quote will suggest " +
        "one. Never make up a size or a list of sizes.\n" +
        "- Anything it does not cover — a price, setup or tooling fees, shipping terms, a date for this order, whether we can do something in " +
        "particular — you cannot promise. Say you will include it in their quote. Never " +
        "say you will check, confirm or find out." +
        (context.questionsForRep.length ? `\nQuestions they raised to address directly in your reply:\n${context.questionsForRep.map((q) => `- ${q}`).join("\n")}` : "")
      : "",
    "",
    `Chat so far:\n${transcriptOf(context.messages)}`,
  ].join("\n");

  const responseFormat = {
    type: "json_schema",
    json_schema: {
      name: "chat_reply",
      strict: true,
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          reply: {
            type: "string",
            description:
              "The message to send. Plain text. Short — under 25 words — unless it carries one of the written answers, which go out in full.",
          },
          // An enum, not a description: left free, it came back as "Shipping
          // terms" and "shipping", which went into the attempt counts as fields.
          asked: {
            type: "string",
            enum: ["product", "sizes", "finishes", "quantity", "skus", "extras", "material", "name", "email", "phone", ""],
            description: "Which detail you just asked for. Empty string if you asked for none of them.",
          },
        },
        required: ["reply", "asked"],
      },
    },
  } as const;

  const write = async (correction?: string): Promise<ChatReply> => {
    const response = await createChatCompletion(
      {
        temperature: 0.4,
        messages: [
          { role: "system", content: rules.join("\n") },
          { role: "user", content: situation },
          ...(correction ? [{ role: "user" as const, content: correction }] : []),
        ],
        response_format: responseFormat,
      },
      settings,
      "chat-reply"
    );

    const raw = response.choices[0]?.message?.content;
    if (!raw) throw new Error("The model returned no chat reply");

    const parsed = JSON.parse(raw);
    const reply = String(parsed.reply || "").trim();
    if (!reply) throw new Error("The model returned an empty chat reply");

    return { reply, asked: String(parsed.asked || "").trim() };
  };

  let written = await write();

  /**
   * Only outside the contact ask.
   *
   * That message is told to say what the address is for, so "where should I
   * send the quote" is the point of it rather than a slip.
   */
  const mayNotMentionIt = !context.ask;

  const answeredSince =
    Boolean(lastFromBot && lastFromVisitor) &&
    context.messages.lastIndexOf(lastFromVisitor!) > context.messages.lastIndexOf(lastFromBot!);

  /** What is left of a reply once its own question and a "Got it" come out. */
  const answerPartOf = (reply: string) =>
    reply
      .split(SENTENCE_BREAK)
      .filter((sentence) => !isQuestionSentence(sentence))
      // A whole sentence of courtesy is not an answer either. Asked "What are
      // my options" twice, the bot replied "Nice to meet you. Could I take your
      // name?" and then "Thanks for clarifying. Could I take your name?" — both
      // counted as answers here, because both are longer than fifteen
      // characters, and she was never told her options.
      .filter((sentence) => !JUST_A_COURTESY.test(sentence.trim()))
      .join(" ")
      .replace(/^(got it|great|perfect|thanks|thank you|understood|sure|noted)[,.! ]*/i, "")
      .trim();

  /** Fact questions in their latest message that the reply does not answer. */
  const unansweredFacts = (reply: ChatReply) =>
    lastFromVisitor && context.visitorAsking ? factQuestionsUnanswered(lastFromVisitor.text, reply.reply) : [];

  /**
   * The same question as our last message, after they have answered it.
   *
   * If the visitor asked a question of their own, putting our last question back
   * is acceptable ONLY if we actually answered what they asked!
   */
  const repeatsLast = (reply: ChatReply) => {
    if (!answeredSince || !lastFromBot) return false;
    const isRepeat = repeatsTheQuestion(reply.reply, lastFromBot.text);
    if (!isRepeat) return false;
    if (lastFromVisitor && visitorIsAsking(lastFromVisitor.text)) {
      const answered = answerPartOf(reply.reply).length >= 15 || unansweredFacts(reply).length === 0;
      return !answered;
    }
    return true;
  };

  /** Any question asked in earlier bot messages in this conversation. */
  const earlierAiQuestions = context.messages
    .filter((m) => m.author === "ai")
    .map((m) => questionIn(m.text))
    .filter(Boolean);

  const repeatsEarlier = (reply: ChatReply) => {
    const q = questionIn(reply.reply);
    if (!q) return false;
    const isRepeat = earlierAiQuestions.some((earlier) => repeatsTheQuestion(reply.reply, earlier));
    if (!isRepeat) return false;
    if (lastFromVisitor && visitorIsAsking(lastFromVisitor.text)) {
      const answered = answerPartOf(reply.reply).length >= 15;
      const isImmediateLast = lastFromBot && repeatsTheQuestion(reply.reply, lastFromBot.text);
      return !answered || !isImmediateLast;
    }
    return true;
  };

  /**
   * A detail we already hold. Not extras on a non-bag, and not the size or
   * quantity when this turn is told to query them.
   */
  const weHave = (key: keyof CollectedFields) => {
    const value = collected[key];
    const hasValue = Boolean(value && value.trim() && !isPlaceholderValue(value));
    const alreadyAskedInChat = context.messages.some(
      (m) => m.author === "ai" && fieldsAskedAbout(questionIn(m.text)).includes(key)
    );
    if (key === "skus") {
      const skusInVisitorWords = visitorWords.some((w) => Boolean(extractSkusInText(w)));
      return hasValue || alreadyAskedInChat || skusInVisitorWords;
    }
    if (key === "extras") return hasValue || !isBagFamily(collected.product);
    if (key === "sizes") {
      if (needsSizeUnit) return false;
      return hasValue || alreadyAskedInChat;
    }
    if (key === "quantity") {
      if (quantityTooLow) return false;
      return hasValue || alreadyAskedInChat;
    }
    return hasValue || alreadyAskedInChat;
  };

  /**
   * The detail we already hold that this reply asks for, or "".
   *
   * By the label the writer gave, and by the question's own words, because the
   * label is the writer's word too — see fieldsAskedAbout.
   */
  type Held = keyof CollectedFields | "name" | "email" | "phone";

  const askedForWhatWeHave = (reply: ChatReply): Held | "" => {
    // A contact detail they already gave: asked for "the best delivery address
    // for the quote" in a replay of #4457, with her email two messages up.
    if (reply.asked === "name" || reply.asked === "email" || reply.asked === "phone") {
      return context.contact?.[reply.asked] ? reply.asked : "";
    }
    const labelled = reply.asked as keyof CollectedFields;
    if (labelled && weHave(labelled)) return labelled;
    const worded = fieldsAskedAbout(questionIn(reply.reply)).find((key) => weHave(key as keyof CollectedFields));
    return (worded as keyof CollectedFields | undefined) || "";
  };

  /**
   * A designs or SKUs question on a plain order. Told not to in the prompt, and
   * asked anyway in testing: "Perfect, you've got 10x8x4 inches, 1000 units,
   * matte finish. How many total designs or SKU's do you have?" for a plain
   * white box.
   */
  const asksDesignsOfPlain = (reply: ChatReply) =>
    isPlain && (reply.asked === "skus" || fieldsAskedAbout(questionIn(reply.reply)).includes("skus"));

  /**
   * A contact ask that does not ask for the contact detail.
   *
   * In testing, the turn told to ask for a phone number instead said "I’ll send
   * the quote to priya@…. How many total designs or SKUs do you have?", and the
   * next one said only "I’ll send the quote to priya@…" — no question at all.
   */
  const askKey = context.ask ? context.ask.label.trim().toLowerCase() : "";
  const skipsTheAsk = (reply: ChatReply) =>
    Boolean(askKey) &&
    reply.asked !== askKey &&
    !new RegExp(askKey === "phone" ? "\\b(phone|number)\\b" : `\\b${askKey}\\b`, "i").test(questionIn(reply.reply));

  const statesBannerMinimum = (reply: ChatReply) => isBanner && MINIMUM_STATED.test(reply.reply);

  /**
   * A quantity we cannot make, and the reply says nothing about it.
   *
   * The writer is told plainly to give the minimum and mostly does — but "500"
   * on a Mylar bag enquiry came back with the bag style question and not a word
   * about it, and the same miss turned up once in three test runs on "80". A
   * lead that reaches a rep looking complete with an impossible number on it is
   * worse than one that asks an extra question, so this one does not depend on
   * the model getting it right.
   */
  const skipsTheMinimum = (reply: ChatReply) => quantityTooLow && !MINIMUM_STATED.test(reply.reply);

  /**
   * The minimum given as a flat condition, with nothing offered around it.
   *
   * "Minimum for a first run is 1000 per size and per design." opening a reply
   * to somebody who said 200 is the version that loses them: it is accurate, it
   * is what the old rule asked for, and it reads as a door closing. The team's
   * own answer starts with what they can do.
   *
   * Order matters, so it is checked by sentence rather than by whether the
   * words appear anywhere. "Minimum for a first run is 1000 per size and per
   * design. Would you like to proceed with 1000, or shall I explore options for
   * a smaller run?" does offer the way out — in second place, behind a refusal
   * the customer has already read.
   */
  const OFFERS_TO_LOOK =
    /\b(?:look at|looking at|see what we can do|check what we can do|explore|work with you|come back to you|put (?:it|that) to)\b/i;
  const refusesFlatly = (reply: ChatReply) => {
    if (!quantityTooLow) return false;
    const sentences = reply.reply.split(SENTENCE_BREAK);
    const states = sentences.findIndex((sentence) => MINIMUM_STATED.test(sentence));
    if (states < 0) return false; // skipsTheMinimum has this one.
    const offers = sentences.findIndex((sentence) => OFFERS_TO_LOOK.test(sentence));
    return offers < 0 || offers > states;
  };

  /**
   * They asked for the smaller run, and the reply carries on down the script as
   * though they had not. See askedForSmaller — this is the check that stops it.
   */
  const TAKES_IT_TO_THE_TEAM =
    /\b(?:put (?:it|that|this|\d[\d,]*) to|take (?:it|that|this) to|come back to you|see what (?:we|i) can do|check what (?:we|i) can do|look(?:ing)? into (?:it|that)|run (?:it|that) (?:past|by))\b/i;
  const ignoresTheSmallerRun = (reply: ChatReply) => askedForSmaller && !TAKES_IT_TO_THE_TEAM.test(reply.reply);

  /** What goes in when the writer leaves their request unanswered. */
  const smallerRunLine =
    `Let me put ${String(collected.quantity || "").trim() || "that quantity"} to the team and ` +
    "come back to you on what we can do.";

  /**
   * The minimum, said the way the rules tell the writer to say it.
   *
   * Two versions, and which one goes in depends on what the writer already
   * wrote. The full line opens with the offer rather than the condition: cold,
   * "Our minimum is 1000 per size." in front of a question reads as a rejection
   * the customer has to argue with. But the writer often gets that half right
   * and only forgets the figure, and pasting the whole line in after it
   * produced "We can look at that quantity for you. We can look at that for you
   * — our minimum is 1000 per size and per design." in a live chat. When the
   * offer is already there, only the figure is missing.
   */
  const bareMinimumLine = `Our minimum is ${MINIMUM_ORDER} per size${isPlain ? "" : " and per design"}.`;
  const minimumLine = `We can look at that for you — our minimum is ${MINIMUM_ORDER} per size${isPlain ? "" : " and per design"}.`;

  /** They asked whether it has been sent, and the reply does not say. */
  const theyAskedIfItArrived = Boolean(lastFromVisitor && ASKS_IF_IT_ARRIVED.test(lastFromVisitor.text));
  const dodgesHasItArrived = (reply: ChatReply) =>
    theyAskedIfItArrived && !SAYS_IT_HAS_NOT_GONE.test(reply.reply);



  /**
   * They asked something and the reply only asks them something else.
   *
   * Half the visitor questions in four days of live chats were answered this
   * way: "How much does the 1000 pieces cost?" met with the minimum and the next
   * question, "how quickly could you ship them out" with "What box size are you
   * looking for?".
   */
  const dodgesTheirQuestion = (reply: ChatReply) =>
    Boolean(context.visitorAsking) && answerPartOf(reply.reply).length < 15;

  /** A price question, and a reply that names no price and no quote either. */
  const theyAskedAPrice = Boolean(lastFromVisitor && asksAboutPrice(lastFromVisitor.text));
  // Not when the price is going out with this reply: the engine answers it.
  const dodgesThePrice = (reply: ChatReply) =>
    theyAskedAPrice && !context.instantPrice?.coming && !answersAboutPrice(reply.reply);

  /**
   * Their own question, handed back to them.
   *
   * Compared against each question in their message as well as the whole of it.
   * A visitor who wrote four lines — the product, the capacity, the quantity,
   * and "Do y'all do designing?" — was answered with "Do y'all do designing?",
   * and that went undetected because one short question is a small share of a
   * long message.
   */
  const parrots = (reply: ChatReply) => {
    if (!lastFromVisitor) return false;
    const question = questionIn(reply.reply);
    if (!question) return false;
    return (
      parrotsTheirQuestion(question, lastFromVisitor.text) ||
      questionSentences(lastFromVisitor.text).some((theirs) => parrotsTheirQuestion(question, theirs))
    );
  };

  /** Their own unusable words, read back to them as though they meant something. */
  const echoesTheirWords = (reply: ChatReply) =>
    Boolean(
      context.unclear &&
        lastFromVisitor &&
        reply.reply.toLowerCase().includes(lastFromVisitor.text.trim().toLowerCase())
    );

  /** They asked what is standard, and the reply just asks them instead. */
  const theyAskedWhatIsUsual = Boolean(lastFromVisitor && asksWhatIsUsual(lastFromVisitor.text));
  const dodgesWhatIsUsual = (reply: ChatReply) =>
    (theyAskedWhatIsUsual || stuckOnTheSize) && !ANSWERS_WHAT_IS_USUAL.test(reply.reply);

  /**
   * A question that is neither the script's nor a contact detail.
   *
   * Caught two ways: by what it asks about — see asksAboutTheQuote — and by the
   * writer not being able to name which detail it just asked for.
   */
  const offScript = (reply: ChatReply) => {
    if (isOpening || context.ask || quantityTooLow || needsSizeUnit || context.afterTheQuote) return false;
    const question = questionIn(reply.reply);
    if (!question) return false;
    return asksAboutTheQuote(question) || (reply.asked === "" && !theyAskedWhatIsUsual);
  };

  /** A size, finish, quantity or style question before anything has been named. */
  const asksAheadOfProduct = (reply: ChatReply) => {
    if (productNamed || context.ask) return false;
    const question = questionIn(reply.reply);
    return (
      ["sizes", "finishes", "quantity", "skus", "extras", "material"].includes(reply.asked) ||
      fieldsAskedAbout(question).length > 0 ||
      /\b(style|zipper|tear notch)\b/i.test(question)
    );
  };

  /**
   * Two quote details asked for in one message — "What size and quantity are
   * you thinking for the knit kit boxes?". One gets answered, the other is lost.
   */
  const asksTwoThings = (reply: ChatReply) =>
    new Set(fieldsAskedAbout(questionIn(reply.reply))).size >= 2 || questionSentences(reply.reply).length >= 2;

  const heldValue = (key: Held) =>
    key === "name" || key === "email" || key === "phone" ? context.contact?.[key] : collected[key];

  const repeatsOpening = (reply: ChatReply) => {
    if (!lastFromBot) return false;
    const lastFirst = (lastFromBot.text.split(/[.!?]/)[0] || "").trim().toLowerCase();
    const thisFirst = (reply.reply.split(/[.!?]/)[0] || "").trim().toLowerCase();
    if (!lastFirst || !thisFirst) return false;
    return lastFirst.length > 8 && lastFirst === thisFirst;
  };

  /**
   * Everything wrong with a reply that code can see, as one correction.
   *
   * Each was a rule in the prompt first and each was broken anyway, several in a
   * single chat: a question already answered asked again word for word, a detail
   * we held asked for, "I’ll confirm" about things the facts answer. One rewrite
   * for all of them, so a bad reply costs one extra call and not several.
   */
  const problemsWith = (reply: ChatReply): string[] => {
    const problems: string[] = [];

    if (mayNotMentionIt && ANNOUNCES_THE_QUOTE.test(reply.reply)) {
      problems.push(
        "It announces the quote. You do not decide when the chat is finished, and you never say you will prepare, get or send a quote."
      );
    }
    if (repeatsOpening(reply)) {
      problems.push(
        "It repeats the exact same opening acknowledgment as your previous message. Acknowledge only what the visitor just said in their latest message (e.g. if they gave their name, say 'Thanks [Name].')."
      );
    }
    if (repeatsLast(reply) || repeatsEarlier(reply)) {
      problems.push(
        `It asks what has already been asked in this chat ("${questionIn(reply.reply)}"). ` +
          "Never ask twice for something you already have or already asked. Ask the next unanswered question instead."
      );
    }
    const had = askedForWhatWeHave(reply);
    if (had) {
      problems.push(
        `It asks for ${had}, which you already have: "${heldValue(had)}". Never ask for it again. ` +
          "Ask the next unanswered question instead."
      );
    }
    if (dodgesTheirQuestion(reply)) {
      problems.push(
        "They asked you something and this only asks them something else. Answer them first, in one short sentence, and then ask your question."
      );
    }
    if (dodgesThePrice(reply)) {
      problems.push(
        (context.minimumWaived
          ? "They asked what it costs. Never give a figure yourself — say you can give them the exact price right here once you have a couple more details, then ask your question."
          : "They asked what it costs. Never give a figure, and never answer it with the minimum order — say the pricing comes with their quote, then ask your question.")
      );
    }
    if (parrots(reply)) {
      problems.push("It asks them their own question back. Answer it instead, then ask what you still need.");
    }
    if (dodgesHasItArrived(reply)) {
      problems.push(
        "They asked whether the quote or an email has arrived. Say plainly that it has not gone out yet and when it will — nothing else answers that."
      );
    }
    if (echoesTheirWords(reply)) {
      problems.push(
        "It reads their own unusable words back to them as though they meant something. Say you did not catch that, and ask what they are looking to have made."
      );
    }
    if (offScript(reply)) {
      problems.push(
        "It asks something that is not on the script. Proofs, artwork, file names, PDFs and approval links, how the quote is laid out or grouped, delivery addresses, shipping and carriers are not your questions — a rep sorts those out. Ask the next unanswered question from the script instead."
      );
    }
    if (dodgesWhatIsUsual(reply)) {
      problems.push(
        "They asked what is standard, and this just asks them instead. Say there is no standard — everything is made to fit what goes inside — and then ask what goes in it and roughly how big it is."
      );
    }
    if (asksAheadOfProduct(reply)) {
      problems.push(
        "They have not said what they want made — the page title is not their answer. Ask what they are looking to have made: boxes, bags or labels. Nothing about size, finish or quantity yet."
      );
    }
    if (statesBannerMinimum(reply)) {
      problems.push(
        "It gives a minimum order, and banners have none — we make one, two or more. If they asked, say that instead."
      );
    }
    if (skipsTheMinimum(reply)) {
      problems.push(
        `Their quantity is below our minimum of ${MINIMUM_ORDER}, and this does not say so. Say we can look ` +
          "at it for them and give the minimum plainly, before your question — without it a rep is " +
          "handed a number nobody has answered. Do not tell them we cannot make it."
      );
    }
    if (refusesFlatly(reply)) {
      problems.push(
        "It states the minimum as a flat condition and offers them nothing. Lead with what we can do — " +
          "that we can look at their quantity — and give the minimum after it, not the other way round."
      );
    }
    if (ignoresTheSmallerRun(reply)) {
      problems.push(
        "They have asked for the smaller run and this says nothing about it. Say you will put their " +
          "quantity to the team and come back to them on it, then ask your question. Never repeat the " +
          "minimum at them and never turn them down."
      );
    }
    if (asksTwoThings(reply)) {
      problems.push("It asks for two things at once. Ask for one — the first still unanswered — and nothing else.");
    }
    if (skipsTheAsk(reply)) {
      problems.push(
        `It does not ask for their ${askKey}. This message asks for that and nothing else: "${context.ask!.question}"`
      );
    }
    if (asksDesignsOfPlain(reply)) {
      problems.push(
        "They want it plain, with no printing, so there are no designs or SKUs. Never ask how many. Ask the next unanswered question instead."
      );
    }
    const missed = unansweredFacts(reply);
    if (missed.length) {
      problems.push(
        `It does not answer what they asked about ${missed.join(", ")}. ABOUT US has the answer: give it in those ` +
          "words, one short sentence each, before your question."
      );
    }
    const recited = factsVolunteered(visitorWords, reply.reply, { minimumDue: quantityTooLow });
    if (recited.length) {
      problems.push(
        `It recites ${recited.join(", ")}, which they did not ask about. Leave that out and answer only what they asked.`
      );
    }
    if (!context.afterTheQuote && !reply.reply.includes("?")) {
      problems.push("It asks nothing, which leaves them nothing to answer. End with your one question.");
    }
    if (REFUSES_TO_GO_ON.test(reply.reply)) {
      problems.push(
        "It says you cannot go on without something. Nothing they give is required to keep talking — never say that; just ask."
      );
    }
    // Exempt on the turn they ask to go under the minimum. That one really is a
    // person's decision — it is the only thing in the script the facts do not
    // answer — so "I'll put it to the team" there is the right answer, not the
    // empty promise this rule was written to stop.
    if (PROMISES_TO_CHECK.test(reply.reply) && !askedForSmaller) {
      problems.push(
        "It says you will confirm, check or find out something. Never say that. If ABOUT US answers it, answer it; if not, say you will include it in their quote."
      );
    }

    return problems;
  };

  const problems = problemsWith(written);

  // A rewrite is a second model call, and SalesIQ stops waiting at about ten
  // seconds — one test turn took 10.0 with the model slow on both reads. Out of
  // time, the checks below still put the reply right in code.
  const timeForARewrite = !context.replyBy || Date.now() + REWRITE_MS < context.replyBy;
  if (problems.length && !timeForARewrite) {
    console.warn(`[chat] no time to rewrite (${problems.length} problem(s)), fixing in code: ${written.reply}`);
  }

  if (problems.length && timeForARewrite) {
    console.warn(`[chat] rewriting a reply — ${problems.length} problem(s): ${written.reply}`);
    written = await write(
      `That reply has ${problems.length === 1 ? "a problem" : "problems"}: "${written.reply}"\n` +
        problems.map((problem) => `- ${problem}`).join("\n") +
        "\nWrite it again: take in what they just said, then your one question."
    );
  }

  // Twice is enough. The sentence comes out and what is left — an
  // acknowledgement and a question — is the message it should have been.
  if (mayNotMentionIt && ANNOUNCES_THE_QUOTE.test(written.reply)) {
    const kept = withoutTheAnnouncement(written.reply);
    console.warn(`[chat] took the quote line out: ${written.reply}`);
    if (kept) written = { reply: kept, asked: written.asked };
  }

  
  /** The next script question still unanswered, not one of those named, and not the one we just asked. */
  const nextQuestion = (skip: string[], allowRepeat = false) =>
    SCRIPT_ORDER.find(
      ({ key, question }) =>
        !skip.includes(key) &&
        fields.some((field) => field.key === key) &&
        !(collected[key] && !isPlaceholderValue(collected[key])) &&
        !(context.givenUp || []).includes(key) &&
        // Named in their words but not yet recorded is still named: a sticker
        // kit enquiry was asked "What are you looking to have made?".
        !(key === "product" && productNamed) &&
        !(key === "skus" && (weHave("skus") || isPlain)) &&
        !(key === "extras" && !isBagFamily(collected.product)) &&
        (allowRepeat || !context.messages.some((m) => m.author === "ai" && repeatsTheQuestion(question, m.text)))
    );

  const beforeFixes = written;

  // Facts nobody asked about come out, sentence by sentence.
  const stillRecited = factsVolunteered(visitorWords, written.reply, { minimumDue: quantityTooLow });
  if (stillRecited.length) {
    console.warn(`[chat] took out what nobody asked about (${stillRecited.join(", ")}): ${written.reply}`);
    written = { reply: withoutVolunteeredFacts(written.reply, stillRecited), asked: written.asked };
  }

  // A name the bot gave itself comes out — see INTRODUCES_BY_NAME. Only when it
  // was not supposed to have one: off-hours it runs the whole chat as a named
  // person and the lead is written under that name, so the introduction is the
  // point. By day it has no name, and the name it would invent is very likely
  // not the one of whoever answers them next.
  if (!context.repName && INTRODUCES_BY_NAME.test(written.reply)) {
    const stripped = withoutTheName(written.reply);
    console.warn(`[chat] took a name out of the reply: ${written.reply}`);
    if (stripped) written = { reply: stripped, asked: written.asked };
  }

  // A minimum on a banner chat comes out. If they asked, the facts step below
  // puts "no minimum" in its place.
  if (statesBannerMinimum(written)) {
    console.warn(`[chat] took a minimum out of a banner reply: ${written.reply}`);
    written = {
      reply: written.reply
        .split(SENTENCE_BREAK)
        .filter((sentence) => !MINIMUM_STATED.test(sentence))
        .join(" ")
        .trim(),
      asked: written.asked,
    };
  }

  // Still the same question, or still asking for what we have: the question is
  // swapped for the next one on the script rather than sent again.
  const stillHad = askedForWhatWeHave(written);
  if (repeatsLast(written) || repeatsEarlier(written) || stillHad || asksDesignsOfPlain(written)) {
    const next = nextQuestion([written.asked, stillHad, "skus"]);
    const kept = written.reply
      .split(SENTENCE_BREAK)
      .filter((sentence) => !sentence.includes("?"))
      .join(" ")
      .trim();

    console.warn(`[chat] still repeating after a rewrite, asking ${next?.key || "nothing"} instead: ${written.reply}`);

    if (next) {
      written = { reply: `${kept ? `${kept} ` : ""}${next.question}`, asked: next.key };
    } else if (kept) {
      written = { reply: kept, asked: "" };
    }
  }

  // Still two things in one question: cut to the first of them still unanswered.
  if (asksTwoThings(written)) {
    const keys = fieldsAskedAbout(questionIn(written.reply));
    const first = SCRIPT_ORDER.find(
      ({ key }) => keys.includes(key) && !(collected[key] && !isPlaceholderValue(collected[key])) && !(key === "skus" && isPlain)
    );
    if (first) {
      const kept = written.reply
        .split(SENTENCE_BREAK)
        .filter((sentence) => !sentence.includes("?"))
        .join(" ")
        .trim();
      console.warn(`[chat] still two questions, asking only ${first.key}: ${written.reply}`);
      written = { reply: `${kept ? `${kept} ` : ""}${first.question}`, asked: first.key };
    }
  }

  // Still two question sentences: keep the first and drop the rest.
  if (questionSentences(written.reply).length >= 2) {
    let asked = false;
    console.warn(`[chat] still two question sentences, keeping the first: ${written.reply}`);
    written = {
      reply: written.reply
        .split(SENTENCE_BREAK)
        .filter((sentence) => {
          if (!isQuestionSentence(sentence)) return true;
          if (asked) return false;
          asked = true;
          return true;
        })
        .join(" ")
        .trim(),
      asked: written.asked,
    };
  }

  // "I can't proceed without…" comes out.
  if (REFUSES_TO_GO_ON.test(written.reply)) {
    written = {
      reply: written.reply
        .split(SENTENCE_BREAK)
        .filter((sentence) => !REFUSES_TO_GO_ON.test(sentence))
        .join(" ")
        .trim(),
      asked: written.asked,
    };
  }

  // Still asking about a product nobody has named: ask what they want made.
  if (asksAheadOfProduct(written)) {
    const kept = written.reply
      .split(SENTENCE_BREAK)
      .filter((sentence) => !sentence.includes("?"))
      .join(" ")
      .trim();
    console.warn(`[chat] asked about a product nobody named, asking what they want made: ${written.reply}`);
    written = { reply: `${kept ? `${kept} ` : ""}${SCRIPT_ORDER[0].question}`, asked: "product" };
  }

  // Still off the script: ask the next thing the team actually asks.
  if (offScript(written)) {
    const next = nextQuestion([]);
    if (next) {
      const kept = written.reply
        .split(SENTENCE_BREAK)
        .filter((sentence) => !sentence.includes("?"))
        .join(" ")
        .trim();
      console.warn(`[chat] off-script question, asking ${next.key} instead: ${written.reply}`);
      written = { reply: `${kept ? `${kept} ` : ""}${next.question}`, asked: next.key };
    }
  }

  // A contact ask that still does not ask for the detail gets its own question,
  // after whatever acknowledgement the reply had — and without a quote line.
  if (skipsTheAsk(written)) {
    const kept = written.reply
      .split(SENTENCE_BREAK)
      .filter((sentence) => !sentence.includes("?") && !ANNOUNCES_THE_QUOTE.test(sentence))
      .join(" ")
      .trim();
    console.warn(`[chat] contact ask did not ask for ${askKey}, asking it: ${written.reply}`);
    written = { reply: `${kept ? `${kept} ` : ""}${context.ask!.question}`, asked: askKey };
  }

  // A reply that asks nothing leaves them nothing to answer, and the chat
  // stops. Not on a contact ask, which is told to ask for that and nothing else.
  if (!context.ask && !context.afterTheQuote && !written.reply.includes("?")) {
    const next = nextQuestion([]);
    if (next) {
      console.warn(`[chat] reply asked nothing, adding the ${next.key} question: ${written.reply}`);
      written = { reply: `${written.reply ? `${written.reply} ` : ""}${next.question}`, asked: next.key };
    } else {
      // If all script questions are done, ask for missing contact info rather than leaving a bare acknowledgment!
      if (!context.contact?.name) {
        console.warn(`[chat] reply asked nothing and script done, asking for name: ${written.reply}`);
        written = { reply: `${written.reply ? `${written.reply} ` : ""}Could I take your name?`, asked: "name" };
      } else if (!context.contact?.phone && (context.needsAnyContact || (settings.chat.askContactFields || []).includes("phone"))) {
        console.warn(`[chat] reply asked nothing and script done, asking for phone: ${written.reply}`);
        written = { reply: `${written.reply ? `${written.reply} ` : ""}Could I have your phone number in case we need to check anything?`, asked: "phone" };
      } else if (!context.contact?.email) {
        console.warn(`[chat] reply asked nothing and script done, asking for email: ${written.reply}`);
        written = { reply: `${written.reply ? `${written.reply} ` : ""}What is the best email to send the quote to?`, asked: "email" };
      }
    }
  }

  if (!written.reply.trim()) written = beforeFixes;

  written = { ...written, reply: withoutDanglingTail(written.reply) };
  written = {
    ...written,
    reply: withoutRepeatedGreeting(written.reply, botSaid, Boolean(context.visitorName), isOpening),
  };

  // They cannot give a size: the question is replaced, not just prefixed.
  // Prefixing it left "There is no standard size... What finish do you prefer?",
  // which moves on from the one field that cannot be guessed.
  if (stuckOnTheSize && !ASKS_WHAT_GOES_INSIDE.test(questionIn(written.reply))) {
    console.warn(`[chat] they could not give a size, asking what goes inside: ${written.reply}`);
    written = { reply: `${NO_STANDARD_SIZE} ${WHAT_GOES_INSIDE}`, asked: "sizes" };
  }

  // Still no answer to "what is standard?": say it before the question.
  if (dodgesWhatIsUsual(written)) {
    const aboutSize = stuckOnTheSize || /\bsizes?\b|\bdimension/i.test(lastFromVisitor!.text);
    console.warn(`[chat] answered "what is standard" with a question, saying there is none: ${written.reply}`);
    written = {
      reply: `${aboutSize ? NO_STANDARD_SIZE : NO_STANDARD_ANSWER} ${written.reply}`.trim(),
      asked: written.asked,
    };
  }

  // Still no answer to a price question: say where the price comes from.
  if (dodgesThePrice(written)) {
    console.warn(`[chat] price question unanswered, saying where pricing comes from: ${written.reply}`);
    const question = questionIn(written.reply);
    // Bags we price here get the price in this chat, not with a quote later.
    const whereItComesFrom = context.minimumWaived ? PRICE_HERE_SHORTLY : PRICING_COMES_WITH_THE_QUOTE;
    written = { reply: `${whereItComesFrom}${question ? ` ${question}` : ""}`.trim(), asked: written.asked };
  }

  // Still not answering whether it has been sent: say so in plain words.
  if (dodgesHasItArrived(written)) {
    console.warn(`[chat] did not answer whether the quote had been sent: ${written.reply}`);
    written = { reply: NOT_SENT_YET, asked: "" };
  }

  // Still handing their own question back: it is replaced by the next thing on
  // the script. Answering it is the rewrite's job and there is not always time
  // for one, but asking it back is never right.
  if (parrots(written)) {
    const next = nextQuestion([]);
    const kept = written.reply
      .split(SENTENCE_BREAK)
      .filter((sentence) => !sentence.includes("?"))
      .join(" ")
      .trim();
    console.warn(`[chat] asked their own question back, asking ${next?.key || "nothing"} instead: ${written.reply}`);
    if (next) written = { reply: `${kept ? `${kept} ` : ""}${next.question}`, asked: next.key };
    else if (kept) written = { reply: kept, asked: "" };
  }

  // Still reading their gibberish back: say so plainly and ask again.
  if (echoesTheirWords(written)) {
    console.warn(`[chat] repeated a visitor's unusable words, asking again instead: ${written.reply}`);
    written = { reply: `Sorry, I didn't catch that. ${SCRIPT_ORDER[0].question}`, asked: "product" };
  }

  /**
   * A unit we assumed, said out loud.
   *
   * The whole trade is that we take the guess instead of asking — which is only
   * fair if they can see it. Two replies in three came back "Got it, 50x30."
   * with the millimetres kept to ourselves, so the size they read back is the
   * one we wrote down.
   */
  if (context.assumedSize) {
    const shown = context.assumedSize.replace(/\s*\(assumed\)\s*/g, "").trim();
    const bare = shown.replace(/\s+\S+$/, "").trim();
    if (shown && !written.reply.includes(shown)) {
      console.warn(`[chat] reply did not say the size was read as ${shown}: ${written.reply}`);
      written = {
        reply:
          bare && written.reply.includes(bare)
            ? written.reply.replace(bare, shown)
            : `Taking that as ${shown}. ${written.reply}`.trim(),
        asked: written.asked,
      };
    }
  }

  // A doubled small word: "what size are you looking for for your boxes?".
  written = {
    reply: written.reply.replace(/\b(for|the|to|a|an|of|in|on|you|your|is|and)\s+\1\b/gi, "$1"),
    asked: written.asked,
  };

  // A finish typo is never said back: "glass" was answered with "finish: glass,
  // which we treat as gloss". Only when their message was that short answer,
  // so "labels for glass jars" is left alone.
  if (lastFromVisitor && lastFromVisitor.text.trim().split(/\s+/).length <= 4) {
    const typo = FINISH_TYPOS.find(([word]) => new RegExp(`\\b${word}\\b`, "i").test(lastFromVisitor.text));
    if (typo && new RegExp(`\\b${typo[0]}\\b`, "i").test(written.reply)) {
      written = { reply: written.reply.replace(new RegExp(`\\b${typo[0]}\\b`, "gi"), typo[1]), asked: written.asked };
    }
  }

  // A quantity we cannot make, still unmentioned after the rewrite: the
  // minimum goes in front of the question rather than being left to chance.
  if (skipsTheMinimum(written)) {
    console.warn(`[chat] quantity below the minimum and the reply did not say so: ${written.reply}`);
    const line = OFFERS_TO_LOOK.test(written.reply) ? bareMinimumLine : minimumLine;
    written = { reply: withAnswersBeforeQuestion(written.reply, [line]), asked: written.asked };
  }

  // They asked for the smaller run and the rewrite still walked past it. Left to
  // chance this is the one that loses the customer — they answered the question
  // we put to them and got the next item on the script back.
  if (ignoresTheSmallerRun(written)) {
    console.warn(`[chat] asked to go under the minimum and the reply did not answer it: ${written.reply}`);
    written = { reply: withAnswersBeforeQuestion(written.reply, [smallerRunLine]), asked: written.asked };
  }

  // Fact questions still unanswered after the rewrite get the facts' own
  // answers, in front of the question.
  const stillMissed = unansweredFacts(written);
  if (stillMissed.length && context.companyFacts) {
    const answers = answersFromFacts(stillMissed, context.companyFacts, {
      banner: isBanner,
      pricedBags: context.minimumWaived,
    });
    if (answers.length) {
      console.warn(`[chat] added what the reply left out (${stillMissed.join(", ")}): ${written.reply}`);
      written = { reply: withAnswersBeforeQuestion(written.reply, answers), asked: written.asked };
    }
  }

  return written;
}

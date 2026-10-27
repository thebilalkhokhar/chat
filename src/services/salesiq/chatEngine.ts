import type { Connection, HydratedDocument, Model } from "mongoose";
import { chatConversationModel, IChatConversation, HandoffReason, type ChatAttachment } from "../../models/ChatConversation";
import { extractFields } from "../extractor";
import { composeChatReply } from "./chatComposer";
import {
  missingFields,
  isComplete,
  withDefaults,
  extractSkusInText,
  isDesignCountAnswer,
} from "../../domain/quoteFields";
import type { ConversationMessage } from "../../models/Conversation";
import type { ISettings } from "../../models/Settings";
import { pickRepForChat, inRotation } from "./repPool";
import { extractContact } from "./contactExtractor";
import {
  missingContactFields,
  contactFieldByKey,
  isPlaceholderName,
  isContactValueUsable,
  hasReachableContact,
  emailIn,
  isOurRepsName,
  REACHABLE_KEYS,
} from "../../domain/contactFields";
import {
  MAX_ASKS,
  askOutcome,
  applyAskOutcome,
  isContactKey,
  visitorIsAsking,
  saysNothingUseful,
} from "../../domain/askAttempts";
import { asksBareFactTopic } from "../../domain/factQuestions";
import { chatIsAboutAJob, chatIsAPitch, PITCH_MESSAGE } from "../../domain/notACustomer";
import { isOfficeHours } from "../../domain/officeHours";
import {
  answerToTheMinimum,
  belowMinimum,
  minimumAlreadyStated,
  minimumApplies,
  quantityIsAPackCount,
  tidyQuantity,
  MINIMUM_ORDER,
} from "../../domain/minimumOrder";
import { isOurEmail } from "../../domain/ourOwnContacts";
import {
  sizeMissingUnit,
  unitAnswer,
  guessUnit,
  sizeWithAssumedUnit,
  unitWasAssumed,
  withCorrectedUnit,
  withoutAssumedMark,
  tidySize,
  sizeIsAPackCount,
} from "../../domain/sizeUnit";
import { fieldsAskedAbout } from "../../domain/repeatedQuestion";
import { earlierChatFor } from "./sameCustomer";
import { isPleasantry } from "./handoff";
import { getChatCompleteMessage, isChatCompleteMessage, whenTheTeamReplies } from "../../domain/chatCompleteMessage";
import { ENGLISH } from "../../domain/visitorLanguage";
import { replyLanguageFor, translateReplies, SEND_BY_MS, TRANSLATION_MS } from "./replyLanguage";
import {
  isConfigured as isPricingConfigured,
  priceRequestFor,
  priceKey,
  fetchPrice,
  describePrice,
  describePriceForRep,
  needsGusset,
  gussetAsks,
  gussetQuestion,
  withGusset,
  dimensionsInInches,
  ASKS_THE_GUSSET,
  minimumWaivedFor,
  quantityGivenByThem,
  quantityIsTheDesignCount,
  type PriceRequest,
  type PriceResult,
} from "../erpPricing";

/**
 * Deciding what the bot says next.
 *
 * One visitor message in, one reply out. Everything that decides whether the
 * bot keeps asking or hands over lives here, so "why did it say that?" has a
 * single place to be answered — the same reason `rejectionReason` exists on the
 * email side.
 *
 * The order of the checks matters and is deliberate: a visitor who asks for a
 * person gets one before anything else is considered, and the turn limit is
 * applied before composing rather than after, so the bot cannot talk past it.
 */

export interface ChatTurn {
  /** What to say. Empty when the bot should stay silent. */
  reply: string;
  /**
   * Say nothing at all, rather than fall back to the holding line.
   *
   * An empty reply on its own is indistinguishable from a turn that failed, and
   * the webhook answers that with "one of our team will be with you shortly".
   * This is the difference between having nothing to say and having gone wrong.
   */
  silent?: boolean;
  /** Set when this turn ends the bot's involvement. */
  handoff?: HandoffReason;
  /** Messages sent as their own bubbles ahead of `reply` — see the webhook. */
  before?: string[];
  conversation: IChatConversation;
}

/** The SalesIQ payload, reduced to what a turn actually needs. */
export interface IncomingChat {
  conversationId: string;
  uvid: string;
  /** SalesIQ's own conversation number; on `message` payloads, never on the opening `trigger`. */
  salesIqConversationId?: string;
  uuid: string;
  visitorId: string;
  name: string;
  email: string;
  phone: string;
  landingPageTitle: string;
  currentPageUrl: string;
  landingPageUrl?: string;
  referer?: string;
  visitorChannel?: string;
  question: string;
  departmentId: string;
  /** The visitor's message. Absent on the opening trigger. */
  text: string;
  /** A photo or file came with this message; `text` then holds only its caption, if any. */
  sharedFile?: boolean;
  /** The files' names, where SalesIQ gives them. */
  fileNames?: string[];
  /** The files themselves, where SalesIQ links them. */
  files?: ChatAttachment[];
  /** SalesIQ's `msgid` for this message. Present on about half of them. */
  messageId?: string;
}

/**
 * Phrases that mean "stop talking to me and get a person".
 *
 * Checked in plain code rather than by asking the model, because a visitor who
 * has asked for a human should not have to wait on an API call to get one, and
 * a model that misreads this keeps someone trapped talking to a bot.
 */
const WANTS_HUMAN =
  /\b(human|person|agent|representative|rep\b|real (?:person|human)|someone else|speak to (?:a|an|someone|sales|support|rep)|talk to (?:a|an|someone|sales|support|rep)|operator|manager|customer service|live support|live chat|live agent)\b|\b(?:don'?t|do not|not|no|stop|hate)\s+(?:want\s+to\s+)?(?:talk(?:ing)?\s*(?:to)?\s+|speak(?:ing)?\s*(?:to)?\s+|chat(?:ting)?\s*(?:with)?\s+)?(?:an?\s+)?(?:ai|bot|robot|automated|machine)\b|\b(?:are you|is this)\s+(?:an?\s+)?(?:ai|bot|robot)\b/i;

/**
 * Whether they asked for a person — with email addresses taken out first.
 *
 * An address is not a request: "human.e2e@example.com" or "agent@acme.com"
 * typed in answer to the email question handed the chat over, without the
 * address, and wrote no lead.
 */
export function wantsAPerson(text: string): boolean {
  return WANTS_HUMAN.test(String(text || "").replace(/\S+@\S+/g, " "));
}

/**
 * They asked, in so many words, whether they are talking to a bot.
 *
 * It goes to a person like any other request for one, but it is a question and
 * gets a straight answer. "are you bot" was met with "Great, thank you. I will
 * connect with you in the morning." — the line written for somebody who had
 * asked for a human, which answers nothing and dodges what they asked.
 */
const ASKS_IF_BOT =
  /\b(?:are you|r u|is this|am i (?:talking|speaking|chatting) (?:to|with))\s+(?:an?\s+|the\s+)?(?:real\s+)?(?:ai|bot|robot|chat ?bot|automated|machine|human|person)\b/i;

export function asksIfWeAreABot(text: string): boolean {
  return ASKS_IF_BOT.test(String(text || ""));
}

/**
 * Their message with the "are you a bot?" sentence taken out, to see whether
 * they asked for a person as well. "Are you a real person or a robot?" names a
 * person and is still only a question.
 */
function withoutTheBotQuestion(text: string): string {
  return String(text || "").replace(
    /\b(?:are you|r u|is this|am i (?:talking|speaking|chatting) (?:to|with))\b[^.?!]*[.?!]?/gi,
    " "
  );
}

/**
 * Asked whether we are a bot, and nothing more: answered straight, and the chat
 * carries on.
 *
 * It used to hand the chat over. Of four hand-overs in a day and a half, two were
 * only this question, and one of those — "I need individual boxes for my peptide
 * vials" — closed with no email and no lead, because the hand-over had become the
 * end of the conversation. Asking is curiosity, not a request for somebody else.
 */
export function asksOnlyIfWeAreABot(text: string): boolean {
  return asksIfWeAreABot(text) && !wantsAPerson(withoutTheBotQuestion(text));
}

export const ANSWER_TO_ARE_YOU_A_BOT =
  "I'm Print247's automated assistant. I'll take down what you need, and our team will follow up with your quote.";

/**
 * They are done with us: not interested, never mind, stop messaging.
 *
 * "No longer interested goodbye" was answered "Understood. What size are you
 * looking for?" — the script does not know how to stop. Checked in code, like
 * the request for a person: the model carried on regardless.
 */
const DONE_WITH_US =
  // "Not interested in the zipper" declines a detail, not us, hence the lookahead.
  /\b(?:(?:no longer|not|am not|i'?m not)\s+interested\b(?!\s+in\b)|never\s?mind|forget (?:it|about it)|leave me alone|stop (?:messaging|texting|contacting|calling)|unsubscribe|don'?t (?:contact|message|text|call) me|ya no me interesa)|\b(?:good\s?bye|bye[\s-]bye)\b/i;

export function isDoneWithUs(text: string): boolean {
  return DONE_WITH_US.test(String(text || "")) && !/\?/.test(String(text || ""));
}

export const DONE_WITH_US_MESSAGE =
  "Understood, thanks for your time. If you need packaging later, just message us here.";

/**
 * Offering a phone number, in English or Spanish, rather than giving one.
 *
 * "Te puedo pasar mi número de teléfono?" was answered with how to upload
 * artwork, then the email question twice; they left, and with no address and no
 * number nothing reached a rep.
 */
const OFFERS_A_NUMBER =
  /\b(?:can|could|may|shall|should)\s+i\s+(?:just\s+)?(?:give|send|share|leave|pass|text)\s+(?:you\s+)?(?:my\s+)?(?:phone|number|cell|mobile|whats\s?app|contact)|\bcall me\b|\b(?:te|le)?\s*puedo\s+(?:pasar|dar|enviar|mandar)(?:te|le)?\s+(?:mi\s+)?(?:n[uú]mero|tel[eé]fono|cel(?:ular)?|whats\s?app)/i;

export function offersAPhoneNumber(text: string): boolean {
  return OFFERS_A_NUMBER.test(String(text || ""));
}

export const YES_SEND_YOUR_NUMBER = "Yes, please. What's the best phone number to reach you on?";

/** When they will hear back comes from the same Texas-time windows as the closing line. */
export function answerToAreYouABot(canReachThem: boolean, at: Date = new Date()): string {
  const when = whenTheTeamReplies(at);
  return canReachThem
    ? `I'm Print247's automated assistant, so I've passed your chat to our team. Someone will get back to you ${when}.`
    : `I'm Print247's automated assistant, so I'm passing your chat to our team. Could you share your email so they can get back to you ${when}?`;
}

/**
 * Somebody who is already a customer, not somebody asking for a quote.
 *
 * The script assumes every visitor is a new enquiry, and runs at them
 * accordingly. A woman who had bought labels and not received them was asked
 * what bag size she wanted, then what label size, then how many SKUs — while
 * she was saying "I already have them" and naming two reps who had gone quiet
 * on her. Qualifying an existing order as a fresh one is worse than saying
 * nothing: it tells a customer with a problem that nobody is listening.
 *
 * Checked in code for the same reason the human request is: the model gets it
 * right most of the time, and the times it does not are exactly the ones where
 * somebody is already unhappy.
 *
 * Deliberately narrow. "Order" alone is not enough — plenty of new enquiries
 * say "I want to order" — so this looks for the past tense, a delivery that has
 * not arrived, or a complaint about an order that already exists.
 */
const ALREADY_A_CUSTOMER =
  /\b(i (already )?(purchased|ordered|bought|placed an order)|my (order|invoice|shipment|delivery|package|tracking)|(haven'?t|have not|hasn'?t|has not|still (haven'?t|not)) (received|got|arrived)|where is my|order (status|number)|already (have|received) (them|it|those)|refund|damaged|wrong (item|order|size)|previous order|last order|reorder|(was|been|am) (working|dealing|speaking|talking) with|\bMIA\b|(no|not) (response|responding|replying|reply)|gone quiet|stopped (responding|replying)|(still )?waiting (for|on) (your |the |my |a )?(feedback|reply|response|quote|answer|update)|any update|(didn'?t|did not|haven'?t|have not|never) (get|got|receive|received) (the |my |a |your )?quote|mi cotizaci[oó]n|(sent|send) you (the|my) (quote|details|artwork))\b/i;

/**
 * How long the two reads may take before the turn goes on without them.
 *
 * Understanding the message is worth having and is not worth failing over. If it
 * does not come back in time the reply is composed from what we already knew,
 * which at worst asks for something the visitor just told us — a repeated
 * question is a small cost, and the alternative is SalesIQ declaring the bot
 * dead and showing a holding line instead of an answer.
 *
 * Six seconds because three was measured on a laptop sitting next to a fast
 * connection, and the service does not run there. From Railway a single model
 * call takes three to four seconds, so a three second budget expired on every
 * turn — the reply still went out, but nothing the customer said was ever
 * written down. A budget that always expires is not a safety net, it is an
 * off switch.
 */
/**
 * "No" to the material or extras question, which is an answer: none.
 *
 * Left unrecorded the question comes back. In testing a visitor answered "no
 * special material" and was asked for the material again two turns later.
 */
const DECLINED_THE_FIELD = /^(no|none|nope|no thanks?|nothing|not really|no preference|no special[\w\s]*)\W*$/i;

const READ_BUDGET_MS = 6000;

/**
 * When a reply has to be ready, counted from when SalesIQ's request arrived.
 *
 * SalesIQ gives up at about ten seconds. Eight leaves room for the save and the
 * network; past it the composer skips a rewrite and fixes the reply in code.
 */
const REPLY_BUDGET_MS = 8000;

/**
 * What of the writer's reply goes out after the price: its question, and
 * nothing else.
 *
 * "…$112.00 total. Taking that as 3 by 4 inches. Got it, gummy pouch. What
 * finish do you prefer?" — the price already says the size and the style, so
 * everything in front of the question repeats it or thanks them for nothing.
 * Kept whole when they asked us something, because then the part before the
 * question is our answer to it.
 */
export function afterThePrice(reply: string, theyAskedSomething = false): string {
  const trimmed = String(reply || "").trim();
  if (theyAskedSomething) return trimmed;

  const sentences = trimmed.split(/(?<=[.!?])\s+/);
  const question = [...sentences].reverse().find((sentence) => sentence.includes("?"));
  return question ? question.trim() : trimmed;
}

/** The details asked before an instant price, in the script's order. */
const PRICE_DETAILS = ["finishes", "skus", "extras", "material"] as const;

/** Them bringing a detail up without being asked. */
const THEY_MENTIONED: Record<(typeof PRICE_DETAILS)[number], RegExp> = {
  finishes: /\b(matt?e?|maat|gloss\w*|shiny|soft[\s-]*touch|velvet|finish\w*)\b/i,
  skus: /\b(designs?|skus?|flavou?rs?|versions?|artworks?)\b/i,
  extras: /\b(zip\w*|notch\w*|hang[\s-]*holes?|windows?)\b/i,
  material: /\b(materials?|metal\w*|clear|white|foil|holograph\w*|microns?|smell[\s-]*proof|special)\b/i,
};

/** The script's own wording, for when the writer skipped one. */
const PRICE_DETAIL_QUESTIONS: Record<(typeof PRICE_DETAILS)[number], string> = {
  finishes: "What finish do you prefer: matte, gloss or soft touch?",
  skus: "How many total designs or SKUs do you have?",
  extras: "Do you want me to add a zipper and tear notch?",
  material: "Do you have any specific material or special features in mind?",
};

/**
 * A few words taking in their answer, in front of a question asked in fixed
 * words — never the same opener as the message before, which reads as a form.
 */
export function acknowledgementAfter(botSaid: string[]): string {
  const OPENERS = ["Got it.", "Thanks.", "Great.", "Perfect."];
  const last = String(botSaid[botSaid.length - 1] || "").trim();
  const recent = botSaid.slice(-3).map((text) => text.trim());
  return (
    OPENERS.find((opener) => !recent.some((text) => text.startsWith(opener))) ||
    OPENERS.find((opener) => !last.startsWith(opener)) ||
    OPENERS[0]
  );
}

/** Resolves to the fallback if the work has not finished in time. */
function withDeadline<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
  ]);
}

/**
 * The turn in flight for each conversation.
 *
 * SalesIQ does not wait for one webhook to be answered before sending the next,
 * and a turn here is three model calls long. Two of them running at once both
 * read the conversation before either had saved, so each picked the next
 * question from the same state and the visitor got two questions in a row — the
 * chats where the bot asked style, finish and quantity without waiting for a
 * word back. Serialising them means the second turn reads what the first said.
 */
const running = new Map<string, Promise<unknown>>();

export function runChatTurn(
  leadsDb: Connection,
  incoming: IncomingChat,
  settings: ISettings,
  /** True when this is the chat opening rather than something the visitor typed. */
  isTrigger = false,
  /** When SalesIQ's request arrived — the clock its timeout runs on. */
  receivedAt = Date.now()
): Promise<ChatTurn> {
  const key = incoming.conversationId;

  // Noted on arrival, before queueing, so a photo still waiting its turn can see
  // that another one has come in behind it — see lastPhotoOfTheSend.
  if (incoming.sharedFile && !incoming.text.trim()) latestFileAt.set(key, receivedAt);

  // Queued behind whatever is already running for this chat, and behind it even
  // if that one threw: a failed turn must not take the rest of the chat with it.
  const turn = (running.get(key) || Promise.resolve())
    .catch(() => {})
    .then(() => takeChatTurn(leadsDb, incoming, settings, isTrigger, receivedAt))
    .then((done) => inTheirLanguage(done, settings, receivedAt));

  const settled = turn.catch(() => {});
  running.set(key, settled);
  settled.then(() => {
    if (running.get(key) === settled) running.delete(key);
  });

  return turn;
}

/**
 * The turn's messages in the visitor's language — see replyLanguage.ts.
 *
 * The transcript keeps the English the engine reasons with; what the visitor
 * was sent goes beside it as `shown`. A translation that fails or runs late
 * leaves the English to go out, which is still an answer.
 */
async function inTheirLanguage(turn: ChatTurn, settings: ISettings, receivedAt: number): Promise<ChatTurn> {
  const english = [...(turn.before || []), turn.reply];
  if (!english.some((text) => text && text.trim())) return turn;

  const conversation = turn.conversation as IChatConversation & { save: () => Promise<any>; markModified: (path: string) => void };
  if (replyLanguageFor(conversation.messages) === ENGLISH) return turn;

  const translated = await translateReplies(english, conversation.messages, settings, receivedAt + SEND_BY_MS - Date.now());
  if (!translated) {
    console.log(`[chat] ${conversation.conversationId}: translation not ready in time, sending English`);
    return turn;
  }

  // Each English line, newest first, gets what was actually sent beside it.
  let changed = false;
  english.forEach((text, index) => {
    if (!text || translated[index] === text) return;
    const message = [...conversation.messages].reverse().find((m) => m.author === "ai" && m.text === text && !m.shown);
    if (message) {
      message.shown = translated[index];
      changed = true;
    }
  });
  if (changed) {
    conversation.markModified("messages");
    await conversation.save().catch((error: any) => console.error("[chat] could not save the translated reply:", error.message));
  }

  const before = turn.before ? translated.slice(0, turn.before.length) : undefined;
  return { ...turn, ...(before ? { before } : {}), reply: translated[translated.length - 1] };
}

/**
 * How long a repeat of the same message is read as SalesIQ sending it twice.
 *
 * It re-delivers when we are slow to answer, and a turn takes seconds. The
 * second copy used to be answered as though the visitor had said it again,
 * which walked the script forward without them: two questions, one answer.
 */
const REDELIVERY_WINDOW_MS = 60_000;

async function takeChatTurn(
  leadsDb: Connection,
  incoming: IncomingChat,
  settings: ISettings,
  isTrigger: boolean,
  receivedAt: number
): Promise<ChatTurn> {
  const ChatConversation = chatConversationModel(leadsDb);

  let conversation =
    (await ChatConversation.findOne({ conversationId: incoming.conversationId })) ||
    (await continueWebsiteGreeting(ChatConversation, incoming, isTrigger)) ||
    new ChatConversation({
      conversationId: incoming.conversationId,
      uvid: incoming.uvid,
      uuid: incoming.uuid,
      visitorId: incoming.visitorId,
      question: incoming.question,
      departmentId: incoming.departmentId,
    });

  const typed = incoming.text.trim();

  // A photo arrives with no words of its own. It still goes into the
  // transcript, named, so the rep can see it was sent — and so a redelivery of
  // it is recognised like any other message.
  const text = [incoming.sharedFile ? sharedFileNote(incoming.fileNames || []) : "", typed]
    .filter(Boolean)
    .join(" ");

  const lastFromVisitor = [...conversation.messages].reverse().find((m) => m.author === "visitor");

  // By SalesIQ's message id when both sides have one. The same words inside a
  // minute used to count as a redelivery on their own, and seven real messages
  // in a week were swallowed that way — a customer asked for her size "in
  // inches" typed "inches" again and got the question repeated back at her.
  // When SalesIQ genuinely redelivers, the id is the same.
  const redelivered =
    Boolean(text && lastFromVisitor) &&
    (incoming.messageId && lastFromVisitor?.msgid
      ? lastFromVisitor.msgid === incoming.messageId
      : lastFromVisitor!.text.trim() === text &&
        Date.now() - new Date(lastFromVisitor!.at).getTime() < REDELIVERY_WINDOW_MS);

  // A photo on its own — see whatToDoWithAFile. "Finished" is the quote having
  // gone out or the chat having been handed to a person, not a greeting the
  // idle sweep closed: that one has said nothing yet and should start up.
  const aboutTheFile = whatToDoWithAFile({
    fileOnly: Boolean(incoming.sharedFile) && !typed,
    lastFromVisitor,
    finished:
      (conversation.status === "ready_to_quote" || conversation.status === "handed_off") &&
      whatToDoWithFinishedChat(conversation, isTrigger) !== "new-visit",
  });

  if (aboutTheFile !== "take-the-turn") {
    // The files still go into the transcript, named, so the rep sees every one
    // of them — but a redelivery of a file we already have is not a new one.
    if (!redelivered) {
      conversation.messages.push({
        author: "visitor",
        text,
        at: new Date(),
        ...(incoming.messageId ? { msgid: incoming.messageId } : {}),
        ...(incoming.files?.length ? { attachments: incoming.files } : {}),
      });
    }

    if (aboutTheFile === "say-nothing") {
      await conversation.save();
      const ours = conversation.messages[conversation.messages.length - 1];
      const oursAt = ours?.author === "visitor" ? new Date(ours.at).getTime() : Date.now();
      if (!(await lastPhotoOfTheSend(ChatConversation, incoming.conversationId, receivedAt, oursAt))) {
        return { reply: "", silent: true, conversation };
      }
      const reply = theRestOfThePhotos(conversation.messages);
      if (!reply) return { reply: "", silent: true, conversation };
      conversation.messages.push({ author: "ai", text: reply, at: new Date(), ...(settings.chat.dryRun ? { dryRun: true } : {}) });
      conversation.aiMessageCount += 1;
      await conversation.save();
      return { reply, conversation };
    }

    conversation.messages.push({
      author: "ai",
      text: FILE_RECEIVED,
      at: new Date(),
      ...(settings.chat.dryRun ? { dryRun: true } : {}),
    });
    conversation.aiMessageCount += 1;
    await conversation.save();
    return { reply: FILE_RECEIVED, conversation };
  }

  if (redelivered) {
    const lastFromBot = [...conversation.messages].reverse().find((m) => m.author === "ai");
    await conversation.save();
    return { reply: lastFromBot?.text || "", conversation };
  }

  /**
   * A chat that had already finished, and somebody is here again.
   *
   * It used to say nothing, and nothing reached the visitor as the holding line
   * — "One of our team will be with you shortly" — to every message, for good.
   * 1,191 widget openings and 84 messages in one week: mostly greetings the
   * sweep had closed three minutes after nobody answered, but also visitors who
   * paused mid-chat and came back to a dead bot, and details like "the boxes can
   * also have a depth of 2 inches" that never reached anybody.
   *
   * The runaway the old silence guarded against came from SalesIQ's failure
   * callback re-entering the turn. The webhook answers that handler on its own
   * now and never brings it here.
   */
  /** They are coming back to a chat that had already produced its quote. */
  let pickedUpAfterTheQuote = false;
  /** Whether the rep they are talking to now is the one they had before. */
  let metThisRepBefore = true;
  /** The rep who took their last chat over, when they come back — see repWhoTookItOver. */
  let backToTheirRep: { email: string; name: string } | null = null;

  if (conversation.status !== "active") {
    const next = whatToDoWithFinishedChat(conversation, isTrigger);
    pickedUpAfterTheQuote = next === "reopen" && conversation.status === "ready_to_quote";

    if (next === "repeat-last") {
      const lastFromBot = [...conversation.messages].reverse().find((m) => m.author === "ai");
      await conversation.save();
      return { reply: lastFromBot?.text || "", conversation };
    }

    if (next === "new-visit") {
      // Decided before the new visit replaces it: whether they are coming back
      // to the rep they had, or to a new one because theirs has left the pool.
      metThisRepBefore = inRotation(conversation.repEmail, settings);
      backToTheirRep = repWhoTookItOver(conversation, settings);
      conversation = await startNewVisit(ChatConversation, conversation, incoming, settings);
    } else {
      reopen(conversation);
    }
  }

  const contactBefore = `${conversation.email}|${conversation.phone}`;

  // Chosen once, on the opening turn, and kept for the rest of the chat. The
  // visitor is talking to a named person, so that name cannot change mid-way.
  if (!conversation.repEmail) {
    const rep = await pickRepForChat(leadsDb, settings);
    if (rep) {
      conversation.repEmail = rep.email;
      conversation.repName = rep.name;
    }
  }

  /**
   * SalesIQ's own identifiers, which arrive later than the conversation does.
   *
   * A chat is created on the opening trigger, and that payload carries neither
   * `visitor_id` nor `uuid` — only the uvid. Every later message carries all
   * three, but they were being read at creation only, so 6,749 of 6,808 chats
   * held an empty visitorId while SalesIQ had been sending it all along. It is
   * the id SalesIQ's own console uses, so without it there is no way to link a
   * rep to the conversation they are being alerted about.
   */
  if (incoming.visitorId) conversation.visitorId = incoming.visitorId;
  if (incoming.uuid) conversation.uuid = incoming.uuid;
  if (incoming.uvid) conversation.uvid = incoming.uvid;

  // Contact details arrive part-way through a chat rather than at the start, so
  // they are filled in whenever they appear instead of only at creation.
  if (incoming.name) conversation.name = incoming.name;
  if (incoming.email) conversation.email = incoming.email;
  if (incoming.phone) conversation.phone = incoming.phone;
  if (incoming.landingPageTitle) conversation.landingPageTitle = incoming.landingPageTitle;
  if (incoming.currentPageUrl) conversation.currentPageUrl = incoming.currentPageUrl;
  // Where the visit started stays as first seen; only the current page moves on.
  if (incoming.landingPageUrl && !conversation.landingPageUrl) conversation.landingPageUrl = incoming.landingPageUrl;
  if (incoming.referer && !conversation.referer) conversation.referer = incoming.referer;
  if (incoming.visitorChannel && !conversation.visitorChannel) conversation.visitorChannel = incoming.visitorChannel;

  // SalesIQ fires the opening trigger more than once — twice within the same
  // second in the captures, three times for one visitor. Composing on each would
  // greet the same person repeatedly and burn a model call every time, so the
  // greeting already given is repeated verbatim instead.
  if (isTrigger && conversation.aiMessageCount > 0) {
    const lastFromBot = [...conversation.messages].reverse().find((m) => m.author === "ai");
    await conversation.save();
    return { reply: lastFromBot?.text || "", conversation };
  }

  if (text) {
    conversation.messages.push({
      author: "visitor",
      text,
      at: new Date(),
      ...(incoming.messageId ? { msgid: incoming.messageId } : {}),
      ...(incoming.files?.length ? { attachments: incoming.files } : {}),
    });
  }

  // An address they typed is read in code as well — see `emailIn`. Before the
  // hand-off checks below, so "can I talk to someone? I'm x@y.com" goes to a
  // person with the address on it, and a lead is written.
  const typedEmail = emailIn(typed);
  if (typedEmail && !isContactValueUsable("email", conversation.email) && !isOurEmail(typedEmail, settings)) {
    conversation.email = typedEmail;
  }

  /**
   * Back after a rep took their last chat over: straight to that rep.
   *
   * Jessica took Michael's chat, rang him and gave him her number; when he wrote
   * again the next morning the bot greeted him as Hazel and asked what he wanted
   * made. He was talking to Jessica, and the bot starting the script over is
   * what made him walk away.
   */
  if (backToTheirRep && typed) {
    conversation.repEmail = backToTheirRep.email;
    conversation.repName = backToTheirRep.name;
    const first = firstNameOf(backToTheirRep.name) || "the rep";
    console.log(`[chat] ${conversation.conversationId} is back — passed straight to ${backToTheirRep.email}, who took the last chat over`);
    return finish(conversation, "visitor_asked", `Thanks for getting back to us. I'm passing you straight to ${first}, who you were talking to.`);
  }

  // Answered in front of whatever the bot says next — see asksOnlyIfWeAreABot.
  const botQuestionAnswer = typed && asksOnlyIfWeAreABot(typed) ? ANSWER_TO_ARE_YOU_A_BOT : "";

  if (typed && !botQuestionAnswer && (wantsAPerson(typed) || asksIfWeAreABot(typed))) {
    const canReachThem = hasReachableContact({
      email: conversation.email,
      phone: conversation.phone,
    });

    /**
     * One question first, when there is no way to reach them.
     *
     * Handing over at this moment ends our part of the chat with an anonymous
     * transcript. If nobody takes it before they close the tab there is nothing
     * to write to in the morning — and the morning is when most of these are
     * actually answered, because people do not pick up the phone.
     */
    // Blank means an admin has turned this off, and an empty message would be
    // a save error rather than a hand-off.
    const askingConfigured = String(settings.chat.humanAskEmailMessage || "").trim();
    const asking = askingConfigured && asksIfWeAreABot(typed) ? answerToAreYouABot(false) : askingConfigured;

    if (
      asking &&
      !canReachThem &&
      !conversation.awaitingHumanContact &&
      (settings.chat.askContactFields || []).includes("email")
    ) {
      conversation.awaitingHumanContact = true;
      conversation.lastAsked = "email";
      conversation.messages.push({
        author: "ai",
        text: asking,
        at: new Date(),
        ...(settings.chat.dryRun ? { dryRun: true } : {}),
      });
      conversation.aiMessageCount += 1;
      await conversation.save();
      return { reply: asking, conversation };
    }

    return finish(
      conversation,
      "visitor_asked",
      asksIfWeAreABot(typed)
        ? answerToAreYouABot(canReachThem)
        : canReachThem
          ? settings.chat.humanConnectMessage
          : settings.chat.handoffMessage
    );
  }

  /**
   * An existing customer with a problem, not a quote to qualify.
   *
   * Said once and then handed on. There is nothing in the script that helps
   * somebody whose order has not arrived, and asking them a fourth question
   * about label sizes is how a bad experience becomes a worse one. What they
   * are asked for instead is what a rep actually needs to find them in the
   * system: their name, the account the order sits under, and a number to call.
   *
   * `awaitingHumanContact` reuses the flow the human request already has —
   * whatever they say next, the chat goes to a person.
   */
  /**
   * Done with us — see isDoneWithUs. Not on a chat that already produced its
   * quote: "ok bye" there is a sign-off, and the closing line answers it.
   */
  if (typed && isDoneWithUs(typed) && !pickedUpAfterTheQuote) {
    console.log(`[chat] ${conversation.conversationId} — the visitor is done ("${typed.slice(0, 60)}"), stopped`);
    return finish(conversation, "declined", DONE_WITH_US_MESSAGE);
  }

  const existingCustomerMessage = String(settings.chat.existingCustomerMessage || "").trim();

  if (typed && existingCustomerMessage && ALREADY_A_CUSTOMER.test(typed) && !conversation.awaitingHumanContact) {
    conversation.awaitingHumanContact = true;
    conversation.messages.push({
      author: "ai",
      text: existingCustomerMessage,
      at: new Date(),
      ...(settings.chat.dryRun ? { dryRun: true } : {}),
    });
    conversation.aiMessageCount += 1;
    await conversation.save();
    console.log(`[chat] ${conversation.conversationId} is an existing customer — handed on, not qualified`);
    return { reply: existingCustomerMessage, conversation };
  }

  /**
   * Not here to buy packaging — see notACustomer.ts.
   *
   * Answered once and stopped. Carrying on is what produced "What box size are
   * you looking for?" to somebody who had just written "You xant understand .im
   * looking job", and the stop reason keeps them out of the CRM: they usually
   * leave an email, and an email is all the lead sweep used to require.
   *
   * The whole chat is read, not just this message. "Looking for a job" is
   * turn one and the email arrives at turn three, by which point nothing in the
   * latest message says what is going on.
   */
  const notACustomerMessage = String(settings.chat.notACustomerMessage || "").trim();
  const visitorHasSaid = conversation.messages
    .filter((message) => message.author === "visitor")
    .map((message) => message.text);

  if (notACustomerMessage && chatIsAboutAJob(visitorHasSaid)) {
    console.log(`[chat] ${conversation.conversationId} is looking for work, not packaging — stopped, no lead`);
    return finish(conversation, "not_a_customer", notACustomerMessage);
  }

  if (chatIsAPitch(visitorHasSaid)) {
    console.log(`[chat] ${conversation.conversationId} is selling to us or offering promotion — stopped, no lead`);
    return finish(conversation, "not_a_customer", PITCH_MESSAGE);
  }

  /**
   * Working hours: a person takes it, not the bot.
   *
   * On the visitor's first reply, so the greeting still comes from us and the
   * chat is never a dead window — but the script does not run at all. Anybody
   * on the floor can qualify better live than the bot can through a form, and
   * the four agents are sitting there while it does.
   *
   * Deliberately after the checks above. Somebody who asked for a human already
   * has their own path with its own wording, and a job seeker must not be put
   * in front of an agent at all.
   *
   * Off-hours this never fires and the bot runs the whole script, which is what
   * it is for: the shift is over and there is nobody to pass the chat to.
   *
   * Nor with `aiAllHours` on, which the team now runs with: the bot sees every
   * chat through, day and night.
   */
  const liveAgents = (settings.chat.liveAgentEmails || []).map((email) => String(email || "").trim()).filter(Boolean);
  const liveAgentMessage = String(settings.chat.liveAgentMessage || "").trim();

  if (
    typed &&
    liveAgents.length &&
    liveAgentMessage &&
    botStepsAside(settings) &&
    !conversation.awaitingHumanContact
  ) {
    console.log(
      `[chat] ${conversation.conversationId} — working hours, offering to ${liveAgents.length} agents: ${liveAgents.join(", ")}`
    );
    return finish(conversation, "live_agent", liveAgentMessage);
  }



  // Bounded before composing, not after: a bot that notices the limit only once
  // it has already spoken has exceeded it.
  //
  // Not for an enquiry that is already complete and has been picked back up:
  // somebody saying "thanks" after it is finished is owed the closing line
  // again, not a hand-off.
  const alreadyQualified =
    isComplete(conversation.collected) &&
    hasReachableContact({ email: conversation.email, phone: conversation.phone });

  if (conversation.aiMessageCount >= settings.chat.maxAiMessages && !alreadyQualified) {
    return finish(conversation, "max_turns", settings.chat.handoffMessage);
  }

  /**
   * Both reads at once, because neither needs the other's answer.
   *
   * They used to queue: the quote fields, then the contact details, then the
   * reply — three model calls end to end, and with a provider cascade in front
   * of each one that is nine HTTP requests before the visitor hears anything.
   * SalesIQ gives us about ten seconds and then declares the bot failed, and a
   * chat that trips that gets a holding line instead of an answer. One of them
   * did: eighteen and a half seconds on a message that said "File Shared", and
   * the customer's next question — what our MOQ was — never reached us at all.
   *
   * They read the same transcript and write different fields, so running them
   * together costs nothing and saves a whole call's latency.
   */
  const visitorSaid = conversation.messages.filter((m) => m.author === "visitor").map((m) => m.text);
  const ourNames = [conversation.repName, conversation.spokeAs];

  // A name that is our rep's was never theirs — see isOurRepsName. Cleared so it
  // gets asked for, and so no lead is written under the rep's own name.
  if (isOurRepsName(conversation.name, ourNames, visitorSaid)) conversation.name = "";

  // Kept from before the read: the reader sees "50x30 mm (assumed)" in the
  // transcript and writes back "50x30 mm", which quietly turns our guess into
  // something the customer appears to have said.
  const sizeBeforeReading = String((conversation.collected as Record<string, string>).sizes || "");

  // Kept for the same reason: a bare number answering a question that was not
  // about quantity must not become the quantity, and the only way to know the
  // read invented one is to have what was there before it ran.
  const quantityBeforeReading = String((conversation.collected as Record<string, string>).quantity || "");

  if (text) {
    const [extraction, contact] = await withDeadline(
      Promise.all([
      extractFields(
        asConversationMessages(conversation),
        settings.quoteFields,
        conversation.collected,
        settings
      ).catch((error: any) => {
        // A failed read costs this turn's understanding, not the conversation:
        // the next message is extracted from the full transcript anyway.
        console.error("[chat] could not read the visitor's answers:", error.message);
        return null;
      }),
      extractContact(
        conversation.messages,
        {
          name: isPlaceholderName(conversation.name) ? undefined : conversation.name,
          email: conversation.email || undefined,
          phone: conversation.phone || undefined,
        },
        conversation.spokeAs || conversation.repName,
        settings
      ).catch((error: any) => {
        console.error("[chat] could not read the visitor's contact details:", error.message);
        return null;
      }),
      ]),
      READ_BUDGET_MS,
      [null, null]
    );

    if (!extraction && !contact) {
      console.warn(
        "[chat] reads did not finish in " + READ_BUDGET_MS + "ms — replying from what we already had"
      );
    }

    if (extraction) {
      conversation.collected = extraction.collected;
      if (extraction.questionsForRep.length) {
        conversation.questionsForRep = extraction.questionsForRep;
      }
    }

    if (contact) {
      if (contact.name && !isOurRepsName(contact.name, ourNames, visitorSaid)) conversation.name = contact.name;
      if (contact.email) conversation.email = contact.email;
      if (contact.phone) conversation.phone = contact.phone;
      if (contact.name || contact.email || contact.phone) {
        await conversation.save();
      }
    }
  }

  // A unit on its own, in answer to the unit question, goes onto the size —
  // see unitAnswer. It also overrides a unit we worked out for ourselves: they
  // are correcting us, and their word wins.
  const unit = unitAnswer(typed);
  let sizesNow = (conversation.collected as Record<string, string>).sizes;

  // The marker put back, when the read handed it back as their own words.
  if (unitWasAssumed(sizeBeforeReading) && !unitWasAssumed(sizesNow) && sizesNow === withoutAssumedMark(sizeBeforeReading)) {
    sizesNow = sizeBeforeReading;
    (conversation.collected as Record<string, string>).sizes = sizesNow;
    conversation.markModified("collected");
  }

  /**
   * The same size handed back with less in it.
   *
   * The read goes back to what they first typed — "5x7, one that can stand on
   * the shelf" — and drops what was added since: the gusset they gave on its own
   * turn, and the unit we worked out. The bot then said "Taking that as…" again
   * on every message, and was one turn from asking for the gusset a second time.
   * Same measurements, fewer of them, no unit of their own: what we had stands.
   */
  {
    const before = dimensionsInInches(sizeBeforeReading);
    const now = dimensionsInInches(sizesNow);
    const sameStart = Boolean(before && now) && now!.every((n, i) => Math.abs(n - before![i]) < 0.01);
    const lostSomething = sameStart && (now!.length < before!.length || (unitWasAssumed(sizeBeforeReading) && sizeMissingUnit(sizesNow)));
    if (lostSomething) {
      console.log(`[chat] ${conversation.conversationId} kept the size "${sizeBeforeReading}" over the re-read "${sizesNow}"`);
      sizesNow = sizeBeforeReading;
      (conversation.collected as Record<string, string>).sizes = sizesNow;
      conversation.markModified("collected");
    }
  }

  if (unit && sizeMissingUnit(sizesNow)) {
    (conversation.collected as Record<string, string>).sizes = `${sizesNow} ${unit}`;
    conversation.markModified("collected");
  } else if (unit && (unitWasAssumed(sizesNow) || unitWasAssumed(sizeBeforeReading))) {
    (conversation.collected as Record<string, string>).sizes = withCorrectedUnit(sizesNow, unit);
    conversation.markModified("collected");
    console.log(`[chat] ${conversation.conversationId} corrected our assumed unit to ${unit}`);
  }

  /**
   * A size with no unit that the numbers themselves answer — see guessUnit.
   *
   * Taken rather than asked about. The question costs a whole message and the
   * customer already told us: nobody orders a 50mm box or a 50 inch label.
   * What the bot does say is which way it read it, so a correction costs them
   * one word instead of an exchange.
   */
  // The measurements alone, not the sentence they came in — see tidySize.
  {
    const collected = conversation.collected as Record<string, string>;
    // How many go inside, recorded as the size — see sizeIsAPackCount. Taken off
    // so the real size is asked for.
    if (collected.sizes && sizeIsAPackCount(collected.sizes)) {
      console.log(`[chat] ${conversation.conversationId} — "${collected.sizes}" is a pack count, not a size`);
      delete collected.sizes;
      conversation.markModified("collected");
    }
    const tidiedSize = tidySize(collected.sizes);
    if (collected.sizes && tidiedSize !== collected.sizes) {
      console.log(`[chat] ${conversation.conversationId} read the size "${collected.sizes}" as "${tidiedSize}"`);
      collected.sizes = tidiedSize;
      conversation.markModified("collected");
    }
  }

  let assumedSize = "";
  const sizeToRead = (conversation.collected as Record<string, string>).sizes;
  if (sizeMissingUnit(sizeToRead)) {
    const guessed = guessUnit(sizeToRead, conversation.collected.product);
    if (guessed) {
      assumedSize = sizeWithAssumedUnit(sizeToRead, guessed);
      (conversation.collected as Record<string, string>).sizes = assumedSize;
      conversation.markModified("collected");
      console.log(`[chat] ${conversation.conversationId} read "${sizeToRead}" as ${guessed} rather than asking`);
    }
  }

  // A pack count read as the order — see quantityIsAPackCount. Taken off, so the
  // quantity is asked for and nothing is priced at "2 bags".
  {
    const collected = conversation.collected as Record<string, string>;
    const said = conversation.messages.filter((m) => m.author === "visitor").map((m) => m.text);
    if (collected.quantity && quantityIsAPackCount(collected.quantity, said)) {
      console.log(`[chat] ${conversation.conversationId} — "${collected.quantity}" is a pack count, not the order quantity`);
      delete collected.quantity;
      conversation.markModified("collected");
    }
    // A finish written into the material — "material: matte" — is not an answer
    // about the material, and it stopped that question from ever being asked.
    if (/^\s*(matt?e?|maat|gloss(y)?|shiny|soft[\s-]*touch)\s*(finish)?\s*$/i.test(String(collected.material || ""))) {
      console.log(`[chat] ${conversation.conversationId} — "${collected.material}" is a finish, not the material`);
      delete collected.material;
      conversation.markModified("collected");
    }
    if (collected.quantity && quantityIsTheDesignCount(collected.quantity, conversation.messages)) {
      // The designs answer, copied into the quantity — see quantityIsTheDesignCount.
      console.log(`[chat] ${conversation.conversationId} — "${collected.quantity}" answered the designs question, not the quantity`);
      delete collected.quantity;
      conversation.markModified("collected");
    }
  }

  // A quantity that came back as a sentence — see tidyQuantity.
  const quantityNow = (conversation.collected as Record<string, string>).quantity;
  const tidied = tidyQuantity(quantityNow);
  if (tidied !== quantityNow) {
    (conversation.collected as Record<string, string>).quantity = tidied;
    conversation.markModified("collected");
    console.log(`[chat] ${conversation.conversationId} read the quantity "${quantityNow}" as "${tidied}"`);
  }

  /**
   * The designs answer, read as the order quantity.
   *
   * We asked "How many total designs or SKUs do you have?", the customer
   * answered "1", and the read put 1 in the quantity — so somebody who had
   * never named a quantity at all was told mid-script that their order was
   * under our minimum. The customer had done nothing wrong and there was
   * nothing for them to say back.
   *
   * The question we just asked is the one being answered. A bare number here is
   * a design count, it goes where it belongs, and the quantity goes back to
   * whatever it was before the read guessed.
   */
  const lastBotText = [...conversation.messages].reverse().find((message) => message.author === "ai")?.text || "";

  /**
   * They were asked whether the minimum works and said yes.
   *
   * Then the quantity is a thousand, whatever they opened with. Left alone, the
   * lead reads "Quantity: 200" for a customer who has just agreed to order
   * 1000, and the rep prices the number the customer has already moved off.
   */
  // No minimum on a bag priced instantly — see minimumWaivedFor.
  const minimumWaived = minimumWaivedFor(conversation.collected, conversation.messages);

  if (typed && !minimumWaived && minimumApplies(conversation.collected.product)) {
    const answer = answerToTheMinimum(typed, lastBotText);
    const collected = conversation.collected as Record<string, string>;
    if (answer === "minimum" && belowMinimum(collected.quantity)) {
      console.log(
        `[chat] ${conversation.conversationId} — took the minimum over "${collected.quantity}"`
      );
      collected.quantity = String(MINIMUM_ORDER);
      conversation.markModified("collected");
    }
  }

  if (isDesignCountAnswer(conversation.lastAsked || "", lastBotText, typed)) {
    const collected = conversation.collected as Record<string, string>;
    if (collected.quantity !== quantityBeforeReading) {
      if (quantityBeforeReading) collected.quantity = quantityBeforeReading;
      else delete collected.quantity;
      conversation.markModified("collected");
      console.log(
        `[chat] ${conversation.conversationId} — "${typed}" answered the designs question, not the quantity`
      );
    }
    if (!collected.skus) {
      collected.skus = typed.trim();
      conversation.markModified("collected");
    }
  }

  // A number of designs or SKUs mentioned in text (e.g. "having 2 designs", "1000 with 2 designs")
  const skusInText = extractSkusInText(typed);
  if (skusInText) {
    (conversation.collected as Record<string, string>).skus = skusInText;
    conversation.markModified("collected");
  }

  /** Whatever the read took from this message is their own words handed back. */
  const dropValuesTakenFromTheirMessage = (why: string) => {
    const theirWords = typed.toLowerCase().replace(/\s+/g, " ");
    const collected = conversation.collected as Record<string, string>;
    for (const key of Object.keys(collected)) {
      const value = String(collected[key] || "").trim().toLowerCase();
      if (value && theirWords.includes(value)) {
        delete collected[key];
        conversation.markModified("collected");
        console.log(`[chat] ${conversation.conversationId} — dropped ${key} taken from "${typed}" (${why})`);
      }
    }
  };

  /**
   * Nothing in their message to act on — see saysNothingUseful. Whatever the
   * read took from it is their own words handed back, not an answer, so it goes.
   */
  const unclear = saysNothingUseful(typed);
  if (unclear) dropValuesTakenFromTheirMessage("nothing usable in it");

  /**
   * They answered our question with a question of their own — see
   * asksBareFactTopic. "Moq" is not the number of designs they have, and it
   * reached a rep's lead as exactly that.
   */
  const bareFactTopic = asksBareFactTopic(typed);
  if (bareFactTopic) dropValuesTakenFromTheirMessage(`they are asking about ${bareFactTopic}`);

  const answeredField = conversation.lastAsked;
  if ((answeredField === "material" || answeredField === "extras") && DECLINED_THE_FIELD.test(typed)) {
    (conversation.collected as Record<string, string>)[answeredField] = "none";
    conversation.markModified("collected");
  }

  // The moment this chat first has a way to reach them, check whether that
  // address or number is already one of our reps' customers.
  if (`${conversation.email}|${conversation.phone}` !== contactBefore) {
    await belongToTheirRep(ChatConversation, conversation, settings);
  }

  // They asked for a person last turn and were asked for an address first. This
  // is their answer to that, and it is the last turn either way: somebody who
  // has asked for a human does not get kept talking to us while we finish the
  // script.
  if (conversation.awaitingHumanContact) {
    const canReachThem = hasReachableContact({
      email: conversation.email,
      phone: conversation.phone,
    });
    return finish(
      conversation,
      "visitor_asked",
      canReachThem ? settings.chat.humanConnectMessage : settings.chat.handoffMessage
    );
  }

  // They offered a number and did not give one — see offersAPhoneNumber.
  if (typed && offersAPhoneNumber(typed) && !isContactValueUsable("phone", conversation.phone)) {
    const reply = [botQuestionAnswer, YES_SEND_YOUR_NUMBER].filter(Boolean).join(" ");
    conversation.lastAsked = "phone";
    conversation.messages.push({ author: "ai", text: reply, at: new Date(), ...(settings.chat.dryRun ? { dryRun: true } : {}) });
    conversation.aiMessageCount += 1;
    await conversation.save();
    return { reply, conversation };
  }

  const asked: Record<string, number> = { ...(conversation.askedCounts || {}) };

  /**
   * Spend an attempt only when the visitor has actually had a go at answering.
   *
   * This used to be counted the moment a question went out, which meant the
   * count measured how often the bot spoke rather than how often the visitor
   * declined to say. In one chat the email question was spent on a mistyped
   * "ocated" and on a turn where the visitor asked where the company was — two
   * strikes, neither of them a refusal — and the bot never asked again. It then
   * filed nothing at all, because a chat with no email and no phone is invisible
   * to the sweep that writes leads up.
   */
  const lastAsked = conversation.lastAsked;
  if (text && lastAsked) {
    const haveItNow = isContactKey(lastAsked)
      ? isContactValueUsable(lastAsked, {
          name: conversation.name,
          email: conversation.email,
          phone: conversation.phone,
        }[lastAsked])
      : Boolean((conversation.collected as Record<string, string>)[lastAsked]);

    asked[lastAsked] = applyAskOutcome(
      asked[lastAsked] || 0,
      askOutcome(lastAsked, text, haveItNow)
    );
  }

  // Recorded honestly: "not given" means we asked and they did not say, which is
  // different from "not sure", which is them telling us they do not know. A rep
  // reading the lead needs to be able to tell those apart.
  for (const key of missingFields(conversation.collected)) {
    if ((asked[key] || 0) >= MAX_ASKS) {
      (conversation.collected as Record<string, string>)[key] = "not given";
    }
  }

  // If all applicable script questions for this product have either been collected
  // or asked in the conversation, mark any remaining uncollected quote fields as "not specified"
  // so the conversation proceeds to collect contact details (name, phone) and completes smoothly.
  const aiMessages = conversation.messages.filter((m) => m.author === "ai").map((m) => m.text);
  const unaskedQuoteFields = missingFields(conversation.collected).filter((key) => {
    const wasAsked = (asked[key] || 0) >= 1 || aiMessages.some((txt) => fieldsAskedAbout(txt).includes(key));
    return !wasAsked;
  });

  if (unaskedQuoteFields.length === 0) {
    for (const key of missingFields(conversation.collected)) {
      if (!conversation.collected[key]) {
        /**
         * "none" means they told us there is none; "not specified" means we
         * asked and never got it. The attempt count alone could not tell them
         * apart — a question the visitor answered with a question of their own
         * costs no attempt, so the count stays at nought — and a customer who
         * was asked her quantity twice and never gave one had "Quantity: none"
         * written on her lead. Nobody orders none.
         */
        const wasAsked =
          (asked[key] || 0) >= 1 || aiMessages.some((text) => fieldsAskedAbout(text).includes(key));
        (conversation.collected as Record<string, string>)[key] = wasAsked ? "not specified" : "none";
      }
    }
  }
  conversation.markModified("collected");

  /**
   * Their answer to the gusset question, onto the size — see needsGusset.
   *
   * Done here rather than trusted to the read, which has no idea "2" is the
   * third measurement and is as likely to write it into the quantity.
   */
  if (
    typed &&
    ASKS_THE_GUSSET.test(lastBotText) &&
    needsGusset(conversation.collected, conversation.messages)
  ) {
    const collected = conversation.collected as Record<string, string>;
    const merged = withGusset(collected.sizes, typed);
    if (merged) {
      console.log(`[chat] ${conversation.conversationId} — gusset "${typed}" makes the size ${merged}`);
      collected.sizes = merged;
      if (collected.quantity !== quantityBeforeReading) {
        if (quantityBeforeReading) collected.quantity = quantityBeforeReading;
        else delete collected.quantity;
      }
      conversation.markModified("collected");
    }
  }

  /**
   * An instant price, for a flat or stand up pouch — see erpPricing.ts.
   *
   * Started here and awaited where the reply is put together, so the ERP call
   * runs alongside the writer rather than in front of it. Bounded by what is
   * left of SalesIQ's patience: a price that misses this turn is asked for again
   * on the next one, because nothing is recorded until it arrives.
   */
  // Only on a quantity they gave as one — see quantityGivenByThem.
  const fullRequest =
    isPricingConfigured() &&
    quantityGivenByThem((conversation.collected as Record<string, string>).quantity, conversation.messages)
      ? priceRequestFor(withDefaults(conversation.collected), conversation.messages)
      : null;

  /**
   * Every detail asked before the price goes out.
   *
   * Priced the moment size and quantity were in, "2.5 by 3.5 pouch, 60k" got a
   * figure with matte assumed and nobody asked about the finish, designs, the
   * zipper or the material — then the finish question came after the price, as
   * though it did not matter. Now the script runs first: the finish, material and
   * quantity answered (a "none" counts), the designs and zipper answered or at
   * least asked. The closing turn prices whatever is held regardless — see
   * below — so a chat where the writer skipped a question still gets one.
   */
  // Covered means we asked it, or they brought it up themselves. What the read
  // wrote into the field is not enough: it filled "extras: none" for a zipper
  // nobody asked about, and "material: matte" from the finish.
  const held = conversation.collected as Record<string, string>;
  const botAsked = conversation.messages.filter((m) => m.author === "ai").map((m) => m.text);
  const theySaid = conversation.messages.filter((m) => m.author === "visitor").map((m) => m.text).join("\n");
  const answered = (key: string) => Boolean(String(held[key] || "").trim());
  const covered = (key: keyof typeof THEY_MENTIONED) =>
    botAsked.some((text) => fieldsAskedAbout(text).includes(key)) || THEY_MENTIONED[key].test(theySaid);
  const stillToAsk = PRICE_DETAILS.find((key) => !covered(key));
  const everythingAsked = ["product", "sizes", "quantity"].every(answered) && !stillToAsk;
  /** A priced bag with the size and quantity in, and a detail nobody has asked yet. */
  const mustAskBeforePrice = Boolean(fullRequest && stillToAsk && minimumWaivedFor(conversation.collected, conversation.messages));

  /**
   * The gusset is still owed: they want it standing, gave two measurements, and
   * have not been asked twice. It outranks the name and phone — asked after
   * them, the chat closed first and the customer left without a price.
   */
  const gussetOwed =
    isPricingConfigured() &&
    needsGusset(conversation.collected, conversation.messages) &&
    gussetAsks(conversation.messages) < MAX_ASKS;

  const priceRequest = everythingAsked ? fullRequest : null;
  const priceWanted =
    priceRequest && priceKey(priceRequest) !== conversation.instantPrice?.key ? priceRequest : null;
  // A reply that is going to be translated has to be written sooner, so the
  // translation still fits inside SalesIQ's wait — see replyLanguage.ts.
  const replyBudget =
    replyLanguageFor(conversation.messages) === ENGLISH ? REPLY_BUDGET_MS : REPLY_BUDGET_MS - TRANSLATION_MS;
  const priceBy = () => Math.max(0, receivedAt + replyBudget - Date.now());
  const pricing = priceWanted
    ? withDeadline(fetchPrice(priceWanted, conversation.conversationId), priceBy(), null)
    : Promise.resolve(null);

  /** The reply with the price in front of it, when one came back. */
  const priced = (request: PriceRequest, price: PriceResult, reply: string, theyAskedSomething: boolean): string => {
    const line = describePrice(request, price, Boolean(conversation.instantPrice));
    const forRep = describePriceForRep(request, price);
    conversation.instantPrice = { key: priceKey(request), ...price, line, forRep, at: new Date() };
    conversation.markModified("instantPrice");
    console.log(`[chat] ${conversation.conversationId} priced by the ERP (#${price.erpId}): ${forRep}`);
    // On a line of its own, so the price is not lost in the middle of a sentence.
    const rest = afterThePrice(reply, theyAskedSomething);
    return rest ? `${line}\n\n${rest}` : line;
  };

  const withPrice = async (reply: string, theyAskedSomething = false): Promise<string> => {
    const price = await pricing;
    return price && priceWanted ? priced(priceWanted, price, reply, theyAskedSomething) : reply;
  };

  /**
   * At the close, whatever is held is priced, even if a question was skipped
   * along the way — a customer who finished the chat is not sent off without the
   * price they were going to get.
   */
  const withPriceAtTheEnd = async (): Promise<string> => {
    const line = await withPrice("");
    if (line || conversation.instantPrice || !fullRequest) return line;
    const price = await withDeadline(fetchPrice(fullRequest, conversation.conversationId), priceBy(), null);
    return price ? priced(fullRequest, price, "", false) : "";
  };

  const contact = {
    name: isPlaceholderName(conversation.name) ? undefined : conversation.name,
    email: conversation.email || undefined,
    phone: conversation.phone || undefined,
  };

  const wantedContact = missingContactFields(contact, settings.chat.askContactFields || []);

  /**
   * Still worth asking for: wanted, missing, and not already run at twice.
   *
   * The give-up rule is suspended for email and phone while we have neither of
   * them. It exists so a visitor is not badgered about a finish they do not care
   * about — a fair trade there, and a bad one here, because the two questions it
   * retires are the only two that decide whether the enquiry reaches anybody.
   * A chat with six answers and no address was invisible to the sweep that
   * writes leads up; that is the failure this prevents.
   */
  const reachable = hasReachableContact(contact);

  // A chat that already produced its quote does not start collecting again. It
  // finished once with what it had; coming back to say "ok" is not the moment to
  // ask for a name.
  const missingContact = (pickedUpAfterTheQuote ? [] : wantedContact).filter(
    (key) =>
      // If we already have a way to reach them (email or phone), ask for any optional
      // contact detail at most ONCE — never badger someone who already gave an email
      // for their phone number twice.
      (reachable ? (asked[key] || 0) < 1 : (asked[key] || 0) < MAX_ASKS) ||
      // Keep asking for a way to reach them when we have NEITHER, even past the usual limit —
      // but only for the one they have not refused outright.
      (!reachable &&
        (REACHABLE_KEYS as readonly string[]).includes(key) &&
        (asked[key] || 0) < MAX_ASKS + 1)
  );

  // The job first, then who to send it to. Someone who has just described what
  // they want has a reason to leave a number; someone asked on arrival has not.
  //
  // Both a name and an address are wanted; only one way of reaching them is
  // required. A visitor who leaves a phone number and will not give an email is
  // a lead a rep can work, and holding the chat open for the second one loses
  // the enquiry over a detail we do not need.
  /**
   * A question asked after the quote was promised.
   *
   * "did you email me" was answered with the closing line — twice, word for
   * word, because a finished chat has nothing left to ask. It gets an answer
   * instead, and the chat stays finished.
   */
  const answeringAfterTheQuote =
    pickedUpAfterTheQuote && Boolean(typed) && (visitorIsAsking(typed) || ASKS_IF_IT_ARRIVED.test(typed));

  // Not closed while a priced bag still has a detail nobody asked — it is asked
  // below, and the price follows it.
  if (
    !answeringAfterTheQuote &&
    !mustAskBeforePrice &&
    !gussetOwed &&
    isComplete(conversation.collected) &&
    missingContact.length === 0
  ) {
    if (reachable) {
      conversation.collected = withDefaults(conversation.collected);
      // The price first, so the closing knows whether one was given and does not
      // promise pricing "within today" to somebody already looking at it.
      const priceLine = await withPriceAtTheEnd();
      const dynamicComplete = getChatCompleteMessage(new Date(), Boolean(conversation.instantPrice));
      return finish(
        conversation,
        "complete",
        [botQuestionAnswer, priceLine, closingLineFor(conversation, typed, dynamicComplete)].filter(Boolean).join("\n\n")
      );
    }

    // Everything about the job, and no way to answer it. That is not a finished
    // enquiry — it is one only a person can rescue, so it goes to a person
    // rather than being closed with "I'll send a quote over" to nobody.
    console.warn(`[chat] ${conversation.conversationId} qualified but left no email or phone`);
    return finish(conversation, "needs_human", settings.chat.handoffMessage);
  }

  const askContact =
    isComplete(conversation.collected) && missingContact.length > 0
      ? contactFieldByKey(missingContact[0])
      : null;

  /**
   * The address, once — as soon as we know what they are buying.
   *
   * It used to be asked only at the end, and the reasoning was sound: somebody
   * who has just described what they want has a reason to leave a number, and a
   * stranger greeted by a form does not. What it missed is that most chats never
   * reach the end. The visitor stops replying at question four and we are left
   * holding half a job and no way to ask about the other half, when they would
   * have given an address at question two — and an address on its own is a lead
   * a rep can work in the morning.
   *
   * Once. If they ignore it, the attempt is spent and the closing ask above is
   * the one that tries again; asked twice in a row it reads as a wall.
   */
  /**
   * A quantity we cannot make, which nobody has answered yet.
   *
   * It outranks the address. Asked for an email straight after saying "80", a
   * customer has been quietly accepted for an order that cannot be produced —
   * that happened twice in one morning, on eighty stickers and on "3-500" — and
   * the lead reaches a rep looking complete when the first thing on it is
   * impossible. The minimum gets answered first; the address is one message
   * behind and loses nothing by waiting.
   */
  const mustAnswerTheMinimum =
    !minimumWaivedFor(conversation.collected, conversation.messages) &&
    minimumApplies(conversation.collected.product) &&
    belowMinimum((conversation.collected as Record<string, string>).quantity) &&
    !minimumAlreadyStated(
      conversation.messages.filter((message) => message.author === "ai").map((message) => message.text)
    );

  /**
   * They have asked us things, so the early address ask waits a turn.
   *
   * That message is told to ask for the email and nothing else, and on it a
   * customer who had asked for the minimum, the lead time and whether we
   * assemble in-house got none of it answered — and never did, because by the
   * next turn her questions were history.
   */
  // Or the message is just the name of a fact we publish — see asksBareFactTopic.
  // "Moq" has no question mark and no question word, so nothing here saw the
  // question in it and the whole fact-answering path stayed switched off.
  const visitorAsking = Boolean(typed) && (visitorIsAsking(typed) || Boolean(bareFactTopic));

  const earlyEmail =
    !askContact &&
    !mustAnswerTheMinimum &&
    !visitorAsking &&
    !unclear &&
    !reachable &&
    (settings.chat.askContactFields || []).includes("email") &&
    Boolean((conversation.collected as Record<string, string>).product) &&
    (asked.email || 0) === 0 &&
    conversation.lastAsked !== "email"
      ? contactFieldByKey("email")
      : null;

  const pendingAsk = askContact || earlyEmail;

  /**
   * A field asked twice already is off the table.
   *
   * The writer picks its own next question now, so this is the one place that
   * still bounds it: anything it has run at twice without an answer is named
   * below as something not to raise again.
   */
  const givenUp = Object.keys(asked).filter((key) => (asked[key] || 0) >= MAX_ASKS);

  /**
   * The gusset, when their words say stand-up or flat bottom and the size has
   * only width and height — asked in fixed words rather than by the writer,
   * whose checks read any size question after the size is in as asking for
   * something we hold. The style itself is never asked: the size decides it.
   * Not when anything more pressing is due — the early email, the minimum, a
   * question of theirs to answer — which puts it off a turn. At most twice.
   *
   * Ahead of the closing name and phone asks, though: those came first, the
   * chat was complete by the time they were answered, and it closed without
   * the gusset or the price.
   */
  const sizesNowHeld = (conversation.collected as Record<string, string>).sizes;
  const pricingQuestion =
    !isPricingConfigured() ||
    (pendingAsk && !askContact) ||
    mustAnswerTheMinimum ||
    visitorAsking ||
    unclear ||
    answeringAfterTheQuote ||
    sizeMissingUnit(sizesNowHeld)
      ? null
      : gussetOwed
        ? { text: gussetQuestion(sizesNowHeld, gussetAsks(conversation.messages)), field: "sizes" }
        : // A detail the writer skipped on a bag about to be priced, in the
          // script's words — see mustAskBeforePrice.
          mustAskBeforePrice && stillToAsk
          ? { text: `${acknowledgementAfter(botAsked)} ${PRICE_DETAIL_QUESTIONS[stillToAsk]}`, field: stillToAsk }
          : null;

  if (pricingQuestion) {
    const question = [botQuestionAnswer, pricingQuestion.text].filter(Boolean).join(" ");
    conversation.lastAsked = pricingQuestion.field;
    conversation.askedCounts = asked;
    conversation.markModified("askedCounts");
    conversation.messages.push({
      author: "ai",
      text: question,
      at: new Date(),
      ...(settings.chat.dryRun ? { dryRun: true } : {}),
    });
    conversation.aiMessageCount += 1;
    await conversation.save();
    return { reply: question, conversation };
  }

  let turn: { reply: string; asked: string };
  try {
    turn = await composeChatReply({
      visitorName: displayName(conversation.name),
      /**
       * A name only when the bot is going to see the chat through itself.
       *
       * Working hours: blank. The chat is handed to whoever accepts it first,
       * so opening as Frank and being answered by Brian reads as being passed
       * around. Off-hours: the persona's name, used throughout and written on
       * the lead, so a customer who rings back gets the person they spoke to.
       */
      repName: botStepsAside(settings)
        ? ""
        : firstNameOf(conversation.spokeAs || conversation.repName),
      returning: Boolean(conversation.previousChatAt) && metThisRepBefore,
      returningToNewRep: Boolean(conversation.previousChatAt) && !metThisRepBefore,
      visitorAsking,
      unclear,
      assumedSize,
      afterTheQuote: answeringAfterTheQuote,
      sharedFile: Boolean(incoming.sharedFile),
      fileNames: incoming.fileNames,
      contact,
      replyBy: receivedAt + replyBudget,
      settings,
      fields: settings.quoteFields.filter((field) => field.enabled),
      collected: conversation.collected,
      ...(pendingAsk
        ? {
            ask: {
              label: pendingAsk.label,
              question: pendingAsk.question,
              ...(earlyEmail ? { early: true } : {}),
            },
          }
        : {}),
      needsAnyContact: Boolean(askContact) && !reachable,
      ...(minimumWaivedFor(conversation.collected, conversation.messages) ? { minimumWaived: true } : {}),
      ...(priceWanted
        ? { instantPrice: { coming: true } }
        : conversation.instantPrice
          ? { instantPrice: { line: conversation.instantPrice.line } }
          : {}),
      companyFacts: settings.company?.facts,
      givenUp,
      messages: conversation.messages,
      pageTitle: conversation.landingPageTitle,
      question: conversation.question,
      questionsForRep: conversation.questionsForRep,
    });
  } catch (error: any) {
    /**
     * The model failed (usually OpenAI slow past the timeout). This used to end
     * the chat with "Let me check on that and come back to you shortly" — 60
     * chats on 9 and 22 October alone, most of them on the greeting, before the
     * visitor had said anything. The script still knows what to ask next, so
     * the chat carries on with that and the next turn tries the model again.
     */
    console.error("[chat] could not compose a reply, using the script:", error.message);
    const fallback = scriptedFallback(conversation, settings, pendingAsk, asked, botStepsAside(settings));
    if (!fallback) return finish(conversation, "error", settings.chat.handoffMessage);
    turn = fallback;
  }

  // Remembered, not counted. Whether this attempt was spent is decided next
  // turn, once we can see whether they tried to answer it.
  //
  // Nothing is remembered on the opening turn, because nothing from the script
  // was asked: the visitor has not spoken, so the bot only says hello and asks
  // what they need. Recording a field here would spend an attempt on a question
  // that never went out — and with two attempts allowed, that is half the
  // budget for a detail nobody has been asked about once.
  const visitorHasSpoken =
    conversation.messages.some((message) => message.author === "visitor") ||
    Boolean(conversation.question?.trim());

  // Taken from the writer's own answer rather than from a plan made before it
  // spoke. The plan and the message used to be able to disagree — the plan said
  // "sizes", the message asked something else, and the attempt was charged to
  // the wrong field.
  conversation.lastAsked = !visitorHasSpoken ? "" : pendingAsk ? pendingAsk.key : turn.asked;
  conversation.askedCounts = asked;
  conversation.markModified("askedCounts");

  turn.reply = await withPrice(turn.reply, visitorAsking);
  if (botQuestionAnswer) turn.reply = `${botQuestionAnswer} ${turn.reply}`;

  conversation.messages.push({
    author: "ai",
    text: turn.reply,
    at: new Date(),
    ...(settings.chat.dryRun ? { dryRun: true } : {}),
  });
  conversation.aiMessageCount += 1;

  // Answering a question after the quote does not reopen the enquiry. The lead
  // sweep picks the new messages up as a note on the lead they already have.
  if (answeringAfterTheQuote) conversation.status = "ready_to_quote";

  await conversation.save();

  return { reply: turn.reply, conversation };
}

/**
 * How far back a website greeting is looked for.
 *
 * The four website chats that split in a week were typed 2, 5, 16 and 62
 * minutes after their greeting. Three hours covers a tab left open without
 * reaching back into somebody's previous visit.
 */
const GREETING_LOOKBACK_MS = 3 * 60 * 60_000;

/** SalesIQ's number for an anonymous visitor: "Visitor 904311" and "904311" are one person. */
export function anonymousVisitorNumber(name: string): string {
  return (String(name || "").trim().match(/^(?:visitor\s*)?(\d{4,})$/i) || [])[1] || "";
}

/**
 * The website greeting a chat already opened with, when SalesIQ has not tied
 * the message to it.
 *
 * The widget's `trigger` carries only the browser's uvid. Most messages carry
 * it too and land on the same record, but some carry only the conversation id —
 * and those started a second record: a fresh rep picked, and a second
 * introduction under a different name. "Hi, I'm Jessica. Nice to meet you!",
 * then "Hi, I'm Frank." Four website chats in one week, and in all four the two
 * names differed.
 *
 * What both payloads do share is SalesIQ's number for an anonymous visitor —
 * the trigger names them "904311", the message "Visitor 904311" — and in every
 * one of the four it matched exactly one greeting. Matched only onto a record
 * that is a greeting and nothing more: no visitor words, no lead, recent. The
 * sweep closes an unanswered greeting after three minutes, and all four had
 * been, so a greeting closed that way still counts.
 */
export function findWebsiteGreeting(
  ChatConversation: Model<IChatConversation>,
  incoming: IncomingChat,
  now = new Date()
) {
  // A message carrying the uvid is already keyed onto its greeting.
  if (incoming.uvid) return null;
  const number = anonymousVisitorNumber(incoming.name);
  if (!number) return null;

  return ChatConversation.findOne({
    uvid: { $ne: "" },
    visitorId: "",
    $expr: { $eq: ["$conversationId", "$uvid"] },
    name: { $in: [number, `Visitor ${number}`] },
    "messages.author": { $ne: "visitor" },
    createdAt: { $gte: new Date(now.getTime() - GREETING_LOOKBACK_MS), $lte: now },
    $and: [
      { $or: [{ status: "active" }, { status: "stopped", handoffReason: "abandoned_empty" }] },
      { $or: [{ zohoLeadId: { $exists: false } }, { zohoLeadId: "" }, { zohoLeadId: null }] },
    ],
  }).sort({ createdAt: -1 });
}

/**
 * The record this turn belongs to when its own id finds nothing.
 *
 * A message picks up the website greeting it follows, re-keyed onto the
 * conversation id — every later message, the lead write and the rep alerts all
 * look it up by that id. A trigger then finds it again by uvid, the way it
 * would have found the greeting, rather than starting a third record with a
 * third name.
 */
async function continueWebsiteGreeting(
  ChatConversation: Model<IChatConversation>,
  incoming: IncomingChat,
  isTrigger: boolean
) {
  if (isTrigger) {
    if (!incoming.uvid) return null;
    return ChatConversation.findOne({
      uvid: incoming.uvid,
      // Not an earlier visit's chat, set aside under a "~" id by startNewVisit.
      conversationId: { $not: /~/ },
      $expr: { $ne: ["$conversationId", "$uvid"] },
    }).sort({ updatedAt: -1 });
  }

  const greeting = await findWebsiteGreeting(ChatConversation, incoming);
  if (!greeting) return null;

  console.log(
    `[chat] ${incoming.conversationId} continues the website greeting ${greeting.conversationId} ` +
      `as ${greeting.repName || "no rep"} rather than introducing a second rep`
  );
  greeting.conversationId = incoming.conversationId;
  greeting.status = "active";
  greeting.handoffReason = undefined;
  greeting.handedOffAt = undefined;
  return greeting;
}

/**
 * How long after a chat's last message somebody is on a new visit.
 *
 * Inside it, a visitor who paused and came back — or who adds "thanks" or one
 * more detail after the chat finished — carries on in the same chat. Past it,
 * they are back with something new, and get a fresh chat with the same rep.
 */
const NEW_VISIT_AFTER_MS = 3 * 60 * 60_000;

export type FinishedChatAction = "reopen" | "new-visit" | "repeat-last";

/**
 * What a finished chat does when its visitor turns up again.
 *
 * - A greeting nobody answered, and nothing more: open it again. Same browser,
 *   same rep, same greeting — 841 of the week's holding lines were exactly this.
 * - A real chat, a while ago: a new visit.
 * - A real chat, just now: carry on with it — except that opening the widget
 *   again, or writing into a chat handed to a person, only hears the last thing
 *   we said.
 */
export function whatToDoWithFinishedChat(
  conversation: Pick<IChatConversation, "status" | "messages" | "zohoLeadId" | "updatedAt">,
  isTrigger: boolean,
  now = new Date()
): FinishedChatAction {
  const visitorSpoke = conversation.messages.some((message) => message.author === "visitor");
  if (!visitorSpoke && !conversation.zohoLeadId) return "reopen";

  const last = conversation.messages[conversation.messages.length - 1];
  const lastAt = new Date(last?.at || conversation.updatedAt || 0).getTime();
  if (now.getTime() - lastAt >= NEW_VISIT_AFTER_MS) return "new-visit";

  if (isTrigger || conversation.status === "handed_off") return "repeat-last";
  return "reopen";
}

function reopen(conversation: IChatConversation): void {
  conversation.status = "active";
  conversation.handoffReason = undefined;
  conversation.handedOffAt = undefined;
}

/** How long after a rep took a chat over a returning visitor still goes back to them. */
const BACK_TO_THEIR_REP_FOR_MS = 14 * 24 * 60 * 60_000;

/**
 * The rep who took this chat over, if the visitor coming back should go to them:
 * somebody took it in the last two weeks and still takes chats.
 */
export function repWhoTookItOver(
  previous: Pick<IChatConversation, "attenderEmail" | "attenderName" | "attendedAt" | "messages">,
  settings: ISettings,
  now = new Date()
): { email: string; name: string } | null {
  const email = String(previous.attenderEmail || "").trim().toLowerCase();
  if (!email) return null;
  const takesChats = [
    ...(settings.chat?.repPool || []),
    ...(settings.chat?.liveAgentEmails || []),
    ...(settings.chat?.crmLeadAgents || []),
  ].some((e) => String(e || "").trim().toLowerCase() === email);
  if (!takesChats) return null;
  const last = previous.messages[previous.messages.length - 1];
  const at = new Date(previous.attendedAt || last?.at || 0).getTime();
  if (now.getTime() - at > BACK_TO_THEIR_REP_FOR_MS) return null;
  const fromAddress = email.split(/[.@]/)[0];
  return { email, name: String(previous.attenderName || "").trim() || fromAddress.charAt(0).toUpperCase() + fromAddress.slice(1) };
}

/**
 * A fresh chat for a visitor who has been here before.
 *
 * The id is SalesIQ's and stays with the visitor, so the earlier chat is set
 * aside under the same id plus "~" and when it started — it keeps its lead,
 * its transcript and its place in the lead sweep. The new one keeps the rep and
 * whatever we know about how to reach them, and remembers they are returning.
 *
 * The rep only if they are still in the rotation — see inRotation. Otherwise
 * the new visit starts without one and is given a rep from the pool like any
 * other chat.
 */
async function startNewVisit(
  ChatConversation: Model<IChatConversation>,
  previous: HydratedDocument<IChatConversation>,
  incoming: IncomingChat,
  settings: ISettings
): Promise<HydratedDocument<IChatConversation>> {
  const id = previous.conversationId;
  previous.conversationId = `${id}~${new Date(previous.createdAt).getTime()}`;
  await previous.save();

  const keepsTheirRep = inRotation(previous.repEmail, settings);

  console.log(
    `[chat] ${id} is back after a finished chat — new visit with ` +
      `${keepsTheirRep ? previous.repName || "no rep" : `a new rep (${previous.repName || previous.repEmail} is out of rotation)`}, ` +
      `earlier chat kept as ${previous.conversationId}`
  );

  return new ChatConversation({
    conversationId: id,
    uvid: incoming.uvid || previous.uvid,
    uuid: incoming.uuid || previous.uuid,
    visitorId: incoming.visitorId || previous.visitorId,
    // SalesIQ keeps a WhatsApp chat's opening question for good, and last
    // week's question is not what they are asking today.
    question: incoming.question !== previous.question ? incoming.question : "",
    departmentId: incoming.departmentId || previous.departmentId,
    ...(keepsTheirRep
      ? { repEmail: previous.repEmail, repName: previous.repName, spokeAs: previous.spokeAs }
      : {}),
    name: isPlaceholderName(previous.name) ? "" : previous.name,
    email: previous.email,
    phone: previous.phone,
    previousChatAt: previous.previousChatAt || previous.createdAt,
  });
}

/**
 * Hands the chat to the rep who already has this customer, if one does.
 *
 * Found by the address or number they have just given — see sameCustomer.ts.
 * The bot keeps the name it introduced itself with, because the visitor has
 * been talking to that name; the alerts, the lead and the dashboard move to
 * the rep who already knows them.
 *
 * Not to a rep who has left the rotation — see inRotation. The chat stays with
 * the rep it already has.
 */
async function belongToTheirRep(
  ChatConversation: Model<IChatConversation>,
  conversation: IChatConversation & { _id?: unknown },
  settings: ISettings
): Promise<void> {
  const earlier = await earlierChatFor(ChatConversation, conversation).catch((error: any) => {
    console.error("[chat] could not look for an earlier chat with this customer:", error.message);
    return null;
  });
  if (!earlier) return;

  if (!conversation.previousChatAt) conversation.previousChatAt = earlier.createdAt;

  if (earlier.repEmail && earlier.repEmail !== conversation.repEmail && !inRotation(earlier.repEmail, settings)) {
    console.log(
      `[chat] ${conversation.conversationId} was ${earlier.repName || earlier.repEmail}'s customer, ` +
        `but they are out of rotation — stays with ${conversation.repName || "no rep"}`
    );
    return;
  }

  if (earlier.repEmail && earlier.repEmail !== conversation.repEmail) {
    console.log(
      `[chat] ${conversation.conversationId} is already ${earlier.repName || earlier.repEmail}'s customer ` +
        `(chat ${earlier.conversationId}) — moved from ${conversation.repName || "no rep"}`
    );
    if (conversation.aiMessageCount > 0 && !conversation.spokeAs) conversation.spokeAs = conversation.repName;
    conversation.repEmail = earlier.repEmail;
    conversation.repName = earlier.repName;
  }
}

/** Whether live agents take chats right now instead of the bot. */
function botStepsAside(settings: ISettings): boolean {
  return settings.chat.aiAllHours === false && isOfficeHours(new Date(), settings.officeHours);
}

const SIGN_OFFS = ["You're welcome — talk soon.", "Great — talk soon."];

/**
 * Asking whether it has been sent — "answer me did you email me" has no question
 * mark and is still a question. Kept here so the turn takes it as one.
 */
const ASKS_IF_IT_ARRIVED =
  /\b(did|have) you (e-?mail|sent|send)\b|\bany(thing)? (yet|come through)\b|\bnot receiv|\bhaven'?t (got|received)\b|\bwhere('?s| is) (the|my) (quote|email)\b|\bis (the|my) quote (ready|sent|done)\b/i;

/** For a detail added after the closing line, rather than saying it twice. */
const NOTED_AFTER_THE_QUOTE = "Noted — I've added that to your request.";

/**
 * The closing line, unless it has only just been said.
 *
 * A finished chat picked back up with "ok" finishes again, and it used to say
 * the closing line again word for word — "I will get you a quote in the morning
 * and we will go from there." twice running. A pleasantry straight after it
 * gets a sign-off instead. Anything with substance still gets the closing line,
 * which is the right answer to "did you get my message?".
 */
export function closingLineFor(
  conversation: Pick<IChatConversation, "messages">,
  typed: string,
  completeMessage?: string,
  now = new Date()
): string {
  const messageToSend = completeMessage || getChatCompleteMessage(now);
  const lastFromBot = [...conversation.messages].reverse().find((m) => m.author === "ai")?.text || "";
  if (!typed) return messageToSend;

  // Anything we said after the quote counts, not only the closing line: a
  // "did you email me" answer sat in between, and "ok thanks" got the closing
  // line again because the last thing said was no longer on the short list.
  const weHaveFinished = Boolean(lastFromBot) && !lastFromBot.includes("?");

  if (isPleasantry(typed) && weHaveFinished) {
    if (/\b(hi|hello|hey|hiya|howdy|good morning|good afternoon|good evening)\b/i.test(typed)) {
      return "Hi there! Talk soon.";
    }
    const signOff = /\b(thanks?|thank|thx|ty)\b/i.test(typed) ? SIGN_OFFS[0] : SIGN_OFFS[1];
    return signOff === lastFromBot ? SIGN_OFFS.find((line) => line !== lastFromBot)! : signOff;
  }

  // A few words and no question, after the closing line went out earlier: a
  // sign-off we have no phrase for, not something to answer with the paragraph
  // again. "See you soon" got the whole closing line a second time.
  const closedEarlier = conversation.messages.some((m) => m.author === "ai" && isChatCompleteMessage(m.text));
  if (closedEarlier && weHaveFinished && !/[?\d]|\[shared/.test(typed) && typed.trim().split(/\s+/).length <= 4) {
    return SIGN_OFFS.find((line) => line !== lastFromBot) || SIGN_OFFS[0];
  }

  // Something with substance, and the closing line is already the last thing we
  // said. Saying it again reads as a machine that did not listen.
  if (
    lastFromBot === messageToSend ||
    isChatCompleteMessage(lastFromBot) ||
    (completeMessage && lastFromBot === completeMessage)
  ) {
    return NOTED_AFTER_THE_QUOTE;
  }

  return messageToSend;
}

/** How a shared file reads in the transcript. */
export function sharedFileNote(fileNames: string[]): string {
  if (fileNames.length === 0) return "[shared a file]";
  return `[shared ${fileNames.length === 1 ? "a file" : `${fileNames.length} files`}: ${fileNames.join(", ")}]`;
}

/** That note, read back out of the transcript. */
const IS_A_SHARED_FILE = /^\[shared (?:a file|\d+ files)\b/i;

/**
 * How close together attachments count as one send.
 *
 * Measured, not guessed. The six photos that caused this arrived 1.7 to 2.1
 * seconds apart — one drag-and-drop, delivered as six webhooks. A customer
 * picking files one at a time is slower: in the chat that followed, three came
 * 4 and 12 seconds apart.
 *
 * Fifteen seconds sits between the two. A batch dropped in at once still gets a
 * single reply; a photo somebody chose to send a quarter of a minute later is
 * a new message and is answered like one. This was 45 seconds first, and the
 * customer who took twelve seconds over his third photo got nothing back —
 * technically correct, because the bot's question was still standing, and it
 * reads as a bot that has stopped listening.
 */
const FILE_BURST_MS = 15_000;

/** For files that arrive once the enquiry is already finished. */
const FILE_RECEIVED = "Thanks, I've got that — I've added it to your request.";

export type FileAction = "take-the-turn" | "acknowledge" | "say-nothing";

/** When each chat's latest photo-only webhook arrived, in this process. */
const latestFileAt = new Map<string, number>();

/**
 * How long a photo waits to see whether more are coming before it is answered.
 *
 * Six photos sent together arrive about a second apart. The first is answered as
 * a turn; the rest used to be recorded in silence, so a customer who sent his
 * vials got one reply about the first picture and nothing for the other five,
 * and was left looking at a chat that seemed to have stopped. Now the last of
 * them is answered once, for all of them.
 */
const PHOTO_SETTLE_MS = 3000;

/**
 * Whether this photo is the last of the send. Waits until it has been here
 * PHOTO_SETTLE_MS (no wait at all when it already queued that long behind the
 * turn before it), then checks both this process's arrivals and the stored
 * transcript, since another instance may have taken a later photo.
 */
export async function lastPhotoOfTheSend(
  ChatConversation: Model<IChatConversation>,
  conversationId: string,
  receivedAt: number,
  /** When this photo went into the transcript. */
  oursAt: number
): Promise<boolean> {
  const wait = receivedAt + PHOTO_SETTLE_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));

  if ((latestFileAt.get(conversationId) ?? receivedAt) > receivedAt) return false;

  const stored = await ChatConversation.findOne({ conversationId }, { messages: { $slice: -1 } }).lean();
  const last = (stored as any)?.messages?.[0];
  if (last && last.author === "visitor" && new Date(last.at).getTime() > oursAt) return false;

  if (latestFileAt.get(conversationId) === receivedAt) latestFileAt.delete(conversationId);
  return true;
}

/** One line for the photos that came after the one we already answered. */
export function theRestOfThePhotos(messages: Pick<IChatConversation["messages"][number], "author" | "text">[]): string {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.author !== "visitor") break;
    if (!IS_A_SHARED_FILE.test(message.text)) return "";
    const many = message.text.match(/\[shared (\d+) files/);
    count += many ? Number(many[1]) : 1;
  }
  if (!count) return "";
  return count === 1
    ? "Thanks, I've got that one too — it's added to your request."
    : `Thanks, I've got all ${count} of those too — they're added to your request.`;
}

/**
 * What to say when a photo turns up with no words attached.
 *
 * SalesIQ sends a webhook per attachment. A customer who dropped six pictures
 * of his vials into a chat that had already finished produced six turns, and
 * every one of them ran to the end and closed the enquiry again — the same
 * closing paragraph, six times, inside forty seconds. He had typed nothing;
 * there was nothing there to answer.
 *
 * So: the second and later files of one send are recorded and not replied to,
 * because they are one gesture and not six messages. A file arriving after the
 * quote is acknowledged once instead of reopening a finished chat. And a file in
 * a chat that is still running is answered as a turn like anything else — it is
 * usually the artwork we just asked for, and the reply has somewhere to go next.
 */
export function whatToDoWithAFile(
  chat: {
    /** A file arrived, and the visitor typed nothing with it. */
    fileOnly: boolean;
    /** The visitor's previous message, whatever it was. */
    lastFromVisitor?: { text: string; at: Date };
    /** The enquiry is finished, and this is not somebody back with something new. */
    finished: boolean;
  },
  now = new Date()
): FileAction {
  if (!chat.fileOnly) return "take-the-turn";

  const last = chat.lastFromVisitor;
  const sameSend =
    Boolean(last) &&
    IS_A_SHARED_FILE.test(last!.text) &&
    now.getTime() - new Date(last!.at).getTime() < FILE_BURST_MS;

  if (sameSend) return "say-nothing";
  return chat.finished ? "acknowledge" : "take-the-turn";
}

/**
 * The transcript's note that SalesIQ has been asked for a person.
 *
 * Written when the forward actually goes out, not when the bot decides to make
 * one, so it means what it says. It is not the same as somebody arriving —
 * `attenderName` is that, and only SalesIQ's chat-event webhook can set it —
 * so the wording says we are waiting rather than that anyone has come.
 */
export function handedOverLine(who: string): string {
  return `Chat handed to ${who.trim() || "the team"} — waiting for them to join.`;
}

export async function noteHandedToAPerson(
  conversation: IChatConversation & { save: () => Promise<any> },
  operatorEmail: string
): Promise<void> {
  const who = conversation.repName?.trim() || operatorEmail;
  const line = handedOverLine(who);

  // Handing the same chat over twice writes one line, not two.
  if (conversation.messages.some((message) => message.author === "system" && message.text === line)) return;

  conversation.forwardedToOperator = true;
  conversation.messages.push({ author: "system", text: line, at: new Date() });
  await conversation.save();
}

async function finish(
  conversation: IChatConversation & { save: () => Promise<any> },
  reason: HandoffReason,
  message: string
): Promise<ChatTurn> {
  // "not_a_customer" stops rather than hands off: "handed_off" is one of the
  // statuses the lead sweep writes to the CRM, and the whole point of the
  // reason is that this chat must never reach a rep.
  conversation.status =
    reason === "complete" ? "ready_to_quote" : reason === "not_a_customer" || reason === "declined" ? "stopped" : "handed_off";
  conversation.handoffReason = reason;
  conversation.handedOffAt = new Date();
  if (message) {
    conversation.messages.push({ author: "ai", text: message, at: new Date() });
  }
  await conversation.save();
  return { reply: message, handoff: reason, conversation };
}

/**
 * A rep introduces themselves by first name in a chat.
 *
 * "Hi, I'm Alex" is how a person opens; "Hi, I'm Alex Kane" reads like a form.
 */
/**
 * What to say when the model could not write the reply: the script's own next
 * question, so the chat keeps going. The greeting when the bot has not spoken
 * yet; the pending contact ask; otherwise the first enabled detail not yet
 * collected and not asked twice already. Null only when there is nothing left
 * to ask, which leaves the old hand-off in place.
 */
function scriptedFallback(
  conversation: IChatConversation,
  settings: ISettings,
  pendingAsk: { key: string; question: string } | null,
  asked: Record<string, number>,
  stepsAside: boolean
): { reply: string; asked: string } | null {
  const botSpoke = conversation.messages.some((message) => message.author === "ai");
  const collected = (conversation.collected || {}) as Record<string, string>;

  if (!botSpoke) {
    const name = stepsAside ? "" : firstNameOf(conversation.spokeAs || conversation.repName);
    return {
      reply: `${name ? `Hi, I'm ${name}. ` : "Hi! "}What are you looking to have made — boxes, bags or labels?`,
      asked: "",
    };
  }

  if (pendingAsk?.question) return { reply: `Thanks. ${pendingAsk.question}`, asked: pendingAsk.key };

  const next = (settings.quoteFields || []).find(
    (field) => field.enabled && field.question && !String(collected[field.key] || "").trim() && (asked[field.key] || 0) < 2
  );
  if (next) return { reply: `Thanks. ${next.question}`, asked: next.key };

  // Nothing left on the quote list: make sure the quote has somewhere to go,
  // and otherwise take it in and keep the chat open rather than end it.
  if (!String(conversation.email || "").trim() && !String(conversation.phone || "").trim()) {
    return { reply: "Thanks. What is the best email to send the quote to?", asked: "email" };
  }
  return { reply: "Thanks, I've noted that. Is there anything else you'd like included in your quote?", asked: "" };
}

function firstNameOf(fullName: string): string {
  const first = String(fullName || "").trim().split(/\s+/)[0] || "";
  // Capitalised on the way out: the credential store holds names as they were
  // typed, and one of them is "frank castle", which introduced the rep to
  // customers as "Hi, I'm frank".
  return first ? first[0].toUpperCase() + first.slice(1) : "";
}

/** SalesIQ names an anonymous visitor "Visitor 365140", which is not a name. */
function displayName(name: string): string {
  const value = String(name || "").trim();
  if (!value || /^visitor\s*\d*$/i.test(value) || /^\d+$/.test(value)) return "";
  return value;
}

/** The extractor reads email threads; a chat is the same shape with no subject. */
function asConversationMessages(conversation: IChatConversation): ConversationMessage[] {
  // System lines are ours, not the visitor's. Without this they read as
  // "customer" and "Max Carter joined the chat" becomes something they said.
  return conversation.messages
    .filter((message) => message.author !== "system")
    .map((message) => ({
      author: message.author === "ai" ? "ai" : "customer",
      subject: "",
      body: message.text,
      at: message.at,
    })) as ConversationMessage[];
}

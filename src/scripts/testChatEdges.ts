import "dotenv/config";
/**
 * The chat's edge cases that can be proved without a database or a model:
 * photos, typed addresses, a "thanks" after the lead, what a finished chat does
 * when its visitor comes back, and the guards chat #4457 needed.
 */
import { readMessage } from "../services/salesiq/webhook";
import {
  whatToDoWithFinishedChat,
  whatToDoWithAFile,
  sharedFileNote,
  closingLineFor,
  handedOverLine,
  wantsAPerson,
} from "../services/salesiq/chatEngine";
import { readChatEvent, isSomebodyJoining, joinedLine } from "../services/salesiq/chatEvents";
import { inRotation } from "../services/salesiq/repPool";
import { unitAnswer } from "../domain/sizeUnit";
import { isPleasantry } from "../services/salesiq/handoff";
import { emailIn, isOurRepsName, isPlaceholderName } from "../domain/contactFields";
import { repeatsTheQuestion } from "../domain/repeatedQuestion";
import {
  visitorIsAsking,
  asksWhatIsUsual,
  saysNothingUseful,
  saysTheyDoNotKnow,
  askOutcome,
} from "../domain/askAttempts";
import { sizeIsReallyAQuantity, sizeIsNotASize, sizeIsACapacity } from "../domain/sizeUnit";
import { asksAboutTheQuote } from "../domain/salesScript";
import { tidyQuantity } from "../domain/minimumOrder";
import { isPlaceholderValue, isAQuestionNotAnAnswer, extractSkusInText } from "../domain/quoteFields";
import {
  factQuestionsUnanswered,
  answersFromFacts,
  withAnswersBeforeQuestion,
  factsVolunteered,
  withoutVolunteeredFacts,
  asksBareFactTopic,
} from "../domain/factQuestions";
import { fieldsAskedAbout, questionSentences } from "../domain/repeatedQuestion";
import { parrotsTheirQuestion } from "../domain/visitorQuestions";
import { DEFAULT_COMPANY_FACTS } from "../domain/companyKnowledge";
import { introducesByName, withoutTheName } from "../services/salesiq/chatComposer";

let bad = 0;
function check(label: string, got: unknown, expected: unknown) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) bad += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${label}: ${JSON.stringify(got)}${ok ? "" : `  (expected ${JSON.stringify(expected)})`}`);
}

console.log("-- files and message ids (shapes taken from real SalesIQ payloads)");
check(
  "website/Instagram photo",
  readMessage({ message: { type: "file", meta: { urls: {} } }, attachments: [{ name: "image", contenttype: "image" }] }),
  { text: "", sharedFile: true, fileNames: ["image"], files: [], messageId: "" }
);
check(
  "WhatsApp photo with a caption",
  readMessage({ message: { type: "files", meta: { comments: { abc: "A cigar box" } } }, attachments: [{ name: "1054.jpeg" }] }),
  { text: "A cigar box", sharedFile: true, fileNames: ["1054.jpeg"], files: [], messageId: "" }
);
check('Instagram "File Shared"', readMessage({ message: { text: "File Shared", type: "text" }, attachments: [] }), {
  text: "",
  sharedFile: true,
  fileNames: [],
  files: [],
  messageId: "",
});
check("plain text with a msgid", readMessage({ message: { msgid: 1789157122893, text: "inches", type: "text" }, attachments: [] }), {
  text: "inches",
  sharedFile: false,
  fileNames: [],
  files: [],
  messageId: "1789157122893",
});
check("trigger, no message", readMessage({}), { text: "", sharedFile: false, fileNames: [], files: [], messageId: "" });
check(
  "website photo with its link",
  readMessage({
    message: {
      type: "files",
      meta: {
        urls: { k1: "https://salesiq.zoho.com/api/v2/print247usllc/attachments/abc?file_name=IMG_1906.jpeg&purpose=chat_attachment" },
        comments: { k1: "see attached sample" },
        type: "file",
        value: "k1",
      },
    },
    attachments: [],
  }),
  {
    text: "see attached sample",
    sharedFile: true,
    fileNames: ["IMG_1906.jpeg"],
    files: [{ url: "https://salesiq.zoho.com/api/v2/print247usllc/attachments/abc?file_name=IMG_1906.jpeg&purpose=chat_attachment", name: "IMG_1906.jpeg" }],
    messageId: "",
  }
);
check("transcript note", sharedFileNote(["image"]), "[shared a file: image]");
check("transcript note, no names", sharedFileNote([]), "[shared a file]");

console.log("\n-- an email typed into the chat");
for (const [typed, expected] of [
  ["Majorleaguecreators@gmail.com", "majorleaguecreators@gmail.com"],
  ["my email is h.brown@pcloudinnovations.com.", "h.brown@pcloudinnovations.com"],
  ["Jackie.goblueseal@gmail.com. Please provide bulk pricing", "jackie.goblueseal@gmail.com"],
  ["email me at jane@example", ""],
  ["1 sku couple thousand units", ""],
  ["", ""],
]) {
  check(JSON.stringify(typed), emailIn(typed), expected);
}

console.log("\n-- nothing a rep needs a note about");
for (const [text, expected] of [
  ["thanks", true],
  ["Thank you!", true],
  ["Ok thanks", true],
  ["Sounds good", true],
  ["👍", true],
  ['The boxes can also have a depth of 2" as well', false],
  ["I haven't received the email. Can you send it again?", false],
  ["2000 units", false],
] as Array<[string, boolean]>) {
  check(JSON.stringify(text), isPleasantry(text), expected);
}

console.log("\n-- a finished chat, and somebody comes back");
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);
const greeting = (minutes: number, lead = "") =>
  ({
    status: "stopped",
    zohoLeadId: lead,
    updatedAt: ago(minutes),
    messages: [{ author: "ai", text: "Hi, I'm Jessica.", at: ago(minutes) }],
  }) as any;
const chat = (status: string, minutes: number, lead = "123") =>
  ({
    status,
    zohoLeadId: lead,
    updatedAt: ago(minutes),
    messages: [
      { author: "ai", text: "Hi, I'm Alex.", at: ago(minutes + 5) },
      { author: "visitor", text: "Pouches", at: ago(minutes + 4) },
      { author: "ai", text: "I will get you a quote in the morning.", at: ago(minutes) },
    ],
  }) as any;

check("closed greeting, widget opened again", whatToDoWithFinishedChat(greeting(20), true), "reopen");
check("closed greeting, they type", whatToDoWithFinishedChat(greeting(20), false), "reopen");
check("closed greeting from yesterday", whatToDoWithFinishedChat(greeting(1500), true), "reopen");
check("greeting that has a lead, widget again", whatToDoWithFinishedChat(greeting(10, "9"), true), "repeat-last");
check("complete 2 min ago, they type", whatToDoWithFinishedChat(chat("ready_to_quote", 2), false), "reopen");
check("complete 2 min ago, widget again", whatToDoWithFinishedChat(chat("ready_to_quote", 2), true), "repeat-last");
check("idle-closed mid-chat, they type", whatToDoWithFinishedChat(chat("stopped", 10, ""), false), "reopen");
check("handed to a person, they type", whatToDoWithFinishedChat(chat("handed_off", 10), false), "repeat-last");
check("complete 4 hours ago, they type", whatToDoWithFinishedChat(chat("ready_to_quote", 240), false), "new-visit");
check("complete 4 hours ago, widget again", whatToDoWithFinishedChat(chat("ready_to_quote", 240), true), "new-visit");

console.log("\n-- photos arriving on their own (the six that got six closing lines)");
const secondsAgo = (seconds: number) => new Date(Date.now() - seconds * 1000);
const aFileAgo = (seconds: number) => ({ text: "[shared a file: IMG_8619.jpeg]", at: secondsAgo(seconds) });

check(
  "first photo into a finished enquiry",
  whatToDoWithAFile({ fileOnly: true, lastFromVisitor: { text: "3057135969", at: secondsAgo(150) }, finished: true }),
  "acknowledge"
);
check(
  "the next of the same send",
  whatToDoWithAFile({ fileOnly: true, lastFromVisitor: aFileAgo(2), finished: true }),
  "say-nothing"
);
check(
  "the last of a six-photo drop (1.7-2.1s apart)",
  whatToDoWithAFile({ fileOnly: true, lastFromVisitor: aFileAgo(2), finished: true }),
  "say-nothing"
);
check(
  "still the same send at fourteen seconds",
  whatToDoWithAFile({ fileOnly: true, lastFromVisitor: aFileAgo(14), finished: true }),
  "say-nothing"
);
// Chat 948557000003933021: the third photo, twelve seconds after the second,
// was silenced at the old 45-second window. Sixteen seconds is a new message.
check(
  "a photo chosen and sent sixteen seconds later",
  whatToDoWithAFile({ fileOnly: true, lastFromVisitor: aFileAgo(16), finished: true }),
  "acknowledge"
);
check(
  "a photo sent as an afterthought, ten minutes on",
  whatToDoWithAFile({ fileOnly: true, lastFromVisitor: aFileAgo(600), finished: true }),
  "acknowledge"
);
check(
  "artwork in a chat that is still running",
  whatToDoWithAFile({ fileOnly: true, lastFromVisitor: { text: "mailer boxes", at: secondsAgo(20) }, finished: false }),
  "take-the-turn"
);
check(
  "the rest of that artwork",
  whatToDoWithAFile({ fileOnly: true, lastFromVisitor: aFileAgo(2), finished: false }),
  "say-nothing"
);
check(
  "a photo with a caption is a message",
  whatToDoWithAFile({ fileOnly: false, lastFromVisitor: aFileAgo(2), finished: true }),
  "take-the-turn"
);
check(
  "the very first message of a chat is a photo",
  whatToDoWithAFile({ fileOnly: true, finished: false }),
  "take-the-turn"
);

console.log("\n-- a rep joining, as SalesIQ's chat-event webhook might spell it");
// Zoho publishes no schema for these, so the reader is generous and every
// plausible shape is held here. A real capture replaces one of them.
check(
  "entity_data with an attender",
  readChatEvent({
    entity: "chat",
    event_type: "chat_attended",
    entity_data: {
      chat_id: "948557000003933019",
      attender: { name: "Sarah Blake", email_id: "sarah.blake@print247.us" },
      visitor: { visitor_id: "vis_9", uvid: "uvid_9" },
    },
  }),
  {
    event: "chat_attended",
    chatId: "948557000003933019",
    visitorId: "vis_9",
    uvid: "uvid_9",
    attenderName: "Sarah Blake",
    attenderEmail: "sarah.blake@print247.us",
  }
);
check(
  "a flatter shape, first and last name, operation key",
  readChatEvent({
    operation: "ATTENDED",
    chat: { id: "c1", operator: { first_name: "Max", last_name: "Carter", email: "MAX@print247.us" } },
  }),
  { event: "attended", chatId: "c1", visitorId: "", uvid: "", attenderName: "Max Carter", attenderEmail: "max@print247.us" }
);
check(
  "nothing we recognise",
  readChatEvent({ hello: "world" }),
  { event: "", chatId: "", visitorId: "", uvid: "", attenderName: "", attenderEmail: "" }
);

for (const [event, name, expected] of [
  ["chat_attended", "Sarah", true],
  ["chat_answered", "Sarah", true],
  ["operator_joined", "Sarah", true],
  ["chat_transferred", "Sarah", true],
  ["chat_closed", "Sarah", false],
  ["chat_missed", "Sarah", false],
  // An attended event naming nobody tells us nothing worth showing.
  ["chat_attended", "", false],
] as Array<[string, string, boolean]>) {
  check(
    `${event}${name ? ` by ${name}` : " by nobody"}`,
    isSomebodyJoining({ event, chatId: "c", visitorId: "", uvid: "", attenderName: name, attenderEmail: "" }),
    expected
  );
}

check("the line itself", joinedLine("Sarah Blake"), "Sarah Blake joined the chat.");
check("with no name to use", joinedLine(""), "A team member joined the chat.");
check("the hand-over line", handedOverLine("Max Carter"), "Chat handed to Max Carter — waiting for them to join.");

console.log("\n-- the closing line, not twice running");
const closing = "I will get you a quote in the morning and we will go from there.";
const endedWith = (text: string) =>
  ({ messages: [{ author: "ai", text, at: new Date() }, { author: "visitor", text: "ok", at: new Date() }] }) as any;
check('"ok" after the closing line (#4457)', closingLineFor(endedWith(closing), "ok", closing), "Great — talk soon.");
check('"thanks" after the closing line', closingLineFor(endedWith(closing), "thanks", closing), "You're welcome — talk soon.");
check('"ok" again after the sign-off', closingLineFor(endedWith("Great — talk soon."), "ok", closing), "You're welcome — talk soon.");
check(
  "a new detail after the closing line",
  closingLineFor(endedWith(closing), "the boxes can be 2 inches deep", closing),
  "Noted — I've added that to your request."
);
check(
  "a new detail when the closing line was not the last thing said",
  closingLineFor(endedWith("Do you want me to add a zipper?"), "the boxes can be 2 inches deep", closing),
  closing
);
check("finishing for the first time", closingLineFor(endedWith("What finish do you prefer?"), "yes", closing), closing);

// New time-based complete messages test with closingLineFor
const daytimeClosing =
  "Thank you for sharing the project details. Based on the specifications provided, we’ll prepare our market competitive pricing and will send that over within today.\n\nIf we need anything further, we’ll contact you on the email/ number provided.";
check('"ok" after daytime complete line', closingLineFor(endedWith(daytimeClosing), "ok", daytimeClosing), "Great — talk soon.");
check(
  "a new detail after daytime complete line",
  closingLineFor(endedWith(daytimeClosing), "the boxes can be 2 inches deep", daytimeClosing),
  "Noted — I've added that to your request."
);

console.log("\n-- the same question again (pairs from chat #4457)");
for (const [label, reply, earlier, expected] of [
  [
    "quantity, again after '2000, 5000, and 10000'",
    "Great, thank you. For a first run, what quantity are you looking to order for your first run?",
    "Thanks for the details, Sara. To proceed with your scope, I’ll confirm in-house assembly for sticker sheets, card, envelope, collation, and packing, plus finishes and removable adhesive safety. Quick question: What quantity are you looking to order for your first run?",
    true,
  ],
  [
    "the kit question, word for word",
    "Perfect, thanks. Do you want the complete kit produced and assembled in-house (sticker sheets, card, envelope, collation, packing) or are there parts you’d like us to source as separate components?",
    "Great, thank you. Do you want the complete kit produced and assembled in-house (sticker sheets, card, envelope, collation, packing) or are there parts you’d like us to source as separate components?",
    true,
  ],
  [
    "shipping terms, reworded",
    "Got it, thanks. What shipping terms to the U.S. would you prefer (DDP or other), and should I include shipping options in the quote?",
    "Got it. Thanks for confirming in-house complete kit production and assembly. What is your preferred shipping terms to the U.S. (DDP or other), and do you want us to include options?",
    true,
  ],
  [
    "1000 per size/design, correct?",
    "Perfect, thank you. For a first run, what quantity are you looking to order per size/design? 1000 per size/design, correct?",
    "Thanks. For a first run, what quantity are you looking to order per size/design?",
    true,
  ],
  ["finish after quantity", "Great, thanks. What finish do you prefer: matte, gloss or soft touch?", "What quantity are you looking to order for your first run?", false],
  ["SKUs after quantity", "Got it. How many total designs or SKU's do you have?", "Thanks. What quantity are you looking to order for your first run?", false],
  ["no question in the reply", "Thanks, I've got that.", "What size bag are you looking for?", false],
  [
    "the SKU question reworded (chat #4461 loop)",
    "Got it. Since you’ll have separate designs for each SKU, how many total designs or SKUs do you have?",
    "Great, for a first run, 1000 per size and per design. How many total designs or SKUs do you have?",
    true,
  ],
  [
    "the quantity question after a size question",
    "Got it, 4x6 inches. What quantity are you looking to order for your first run?",
    "What size are you looking for?",
    false,
  ],
] as Array<[string, string, string, boolean]>) {
  check(label, repeatsTheQuestion(reply, earlier), expected);
}

console.log("\n-- they are asking us something");
for (const [text, expected] of [
  ["We'd like your quote to cover the full finished unit. To scope pricing, please confirm: Can you produce and assemble the complete kit in-house? Minimum order quantity", true],
  ["Do you guys print in house?", true],
  ["what is your MOQ", true],
  ["Can you send me the sample", true],
  ["What is a standard package size", true],
  ["Is 5000 enough for a first run", true],
  ["2000, 5000, and 10000", false],
  ["yes complete kit", false],
  ["Boxes for knit kits", false],
  ["i don't know", false],
  ["ddp", false],
] as Array<[string, boolean]>) {
  check(JSON.stringify(text.slice(0, 50)), visitorIsAsking(text), expected);
}

console.log("\n-- questions the company facts answer, left unanswered");
const saraAsks =
  "To scope pricing, please confirm: Can you produce and assemble the complete kit in-house? Minimum order quantity. " +
  "Unit pricing at 1,000 / 5,000 / 10,000 units. Sample or proof lead time and production lead time. Shipping terms to the U.S.";
check(
  "#4457 opening, asked for her quantity instead",
  factQuestionsUnanswered(saraAsks, "Great, thank you for the details. What quantity are you looking to order for your first run?"),
  ["the minimum order", "the turnaround", "whether we make it in-house"]
);
check(
  "#4457 opening, answered",
  factQuestionsUnanswered(
    saraAsks,
    "Yes, we manufacture in-house in the US. Our MOQ is 1000 per size. It's 12-15 business days including delivery. Pricing, samples and shipping terms I'll include in your quote. What quantity are you looking to order for your first run?"
  ),
  []
);
check("MOQ, answered", factQuestionsUnanswered("What is your MOQ", "Our minimum order is 1,000 per size. What type of cigars are you packing?"), []);

// A bare topic word is a question. Asked how many designs he had, Ajmal typed
// "Moq" — no question mark, no question word — and nothing saw a question in
// it: he was answered "Got it." and the next item on the script, never got the
// figure, and "MOQ" reached his lead as the number of designs.
check("bare moq is a question", asksBareFactTopic("Moq"), "the minimum order");
check("shouted", asksBareFactTopic("MOQ"), "the minimum order");
check("with a mark", asksBareFactTopic("moq?"), "the minimum order");
check("the word itself", asksBareFactTopic("minimum"), "the minimum order");
check("lead time", asksBareFactTopic("turnaround"), "the turnaround");
check("where", asksBareFactTopic("location"), "where we are");
// Not a question: a figure with it is them telling us what they want, and a
// real answer to the question we asked is just an answer.
check("a number with it is an instruction", asksBareFactTopic("minimum 500"), null);
check("a finish", asksBareFactTopic("gloss"), null);
check("a spec", asksBareFactTopic("moisture and longer shelve life"), null);
check("nothing", asksBareFactTopic(""), null);
check("bare moq reaches the fact check", visitorIsAsking("Moq") || Boolean(asksBareFactTopic("Moq")), true);

// How many fit inside is not how big the box is. Courtney asked for "custom
// cookie boxes to fit 6, 12 and 24 cookies" and every guard let that through as
// a size with no unit — one more turn and she would have been asked whether six
// cookies is inches, cm or mm.
check("cookie counts are not a size", sizeIsACapacity("6, 12 and 24 cookies"), true);
check("her words, as the reader had them", sizeIsACapacity("6, 12, and 24 cookies per box"), true);
check("one variant", sizeIsACapacity("fits 12 cookies"), true);
check("bottles", sizeIsACapacity("holds 6 bottles"), true);
check("cigars", sizeIsACapacity("20 cigars"), true);
// A real size stays a real size, whatever else is in the sentence.
check("a size with a unit", sizeIsACapacity("6x6x6 inches"), false);
check("a size and a capacity together", sizeIsACapacity("4 inches tall, fits 12 cookies"), false);
check("dimensions alone", sizeIsACapacity("6x5x4"), false);
check("no numbers", sizeIsACapacity("cookie box"), false);
check("nothing", sizeIsACapacity(""), false);

// The bot no longer names itself. By day whoever accepts the chat first is the
// one who answers next, so opening as "Frank" and being answered by Brian reads
// as being passed around.
check("a plain introduction", introducesByName("Hi, I'm Frank. What are you looking to have made?"), true);
check("no apostrophe", introducesByName("Hello, I am Jessica."), true);
check("this is", introducesByName("Hi, this is Harry — welcome back."), true);
check("it's X again", introducesByName("Hi, it's Alex again."), true);
check("my name is", introducesByName("My name is Brian and I can help."), true);
// Ordinary first-person speech, which must survive untouched.
check("happy to help", introducesByName("I'm happy to help with that."), false);
check("with the team", introducesByName("I'm with the Print247 team."), false);
check("afraid not", introducesByName("I'm afraid not — our minimum is 1000."), false);
check("this is the size", introducesByName("I am going to include that in your quote."), false);
check("no introduction at all", introducesByName("What box size are you looking for?"), false);

// Stripping keeps whatever else the sentence was carrying.
check(
  "the name goes, the question stays",
  withoutTheName("Hi, I'm Frank. What are you looking to have made today?"),
  "What are you looking to have made today?"
);
check(
  "mid-sentence introduction",
  withoutTheName("Hi, I'm Frank, what are you after?"),
  "what are you after?"
);
check(
  "nothing to take out",
  withoutTheName("What box size are you looking for?"),
  "What box size are you looking for?"
);
check(
  "minimum for trial unanswered",
  factQuestionsUnanswered("What is the minimum for trial", "Thanks. What quantity are you looking to order for your first run?"),
  ["the minimum order"]
);
check(
  "same for stickers unanswered",
  factQuestionsUnanswered("Is it the same for stickers as well ?", "Do you have any specific material or special features in mind?"),
  ["the minimum order"]
);
check(
  "location, promised instead of answered",
  factQuestionsUnanswered("where the print247 located?", "I'll confirm our location shortly. How many mylar bags do you need?"),
  ["where we are"]
);
check(
  "what boxes you have unanswered",
  factQuestionsUnanswered("what boxes you have", "Got it. What finish do you prefer: matte, gloss or soft touch?"),
  ["what we make"]
);
check(
  "what boxes you have answered",
  factQuestionsUnanswered("what boxes you have", "We make custom mailer, rigid, corrugated, and folding cartons. What style do you need?"),
  []
);
// #4667.1. "per design" in the minimum sentence used to satisfy this, so a
// reply that said nothing about designing counted as having answered it.
const mylarOpening =
  "Hi. I'm interested in custom Mylar bags. Big enough to hold 28 grams of product. " +
  "Quantity: 500 I don't have a design yet. Do y'all do designing?";
check(
  "#4667.1 designing, answered with the minimum",
  factQuestionsUnanswered(mylarOpening, "Minimum for bags is 1000 per size and per design."),
  ["design assistance / dielines"]
);
check(
  "#4667.1 designing, actually answered",
  factQuestionsUnanswered(mylarOpening, "Design support is free, with an in-house engineering team."),
  []
);
check(
  "designing, asked another way",
  factQuestionsUnanswered("do you guys offer graphic design services", "What quantity do you need?"),
  ["design assistance / dielines"]
);
check("not a fact topic", factQuestionsUnanswered("Do yo have 3D raised?", "What finish do you prefer?"), []);
check("no question about facts", factQuestionsUnanswered("2000 units", "How many designs?"), []);

console.log("\n-- the facts' own answers, for a reply that still left them out");
check(
  "all five topics, from the default facts",
  answersFromFacts(
    ["the minimum order", "the turnaround", "whether we make it in-house", "where we are", "payment"],
    DEFAULT_COMPANY_FACTS
  ),
  [
    "Our MOQ is 1000 per size and if you have multiple designs then we can do 500 each.",
    "It's 12-15 business days that includes both production and delivery to your doorstep.",
    "We manufacture in-house in the United States.",
    "We are based in Houston, Tx.",
    "We accept ACH, Wire transfer and Zelle, we also offer payment links for card payments but there will be 3% bank processing fee.",
  ]
);
check("minimum, for a banner", answersFromFacts(["the minimum order"], DEFAULT_COMPANY_FACTS, { banner: true }), [
  "Banners have no minimum — we make one, two or more.",
]);
check("design, which the facts answer outside the Q&A", answersFromFacts(["design assistance / dielines"], DEFAULT_COMPANY_FACTS), [
  "Design support is free, with an in-house engineering team.",
]);

console.log("\n-- their own question, asked back at them");
// One short question inside a four-line message: measured against the whole
// message it looked like nothing, so "Do y'all do designing?" came back.
check(
  "the whole message hides it",
  parrotsTheirQuestion("Do y'all do designing?", mylarOpening),
  false
);
check(
  "the question on its own does not",
  questionSentences(mylarOpening).some((theirs) => parrotsTheirQuestion("Do y'all do designing?", theirs)),
  true
);
check(
  "a real answer is not a parrot",
  questionSentences(mylarOpening).some((theirs) =>
    parrotsTheirQuestion("What finish do you prefer: matte, gloss or soft touch?", theirs)
  ),
  false
);
check(
  "put in front of the question",
  withAnswersBeforeQuestion("Great, thank you. What quantity are you looking to order for your first run?", ["Our MOQ is 1000 per size."]),
  "Great, thank you. Our MOQ is 1000 per size. What quantity are you looking to order for your first run?"
);

console.log("\n-- what a question asks for, by its words");
for (const [question, expected] of [
  ["What total quantity and SKUs/designs will you have for the first run (per size/design) to start the quote?", ["quantity", "skus"]],
  ["How many mylar bags do you need?", ["quantity"]],
  ["How many total designs or SKU's do you have?", ["skus"]],
  ["What finish do you prefer: matte, gloss or soft touch?", ["finishes"]],
  ["Do you have any specific material or special features in mind beyond the finishes mentioned?", ["material"]],
  ["What size are you looking for?", ["sizes"]],
] as Array<[string, string[]]>) {
  check(JSON.stringify(question.slice(0, 60)), fieldsAskedAbout(question), expected);
}

console.log("\n-- questions about the quote paperwork, not the job");
for (const [question, expected] of [
  ["Do you want me to include a digital proof with the quote?", true],
  ["How would you like the artwork organized for those 15 SKUs?", true],
  ["should we include a link for approval or a PDF attachment?", true],
  ["Is there a preferred file naming for the 15 SKU designs on the proof?", true],
  ["what is the preferred delivery address for the order?", true],
  ["Do you want the shipping method or carrier preference included in the quote?", true],
  ["What finish do you prefer: matte, gloss or soft touch?", false],
  ["How many total designs or SKU's do you have?", false],
  ["What style of box do you need or can you share a reference image?", false],
  ["What is the best email to send the quote to?", false],
] as Array<[string, boolean]>) {
  check(JSON.stringify(question.slice(0, 52)), asksAboutTheQuote(question), expected);
}

console.log("\n-- a name that is not a name");
for (const [value, expected] of [
  ["yes", true],
  ["ok", true],
  ["thanks", true],
  ["Visitor 904311", true],
  ["", true],
  ["Sara Cecchini", false],
  ["Priya", false],
  ["Hammad2", false],
] as Array<[string, boolean]>) {
  check(JSON.stringify(value), isPlaceholderName(value), expected);
}

console.log("\n-- a message with nothing usable in it");
for (const [text, expected] of [
  ["Q as the Ty of", true],
  ["as th e to of", true],
  ["ok got it now", false],
  ["no special material", false],
  ["i dont know", false],
  ["can you do it", false],
  ["mylar bags", false],
  ["4x6", false],
  ["yes", false],
] as Array<[string, boolean]>) {
  check(JSON.stringify(text), saysNothingUseful(text), expected);
}

console.log("\n-- asking what is standard");
for (const [text, expected] of [
  ["What is a standard package size", true],
  ["Do you have standard sizes?", true],
  ["what do you recommend for a coffee pouch?", true],
  ["what's the usual thickness", true],
  ["Could you recommend someone to contact?", false],
  ["can you suggest who I should talk to", false],
  ["standard gloss", false],
  ["4x6 inches", false],
  ["I need boxes", false],
] as Array<[string, boolean]>) {
  check(JSON.stringify(text), asksWhatIsUsual(text), expected);
}

console.log("\n-- who may be handed a chat, fresh or inherited");
const poolWithoutMax = {
  chat: { repPool: ["alex.kane@print247.us", "frank.castle@print247.us", "jessica.joe@print247.us"] },
} as any;
check("a rep in the pool", inRotation("alex.kane@print247.us", poolWithoutMax), true);
check("Max, removed", inRotation("max.carter@print247.us", poolWithoutMax), false);
check("case and spacing do not matter", inRotation("  Jessica.Joe@Print247.us ", poolWithoutMax), true);
check("nobody", inRotation("", poolWithoutMax), false);
check("an empty pool lets nobody in", inRotation("alex.kane@print247.us", { chat: { repPool: [] } } as any), false);

console.log("\n-- a quantity that came back as a sentence (Indigo's chat)");
for (const [value, expected] of [
  ["I like rustic like brown 300", "300"],
  ["about 500", "500"],
  ["I need 2000 boxes please", "2000 boxes"],
  // Left alone: these already say what they mean.
  ["300", "300"],
  ["300 boxes", "300 boxes"],
  ["1000 per size", "1000 per size"],
  ["50 each", "50 each"],
  ["2k", "2k"],
  ["2000, 5000, and 10000", "2000, 5000, and 10000"],
  ["not given", "not given"],
  ["", ""],
] as Array<[string, string]>) {
  check(JSON.stringify(value), tidyQuantity(value), expected);
}

console.log("\n-- \"send it to my email\" is a no to the phone");
for (const [asked, text, expected] of [
  ["phone", "Please send it to my email", "declined"],
  ["phone", "Send info to email for now we can communicate through the email", "declined"],
  ["name", "just email me", "declined"],
  // Asked for the email, that is a preference and not a refusal — the ask
  // stays alive rather than being retired.
  ["email", "Please send it to my email", "free"],
  ["phone", "3057135969", "spent"],
  ["phone", "what is your turnaround?", "free"],
] as Array<[string, string, string]>) {
  check(`askOutcome('${asked}', ${JSON.stringify(text)})`, askOutcome(asked, text, false), expected);
}

console.log("\n-- \"what are my options\", asked twice and never answered");
for (const [text, expected] of [
  ["What are my options", true],
  ["what are my options?", true],
  ["what options do you have", true],
  ["what else can you do", true],
  ["what do you offer", true],
  ["what boxes you have", true],
  ["I need 300 boxes", false],
  ["matte", false],
] as Array<[string, boolean]>) {
  check(
    JSON.stringify(text),
    factQuestionsUnanswered(text, "Nice to meet you. Could I take your name?").includes("what we make"),
    expected
  );
}
check(
  "and answered properly",
  factQuestionsUnanswered("What are my options", "We make custom mailer boxes, rigid boxes and folding cartons. Could I take your name?"),
  []
);

console.log("\n-- they cannot answer (chat 948557000003933021: \"Size: no idea\")");
for (const [text, expected] of [
  ["no idea", true],
  ["No idea.", true],
  ["not sure", true],
  ["I'm not sure yet", true],
  ["don't know", true],
  ["I dont know", true],
  ["no clue", true],
  ["unsure", true],
  ["haven't decided", true],
  ["no preference", true],
  ["you tell me", true],
  ["whatever you recommend", true],
  // A number in it is an answer, however hedged.
  ["not sure, maybe 4x6", false],
  ["no idea, something like 10x8x4 inches", false],
  // And these are answers, not shrugs.
  ["mylar bags", false],
  ["matte", false],
  ["", false],
] as Array<[string, boolean]>) {
  check(JSON.stringify(text), saysTheyDoNotKnow(text), expected);
}

console.log("\n-- our rep's name is not theirs");
const sara = ["We are sourcing a manufacturer... Best regards, Sara Cecchini", "sccecchini@yahoo.com"];
check("Jessica Joe for Sara (#4457)", isOurRepsName("Jessica Joe", ["Jessica Joe"], sara), true);
check("just Jessica", isOurRepsName("Jessica", ["Jessica Joe"], sara), true);
check("the name the bot spoke as", isOurRepsName("Frank", ["Alex Kane", "frank castle"], []), true);
check("Sara herself", isOurRepsName("Sara Cecchini", ["Jessica Joe"], sara), false);
check("a visitor who really is called Alex", isOurRepsName("Alex", ["Alex Kane"], ["my name is Alex"]), false);
check("no name", isOurRepsName("", ["Alex Kane"], []), false);

console.log("\n-- a size that is really the quantity");
check("#4457", sizeIsReallyAQuantity("1000 per size/design", "1000 per size/design"), true);
check("the quantity number again", sizeIsReallyAQuantity("1000", "1000"), true);
check("counted in units", sizeIsReallyAQuantity("500 units", ""), true);
check("a real size", sizeIsReallyAQuantity("4x6 inches", "1000"), false);
check("bare dimensions", sizeIsReallyAQuantity("6 x 4 x 2", "5000"), false);
check("a 12 inch pizza box, unit to come", sizeIsReallyAQuantity("12", "5000"), false);
check("tiers of quantity typed as an answer", sizeIsReallyAQuantity("2000, 5000, and 10000", ""), true);
check("one bare thousand", sizeIsReallyAQuantity("1,000", ""), true);
check("small bare numbers are still a size", sizeIsReallyAQuantity("6 4 2", ""), false);

console.log("\n-- a 'size' nobody could measure");
for (const [value, expected] of [
  ["standard package size", true],
  ["typical size", true],
  ["whatever you recommend", true],
  ["4x6 inches", false],
  ["same as the sample", false],
  ["A4", false],
  ["", false],
] as Array<[string, boolean]>) {
  check(JSON.stringify(value), sizeIsNotASize(value), expected);
}

console.log("\n-- question sentences");
for (const [text, expected] of [
  ["What style of box do you need for the kit, or please share a reference image. Do you have any specific material or special features in mind?", 2],
  ["What bag or box style are you considering for the kit? If you’re unsure, tell me what goes inside and roughly how big it is.", 1],
  ["It's 12-15 business days that includes both production and delivery. Our MOQ is 1000 per size. What quantity are you looking to order for your first run?", 1],
  ["Thanks. For a first run our minimum is 1000 per size and per design — would that work for you?", 1],
  ["Got it.", 0],
] as Array<[string, number]>) {
  check(JSON.stringify(text.slice(0, 50)), questionSentences(text).length, expected);
}

console.log("\n-- a value that stands in for nothing");
for (const [value, expected] of [
  ["null", true],
  ["not specified", true],
  ["N/A", true],
  ["not stated", true],
  ["not sure", false],
  ["not given", false],
  ["none", false],
  ["matte", false],
] as Array<[string, boolean]>) {
  check(JSON.stringify(value), isPlaceholderValue(value), expected);
}

console.log("\n-- facts recited that nobody asked about");
const recitedAll =
  "About us: We are based in Houston, Tx; standard timeline 12-15 business days; we accept ACH, Wire, Zelle and card via payment links with a 3% processing fee; MOQ is 1000 per size (500 per design if multiple designs).";
check(
  "knit kits, 'what is a standard package size' answered with the whole block",
  factsVolunteered(["Boxes for knit kits", "What is a standard package size"], recitedAll),
  ["the minimum order", "the turnaround", "where we are", "payment"]
);
check("…and taken out", withoutVolunteeredFacts(recitedAll, ["the minimum order", "the turnaround", "where we are", "payment"]), "");
check(
  "only the unasked sentence comes out",
  withoutVolunteeredFacts("Great. It's 12-15 business days. What size are you looking for?", ["the turnaround"]),
  "Great. What size are you looking for?"
);
check("asked about, so not recited", factsVolunteered(["What is your MOQ"], "Our minimum order is 1,000 per size. What are you packing?"), []);
check(
  "the minimum, when the quantity is under it",
  factsVolunteered(["80"], "Thanks. For a first run our minimum is 1000 per size and per design — would that work for you?", {
    minimumDue: true,
  }),
  []
);
check("'based on' is not a location", factsVolunteered(["boxes"], "Based on your kit, what size are you looking for?"), []);

console.log("\n-- asking for a person");
for (const [text, expected] of [
  ["Can I speak to a real person please", true],
  ["can I talk to someone? my email is agent.x@example.com", true],
  ["I dont want to talk to ai", true],
  ["i don't want to chat with a bot", true],
  ["stop talking bot", true],
  ["not an ai please", true],
  ["speak to sales rep", true],
  ["connect me to a representative", true],
  ["human.e2e@example.com", false],
  ["agent@acmecandles.com", false],
  ["custom boxes for candles", false],
] as Array<[string, boolean]>) {
  check(JSON.stringify(text), wantsAPerson(text), expected);
}

console.log("\n-- a unit on its own");
for (const [text, expected] of [
  ["mm", "mm"],
  ["Inches", "inches"],
  ["cm.", "cm"],
  ["in", "in"],
  ["50x30", ""],
  ["inches please, 4x6", ""],
] as Array<[string, string]>) {
  check(JSON.stringify(text), unitAnswer(text), expected);
}

console.log("\n-- a question recorded as an answer");
for (const [value, expected] of [
  ["What is a standard package size", true],
  ["Do you have 3D raised?", true],
  ["What size?", true],
  ["4x6x2 inches", false],
  ["Boxes for knit kits", false],
  ["not sure", false],
  ["Do not know", false],
  ["5000", false],
] as Array<[string, boolean]>) {
  check(JSON.stringify(value), isAQuestionNotAnAnswer(value), expected);
}

console.log("\n-- extracting number of designs/SKUs from text");
for (const [text, expected] of [
  ["i am looking for pizza boxes having 2 designs", "2"],
  ["1000 with 2 designs", "2"],
  ["pizza boxes with 2 designs", "2"],
  ["2 designs", "2"],
  ["1 design", "1"],
  ["single design", "1"],
  ["three designs", "3"],
  ["5 skus", "5"],
  ["matte", null],
  ["1000 boxes", null],
  ["", null],
] as Array<[string, string | null]>) {
  check(JSON.stringify(text), extractSkusInText(text), expected);
}

console.log("\n-- declining contact details");
for (const [text, expected] of [
  ["reach me on email", "declined"],
  ["contact me on email", "declined"],
  ["email only", "declined"],
  ["just email", "declined"],
  ["use email", "declined"],
  ["email is fine", "declined"],
  ["email is enough", "declined"],
  ["no phone", "declined"],
  ["no", "declined"],
  ["skip", "declined"],
  ["prefer not", "declined"],
  ["what is the turnaround?", "free"],
  ["hello", "spent"],
] as Array<[string, any]>) {
  check(`askOutcome('phone', ${JSON.stringify(text)})`, askOutcome("phone", text, false), expected);
}

console.log(bad === 0 ? "\nall pass" : `\n${bad} failing`);
process.exit(bad === 0 ? 0 : 1);

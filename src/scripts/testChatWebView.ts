import "dotenv/config";
import { chatWebViewUrl, messageFor } from "../services/whatsappNotify";
import { renderChatViewHtml } from "../server/chatView";
import type { IChatConversation } from "../models/ChatConversation";
import type { ISettings } from "../models/Settings";

let failed = 0;
function check(label: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`ok   ${label}`);
  } else {
    failed++;
    console.error(`FAIL ${label}${detail ? `: ${detail}` : ""}`);
  }
}

console.log("-- 1. Chat web view URL generation");
const url = chatWebViewUrl("visitor_948557000003797015");
check(
  "URL format matches Railway domain",
  url === "https://lead-follow-up-production.up.railway.app/chat-view/visitor_948557000003797015",
  url
);

console.log("\n-- 2. WhatsApp notification formatting");
const mockConversation: IChatConversation = {
  conversationId: "conv_12345",
  visitorId: "vis_12345",
  uvid: "uvid_123",
  uuid: "uuid_123",
  name: "Hammad",
  email: "hammadtest09@gmail.com",
  phone: "+1234567890",
  repEmail: "alex.kane@print247.us",
  repName: "Alex Kane",
  landingPageTitle: "Custom Boxes",
  currentPageUrl: "https://print247.us/custom-boxes?utm_source=google",
  question: "I need pizza boxes",
  departmentId: "dep_1",
  messages: [
    { author: "ai", text: "Hi, I'm Alex. What would you like to have made today?", at: new Date("2026-09-12T00:02:00Z") },
    { author: "visitor", text: "pizza boxes with 2 design", at: new Date("2026-09-12T00:02:30Z") },
    { author: "ai", text: "Great, pizza boxes with 2 designs. What email should I send the quote to?", at: new Date("2026-09-12T00:03:00Z") },
    { author: "visitor", text: "hammadtest09@gmail.com", at: new Date("2026-09-12T00:03:30Z") },
    { author: "ai", text: "Got it. What box size are you looking for?", at: new Date("2026-09-12T00:04:00Z") },
    { author: "visitor", text: "large size 13 inch", at: new Date("2026-09-12T00:04:30Z") },
  ],
  collected: {
    product: "pizza boxes",
    skus: "2",
    sizes: "13 inch",
    finishes: "gloss",
    quantity: "20000",
  },
  questionsForRep: [],
  status: "active",
  aiMessageCount: 3,
  leadAttempts: 0,
  askedCounts: {},
  forwardedToOperator: false,
  createdAt: new Date("2026-09-12T00:02:00Z"),
  updatedAt: new Date("2026-09-12T00:04:30Z"),
};

const mockSettings = {
  chat: {
    chatUrlTemplate: "/admin/chat/{chat_id}",
  },
} as unknown as ISettings;

const groupMsg = messageFor(mockConversation, mockSettings, "group");
const repMsg = messageFor(mockConversation, mockSettings, "rep");

console.log("Group message output:\n" + groupMsg + "\n");
console.log("Rep message output:\n" + repMsg + "\n");

check(
  "Group message includes assigned rep",
  groupMsg.includes("Assigned to: Alex Kane"),
  groupMsg
);
check(
  "Group message includes Web view link with Railway live URL",
  groupMsg.includes("Web view: https://lead-follow-up-production.up.railway.app/chat-view/conv_12345"),
  groupMsg
);
check(
  "Rep message starts with personal header",
  repMsg.startsWith("*New website chat — yours*"),
  repMsg
);
check(
  "Rep message includes Web view link",
  repMsg.includes("Web view: https://lead-follow-up-production.up.railway.app/chat-view/conv_12345"),
  repMsg
);
check(
  "Clean page URL is kept",
  groupMsg.includes("Page: https://print247.us/custom-boxes"),
  groupMsg
);

console.log("\n-- 3. Mobile HTML Chat View Renderer");
const html = renderChatViewHtml(mockConversation, "conv_12345");
check("HTML contains viewport meta for mobile responsiveness", html.includes('name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover"'));
check("HTML contains customer name", html.includes("Hammad"));
check("HTML contains clickable email link", html.includes('href="mailto:hammadtest09@gmail.com"'));
check("HTML contains clickable phone link", html.includes('href="tel:+1234567890"'));
check("HTML contains assigned rep name", html.includes("Alex Kane"));
check("HTML contains collected specs (product)", html.includes("pizza boxes"));
check("HTML contains collected specs (size)", html.includes("13 inch"));
check("HTML contains collected specs (skus)", html.includes("SKUs / Designs"));
check("HTML contains messages timeline", html.includes("pizza boxes with 2 design"));
check("HTML contains active chat pulse indicator", html.includes("status-pulse"));
check("HTML contains copy chat transcript script", html.includes("copyTranscript()"));

console.log("\n-- 4. Attachment card rendering");
const attachmentConversation: IChatConversation = {
  ...mockConversation,
  conversationId: "conv_attachment",
  messages: [
    { author: "visitor", text: "[shared a file: 2139802449909025.jpeg]", at: new Date("2026-09-15T14:34:00Z") },
    { author: "visitor", text: "[shared a file: sample_box.pdf]\nPlease check if you can make this", at: new Date("2026-09-15T14:35:00Z") },
  ],
};
const attachmentHtml = renderChatViewHtml(attachmentConversation, "conv_attachment");
check("Renders image attachment card", attachmentHtml.includes("attachment-card") && attachmentHtml.includes("Image Attachment"));
check("Renders image filename", attachmentHtml.includes("2139802449909025.jpeg"));
check("Renders document attachment card", attachmentHtml.includes("File Attachment") && attachmentHtml.includes("sample_box.pdf"));
check("Renders attachment caption text", attachmentHtml.includes("Please check if you can make this"));
check("Does not render raw bracketed string in chat view", !attachmentHtml.includes("[shared a file: 2139802449909025.jpeg]"));

console.log("\n-- 5. A rep taking the chat over");
const takenOver: IChatConversation = {
  ...mockConversation,
  conversationId: "conv_taken",
  status: "handed_off",
  handoffReason: "visitor_asked",
  forwardedToOperator: true,
  attenderName: "Sarah Blake",
  attenderEmail: "sarah.blake@print247.us",
  attendedAt: new Date("2026-09-12T00:06:00Z"),
  messages: [
    ...mockConversation.messages,
    { author: "system", text: "Chat handed to Alex Kane — waiting for them to join.", at: new Date("2026-09-12T00:05:00Z") },
    { author: "system", text: "Sarah Blake joined the chat.", at: new Date("2026-09-12T00:06:00Z") },
  ],
};
const takenOverHtml = renderChatViewHtml(takenOver, "conv_taken");
check(
  "Hand-over shows as an event, not a chat bubble",
  takenOverHtml.includes("event-handover") && !takenOverHtml.includes('bubble-text">Chat handed to')
);
check("Rep joining shows as an event", takenOverHtml.includes("event-joined") && takenOverHtml.includes("Sarah Blake joined the chat."));
check(
  "Header names who is actually in the chat",
  takenOverHtml.includes('class="rep-tag rep-tag-live"') && takenOverHtml.includes("<strong>Sarah Blake</strong>")
);
check("A chat nobody has joined shows no such tag", !html.includes('class="rep-tag rep-tag-live"'));
check("Events are copied with the transcript", takenOverHtml.includes(".message-row, .event-row"));

console.log("\n-- 6. Not Found Screen");
const notFoundHtml = renderChatViewHtml(null, "missing_999");
check("Not found HTML renders friendly message", notFoundHtml.includes("Conversation Not Found"));
check("Not found HTML includes requested ID", notFoundHtml.includes("missing_999"));

if (failed > 0) {
  console.error(`\n${failed} test(s) failed.`);
  process.exit(1);
} else {
  console.log("\nAll chat web view tests passed successfully!");
}

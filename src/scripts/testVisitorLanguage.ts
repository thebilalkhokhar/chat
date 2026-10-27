/**
 * Which language a chat is answered in, from what visitors have actually typed.
 *
 * The non-English lines are from real chats; the English ones are the kinds of
 * message that must never be mistaken for another language — a wrongly
 * detected visitor gets the whole chat in a language they did not write.
 *
 * Runs on its own — no database, no model.
 */
import { languageOf, visitorLanguage } from "../domain/visitorLanguage";

let bad = 0;

function check(name: string, got: unknown, expected: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) bad += 1;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}`);
  if (!ok) {
    console.log(`        got      ${JSON.stringify(got)}`);
    console.log(`        wanted   ${JSON.stringify(expected)}`);
  }
}

const visitor = (...texts: string[]) => texts.map((text) => ({ author: "visitor", text }));
const chat = (...turns: [string, string][]) => turns.map(([author, text]) => ({ author, text }));

// One message at a time.
const SAID: [string, string][] = [
  ["No hablo Inglés", "Spanish"],
  ["No ablo ingles", "Spanish"],
  ["No sé inglés", "Spanish"],
  ["Hablan español?", "Spanish"],
  ["Hola", "Spanish"],
  ["Hola buen día", "Spanish"],
  ["¡Hola! Quiero más información", "Spanish"],
  ["Precio estimado para 1000 cajas de 5x5x13 cm de impresión simple", "Spanish"],
  ["La bosa cuato cuesta", "Spanish"],
  ["Keria saber si ustedes asen bolsas para negosio", "Spanish"],
  ["https://fb.me/6rUB2gmE3 La información en español porfavor", "Spanish"],
  ["Vc fala português", "Portuguese"],
  ["Oi", "Portuguese"],
  ["Bonjour, je me demande si je peux avoir une soumission", "French"],
  ["Здравейте пращтам снимка на кутията", "Russian"],
  ["Hi, I need a quote for custom boxes", "English"],
  ["What is the price for 1000 mylar bags?", "English"],
  ["Hello", ""],
  ["Hallo", ""],
  ["Cajas", ""],
  ["ok", ""],
  ["5000", ""],
  ["10*20*10 in ψμ", ""],
  ["I TDC f y. Y. Y cncoicihkmmljh. Gou yum", ""],
  ["lead@example.com", ""],
  ["La Croix cans, 12oz", ""],
];
for (const [text, expected] of SAID) check(`"${text}" -> ${expected || "(can't tell)"}`, languageOf(text), expected);

// Over a whole chat.
check("nobody has typed anything", visitorLanguage([]), "English");
check("an English chat", visitorLanguage(visitor("Hi", "I need boxes", "About 2000 please")), "English");
check(
  "one word after saying they do not speak English stays Spanish",
  visitorLanguage(visitor("No ablo ingles", "Cajas")),
  "Spanish"
);
check(
  "switching to Portuguese part-way, then short answers",
  visitorLanguage(visitor("Hi", "How are you?", "Boxes and bag", "Vc fala português", "?", "Ok")),
  "Portuguese"
);
check(
  "switching back to English is followed",
  visitorLanguage(visitor("Hola", "Sorry, can we talk in English please")),
  "English"
);
check(
  "the bot's own lines do not count",
  visitorLanguage(chat(["visitor", "I need labels"], ["ai", "Gracias. ¿Qué tamaño de etiqueta busca?"])),
  "English"
);

console.log(bad ? `\n${bad} failed` : "\nall pass");
process.exit(bad ? 1 : 0);

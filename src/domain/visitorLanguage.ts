/**
 * The language a chat visitor is writing in.
 *
 * The bot thinks and keeps its transcript in English — every rule that reads
 * what it has already said is written against English — and what the visitor
 * sees is translated into their language on the way out (see replyLanguage.ts).
 * This decides which language that is.
 *
 * Deliberately cautious: a visitor wrongly taken for Spanish gets a whole chat
 * in a language they did not write, which is worse than a Spanish speaker
 * getting one English reply. So a language needs either an outright statement
 * ("no hablo inglés", "vc fala português"), a script that is not Latin, or
 * several of its everyday words and more of them than of English.
 */

export const ENGLISH = "English";

/** Everyday words, written without accents — text is compared with its accents removed. */
const WORDS: Record<string, string[]> = {
  English: (
    "the and you your for with are is this that have can will our we to of in it be on not please thank thanks " +
    "would like what how need want looking hello hi hey yes size box boxes bags labels much price quote"
  ).split(" "),
  Spanish: (
    "el la los las del que y en un una por para con es esta estan son su sus usted ustedes gracias hola buenas buenos " +
    "buen dia dias tardes noches quiero quisiera queria necesito cuanto cuanta cuesta precio cajas caja bolsas bolsa " +
    "etiquetas tambien puede pero como mas muy si mi tu te tienes tiene hablo habla espanol ingles entiendo saber " +
    "favor cotizacion presupuesto tamano cantidad"
  ).split(" "),
  French: (
    "le la les des du et est un une pour avec vous nous je bonjour bonsoir merci votre vos sont dans pas que qui sur " +
    "mais tres prix besoin voudrais boites boite sacs etiquettes parlez francais anglais combien devis"
  ).split(" "),
  Portuguese: (
    "o os as que e em um uma para com nao voce vc obrigado obrigada ola oi preciso quero tambem esta sao mais muito " +
    "preco caixas caixa sacos etiquetas tudo bem fala falo portugues ingles orcamento quanto"
  ).split(" "),
  German: (
    "der die das und ist ich sie wir nicht mit fur ein eine zu auf den dem danke hallo bitte haben konnen sind auch " +
    "preis kartons tuten etiketten sprechen deutsch englisch angebot"
  ).split(" "),
  Italian: (
    "il lo gli di che e un una per con non sono grazie ciao buongiorno vorrei anche prezzo molto della scatole " +
    "buste etichette parla italiano inglese preventivo"
  ).split(" "),
};

/** Characters that only one of these languages uses, each worth two words. */
const MARKS: Record<string, RegExp> = {
  Spanish: /[ñ¿¡]/g,
  Portuguese: /[ãõ]/g,
  German: /[ß]/g,
};

/** A visitor saying which language they speak, or that they do not speak English. */
const STATED: [string, RegExp][] = [
  [ENGLISH, /\b(?:in english|speak english|english please)\b/i],
  ["Spanish", /\b(?:no h?ablo ingl[eé]s|no s[eé] ingl[eé]s|^no ingl[eé]s\W*$|no entiendo(?: el)? ingl[eé]s|solo h?ablo espa[nñ]ol|h?ablas? espa[nñ]ol|en espa[nñ]ol|^espa[nñ]ol$)/i],
  ["Portuguese", /\b(?:fala portugu[eê]s|falo portugu[eê]s|em portugu[eê]s|n[aã]o falo ingl[eê]s)\b/i],
  ["French", /\b(?:parlez[- ]vous fran[cç]ais|je parle fran[cç]ais|en fran[cç]ais|je ne parle pas anglais)\b/i],
  ["German", /\b(?:sprechen sie deutsch|auf deutsch|ich spreche (?:kein )?(?:deutsch|englisch))\b/i],
  ["Italian", /\b(?:parla italiano|in italiano|non parlo inglese)\b/i],
];

/** A greeting on its own is short but decisive: "Hola" is somebody about to write Spanish. */
const GREETINGS: [string, RegExp][] = [
  ["Spanish", /^(?:hola|buenas|buenos d[ií]as|buen d[ií]a)\b/i],
  ["French", /^(?:bonjour|bonsoir|salut)\b/i],
  ["Portuguese", /^(?:ol[aá]|oi|bom dia|boa tarde|boa noite)\b/i],
  ["German", /^(?:hallo|guten tag|guten morgen)\b/i],
  ["Italian", /^(?:ciao|buongiorno|buonasera)\b/i],
];

/** Scripts that are not Latin, named by the language the translator should write. */
const SCRIPTS: [string, RegExp][] = [
  ["Arabic", /[؀-ۿ]/g],
  ["Russian", /[Ѐ-ӿ]/g],
  ["Chinese", /[一-鿿]/g],
  ["Japanese", /[぀-ヿ]/g],
  ["Korean", /[가-힯]/g],
  ["Hindi", /[ऀ-ॿ]/g],
  ["Hebrew", /[֐-׿]/g],
  ["Thai", /[฀-๿]/g],
  ["Greek", /[Ͱ-Ͽ]/g],
];

const withoutAccents = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "");

/**
 * One message's language, or "" when it says too little to tell — "Cajas",
 * "ok", "5000", an email address.
 */
export function languageOf(text: string): string {
  const raw = String(text || "")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, " ");
  const trimmed = raw.trim();
  for (const [language, pattern] of STATED) if (pattern.test(trimmed)) return language;

  const letters = (raw.match(/\p{L}/gu) || []).length;
  if (!letters) return "";
  for (const [language, pattern] of SCRIPTS) {
    const inScript = (raw.match(pattern) || []).length;
    if (inScript >= 3 && inScript / letters > 0.3) return language;
  }
  // "Hola" with nothing else is Spanish, but "Hallo" is also how plenty of
  // English speakers type "Hello", so German needs more than the greeting.
  for (const [language, pattern] of GREETINGS) {
    if (pattern.test(trimmed) && (language !== "German" || letters > 12)) return language;
  }
  if (letters < 6) return "";

  // One-letter words ("y", "e", "a", "o") belong to too many languages to count.
  const tokens = (withoutAccents(raw.toLowerCase()).match(/\p{L}+/gu) || []).filter((token) => token.length > 1);
  const score: Record<string, number> = {};
  for (const [language, list] of Object.entries(WORDS)) {
    const words = new Set(list);
    score[language] = tokens.filter((token) => words.has(token)).length;
  }
  for (const [language, pattern] of Object.entries(MARKS)) {
    score[language] += 2 * (raw.match(pattern) || []).length;
  }

  const [best, bestScore] = Object.entries(score)
    .filter(([language]) => language !== ENGLISH)
    .sort((a, b) => b[1] - a[1])[0];
  if (bestScore >= 3 && bestScore >= 2 * score[ENGLISH]) return best;
  // Short and misspelt — "La bosa cuato cuesta" — but with no English in it at all.
  if (bestScore >= 2 && score[ENGLISH] === 0) return best;
  if (score[ENGLISH] >= 2) return ENGLISH;

  return "";
}

/**
 * The language to answer in: that of the latest visitor message that says
 * enough to tell. "Cajas" after "No hablo inglés" is still Spanish, and a
 * visitor who switches to plain English is answered in English from then on.
 */
export function visitorLanguage(messages: { author: string; text: string }[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.author !== "visitor") continue;
    const language = languageOf(message.text);
    if (language) return language;
  }

  return ENGLISH;
}

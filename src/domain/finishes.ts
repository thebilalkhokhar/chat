/**
 * Reading the answer to "matte, gloss or soft touch?".
 *
 * A customer asked to pick one of three types the word they meant and misses:
 * "glass" for gloss, "matt" for matte, "softtouch" run together. The bot repeated
 * one straight back — "Got it, you prefer a glass finish" — which is a finish we
 * do not make, and the same word then went onto the lead for a rep to price.
 *
 * Fixed here rather than in the prompt because the damage is in the record, not
 * only in the sentence: the model can be told to read it correctly and still
 * store what was typed. Only these three are corrected, and only when the whole
 * answer is one of them — a customer who writes something we do not recognise is
 * saying something we should not overwrite.
 */

interface Finish {
  /** What we call it. */
  canonical: string;
  /** The whole answer, when it is only this. */
  exact: RegExp;
  /** The misspelling on its own, inside a longer answer. Never the right word. */
  slip: RegExp;
}

const FINISHES: Finish[] = [
  {
    canonical: "gloss",
    exact: /^(gloss|glossy|glossey|glosy|glass|gluss|gloos|shiny|shine|high gloss)$/,
    slip: /\b(glass|gluss|glosy|glossey|gloos)\b/g,
  },
  {
    canonical: "matte",
    exact: /^(matte|matt|mat|mattee|matty|mate)$/,
    slip: /\b(matt|mat|mattee|matty)\b/g,
  },
  {
    canonical: "soft touch",
    exact: /^(soft ?-? ?touch|softtouch|soft tuch|soft touche|softouch)$/,
    slip: /\b(softtouch|softouch|soft tuch)\b/g,
  },
];

/** The answer with the noise a customer adds around the word itself removed. */
function bareAnswer(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(finish|finishing|lamination|laminate|laminated|please|prefer|i|want|the|a)\b/g, " ")
    .replace(/[.,!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The finish as we would write it, or the answer untouched.
 *
 * Untouched is the common case and the safe one. This is here for the near miss,
 * not to make every answer fit three words: spot UV, foil, embossing and "none"
 * all come through exactly as the customer gave them.
 */
export function normaliseFinish(value?: string): string {
  const answer = String(value || "").trim();
  if (!answer) return answer;

  const bare = bareAnswer(answer);

  for (const finish of FINISHES) {
    if (finish.exact.test(bare)) return finish.canonical;
  }

  // Not the whole answer, so only the misspelt word is replaced and everything
  // they said around it is kept: "glass with spot uv" is a real specification
  // with one word wrong in it.
  let corrected = answer;
  for (const finish of FINISHES) {
    corrected = corrected.replace(finish.slip, finish.canonical);
  }

  return corrected;
}

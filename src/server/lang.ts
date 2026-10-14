/**
 * A small language guesser for the four languages the app drafts in: English, French, Spanish and
 * Catalan. Counts words that are frequent in one language and rare in the others (Spanish and
 * Catalan share many, so only telling words are used), plus a few spelling marks (¿ ¡ ñ for
 * Spanish, l·l for Catalan). Returns null when the text is too short or too mixed to say.
 */

export type Lang = "en" | "fr" | "es" | "ca";
export const LANGS: Lang[] = ["en", "fr", "es", "ca"];
export const LANG_NAMES: Record<Lang, string> = { en: "English", fr: "French", es: "Spanish", ca: "Catalan" };

const TELLING: Record<Lang, string[]> = {
  en: ["the", "and", "you", "is", "are", "with", "this", "that", "have", "will", "please", "thanks", "your", "would", "could", "what", "when", "there", "about", "can", "let", "know", "be"],
  fr: ["le", "des", "est", "et", "je", "vous", "nous", "pour", "avec", "dans", "pas", "merci", "bonjour", "salut", "ce", "sur", "mais", "très", "être", "ça", "oui", "au", "aux", "du", "il", "elle", "suis", "peux", "veux", "chez", "votre", "notre", "bises"],
  es: ["los", "las", "y", "para", "con", "por", "pero", "muy", "gracias", "está", "también", "cuando", "puedes", "nos", "qué", "este", "esta", "yo", "usted", "hasta", "bueno", "tienes", "dime", "abrazo", "saludos", "vale", "hay", "algo", "ahora"],
  ca: ["els", "és", "amb", "però", "molt", "gràcies", "meu", "meva", "també", "quan", "pots", "ens", "què", "aquest", "aquesta", "doncs", "perquè", "jo", "vosaltres", "fins", "aviat", "ho", "fer", "anem", "vens", "dir", "salutacions", "avui", "demà", "dissabte", "divendres", "dijous"],
};
const SETS = Object.fromEntries(LANGS.map((l) => [l, new Set(TELLING[l])])) as Record<Lang, Set<string>>;

export function detectLanguage(text: string): Lang | null {
  const sample = text.slice(0, 4000).toLowerCase();
  const tokens = sample.match(/\p{L}+(?:·\p{L}+)?/gu) ?? [];
  if (tokens.length < 4) return null;
  const score: Record<Lang, number> = { en: 0, fr: 0, es: 0, ca: 0 };
  for (const t of tokens) for (const l of LANGS) if (SETS[l].has(t)) score[l] += 1;
  if (/[¿¡ñ]/.test(sample)) score.es += 2;
  if (/l·l/.test(sample)) score.ca += 2;
  const ranked = LANGS.map((l) => [l, score[l]] as const).sort((a, b) => b[1] - a[1]);
  const [[best, top], [, second]] = ranked;
  // Confident only with a few telling words and a clear lead.
  return top >= 2 && top >= second * 1.5 ? best : null;
}

/** One line, in the email's own language, asking for a natural reply in that language. */
export const REPLY_IN: Record<Lang, string> = {
  en: "Reply in English, naturally.",
  fr: "Réponds en français, de façon naturelle et correcte.",
  es: "Responde en español, de forma natural y correcta.",
  ca: "Respon en català, de manera natural i correcta, sense barrejar-hi castellà.",
};

/** The neutral "I've seen it" reply, in the email's language. */
export function holdingReplyIn(lang: Lang | null, name: string | null): string {
  const n = name ? ` ${name}` : "";
  switch (lang) {
    case "fr":
      return `Bonjour${n},\n\nMerci pour ton message, je l'ai bien vu et je te réponds très vite.\n\nBien à toi`;
    case "es":
      return `Hola${n},\n\nGracias por tu mensaje, lo he visto y te respondo muy pronto.\n\nUn saludo`;
    case "ca":
      return `Hola${n},\n\nGràcies pel teu missatge, l'he vist i et responc ben aviat.\n\nSalutacions`;
    default:
      return `Hi${n},\n\nThanks for your message — I've seen it and will get back to you shortly.\n\nBest regards`;
  }
}

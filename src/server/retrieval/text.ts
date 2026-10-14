/** Text utilities for retrieval: chunking, BM25 lexical scoring, and prompt-injection flagging. */

export function chunkText(text: string, maxChars = 700): string[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const p of paragraphs) {
    if (current && current.length + p.length + 1 > maxChars) {
      chunks.push(current);
      current = "";
    }
    if (p.length > maxChars) {
      // Split very long paragraphs on sentence boundaries.
      for (const sentence of p.split(/(?<=[.!?])\s+/)) {
        if (current && current.length + sentence.length + 1 > maxChars) {
          chunks.push(current);
          current = "";
        }
        current = current ? `${current} ${sentence}` : sentence;
      }
    } else {
      current = current ? `${current}\n${p}` : p;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

const STOP = new Set(
  "a an and are as at be but by for from has have i if in into is it its me my of on or our so that the their them then there these they this to was we what when where which who why will with you your do does did can could should would about how".split(
    " ",
  ),
);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map((t) => (t.length > 4 && t.endsWith("s") ? t.slice(0, -1) : t));
}

export interface LexicalDoc {
  id: string;
  text: string;
}

/** Plain BM25 (k1=1.2, b=0.75). Zero setup, fully offline; the honest baseline semantic search is compared against. */
export function bm25(query: string, docs: LexicalDoc[], k = 5): { id: string; score: number }[] {
  const q = [...new Set(tokenize(query))];
  if (!q.length || !docs.length) return [];
  const toks = docs.map((d) => tokenize(d.text));
  const avg = toks.reduce((s, t) => s + t.length, 0) / toks.length;
  const df = new Map<string, number>();
  for (const t of toks) for (const term of new Set(t)) df.set(term, (df.get(term) ?? 0) + 1);
  const N = docs.length;
  return docs
    .map((d, i) => {
      const tf = new Map<string, number>();
      for (const term of toks[i]) tf.set(term, (tf.get(term) ?? 0) + 1);
      let score = 0;
      for (const term of q) {
        const f = tf.get(term) ?? 0;
        if (!f) continue;
        const idf = Math.log(1 + (N - (df.get(term) ?? 0) + 0.5) / ((df.get(term) ?? 0) + 0.5));
        score += (idf * f * 2.2) / (f + 1.2 * (0.25 + (0.75 * toks[i].length) / avg));
      }
      return { id: d.id, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

/**
 * Instruction-like text in untrusted content, in English, French, Spanish and Catalan. `\b` doesn't work
 * next to accented letters, so non-English patterns use explicit letter boundaries (Unicode mode).
 */
const word = (alternatives: string) => `(?<!\\p{L})(?:${alternatives})(?!\\p{L})`;
const multi = (...parts: string[]) => new RegExp(parts.join(""), "iu");
const AMOUNT = String.raw`(?:\d[\d\s.,]*\s?(?:€|eur|euros?|\$|usd|£|gbp)|iban)`;

const LABELS = {
  ignore: "asks to ignore instructions",
  role: "tries to change the assistant's role",
  system: "references the system prompt",
  permissions: "asks for permissions",
  send: "asks to send data somewhere",
  credentials: "mentions credentials",
  approval: "claims approval",
  money: "asks to move money",
} as const;

const INJECTION_PATTERNS: [RegExp, string][] = [
  // English
  [/\b(ignore|disregard|forget)\b.{0,40}\b(instructions|rules|prompt|policy|policies)\b/i, LABELS.ignore],
  [/\byou are now\b|\bact as\b.{0,30}\b(admin|system|developer)\b/i, LABELS.role],
  [/\bsystem prompt\b|<\/?system>|\[\s*system\s*\]/i, LABELS.system],
  [/\b(grant|give|enable|escalate)\b.{0,40}\b(access|permission|write|auto[- ]?act)\b/i, LABELS.permissions],
  [/\b(send|forward|email|upload|post)\b.{0,60}\b(to|at)\b.{0,40}(@|https?:\/\/)/i, LABELS.send],
  [/\b(api[_ -]?key|password|token|credentials?)\b/i, LABELS.credentials],
  [/\b(approve|approved|pre-?approved)\b.{0,30}\b(this|all|any)\b.{0,20}\baction/i, LABELS.approval],
  [multi(word("wire|transfer|pay|send"), ".{0,40}", AMOUNT), LABELS.money],
  // French
  [multi(word("ignorez?|ignorer|oubliez?|oublier|ne tiens pas compte|ne tenez pas compte"), ".{0,40}", word("instructions?|consignes?|règles|prompt")), LABELS.ignore],
  [multi(word("tu es (?:désormais|maintenant)|vous êtes (?:désormais|maintenant)|agis comme|agissez comme")), LABELS.role],
  [multi(word("prompt (?:du )?système|invite système|message système|instructions système")), LABELS.system],
  [multi(word("accorde[zr]?|donne[zr]?|active[zr]?|octroie[zr]?"), ".{0,40}", word("accès|permissions?|droits? d'écriture")), LABELS.permissions],
  [multi(word("envoie[zr]?|transfère[zr]?|transférez|transmets|transmettez"), ".{0,60}", word("à|a"), ".{0,40}(?:@|https?://)"), LABELS.send],
  [multi(word("mot de passe|identifiants|clé d'api|jeton d'accès")), LABELS.credentials],
  [multi(word("déjà (?:approuvée?s?|validée?s?|autorisée?s?)|pré-?approuvée?s?")), LABELS.approval],
  [multi(word("vire[zr]?|virement|transfère[zr]?|transférez|paye[zr]?|payez"), ".{0,40}", AMOUNT), LABELS.money],
  // Spanish
  [multi(word("ignora[rd]?|olvida[rd]?|haz caso omiso|no hagas caso"), ".{0,40}", word("instrucciones|indicaciones|reglas|normas|prompt")), LABELS.ignore],
  [multi(word("(?:a partir de )?ahora eres|actúa como|actua como")), LABELS.role],
  [multi(word("prompt del sistema|mensaje del sistema|instrucciones del sistema")), LABELS.system],
  [multi(word("concede[r]?|otorga[r]?|dale|activa[r]?"), ".{0,40}", word("acceso|permisos?")), LABELS.permissions],
  [multi(word("envía|envia|reenvía|reenvia|manda|transfiere|sube"), ".{0,60}", word("a|al"), ".{0,40}(?:@|https?://)"), LABELS.send],
  [multi(word("contraseña|credenciales|clave de api|token")), LABELS.credentials],
  [multi(word("ya (?:aprobad[oa]s?|autorizad[oa]s?)|pre-?aprobad[oa]s?")), LABELS.approval],
  [multi(word("transfiere|transferir|transferencia|paga|pagar|ingresa"), ".{0,40}", AMOUNT), LABELS.money],
  // Catalan
  [multi(word("ignora|ignoreu|oblida|oblideu|no facis cas|no feu cas"), ".{0,40}", word("instruccions|indicacions|regles|normes|prompt")), LABELS.ignore],
  [multi(word("(?:a partir d'ara )?ets|actua com|actueu com"), ".{0,20}", word("administrador|sistema|desenvolupador|un altre")), LABELS.role],
  [multi(word("missatge del sistema|instruccions del sistema")), LABELS.system],
  [multi(word("concedeix|dona|activa|atorga"), ".{0,40}", word("accés|permís|permisos")), LABELS.permissions],
  [multi(word("envia|reenvia|transfereix|puja"), ".{0,60}", word("a|al"), ".{0,40}(?:@|https?://)"), LABELS.send],
  [multi(word("contrasenya|credencials|clau d'api")), LABELS.credentials],
  [multi(word("ja (?:aprovad?[ts]?|autoritzad?[ts]?)|pre-?aprovad?[ts]?")), LABELS.approval],
  [multi(word("transfereix|transferir|transferència|paga|pagar|ingressa"), ".{0,40}", AMOUNT), LABELS.money],
];

/** Flags instruction-like text in untrusted content. Flags are informational: the content is treated as data either way. */
export function injectionFlags(text: string): string[] {
  return [...new Set(INJECTION_PATTERNS.filter(([re]) => re.test(text)).map(([, label]) => label))];
}

/**
 * Flags that mean the text is talking to an AI (not just mentioning a password or a transfer). Content
 * with these never goes to the model to draft a reply; the others only add a warning.
 */
const AI_DIRECTED = new Set<string>([LABELS.ignore, LABELS.role, LABELS.system, LABELS.approval]);
export function isAiDirected(flags: string[]): boolean {
  return flags.some((f) => AI_DIRECTED.has(f));
}

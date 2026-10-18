/**
 * The parts of a web page that answer a question. On this laptop the local model reads about four tokens a
 * second, so the first 2,500 characters of three pages (menus, cookie notices, introductions) cost minutes
 * before a word of the answer is written. Instead: cut the page into short passages, keep the ones that share
 * the most words with the question (rare words count more), and give them in page order.
 */

const STOP = new Set(
  "a an the of in on at to for from by with and or is are was were be been it its this that these those what whats which who whom whose when where why how many much do does did i me my you your we our they their there here about into than then as if so not no can could would should will shall may might up out over under more most some any all each other such only own same too very just also tell give find show please know".split(" "),
);

/** Lowercased content words, with a light stem (plurals; -ing/-ed on longer words) so "lives" meets "live". */
export function contentWords(text: string): string[] {
  return (text.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => (w.length <= 3 ? w : w.length > 5 && /(?:ing|ed)$/.test(w) ? w.replace(/(?:ing|ed)$/, "") : w.replace(/ies$/, "y").replace(/(?<!s)s$/, "")));
}

/** Sentences, long runs cut at about 300 characters so one passage never swallows the budget. */
function sentences(text: string): string[] {
  const out: string[] = [];
  for (const s of text.split(/(?<=[.!?])\s+(?=[\p{Lu}\p{N}"“(])/u)) {
    for (let i = 0; i < s.length; i += 300) out.push(s.slice(i, i + 300).trim());
  }
  return out.filter((s) => s.length > 0);
}

/**
 * The best passages of `text` for `question`, in page order, at most about `budget` characters, joined with " … ".
 * A page that shares no word with the question gives its opening only (it may still name the subject).
 */
export function relevantPassages(text: string, question: string, budget = 700): string {
  const want = [...new Set(contentWords(question))];
  const units = sentences(text);
  if (!want.length || !units.length) return text.slice(0, budget);
  const words = units.map((u) => new Set(contentWords(u)));
  // Rare words in this page say more than common ones ("population" beats "lisbon" on a page about Lisbon).
  const weight = new Map(want.map((w) => [w, 1 / Math.log(2 + words.filter((s) => s.has(w)).length)]));
  const asksNumber = /\b(?:how (?:many|much|far|long|tall|high|big|old|deep)|population|when|what year|what time|how often|distance|height|price|cost)\b/i.test(question);
  const scored = units.map((u, i) => {
    let score = 0;
    for (const w of want) if (words[i].has(w)) score += weight.get(w)!;
    if (score > 0 && asksNumber && /\d/.test(u)) score *= 1.5;
    if (i === 0 && score > 0) score *= 1.2; // the opening often defines the subject
    return { i, u, score };
  });
  const best = scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score || a.i - b.i);
  if (!best.length) return text.slice(0, Math.min(budget, 300));
  const kept: typeof best = [];
  let used = 0;
  for (const s of best) {
    if (used + s.u.length > budget && kept.length) continue;
    kept.push(s);
    used += s.u.length + 3;
    if (used >= budget) break;
  }
  return kept
    .sort((a, b) => a.i - b.i)
    .map((s) => s.u)
    .join(" … ")
    .slice(0, budget + 300);
}

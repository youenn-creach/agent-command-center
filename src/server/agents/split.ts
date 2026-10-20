import { z } from "zod";
import { getSetting, type Ctx } from "../db";
import { workLlm, type LlmProvider } from "../llm";

/**
 * Model-based splitting of two-part requests (docs/ACCURACY_PLAN.md, phase B). The wording rules in splitAsks keep growing
 * with every new phrasing; here the local model reads the sentence and says whether it asks for one thing or two, and writes
 * each part as a request of its own (a pronoun replaced by who or what it means). Guarded: each part must be made of the
 * user's own words (a part the model wrote itself is refused), and any failure falls back to the wording rules.
 * Off unless the setting assistant.modelsplit is "on" (measured on the dev set first).
 */

export const SPLIT_SYSTEM = [
  "You read one message a user typed to their personal assistant and decide whether it asks for ONE thing or TWO separate things.",
  "TWO only when the message joins two requests that could each be asked alone, e.g. 'what's on tomorrow and remind me to buy milk', 'nudge Tom and what's the weather in Porto on friday'.",
  "ONE when it is a single request with details or a single chain: 'remind me to call mom and tell her happy birthday' (one reminder), 'find the concert in my email and add it to my calendar', 'check my mail for the invoice and tell me the amount', 'tell Ana yes and put the dinner in my calendar' (one reply that also adds the event).",
  "For TWO, write each part as a full request in the user's own words; replace he/she/it/them/there with what it refers to in the other part.",
  'Answer as JSON: {"parts": ["…"]} with one part (the message unchanged) or two parts.',
].join("\n");
const SPLIT_SCHEMA = { type: "object", properties: { parts: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 2 } }, required: ["parts"] };
const Parts = z.object({ parts: z.array(z.string().min(1).max(400)).min(1).max(2) });

/** Worth asking only when something joins two clauses. */
const JOINED = /\s(?:and|then|also|plus)\s|[,;]\s*\S/i;

export function modelSplitOn(ctx: Ctx) {
  return getSetting(ctx.db, "assistant.modelsplit") === "on";
}

const words = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

/** True when a part is the user's own words: at most two words (a name put in for a pronoun, "the") that the message doesn't have. */
export function ownWords(part: string, text: string): boolean {
  const have = new Set(words(text));
  const w = words(part);
  return w.length >= 2 && w.filter((x) => !have.has(x)).length <= 2;
}

/**
 * The model's split: [a, b] for two requests, "one" when it reads a single request, null when it couldn't say (not asked,
 * model down, unreadable answer, a part not in the user's words): the caller then uses the wording rules.
 */
export async function modelSplit(ctx: Ctx, text: string, llm: LlmProvider = workLlm(ctx, "background")): Promise<[string, string] | "one" | null> {
  if (!JOINED.test(text) || words(text).length < 6) return null;
  try {
    const out = await llm.generate(SPLIT_SYSTEM, `Message: ${text}`, { maxTokens: 160, timeoutMs: 600_000, format: SPLIT_SCHEMA, temperature: 0, keepAlive: "15m" });
    const { parts } = Parts.parse(JSON.parse(out.text));
    const clean = parts.map((p) => p.trim()).filter(Boolean);
    if (clean.length === 1) return "one";
    if (clean.length !== 2 || clean[0].toLowerCase() === clean[1].toLowerCase()) return null;
    return clean.every((p) => ownWords(p, text)) ? [clean[0], clean[1]] : null;
  } catch {
    return null;
  }
}

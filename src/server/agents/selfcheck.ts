import { z } from "zod";
import { getSetting, type Ctx } from "../db";
import { localLlm, fenceUntrusted, type LlmProvider } from "../llm";
import { skillList, type Skill, type SkillAnswer } from "./assistant";

/**
 * The self-check: before an answer the local model routed is shown, the model reads the request and the answer and says whether
 * the answer gives what was asked, every part of it. If not, it names the skill that would, and the command path retries once.
 * It costs one short extra call. Any failure (model down, unreadable verdict) leaves the answer as it was, so the check can
 * never block or break a reply. On only with the setting assistant.selfcheck = "on" (see selfCheckOn).
 */

export const CHECK_SYSTEM = [
  "You check a personal assistant's answer before the user sees it.",
  "Given the user's request and the answer, decide whether the answer gives what the user asked for: every part of the request.",
  "ok is false when the answer is about something else (e.g. today's agenda for a question about a hotel), lists the wrong things, or ignores a part of the request.",
  "ok is true when the answer addresses the request, including an honest 'not found', 'none' or 'I can't do that' about the right thing. Ignore style and length.",
  "When ok is false, skill is the ONE skill below that would answer the request better, or empty if none would. missing says in a few words what is wrong.",
  "Skills:",
].join("\n");
const CHECK_SCHEMA = {
  type: "object",
  properties: { ok: { type: "boolean" }, missing: { type: "string" }, skill: { type: "string" } },
  required: ["ok", "missing", "skill"],
};
const Verdict = z.object({ ok: z.boolean(), missing: z.string().default(""), skill: z.string().default("") });

/**
 * Off by default since 2026-10-17: over the measured runs it fixed no answer and made at least four worse (a question turned
 * into reminders, bills answered with the calendar, a drafted nudge reported as a list), and it adds 30-50 s to a routed
 * request. "on" turns it back on.
 */
export function selfCheckOn(ctx: Ctx): boolean {
  return getSetting(ctx.db, "assistant.selfcheck") === "on";
}

/** The model's verdict on one answer; {ok: true} whenever it can't be had. */
export async function judgeAnswer(ctx: Ctx, request: string, used: string, answer: SkillAnswer, llm: LlmProvider = localLlm(ctx, "background")): Promise<{ ok: boolean; missing: string; skill: Skill | null }> {
  const shown = [answer.reply, ...(answer.items ?? []).slice(0, 8).map((i) => `- ${i.title}${i.detail ? ` (${i.detail.slice(0, 120)})` : ""}`)].join("\n").slice(0, 1500);
  try {
    const out = await llm.generate(`${CHECK_SYSTEM}\n${skillList()}\nAnswer with JSON only.`, `Request: ${request}\nSkill used: ${used}\n${fenceUntrusted("answer shown to the user", shown)}`, {
      maxTokens: 120,
      timeoutMs: 600_000,
      format: CHECK_SCHEMA,
      temperature: 0,
      keepAlive: "15m",
    });
    const v = Verdict.parse(JSON.parse(out.text));
    const known = skillList()
      .split("\n")
      .map((l) => l.split(":")[0].trim());
    const skill = known.includes(v.skill.trim()) ? (v.skill.trim() as Skill) : null;
    return { ok: v.ok, missing: v.missing.slice(0, 200), skill };
  } catch {
    return { ok: true, missing: "", skill: null };
  }
}

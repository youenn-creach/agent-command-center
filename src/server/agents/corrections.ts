import { randomUUID } from "node:crypto";
import { all, run, type Ctx } from "../db";
import { logActivity } from "../activity";
import type { Skill } from "./assistant";
import { choiceLabel } from "./choices";
export { CHOICES, CHOICE_SKILLS } from "./choices";

/**
 * "Understood as … — not right?" (docs/ACCURACY_PLAN.md, phase D): the user picks the kind of request they meant; the request
 * runs again that way, and the pair (their words, the right skill) is kept on this computer as an example for the router,
 * so the next similar request is understood right. Never sent to the cloud router (only the request being routed leaves).
 */


export function recordCorrection(ctx: Ctx, text: string, wrong: string | undefined, chosen: Skill) {
  run(ctx.db, "INSERT INTO route_corrections (id, text, wrong, chosen, created_at) VALUES (?, ?, ?, ?, ?)", randomUUID(), text.slice(0, 500), wrong ?? null, chosen, ctx.now().toISOString());
  const label = (skill: string) => choiceLabel(skill) ?? skill.replace(/_/g, " ");
  logActivity(ctx, { actor: "user", kind: "system", outcome: "info", summary: `Corrected how a request was understood: “${label(chosen)}”${wrong ? ` instead of “${label(wrong)}”` : ""}. It is kept as an example.` });
}

/** The user's corrections as router examples, newest first (the newest choice wins for the same words). */
export function userExamples(ctx: Ctx, limit = 300): [string, string][] {
  const rows = all<{ text: string; chosen: string }>(ctx.db, "SELECT text, chosen FROM route_corrections ORDER BY created_at DESC LIMIT ?", limit);
  const seen = new Set<string>();
  const out: [string, string][] = [];
  for (const r of rows) {
    const key = r.text.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([r.text, `${r.chosen} {}`]);
  }
  return out;
}

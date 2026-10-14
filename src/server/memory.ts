import { randomUUID } from "node:crypto";
import { z } from "zod";
import { all, one, run, type Ctx } from "./db";
import { logActivity } from "./activity";

/**
 * "About me": short facts the user writes (name, tone, languages, habits) that agents may use when
 * writing for them, e.g. reply drafts. The user writes and sees every fact; agents can't add any.
 * Facts are the user's own words, so they are passed to the model as trusted instructions.
 */

export const FactText = z.string().trim().min(2, "Write a few words").max(300, "Keep a fact under 300 characters");
const MAX_FACTS = 50;

export interface FactRow {
  id: string;
  text: string;
  created_at: string;
  updated_at: string;
}

export class MemoryError extends Error {}

export function listFacts(ctx: Ctx): FactRow[] {
  return all<FactRow>(ctx.db, "SELECT * FROM memory_facts ORDER BY created_at");
}

export function addFact(ctx: Ctx, rawText: string): FactRow {
  const text = FactText.parse(rawText);
  if (one<{ n: number }>(ctx.db, "SELECT COUNT(*) n FROM memory_facts")!.n >= MAX_FACTS) throw new MemoryError(`Up to ${MAX_FACTS} facts; remove one first.`);
  const now = ctx.now().toISOString();
  const row = { id: randomUUID(), text, created_at: now, updated_at: now };
  run(ctx.db, "INSERT INTO memory_facts (id, text, created_at, updated_at) VALUES (?, ?, ?, ?)", row.id, row.text, now, now);
  logActivity(ctx, { actor: "user", kind: "system", outcome: "info", summary: "Added a fact to About me" });
  return row;
}

export function updateFact(ctx: Ctx, id: string, rawText: string) {
  const text = FactText.parse(rawText);
  const changed = run(ctx.db, "UPDATE memory_facts SET text = ?, updated_at = ? WHERE id = ?", text, ctx.now().toISOString(), id);
  if (!changed.changes) throw new MemoryError("Fact not found");
}

export function deleteFact(ctx: Ctx, id: string) {
  const changed = run(ctx.db, "DELETE FROM memory_facts WHERE id = ?", id);
  if (!changed.changes) throw new MemoryError("Fact not found");
  logActivity(ctx, { actor: "user", kind: "system", outcome: "info", summary: "Removed a fact from About me" });
}

/** The facts as a prompt block, or "" when there are none. */
export function aboutMePrompt(ctx: Ctx): string {
  const facts = listFacts(ctx);
  if (!facts.length) return "";
  return ["About the user (written by the user themselves; follow these preferences):", ...facts.map((f) => `- ${f.text}`)].join("\n");
}

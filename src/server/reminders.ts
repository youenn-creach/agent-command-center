import { all, one, run, type Ctx } from "./db";
import { randomUUID } from "node:crypto";
import { logActivity } from "./activity";

export interface ReminderRow {
  id: string;
  action_id: string | null;
  text: string;
  due_at: string | null;
  done_at: string | null;
  created_at: string;
}

export class ReminderError extends Error {}

/** Open reminders first (by due date), then the ten most recently completed. */
export function listReminders(ctx: Ctx): ReminderRow[] {
  const open = all<ReminderRow>(ctx.db, "SELECT * FROM reminders WHERE done_at IS NULL ORDER BY COALESCE(due_at, created_at)");
  const done = all<ReminderRow>(ctx.db, "SELECT * FROM reminders WHERE done_at IS NOT NULL ORDER BY done_at DESC LIMIT 10");
  return [...open, ...done];
}

function get(ctx: Ctx, id: string) {
  const r = one<ReminderRow>(ctx.db, "SELECT * FROM reminders WHERE id = ?", id);
  if (!r) throw new ReminderError("Reminder not found");
  return r;
}

/** A reminder the user adds themselves (e.g. "Remind me" on a booking): their own action, no approval needed. */
/** `source` says what the reminder came from (e.g. "booking"), for the Impact card. */
export function addReminder(ctx: Ctx, text: string, dueAt?: string, source?: string) {
  const clean = text.trim().slice(0, 500);
  if (!clean) throw new ReminderError("Write the reminder first");
  const id = `rem_${randomUUID()}`;
  run(ctx.db, "INSERT INTO reminders (id, action_id, text, due_at, done_at, created_at, source) VALUES (?, NULL, ?, ?, NULL, ?, ?)", id, clean, dueAt ?? null, ctx.now().toISOString(), source ?? null);
  logActivity(ctx, { actor: "user", kind: "system", serviceId: "local-tasks", outcome: "info", summary: `Added reminder: ${clean.slice(0, 80)}` });
  return id;
}

export function setReminderDone(ctx: Ctx, id: string, done: boolean) {
  const r = get(ctx, id);
  run(ctx.db, "UPDATE reminders SET done_at = ? WHERE id = ?", done ? ctx.now().toISOString() : null, id);
  logActivity(ctx, { actor: "user", kind: "system", serviceId: "local-tasks", outcome: "info", summary: `${done ? "Completed" : "Reopened"} reminder: ${r.text.slice(0, 80)}` });
}

export function deleteReminder(ctx: Ctx, id: string) {
  const r = get(ctx, id);
  run(ctx.db, "DELETE FROM reminders WHERE id = ?", id);
  logActivity(ctx, { actor: "user", kind: "system", serviceId: "local-tasks", outcome: "info", summary: `Deleted reminder: ${r.text.slice(0, 80)}` });
}

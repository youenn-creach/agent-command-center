import { randomUUID } from "node:crypto";
import { all, run, type Ctx } from "./db";
import type { CommandResult } from "./agents/command";

/**
 * The request board: every Ctrl+K request, with a live status. A request that started something
 * (an action to approve, a workflow run) follows that item, so "draft a reply to Ana" moves from
 * "Waiting for your approval" to "Done" without the user tracking it in a chat thread.
 */

export type RequestState = "waiting" | "working" | "done" | "failed" | "cancelled" | "answered" | "declined" | "unsupported";

export interface RequestView {
  id: string;
  text: string;
  intent: string;
  reply: string;
  created_at: string;
  state: RequestState;
  status: string;
  section: string | null;
  /** The answer a background request delivered (or a direct answer), to show from the board. */
  answer: { reply: string; items?: { title: string; detail?: string; href?: string }[] } | null;
}

const KEEP = 200;

/** Records a request; returns its id (null for the plain help answer). */
export function recordRequest(ctx: Ctx, text: string, result: CommandResult): string | null {
  if (result.intent === "help" && !result.unsupported) return null; // nothing was asked of an agent
  const id = randomUUID();
  run(
    ctx.db,
    "INSERT INTO requests (id, text, intent, reply, action_id, run_id, created_at, status, progress, result) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    id,
    text.slice(0, 300),
    result.intent,
    result.reply.slice(0, 500),
    result.ref?.actionId ?? null,
    result.ref?.runId ?? null,
    ctx.now().toISOString(),
    result.background ? "working" : result.unsupported ? "unsupported" : null,
    result.background ? "Starting…" : null,
    result.items?.length ? JSON.stringify({ reply: result.reply, items: result.items }) : null,
  );
  run(ctx.db, `DELETE FROM requests WHERE id NOT IN (SELECT id FROM requests ORDER BY created_at DESC LIMIT ${KEEP})`);
  return id;
}

/** Progress of a background request ("Reading 4 of 18 emails…"). */
export function setRequestProgress(ctx: Ctx, id: string, progress: string) {
  run(ctx.db, "UPDATE requests SET progress = ? WHERE id = ? AND status = 'working'", progress.slice(0, 120), id);
}

/** A background request finished: its answer is kept for the board, and an action it started is followed. */
export function finishRequest(ctx: Ctx, id: string, out: { ok: boolean; reply: string; items?: { title: string; detail?: string; href?: string }[]; actionId?: string }) {
  run(
    ctx.db,
    "UPDATE requests SET status = ?, progress = NULL, reply = ?, result = ?, action_id = COALESCE(?, action_id) WHERE id = ?",
    out.ok ? "done" : "failed",
    out.reply.slice(0, 500),
    JSON.stringify({ reply: out.reply, items: out.items ?? [] }),
    out.actionId ?? null,
    id,
  );
}

const ACTION_STATE: Record<string, [RequestState, string]> = {
  proposed: ["waiting", "Waiting for your approval"],
  approved: ["waiting", "Approved, ready to run"],
  executing: ["working", "Running"],
  executed: ["done", "Done"],
  dismissed: ["cancelled", "Dismissed"],
  cancelled: ["cancelled", "Cancelled"],
  failed: ["failed", "Failed"],
};
const RUN_STATE: Record<string, [RequestState, string]> = {
  running: ["working", "Working…"],
  succeeded: ["done", "Done"],
  failed: ["failed", "Failed"],
  blocked: ["failed", "Blocked"],
};
const INTENT_STATE: Record<string, [RequestState, string]> = {
  refused: ["declined", "Declined: do this yourself"],
  event: ["done", "Prepared"],
  flights: ["done", "Prepared"],
  remember: ["done", "Saved"],
};
const SECTION: Record<string, string> = {
  agenda: "today",
  reminder: "today",
  waiting_on: "insights",
  trips: "insights",
  subscriptions: "insights",
  nudge: "actions",
  notes: "knowledge",
  event: "today",
  event_from_email: "today",
  reminder_from_email: "today",
  deadlines_to_reminders: "today",
  trip_weather: "today",
  prep_day: "today",
  nudge_all: "actions",
  event_from_web: "today",
  reply_and_add: "actions",
  flights: "today", remember: "knowledge", search: "tech", schedule: "schedules", pending: "actions", today: "today" };

export function listRequests(ctx: Ctx, limit = 15): RequestView[] {
  return all<{ id: string; text: string; intent: string; reply: string; created_at: string; action_id: string | null; run_id: string | null; action_status: string | null; run_status: string | null; status: string | null; progress: string | null; result: string | null }>(
    ctx.db,
    `SELECT r.*, a.status AS action_status, jr.status AS run_status
     FROM requests r LEFT JOIN actions a ON a.id = r.action_id LEFT JOIN job_runs jr ON jr.id = r.run_id
     ORDER BY r.created_at DESC LIMIT ?`,
    limit,
  ).map((r) => {
    const own: [RequestState, string] | null =
      r.status === "working" ? ["working", r.progress ?? "Working…"] : r.status === "failed" ? ["failed", "Failed"] : r.status === "unsupported" ? ["unsupported", "Not possible yet"] : r.status === "done" && !r.action_status ? ["done", "Ready"] : null;
    const [state, status] = own || (r.action_status && ACTION_STATE[r.action_status]) || (r.run_status && RUN_STATE[r.run_status]) || INTENT_STATE[r.intent] || ["answered", "Answered"];
    let answer: RequestView["answer"] = null;
    try {
      answer = r.result ? (JSON.parse(r.result) as RequestView["answer"]) : { reply: r.reply };
    } catch {
      answer = { reply: r.reply };
    }
    return { id: r.id, text: r.text, intent: r.intent, reply: r.reply, created_at: r.created_at, state, status, section: r.action_id ? "actions" : r.run_id ? "today" : (SECTION[r.intent] ?? null), answer };
  });
}

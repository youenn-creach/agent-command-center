import { all, run, type Ctx } from "./db";

export type ActivityKind =
  | "data_access"
  | "agent_run"
  | "action_proposed"
  | "action_edited"
  | "action_approved"
  | "action_executed"
  | "action_dismissed"
  | "permission_change"
  | "permission_denied"
  | "connection_change"
  | "schedule"
  | "retrieval"
  | "system";

export interface ActivityInput {
  actor: string;
  kind: ActivityKind;
  summary: string;
  outcome: "ok" | "denied" | "failed" | "pending" | "info";
  agentId?: string | null;
  serviceId?: string | null;
  detail?: Record<string, unknown>;
}

export interface ActivityRow {
  id: number;
  ts: string;
  actor: string;
  kind: ActivityKind;
  agent_id: string | null;
  service_id: string | null;
  summary: string;
  outcome: string;
  detail: string;
}

// Keys that must never reach the log, even if a caller passes them by mistake.
const REDACT_KEYS = /(body|content|text|snippet|token|secret|password|api[_-]?key|authorization|cookie|uri)/i;
const MAX_DETAIL_STRING = 160;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (typeof value === "string") {
    return value.length > MAX_DETAIL_STRING ? `${value.slice(0, MAX_DETAIL_STRING)}…` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = REDACT_KEYS.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function logActivity(ctx: Ctx, input: ActivityInput) {
  run(
    ctx.db,
    `INSERT INTO activity (ts, actor, kind, agent_id, service_id, summary, outcome, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ctx.now().toISOString(),
    input.actor,
    input.kind,
    input.agentId ?? null,
    input.serviceId ?? null,
    input.summary.slice(0, 300),
    input.outcome,
    JSON.stringify(redact(input.detail ?? {})),
  );
}

/** Newest first; `kind` narrows to one type, so a filter still shows up to `limit` entries of that type. */
export function listActivity(ctx: Ctx, limit = 100, kind?: string): ActivityRow[] {
  if (kind) return all<ActivityRow>(ctx.db, "SELECT * FROM activity WHERE kind = ? ORDER BY id DESC LIMIT ?", kind, Math.min(limit, 500));
  return all<ActivityRow>(ctx.db, "SELECT * FROM activity ORDER BY id DESC LIMIT ?", Math.min(limit, 500));
}

import { createHash } from "node:crypto";
import { notifyLater } from "./notify";
import { z } from "zod";
import { all, newId, one, run, tx, type Ctx } from "./db";
import { authorize } from "./policy/engine";
import { logActivity } from "./activity";
import { callWebhook, webhookDestination, WebhookFieldsSchema, type WebhookFetcher } from "./connectors/webhooks";
import { createAppCalendarEvent, createGmailDraft, type Fetcher } from "./connectors/google";
import { config } from "./config";

/**
 * Proposed actions and the approval lifecycle.
 *
 *   proposed ──approve(hash)──▶ approved ──execute──▶ executing ──▶ executed | failed
 *      │  ▲                        │
 *      │  └──────── edit ──────────┘ (any edit clears the approval)
 *      └─ dismiss                  └─ cancel
 *
 * An approval is bound to the SHA-256 of the exact kind + service + destination + payload the
 * user reviewed. Execution re-checks that hash and the live permission, and the status
 * transition is a compare-and-set, so retries or double clicks cannot execute twice.
 */

export const EmailReplyPayload = z.object({
  to: z.email().max(254),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(5000),
});
export const CalendarEventPayload = z.object({
  calendar: z.string().min(1).max(100),
  title: z.string().min(1).max(200),
  startsAt: z.iso.datetime({ offset: true }),
  endsAt: z.iso.datetime({ offset: true }),
  location: z.string().max(200).optional(),
  allDay: z.boolean().optional(),
  timezone: z.string().max(64).optional(),
});
export const ReminderPayload = z.object({
  text: z.string().min(1).max(500),
  dueAt: z.iso.datetime({ offset: true }).optional(),
});

export const EmailDraftPayload = z.object({
  to: z.email().max(254),
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(10_000),
  threadId: z.string().regex(/^[\w-]{1,64}$/).optional(),
  inReplyTo: z.string().regex(/^<[^<>\s]{3,250}>$/).optional(),
});

export const WebhookPayload = z.object({
  hookId: z.string().regex(/^hook-[a-z0-9-]{1,40}$/),
  fields: WebhookFieldsSchema,
});

export const ACTION_SCHEMAS = {
  email_reply: EmailReplyPayload,
  calendar_event: CalendarEventPayload,
  reminder: ReminderPayload,
  webhook: WebhookPayload,
  email_draft: EmailDraftPayload,
} as const;
export type ActionKind = keyof typeof ACTION_SCHEMAS;
export const ActionKindSchema = z.enum(["email_reply", "calendar_event", "reminder", "webhook", "email_draft"]);

/** Which services each kind of action may target. Checked on propose, so a kind can't be aimed at the wrong service. */
function kindFitsService(kind: ActionKind, serviceId: string, payload: Record<string, unknown>): boolean {
  switch (kind) {
    // Sending mail and creating events exist only for the demo services. Real Gmail can only
    // receive approved *drafts* (email_draft); your main Google Calendar has no write path at all.
    case "email_reply":
      return serviceId === "demo-mail";
    case "calendar_event":
      // The demo calendar, or the app's OWN Google calendar (calendar.app.created). Never the main one.
      return serviceId === "demo-calendar" || serviceId === "google-calendar-app";
    case "reminder":
      return serviceId === "local-tasks";
    case "webhook":
      return serviceId.startsWith("hook-") && payload.hookId === serviceId;
    case "email_draft":
      return serviceId === "gmail-drafts";
  }
}

export type ActionStatus = "proposed" | "approved" | "executing" | "executed" | "dismissed" | "cancelled" | "failed";

export interface ActionRow {
  id: string;
  agent_id: string;
  service_id: string;
  kind: ActionKind;
  title: string;
  destination: string;
  payload: string;
  payload_hash: string;
  status: ActionStatus;
  idempotency_key: string;
  approved_by: string | null;
  approved_at: string | null;
  approved_hash: string | null;
  executed_at: string | null;
  result: string | null;
  is_demo: number;
  created_at: string;
  updated_at: string;
}

export class ApprovalError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "INVALID_STATE" | "HASH_MISMATCH" | "INVALID_PAYLOAD" | "NO_CONNECTOR",
    message: string,
  ) {
    super(message);
  }
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function actionHash(kind: ActionKind, serviceId: string, destination: string, payload: unknown): string {
  return createHash("sha256").update(canonicalJson({ kind, serviceId, destination, payload })).digest("hex");
}

function parsePayload(kind: ActionKind, payload: unknown) {
  const parsed = ACTION_SCHEMAS[kind].safeParse(payload);
  if (!parsed.success) throw new ApprovalError("INVALID_PAYLOAD", `Invalid ${kind} payload: ${parsed.error.issues[0]?.message ?? "unknown"}`);
  return parsed.data;
}

/** Where the effect lands. Derived from the payload so the destination shown is the one bound by the hash. */
function destinationOf(ctx: Ctx, kind: ActionKind, payload: Record<string, unknown>): string {
  switch (kind) {
    case "webhook":
      // Includes the URL fingerprint: replacing the URL invalidates every approval made before.
      return webhookDestination(ctx, String(payload.hookId));
    case "email_draft":
      return `gmail-drafts:${String(payload.to)}`;
    case "email_reply":
      return String(payload.to);
    case "calendar_event":
      return `calendar:${String(payload.calendar)}`;
    case "reminder":
      return "dashboard:reminders";
  }
}

export function getAction(ctx: Ctx, id: string): ActionRow {
  const row = one<ActionRow>(ctx.db, "SELECT * FROM actions WHERE id = ?", id);
  if (!row) throw new ApprovalError("NOT_FOUND", "Action not found");
  return row;
}

export function listActions(ctx: Ctx, statuses?: ActionStatus[]): ActionRow[] {
  if (!statuses?.length) return all<ActionRow>(ctx.db, "SELECT * FROM actions ORDER BY created_at DESC LIMIT 200");
  const marks = statuses.map(() => "?").join(",");
  return all<ActionRow>(ctx.db, `SELECT * FROM actions WHERE status IN (${marks}) ORDER BY created_at DESC LIMIT 200`, ...statuses);
}

export interface ProposeInput {
  agentId: string;
  serviceId: string;
  kind: ActionKind;
  title: string;
  payload: unknown;
  idempotencyKey: string;
}

/** Agents may only *propose*. Requires effective "prepare"; never touches the outside world. */
export function proposeAction(ctx: Ctx, input: ProposeInput): ActionRow {
  authorize(ctx, input.agentId, input.serviceId, "prepare", `Proposing ${input.kind}`);
  const payload = parsePayload(input.kind, input.payload);
  if (!kindFitsService(input.kind, input.serviceId, payload)) throw new ApprovalError("INVALID_PAYLOAD", `A ${input.kind} cannot target ${input.serviceId}`);
  const destination = destinationOf(ctx, input.kind, payload);
  const hash = actionHash(input.kind, input.serviceId, destination, payload);
  const now = ctx.now().toISOString();
  const id = newId("act");
  const res = run(
    ctx.db,
    `INSERT OR IGNORE INTO actions (id, agent_id, service_id, kind, title, destination, payload, payload_hash, status,
       idempotency_key, created_at, updated_at, is_demo)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'proposed', ?, ?, ?, (SELECT CASE kind WHEN 'demo' THEN 1 ELSE 0 END FROM services WHERE id = ?))`,
    id,
    input.agentId,
    input.serviceId,
    input.kind,
    input.title.slice(0, 200),
    destination,
    JSON.stringify(payload),
    hash,
    input.idempotencyKey,
    now,
    now,
    input.serviceId,
  );
  const row = one<ActionRow>(ctx.db, "SELECT * FROM actions WHERE idempotency_key = ?", input.idempotencyKey)!;
  // A key reused for a different agent, service or kind is a bug or an attempt to collide with
  // someone else's proposal: refuse rather than silently returning the other row.
  if (res.changes === 0 && (row.agent_id !== input.agentId || row.service_id !== input.serviceId || row.kind !== input.kind)) {
    throw new ApprovalError("INVALID_PAYLOAD", "Idempotency key already used by a different proposal");
  }
  if (res.changes > 0) {
    logActivity(ctx, {
      actor: input.agentId,
      kind: "action_proposed",
      agentId: input.agentId,
      serviceId: input.serviceId,
      outcome: "pending",
      summary: `Proposed ${input.kind.replace("_", " ")}: ${row.title}`,
      detail: { actionId: row.id, destination },
    });
    notifyLater(ctx, { key: `approval:${row.id}`, kind: "approval", title: "Waiting for your approval", summary: "An agent prepared something for you to review.", detail: row.title });
  }
  return row;
}

/** User edit. Any change invalidates a prior approval — the user must re-approve what they now see. */
export function editAction(ctx: Ctx, id: string, payload: unknown): ActionRow {
  return tx(ctx.db, () => {
    const action = getAction(ctx, id);
    if (action.status !== "proposed" && action.status !== "approved") {
      throw new ApprovalError("INVALID_STATE", `Cannot edit an action that is ${action.status}`);
    }
    const parsed = parsePayload(action.kind, payload);
    if (!kindFitsService(action.kind, action.service_id, parsed)) throw new ApprovalError("INVALID_PAYLOAD", `A ${action.kind} cannot target ${action.service_id}`);
    const destination = destinationOf(ctx, action.kind, parsed);
    const hash = actionHash(action.kind, action.service_id, destination, parsed);
    run(
      ctx.db,
      `UPDATE actions SET payload = ?, destination = ?, payload_hash = ?, status = 'proposed',
         approved_by = NULL, approved_at = NULL, approved_hash = NULL, updated_at = ? WHERE id = ?`,
      JSON.stringify(parsed),
      destination,
      hash,
      ctx.now().toISOString(),
      id,
    );
    logActivity(ctx, {
      actor: "user",
      kind: "action_edited",
      agentId: action.agent_id,
      serviceId: action.service_id,
      outcome: "info",
      summary: `Edited ${action.kind.replace("_", " ")}: ${action.title}${action.status === "approved" ? " (approval cleared)" : ""}`,
      detail: { actionId: id, destination },
    });
    return getAction(ctx, id);
  });
}

/**
 * Approve exactly what the user saw. `expectedHash` is the hash the UI displayed; if the action
 * changed since (edit, tampering, stale tab) the approval is refused.
 */
export function approveAction(ctx: Ctx, id: string, expectedHash: string, approvedBy: string): ActionRow {
  // Authorization is checked outside the transaction so a denial is still recorded in the activity log.
  const current = getAction(ctx, id);
  authorize(ctx, current.agent_id, current.service_id, "write_with_approval", `Approving ${current.kind}`);
  return tx(ctx.db, () => {
    const action = getAction(ctx, id);
    if (action.status !== "proposed") throw new ApprovalError("INVALID_STATE", `Cannot approve an action that is ${action.status}`);
    if (action.payload_hash !== expectedHash) {
      throw new ApprovalError("HASH_MISMATCH", "The action changed after you reviewed it. Review it again before approving.");
    }
    run(
      ctx.db,
      `UPDATE actions SET status = 'approved', approved_by = ?, approved_at = ?, approved_hash = ?, updated_at = ? WHERE id = ?`,
      approvedBy,
      ctx.now().toISOString(),
      expectedHash,
      ctx.now().toISOString(),
      id,
    );
    logActivity(ctx, {
      actor: approvedBy,
      kind: "action_approved",
      agentId: action.agent_id,
      serviceId: action.service_id,
      outcome: "ok",
      summary: `Approved ${action.kind.replace("_", " ")} to ${action.destination}`,
      detail: { actionId: id, hash: expectedHash.slice(0, 12) },
    });
    return getAction(ctx, id);
  });
}

export interface Connector {
  /** Performs the effect. Must be safe to call once per action id. */
  execute(action: ActionRow): { effect: string; simulated: boolean } | Promise<{ effect: string; simulated: boolean }>;
}

/** The only connectors in the MVP: they write to a local outbox table and nowhere else. */
export const simulatedConnector = (ctx: Ctx): Connector => ({
  execute(action) {
    const payload = JSON.parse(action.payload) as Record<string, unknown>;
    const effect =
      action.kind === "email_reply"
        ? `Simulated send of "${String(payload.subject)}" to ${action.destination}`
        : action.kind === "calendar_event"
          ? `Simulated calendar event "${String(payload.title)}" on ${action.destination}`
          : `Reminder added to dashboard: "${String(payload.text).slice(0, 80)}"`;
    if (action.kind === "reminder") {
      // Reminders are the one effect that is real in this build: they live inside the dashboard.
      run(
        ctx.db,
        "INSERT OR IGNORE INTO reminders (id, action_id, text, due_at, created_at) VALUES (?, ?, ?, ?, ?)",
        newId("rem"),
        action.id,
        String(payload.text),
        payload.dueAt ? String(payload.dueAt) : null,
        ctx.now().toISOString(),
      );
    }
    // UNIQUE(action_id) makes the side effect itself idempotent, independent of the status check.
    run(
      ctx.db,
      "INSERT INTO simulated_outbox (id, action_id, service_id, destination, effect, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      newId("out"),
      action.id,
      action.service_id,
      action.destination,
      effect,
      ctx.now().toISOString(),
    );
    return { effect, simulated: true };
  },
});

/** Real effect: an approved call to a user-registered automation webhook. */
export const webhookConnector = (ctx: Ctx, fetcher?: WebhookFetcher): Connector => ({
  async execute(action) {
    return { effect: await callWebhook(ctx, action, fetcher), simulated: false };
  },
});

/** Real effect: a draft in the user's Gmail. Never sent — the user sends it from Gmail. */
export const gmailDraftConnector = (ctx: Ctx, fetcher?: Fetcher): Connector => ({
  async execute(action) {
    const p = EmailDraftPayload.parse(JSON.parse(action.payload));
    await createGmailDraft(ctx, p, fetcher);
    return { effect: `Draft "${p.subject.slice(0, 80)}" to ${p.to} created in Gmail (not sent)`, simulated: false };
  },
});

/** Real effect: an event in the app's own Google calendar (the user's main calendar stays read-only). */
export const appCalendarConnector = (ctx: Ctx, fetcher?: Fetcher): Connector => ({
  async execute(action) {
    const p = CalendarEventPayload.parse(JSON.parse(action.payload));
    const out = await createAppCalendarEvent(ctx, { idempotencyId: action.id, title: p.title, startsAt: p.startsAt, endsAt: p.endsAt, allDay: p.allDay, location: p.location, timeZone: p.timezone ?? config().timezone }, fetcher);
    return { effect: `Event "${p.title.slice(0, 80)}" added to your “${out.calendar}” Google calendar`, simulated: false };
  },
});

export function connectorFor(ctx: Ctx, serviceId: string): Connector {
  const svc = one<{ kind: string }>(ctx.db, "SELECT kind FROM services WHERE id = ?", serviceId);
  if (svc?.kind === "demo") return simulatedConnector(ctx);
  if (svc?.kind === "real" && serviceId.startsWith("hook-")) return webhookConnector(ctx);
  if (svc?.kind === "real" && serviceId === "gmail-drafts") return gmailDraftConnector(ctx);
  if (svc?.kind === "real" && serviceId === "google-calendar-app") return appCalendarConnector(ctx);
  throw new ApprovalError("NO_CONNECTOR", "No live connector is configured for this service. Live writes are disabled in this build.");
}

const STUCK_EXECUTION_MS = 5 * 60_000;

export async function executeAction(ctx: Ctx, id: string, connector?: Connector): Promise<ActionRow> {
  const current = getAction(ctx, id);
  if (current.status === "executing" && ctx.now().getTime() - new Date(current.updated_at).getTime() > STUCK_EXECUTION_MS) {
    // The process died mid-call. The effect may or may not have happened, so never retry blindly.
    run(ctx.db, "UPDATE actions SET status = 'failed', result = ?, updated_at = ? WHERE id = ? AND status = 'executing'", "Interrupted during execution — outcome unknown. Check the destination before proposing it again.", ctx.now().toISOString(), id);
    return getAction(ctx, id);
  }
  if (current.status === "executed" || current.status === "executing") return current;
  // Permission is re-checked at execution time: a revoke after approval wins.
  authorize(ctx, current.agent_id, current.service_id, "write_with_approval", `Executing ${current.kind}`);
  const claimed = tx(ctx.db, () => {
    const action = getAction(ctx, id);
    if (action.status === "executed" || action.status === "executing") return { action, duplicate: true };
    if (action.status !== "approved") throw new ApprovalError("INVALID_STATE", `Only approved actions can run (this one is ${action.status})`);
    if (action.approved_hash !== action.payload_hash) {
      throw new ApprovalError("HASH_MISMATCH", "Approval does not match the current action content.");
    }
    const res = run(ctx.db, "UPDATE actions SET status = 'executing', updated_at = ? WHERE id = ? AND status = 'approved'", ctx.now().toISOString(), id);
    return { action, duplicate: res.changes === 0 };
  });
  if (claimed.duplicate) return getAction(ctx, id);

  const action = claimed.action;
  try {
    const result = await (connector ?? connectorFor(ctx, action.service_id)).execute(action);
    run(
      ctx.db,
      "UPDATE actions SET status = 'executed', executed_at = ?, result = ?, updated_at = ? WHERE id = ?",
      ctx.now().toISOString(),
      result.effect,
      ctx.now().toISOString(),
      id,
    );
    logActivity(ctx, {
      actor: "system",
      kind: "action_executed",
      agentId: action.agent_id,
      serviceId: action.service_id,
      outcome: "ok",
      summary: result.effect,
      detail: { actionId: id, simulated: result.simulated, approvedBy: action.approved_by },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Execution failed";
    run(ctx.db, "UPDATE actions SET status = 'failed', result = ?, updated_at = ? WHERE id = ?", message.slice(0, 300), ctx.now().toISOString(), id);
    logActivity(ctx, {
      actor: "system",
      kind: "action_executed",
      agentId: action.agent_id,
      serviceId: action.service_id,
      outcome: "failed",
      summary: `Execution failed: ${message.slice(0, 120)}`,
      detail: { actionId: id },
    });
  }
  return getAction(ctx, id);
}

export function dismissAction(ctx: Ctx, id: string): ActionRow {
  return closeAction(ctx, id, ["proposed"], "dismissed");
}

export function cancelAction(ctx: Ctx, id: string): ActionRow {
  return closeAction(ctx, id, ["approved"], "cancelled");
}

function closeAction(ctx: Ctx, id: string, from: ActionStatus[], to: "dismissed" | "cancelled"): ActionRow {
  return tx(ctx.db, () => {
    const action = getAction(ctx, id);
    if (!from.includes(action.status)) throw new ApprovalError("INVALID_STATE", `Cannot ${to === "dismissed" ? "dismiss" : "cancel"} an action that is ${action.status}`);
    run(ctx.db, "UPDATE actions SET status = ?, updated_at = ? WHERE id = ?", to, ctx.now().toISOString(), id);
    logActivity(ctx, {
      actor: "user",
      kind: "action_dismissed",
      agentId: action.agent_id,
      serviceId: action.service_id,
      outcome: "info",
      summary: `${to === "dismissed" ? "Dismissed" : "Cancelled"} ${action.kind.replace("_", " ")}: ${action.title}`,
      detail: { actionId: id },
    });
    return getAction(ctx, id);
  });
}

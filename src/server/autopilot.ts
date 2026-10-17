import { all, getSetting, one, run, setSetting, tx, type Ctx } from "./db";
import { logActivity } from "./activity";
import { UserError } from "./errors";
import { approveAction, executeAction, getAction } from "./approvals";
import { demoRowsFilter } from "./mode";
import { deleteAppCalendarEvent, deleteGmailDraft, type Fetcher } from "./connectors/google";

/**
 * Autopilot (docs/ROADMAP.md §1, tests first: docs/AUTOPILOT_SECURITY_TESTS.md). Per kind of action, the owner chooses
 * "Ask first" (the default, today's behaviour) or "Do it, tell me after". Owner's decisions (2026-10-17): calendar events,
 * reminders and Gmail drafts may act alone; anything derived from email or web text stays "Ask first".
 *
 * The decision is one pure function, `mayAutoRun`, so every rule is table-tested. It answers "ask" whenever anything is
 * missing, unknown or failing: the safe answer is always to wait for the owner's click.
 */

// Reminders you ask for are created at once already (they stay on this computer); they are listed in "Done for you" with
// Undo, but need no switch. The switches are for what reaches Google.
export const AUTO_KINDS = ["calendar_event", "email_draft"] as const;
export type AutoKind = (typeof AUTO_KINDS)[number];
export const AUTO_LABELS: Record<AutoKind, string> = {
  calendar_event: "Calendar events you ask for",
  email_draft: "Gmail drafts you ask for (never sent)",
};

/** Where the action's content comes from: the owner's own typed words, or text someone else wrote (email, web, a note). */
export type Origin = "typed" | "source";

export interface AutoFacts {
  /** Calendar events: the start and end the code parsed and checked (never the model's word alone). */
  startsAt?: string;
  endsAt?: string;
  /** Events already on that day. */
  eventsThatDay?: number;
  /** Drafts: the owner has written to this address before, and their typed request names the person. */
  knownRecipient?: boolean;
  namedInRequest?: boolean;
  /** Anything the code could not verify (an ambiguous day or time, a person with two matches). */
  ambiguous?: boolean;
}

export interface AutoBudget {
  lastHour: number;
  lastDay: number;
  perHour: number;
  perDay: number;
}

export interface AutoSetting {
  enabled: boolean;
  paused: boolean;
}

export const DEFAULT_PER_HOUR = 3;
export const DEFAULT_PER_DAY = 10;

/**
 * Whether one prepared action may run without the owner's click, and why not when it may not. Pure: no database, no clock
 * other than `now`, so the table tests in tests/autopilot.test.ts cover every rule.
 */
export function mayAutoRun(kind: string, origin: Origin, facts: AutoFacts, budget: AutoBudget, setting: AutoSetting, now: Date): { auto: true } | { auto: false; why: string } {
  if (!(AUTO_KINDS as readonly string[]).includes(kind)) return { auto: false, why: "this kind of action always waits for your approval" };
  if (setting.paused) return { auto: false, why: "autopilot is paused" };
  if (!setting.enabled) return { auto: false, why: "autopilot is off for this kind" };
  if (origin !== "typed") return { auto: false, why: "it comes from text someone else wrote (an email or a page), so it waits for you" };
  if (facts.ambiguous) return { auto: false, why: "something in the request could mean two things" };
  if (!(budget.lastHour < budget.perHour)) return { auto: false, why: `the limit of ${budget.perHour} automatic actions an hour is reached` };
  if (!(budget.lastDay < budget.perDay)) return { auto: false, why: `the limit of ${budget.perDay} automatic actions a day is reached` };
  if (kind === "calendar_event") {
    const start = Date.parse(facts.startsAt ?? "");
    const end = Date.parse(facts.endsAt ?? "");
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return { auto: false, why: "the date could not be checked" };
    if (start < now.getTime()) return { auto: false, why: "it is in the past" };
    if (start > now.getTime() + 60 * 86_400_000) return { auto: false, why: "it is more than 60 days away" };
    if (end - start > 12 * 3_600_000) return { auto: false, why: "it lasts more than 12 hours" };
    if ((facts.eventsThatDay ?? 0) >= 8) return { auto: false, why: "that day already has 8 events" };
  }
  if (kind === "email_draft") {
    if (!facts.namedInRequest) return { auto: false, why: "your request doesn't name who it is for" };
    if (!facts.knownRecipient) return { auto: false, why: "you haven't written to this address before" };
  }
  return { auto: true };
}

// ---------- settings and state (the only impure part) ----------

export function autopilotStatus(ctx: Ctx) {
  const paused = getSetting(ctx.db, "autopilot.paused") === "1";
  const kinds = Object.fromEntries(AUTO_KINDS.map((k) => [k, getSetting(ctx.db, `autopilot.${k}`) === "auto"])) as Record<AutoKind, boolean>;
  const perHour = Number(getSetting(ctx.db, "autopilot.perHour") ?? DEFAULT_PER_HOUR) || DEFAULT_PER_HOUR;
  const perDay = Number(getSetting(ctx.db, "autopilot.perDay") ?? DEFAULT_PER_DAY) || DEFAULT_PER_DAY;
  return { paused, kinds, perHour, perDay, ...usage(ctx) };
}

/** Automatic actions in the last hour and day (counted from the actions themselves, so a restart can't reset the budget). */
function usage(ctx: Ctx) {
  const since = (ms: number) => new Date(ctx.now().getTime() - ms).toISOString();
  const count = (from: string) => one<{ n: number }>(ctx.db, "SELECT COUNT(*) n FROM actions WHERE approved_by = 'autopilot' AND approved_at >= ?", from)?.n ?? 0;
  return { lastHour: count(since(3_600_000)), lastDay: count(since(86_400_000)) };
}

/** The owner's choice per kind (only from the Settings page: never from a request's words). */
export function setAutopilot(ctx: Ctx, input: { kind?: AutoKind; enabled?: boolean; paused?: boolean }) {
  const kindChange = Boolean(input.kind && (AUTO_KINDS as readonly string[]).includes(input.kind) && input.enabled !== undefined);
  if (!kindChange && input.paused === undefined) throw new AutopilotError("Say which kind to turn on or off, or whether to pause");
  if (kindChange) setSetting(ctx.db, `autopilot.${input.kind}`, input.enabled ? "auto" : "ask");
  if (input.paused !== undefined) setSetting(ctx.db, "autopilot.paused", input.paused ? "1" : "0");
  logActivity(ctx, {
    actor: "user",
    kind: "system",
    outcome: "info",
    summary: !kindChange ? (input.paused ? "Autopilot paused: everything asks first" : "Autopilot resumed") : `Autopilot for ${AUTO_LABELS[input.kind!].toLowerCase()}: ${input.enabled ? "do it, tell me after" : "ask first"}${input.paused !== undefined ? (input.paused ? " (paused)" : " (resumed)") : ""}`,
  });
  return autopilotStatus(ctx);
}

/** The decision for one prepared action, with the owner's current settings and budget. Any error: ask. */
export function decide(ctx: Ctx, kind: string, origin: Origin, facts: AutoFacts) {
  try {
    const s = autopilotStatus(ctx);
    const enabled = (AUTO_KINDS as readonly string[]).includes(kind) ? s.kinds[kind as AutoKind] : false;
    return mayAutoRun(kind, origin, facts, { lastHour: s.lastHour, lastDay: s.lastDay, perHour: s.perHour, perDay: s.perDay }, { enabled, paused: s.paused }, ctx.now());
  } catch {
    return { auto: false as const, why: "autopilot couldn't check its settings" };
  }
}

/** "Done for you": what autopilot did, newest first, with what Undo can still remove. */
export function doneForYou(ctx: Ctx, limit = 30) {
  const actions = all<{ id: string; kind: string; title: string; destination: string; approved_at: string; status: string; undone_at: string | null; result: string | null }>(
    ctx.db,
    "SELECT id, kind, title, destination, approved_at, status, undone_at, result FROM actions WHERE approved_by = 'autopilot' ORDER BY approved_at DESC LIMIT ?",
    limit,
  );
  // Reminders the assistant added from your requests in the last day (Undo deletes them; older ones live in Reminders).
  const since = new Date(ctx.now().getTime() - 86_400_000).toISOString();
  const reminders = all<{ id: string; text: string; created_at: string }>(ctx.db, "SELECT id, text, created_at FROM reminders WHERE source = 'assistant' AND done_at IS NULL AND created_at >= ? ORDER BY created_at DESC LIMIT ?", since, limit);
  return [
    ...actions.map((a) => ({ type: "action" as const, id: a.id, kind: a.kind, title: a.title, at: a.approved_at, status: a.undone_at ? "undone" : a.status, result: a.result })),
    ...reminders.map((r) => ({ type: "reminder" as const, id: r.id, kind: "reminder", title: r.text, at: r.created_at, status: "executed", result: null })),
  ]
    .sort((a, b) => b.at.localeCompare(a.at))
    .slice(0, limit);
}

// ---------- running one prepared action ----------

/**
 * Asks the rule about one action the app just prepared; when it may run alone, approves it as "autopilot" (the same
 * permission check as a click: autopilot can never go past an agent's level) and runs it. Otherwise it stays in the Action
 * Queue as before, and `why` says what kept it there. Any failure leaves it for the owner.
 */
export async function autoRun(ctx: Ctx, actionId: string, origin: Origin, facts: AutoFacts): Promise<{ auto: true; effect: string } | { auto: false; why: string }> {
  let action;
  try {
    action = getAction(ctx, actionId);
  } catch {
    return { auto: false, why: "the action could not be read" };
  }
  if (action.status !== "proposed") return { auto: false, why: `it is already ${action.status}` };
  const verdict = decide(ctx, action.kind, origin, facts);
  if (!verdict.auto) return verdict;
  try {
    approveAction(ctx, actionId, action.payload_hash, "autopilot");
    const done = await executeAction(ctx, actionId);
    if (done.status !== "executed") return { auto: false, why: `it failed: ${(done.result ?? "unknown error").slice(0, 120)}` };
    logActivity(ctx, { actor: "autopilot", kind: "system", agentId: action.agent_id, serviceId: action.service_id, outcome: "ok", summary: `Done for you: ${action.title.slice(0, 120)}`, detail: { actionId, origin } });
    return { auto: true, effect: done.result ?? action.title };
  } catch (err) {
    return { auto: false, why: `it couldn't run on its own (${err instanceof Error ? err.message.slice(0, 120) : "error"})` };
  }
}

/** Facts for an event the owner typed: the parsed times, the day's events, and whether the wording left something open. */
export function eventFacts(text: string, startsAt: string, endsAt: string, eventsThatDay: number): AutoFacts {
  // "at 9" with no am/pm or 24-hour form, or "every Tuesday" (only one event is made): ask.
  const bareHour = /\bat\s+(?:1[0-2]|[1-9])(?![\d:.]|\s*(?:am|pm|h\b|o'?clock))/i.test(text);
  const repeating = /\b(?:every|each|weekly|daily|monthly|recurring)\b/i.test(text);
  return { startsAt, endsAt, eventsThatDay, ambiguous: bareHour || repeating };
}

/** Facts for a draft the owner asked for: is the address one from their own mail, and does the request name the person. */
export function draftFacts(ctx: Ctx, text: string, to: string, name: string | null): AutoFacts {
  const email = to.trim().toLowerCase();
  // The whole address, not a part of one ("ana@x.com" is not "diana@x.com").
  const addressOf = (a: string) => (a.match(/<([^<>\s]+@[^<>\s]+)>/)?.[1] ?? a).trim().toLowerCase();
  const known =
    all<{ a: string }>(ctx.db, `SELECT sender AS a FROM messages WHERE 1 = 1${demoRowsFilter()} ORDER BY received_at DESC LIMIT 1000`).some((r) => addressOf(r.a) === email) ||
    all<{ a: string }>(ctx.db, `SELECT recipient AS a FROM waiting_on WHERE 1 = 1${demoRowsFilter()}`).some((r) => addressOf(r.a) === email);
  const words = [name?.split(/\s+/)[0], email.split("@")[0].split(/[._-]/)[0]].filter((w): w is string => Boolean(w && w.length >= 2));
  const named = words.some((w) => new RegExp(`(?<![\\p{L}])${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}])`, "iu").test(text));
  return { knownRecipient: known, namedInRequest: named };
}

// ---------- Undo ----------

/**
 * Undoes one thing autopilot did (or a reminder the assistant added): deletes the event from the app calendar, the draft from
 * Gmail Drafts, or the reminder. Only autopilot's own actions can be undone here; the action row stays, marked undone.
 */
export async function undoDone(ctx: Ctx, type: "action" | "reminder", id: string, fetcher?: Fetcher): Promise<{ ok: true; summary: string }> {
  if (type === "reminder") {
    const r = one<{ text: string }>(ctx.db, "SELECT text FROM reminders WHERE id = ? AND source = 'assistant'", id);
    if (!r) throw new AutopilotError("That reminder isn't one the assistant added, or it's already gone");
    run(ctx.db, "DELETE FROM reminders WHERE id = ?", id);
    logActivity(ctx, { actor: "user", kind: "system", serviceId: "local-tasks", outcome: "info", summary: `Undone: reminder “${r.text.slice(0, 80)}”` });
    return { ok: true, summary: `Removed the reminder “${r.text.slice(0, 80)}”.` };
  }
  const a = one<{ id: string; kind: string; service_id: string; title: string; status: string; approved_by: string | null; external_ref: string | null; undone_at: string | null }>(
    ctx.db,
    "SELECT id, kind, service_id, title, status, approved_by, external_ref, undone_at FROM actions WHERE id = ?",
    id,
  );
  if (!a || a.approved_by !== "autopilot") throw new AutopilotError("Only something autopilot did can be undone here");
  if (a.undone_at) return { ok: true, summary: "Already undone." };
  if (a.status !== "executed") throw new AutopilotError(`Nothing to undo: it is ${a.status}`);
  const undoable = (a.kind === "calendar_event" && a.service_id === "google-calendar-app") || (a.kind === "email_draft" && a.service_id === "gmail-drafts") || a.service_id === "demo-calendar";
  if (!undoable) throw new AutopilotError("This kind can't be undone automatically");
  if (a.kind === "email_draft" && !a.external_ref) throw new AutopilotError("This draft's Gmail id wasn't recorded: delete it from Gmail Drafts yourself");
  // Claimed first (compare-and-set), so two clicks at once delete once; given back if Google refuses.
  const claimed = tx(ctx.db, () => run(ctx.db, "UPDATE actions SET undone_at = ?, updated_at = ? WHERE id = ? AND undone_at IS NULL", ctx.now().toISOString(), ctx.now().toISOString(), a.id).changes > 0);
  if (!claimed) return { ok: true, summary: "Already undone." };
  try {
    if (a.kind === "calendar_event" && a.service_id === "google-calendar-app") await deleteAppCalendarEvent(ctx, a.id, fetcher);
    else if (a.kind === "email_draft") await deleteGmailDraft(ctx, a.external_ref!, fetcher);
    // The demo calendar is simulated: the outbox entry goes.
    else run(ctx.db, "DELETE FROM simulated_outbox WHERE action_id = ?", a.id);
  } catch (err) {
    run(ctx.db, "UPDATE actions SET undone_at = NULL WHERE id = ?", a.id);
    throw err;
  }
  logActivity(ctx, { actor: "user", kind: "system", serviceId: a.service_id, outcome: "info", summary: `Undone: ${a.title.slice(0, 120)}`, detail: { actionId: a.id } });
  return { ok: true, summary: `Undone: ${a.title.slice(0, 120)}.` };
}

/** Shown to the user as is (a 400 from the API). */
export class AutopilotError extends UserError {}


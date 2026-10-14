import { all, getSetting, one, type Ctx } from "./db";
import { callTool } from "./tools/registry";
import { RunBudget } from "./tools/budget";
import { demoRowsFilter } from "./mode";
import { addReminder } from "./reminders";
import { parseSender } from "./agents/chiefOfStaff";

/** Inbox insights for the dashboard: what the scans found, and the user's follow-up actions on it. */

export interface WaitingRow {
  thread_id: string;
  recipient: string;
  subject: string;
  sent_at: string;
  rfc_message_id: string | null;
  is_demo: number;
}
export interface BookingRow {
  id: string;
  kind: string;
  sender: string;
  subject: string;
  received_at: string;
  is_demo: number;
}
export interface SubscriptionRow {
  sender: string;
  name: string;
  messages: number;
  last_seen: string;
  looks_paid: number;
  can_unsubscribe: number;
  is_demo: number;
}

export class InsightError extends Error {}

export function listInsights(ctx: Ctx) {
  return {
    waiting: all<WaitingRow>(ctx.db, `SELECT * FROM waiting_on WHERE 1 = 1${demoRowsFilter()} ORDER BY sent_at`),
    bookings: all<BookingRow>(ctx.db, `SELECT * FROM bookings WHERE 1 = 1${demoRowsFilter()} ORDER BY received_at DESC LIMIT 20`),
    subscriptions: all<SubscriptionRow>(ctx.db, `SELECT * FROM subscriptions WHERE 1 = 1${demoRowsFilter()} ORDER BY looks_paid DESC, messages DESC, sender LIMIT 60`),
    scannedAt: {
      waiting: getSetting(ctx.db, "insights.scanned.waiting") ?? null,
      bookings: getSetting(ctx.db, "insights.scanned.bookings") ?? null,
      subscriptions: getSetting(ctx.db, "insights.scanned.subscriptions") ?? null,
    },
  };
}

const denied = (err: unknown) => (err as { code?: string }).code === "POLICY_DENIED";

/** Re-scans Gmail for unanswered threads and bookings, as the Follow-up and Inbox agents (permission-checked). */
export async function refreshInsights(ctx: Ctx) {
  const notes: string[] = [];
  try {
    const w = await callTool(ctx, "follow_up", "gmail.scan_waiting", {}, new RunBudget(1, 120_000));
    notes.push(`${w.waiting} thread(s) still waiting on an answer`);
  } catch (err) {
    if (!denied(err)) throw err;
    notes.push("The Follow-up agent needs Read on Gmail to check unanswered threads");
  }
  try {
    const b = await callTool(ctx, "inbox", "gmail.scan_bookings", {}, new RunBudget(1, 120_000));
    notes.push(`${b.bookings} booking(s) found`);
  } catch (err) {
    if (!denied(err)) throw err;
    notes.push("The Inbox agent needs Read on Gmail to find bookings");
  }
  return { message: notes.join(" · ") };
}

export async function runSubscriptionAudit(ctx: Ctx) {
  try {
    const r = await callTool(ctx, "inbox", "gmail.audit_subscriptions", {}, new RunBudget(1, 300_000));
    return { message: `${r.senders} sender(s) found in ${r.scanned} messages` };
  } catch (err) {
    if (denied(err)) throw new InsightError("The Inbox agent needs Read on Gmail to audit subscriptions. Grant it in Connections & Permissions.");
    throw err;
  }
}

/** A short follow-up in the same thread, proposed for approval (a Gmail draft; never sent). */
export async function proposeNudge(ctx: Ctx, threadId: string) {
  const w = one<WaitingRow>(ctx.db, `SELECT * FROM waiting_on WHERE thread_id = ?${demoRowsFilter()}`, threadId);
  if (!w) throw new InsightError("That thread is no longer waiting");
  const { name, email } = parseSender(w.recipient);
  if (!email) throw new InsightError("Couldn't read the recipient's address");
  const first = name?.split(/\s+/)[0];
  const subject = /^re:/i.test(w.subject) ? w.subject : `Re: ${w.subject}`;
  const body = `Hi${first ? ` ${first}` : ""},\n\nJust following up on my message below. Any news?\n\nThanks!`;
  const demo = w.is_demo === 1;
  try {
    const out = await callTool(
      ctx,
      "follow_up",
      "actions.propose",
      {
        serviceId: demo ? "demo-mail" : "gmail-drafts",
        kind: demo ? "email_reply" : "email_draft",
        title: `Follow-up to ${name ?? email}: ${w.subject}`.slice(0, 200),
        payload: demo ? { to: email, subject, body } : { to: email, subject, body, threadId: w.thread_id, ...(w.rfc_message_id ? { inReplyTo: w.rfc_message_id } : {}) },
        idempotencyKey: `nudge:${w.thread_id}:${ctx.now().toISOString().slice(0, 16)}`,
      },
      new RunBudget(1, 5000),
    );
    return { actionId: out.actionId };
  } catch (err) {
    if (denied(err)) throw new InsightError(demo ? "The Follow-up agent can't prepare replies on Demo Gmail." : "The Follow-up agent can't prepare Gmail drafts yet. Connect “Gmail drafts” and grant it in Connections & Permissions.");
    throw err;
  }
}

const KIND_VERB: Record<string, string> = { flight: "Check in for", train: "Check", car: "Pick up the car for", stay: "Check", table: "Confirm", event: "Get tickets ready for" };

export function remindAboutBooking(ctx: Ctx, id: string, dueAt?: string) {
  const b = one<BookingRow>(ctx.db, `SELECT * FROM bookings WHERE id = ?${demoRowsFilter()}`, id);
  if (!b) throw new InsightError("Booking not found");
  return addReminder(ctx, `${KIND_VERB[b.kind] ?? "Check"}: ${b.subject}`, dueAt, "booking");
}

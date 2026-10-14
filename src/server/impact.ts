import { getSetting, one, type Ctx } from "./db";
import { demoRowsFilter } from "./mode";

/**
 * The Impact card: what the assistant did for you over the last `days`, counted from what actually
 * happened (approved actions, scans, reminders), never guessed. Only the time saved is an estimate,
 * and its formula is returned with it so the dashboard can show it.
 */

/** Minutes a person would spend doing each thing by hand. Deliberately conservative. */
export const MINUTES = {
  reply: 4, // reading a thread and writing a reply
  nudge: 2, // noticing a thread went quiet, then writing a follow-up
  bookingReminder: 2, // finding the confirmation again and setting a reminder
  event: 2, // creating a calendar event by hand
  audit: 15, // going through newsletters to find what you pay for
} as const;

export interface Impact {
  days: number;
  since: string;
  /** Replies the agents drafted (proposed) in the period, and the ones you approved. */
  repliesDrafted: number;
  repliesApproved: number;
  /** Follow-ups to quiet threads you approved (Gmail drafts), and threads answered after one. */
  nudgesApproved: number;
  conversationsRevived: number;
  /** Threads still waiting on someone else right now. */
  stillWaiting: number;
  /** Trips and bookings found in your mail (current scan), and how many you turned into reminders. */
  bookingsTracked: number;
  bookingReminders: number;
  eventsAdded: number;
  /** Senders that look like paid subscriptions (latest audit); whether the audit ran in the period. */
  paidSubscriptions: number;
  auditRan: boolean;
  minutesSaved: number;
  formula: string;
}

export function impactSummary(ctx: Ctx, days = 7): Impact {
  const since = new Date(ctx.now().getTime() - days * 86_400_000).toISOString();
  const demo = demoRowsFilter();
  const count = (sql: string, ...params: (string | number)[]) => one<{ n: number }>(ctx.db, sql, ...params)!.n;
  const isReply = "kind IN ('email_draft', 'email_reply') AND idempotency_key NOT LIKE 'nudge:%'";

  const repliesDrafted = count(`SELECT COUNT(*) n FROM actions WHERE ${isReply} AND created_at >= ?${demo}`, since);
  const repliesApproved = count(`SELECT COUNT(*) n FROM actions WHERE ${isReply} AND status = 'executed' AND executed_at >= ?${demo}`, since);
  const nudgesApproved = count(`SELECT COUNT(*) n FROM actions WHERE idempotency_key LIKE 'nudge:%' AND status = 'executed' AND executed_at >= ?${demo}`, since);
  const conversationsRevived = count(`SELECT COUNT(*) n FROM revived_threads WHERE answered_at >= ?${demo}`, since);
  const eventsAdded = count(`SELECT COUNT(*) n FROM actions WHERE kind = 'calendar_event' AND status = 'executed' AND executed_at >= ?${demo}`, since);
  const bookingReminders = count("SELECT COUNT(*) n FROM reminders WHERE source = 'booking' AND created_at >= ?", since);
  const stillWaiting = count(`SELECT COUNT(*) n FROM waiting_on WHERE 1 = 1${demo}`);
  const bookingsTracked = count(`SELECT COUNT(*) n FROM bookings WHERE 1 = 1${demo}`);
  const paidSubscriptions = count(`SELECT COUNT(*) n FROM subscriptions WHERE looks_paid = 1${demo}`);
  const audited = getSetting(ctx.db, "insights.scanned.subscriptions");
  const auditRan = Boolean(audited && audited >= since);

  const minutesSaved =
    repliesApproved * MINUTES.reply +
    nudgesApproved * MINUTES.nudge +
    bookingReminders * MINUTES.bookingReminder +
    eventsAdded * MINUTES.event +
    (auditRan ? MINUTES.audit : 0);
  const formula =
    `${MINUTES.reply} min per approved reply · ${MINUTES.nudge} per approved nudge · ${MINUTES.bookingReminder} per booking reminder · ` +
    `${MINUTES.event} per event added · ${MINUTES.audit} for a subscription audit`;

  return {
    days,
    since,
    repliesDrafted,
    repliesApproved,
    nudgesApproved,
    conversationsRevived,
    stillWaiting,
    bookingsTracked,
    bookingReminders,
    eventsAdded,
    paidSubscriptions,
    auditRan,
    minutesSaved,
    formula,
  };
}

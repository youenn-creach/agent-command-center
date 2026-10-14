import { z } from "zod";
import { getSetting, run, setSetting, type Ctx } from "./db";
import { logActivity } from "./activity";

/**
 * Data minimization over time: how long the dashboard keeps its own history.
 * `0` means "keep forever". Applied by the worker (hourly) and on demand from Settings.
 */

export const RetentionSchema = z.object({
  activityDays: z.number().int().min(0).max(3650),
  searchHistoryDays: z.number().int().min(0).max(3650),
  completedRemindersDays: z.number().int().min(0).max(3650),
  briefingsDays: z.number().int().min(0).max(3650),
});
export type Retention = z.infer<typeof RetentionSchema>;

export const DEFAULT_RETENTION: Retention = { activityDays: 90, searchHistoryDays: 30, completedRemindersDays: 30, briefingsDays: 60 };

export function getRetention(ctx: Ctx): Retention {
  try {
    return RetentionSchema.parse(JSON.parse(getSetting(ctx.db, "retention") ?? "null") ?? DEFAULT_RETENTION);
  } catch {
    return DEFAULT_RETENTION;
  }
}

export function setRetention(ctx: Ctx, value: Retention) {
  const parsed = RetentionSchema.parse(value);
  setSetting(ctx.db, "retention", JSON.stringify(parsed));
  logActivity(ctx, { actor: "user", kind: "system", outcome: "info", summary: `Retention set: activity ${parsed.activityDays || "∞"}d, search ${parsed.searchHistoryDays || "∞"}d, reminders ${parsed.completedRemindersDays || "∞"}d, briefings ${parsed.briefingsDays || "∞"}d` });
}

export function pruneOldData(ctx: Ctx) {
  const r = getRetention(ctx);
  const cutoff = (days: number) => new Date(ctx.now().getTime() - days * 86_400_000).toISOString();
  const removed = { activity: 0, searches: 0, reminders: 0, briefings: 0, actions: 0, runs: 0 };
  if (r.activityDays) removed.activity = Number(run(ctx.db, "DELETE FROM activity WHERE ts < ?", cutoff(r.activityDays)).changes);
  // The request board and the "already notified" memory are history too: they follow the same limit.
  if (r.activityDays) {
    run(ctx.db, "DELETE FROM requests WHERE created_at < ?", cutoff(r.activityDays));
    run(ctx.db, "DELETE FROM notifications_sent WHERE sent_at > '1970-01-02' AND sent_at < ?", cutoff(r.activityDays));
    run(ctx.db, "DELETE FROM revived_threads WHERE answered_at < ?", cutoff(r.activityDays));
    // Closed actions keep recipients, subjects and texts of past drafts: history like the log, with the same limit.
    // Proposals still waiting for you, approved or running are never removed.
    const closed = "status IN ('executed', 'dismissed', 'cancelled', 'failed') AND updated_at < ?";
    run(ctx.db, `DELETE FROM simulated_outbox WHERE action_id IN (SELECT id FROM actions WHERE ${closed})`, cutoff(r.activityDays));
    removed.actions = Number(run(ctx.db, `DELETE FROM actions WHERE ${closed}`, cutoff(r.activityDays)).changes);
    removed.runs = Number(run(ctx.db, "DELETE FROM job_runs WHERE status != 'running' AND COALESCE(finished_at, started_at) < ?", cutoff(r.activityDays)).changes);
  }
  if (r.searchHistoryDays) removed.searches = Number(run(ctx.db, "DELETE FROM retrieval_runs WHERE created_at < ?", cutoff(r.searchHistoryDays)).changes);
  if (r.completedRemindersDays) removed.reminders = Number(run(ctx.db, "DELETE FROM reminders WHERE done_at IS NOT NULL AND done_at < ?", cutoff(r.completedRemindersDays)).changes);
  // Always keep the latest briefing of each kind, whatever its age.
  if (r.briefingsDays) {
    removed.briefings = Number(
      run(
        ctx.db,
        `DELETE FROM briefings WHERE created_at < ? AND id NOT IN (
           SELECT id FROM briefings b WHERE created_at = (SELECT MAX(created_at) FROM briefings WHERE kind = b.kind))`,
        cutoff(r.briefingsDays),
      ).changes,
    );
  }
  const total = Object.values(removed).reduce((a, b) => a + b, 0);
  if (total) logActivity(ctx, { actor: "system", kind: "system", outcome: "info", summary: `Retention: removed ${removed.activity} log entries, ${removed.searches} searches, ${removed.reminders} reminders, ${removed.briefings} briefings, ${removed.actions} closed actions, ${removed.runs} schedule runs` });
  return removed;
}

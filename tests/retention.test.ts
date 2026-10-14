import { describe, expect, it } from "vitest";
import { all, run } from "@/server/db";
import { DEFAULT_RETENTION, getRetention, pruneOldData, setRetention } from "@/server/retention";
import { seededCtx } from "./helpers";

describe("retention", () => {
  it("defaults, and prunes only what is older than the window", () => {
    const ctx = seededCtx(new Date("2026-10-12T10:00:00Z"));
    expect(getRetention(ctx)).toEqual(DEFAULT_RETENTION);
    run(ctx.db, "INSERT INTO activity (ts, actor, kind, summary, outcome) VALUES ('2026-01-01T00:00:00Z', 'x', 'system', 'old', 'info')");
    run(ctx.db, "INSERT INTO reminders (id, text, done_at, created_at) VALUES ('r1', 'old done', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'), ('r2', 'open', NULL, '2026-01-01T00:00:00Z')");
    run(ctx.db, "INSERT INTO briefings (id, created_at, title, body, provenance, kind) VALUES ('b1','2026-01-01T00:00:00Z','a','x','{}','daily'),('b2','2026-01-02T00:00:00Z','b','x','{}','daily'),('w1','2026-01-01T00:00:00Z','w','x','{}','weekly')");
    const removed = pruneOldData(ctx);
    expect(removed).toMatchObject({ activity: 1, reminders: 1, briefings: 1 });
    expect(all<{ id: string }>(ctx.db, "SELECT id FROM reminders")).toEqual([{ id: "r2" }]);
    // the latest daily (b2) and the latest weekly (w1) survive even though they are old
    expect(all<{ id: string }>(ctx.db, "SELECT id FROM briefings ORDER BY id").map((r) => r.id)).toEqual(["b2", "w1"]);
  });

  it("closed actions and finished runs follow the log's limit; pending work is never removed", () => {
    const ctx = seededCtx(new Date("2026-10-12T10:00:00Z"));
    const act = (id: string, status: string, updated: string) =>
      run(
        ctx.db,
        `INSERT INTO actions (id, agent_id, service_id, kind, title, destination, payload, payload_hash, status, idempotency_key, is_demo, created_at, updated_at)
         VALUES (?, 'follow_up', 'demo-mail', 'email_reply', 't', 'd', '{}', 'h', ?, ?, 1, ?, ?)`,
        id, status, `k-${id}`, updated, updated,
      );
    act("old-done", "executed", "2026-01-01T00:00:00Z");
    act("old-dismissed", "dismissed", "2026-01-01T00:00:00Z");
    act("old-pending", "proposed", "2026-01-01T00:00:00Z");
    act("old-approved", "approved", "2026-01-01T00:00:00Z");
    act("recent-done", "executed", "2026-10-10T00:00:00Z");
    run(ctx.db, "INSERT INTO simulated_outbox (id, action_id, service_id, destination, effect, created_at) VALUES ('o1', 'old-done', 'demo-mail', 'd', 'e', '2026-01-01T00:00:00Z')");
    const job = all<{ id: string }>(ctx.db, "SELECT id FROM jobs LIMIT 1")[0].id;
    run(ctx.db, "INSERT INTO job_runs (id, job_id, scheduled_for, trigger, status, started_at, finished_at) VALUES ('run-old', ?, 's1', 'schedule', 'succeeded', '2026-01-01T00:00:00Z', '2026-01-01T00:01:00Z'), ('run-new', ?, 's2', 'schedule', 'succeeded', '2026-10-11T00:00:00Z', '2026-10-11T00:01:00Z')", job, job);
    expect(pruneOldData(ctx)).toMatchObject({ actions: 2, runs: 1 });
    expect(all<{ id: string }>(ctx.db, "SELECT id FROM actions ORDER BY id").map((r) => r.id)).toEqual(["old-approved", "old-pending", "recent-done"]);
    expect(all(ctx.db, "SELECT * FROM simulated_outbox")).toEqual([]);
    expect(all<{ id: string }>(ctx.db, "SELECT id FROM job_runs").map((r) => r.id)).toEqual(["run-new"]);
  });

  it("0 means keep forever", () => {
    const ctx = seededCtx();
    setRetention(ctx, { activityDays: 0, searchHistoryDays: 0, completedRemindersDays: 0, briefingsDays: 0 });
    run(ctx.db, "INSERT INTO activity (ts, actor, kind, summary, outcome) VALUES ('2000-01-01T00:00:00Z', 'x', 'system', 'ancient', 'info')");
    pruneOldData(ctx);
    expect(all(ctx.db, "SELECT * FROM activity WHERE summary = 'ancient'")).toHaveLength(1);
  });
});

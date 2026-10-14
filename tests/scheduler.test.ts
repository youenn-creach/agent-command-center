import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createJob,
  getJob,
  jobHistory,
  nextRuns,
  pauseJob,
  resumeJob,
  runNow,
  tick,
  type WorkflowRegistry,
} from "@/server/scheduler/scheduler";
import { disconnectService, reconnectDemoService, setServiceLevel } from "@/server/policy/permissions";
import { openDb, all } from "@/server/db";
import { resetDemo } from "@/server/seed/seed";
import { seededCtx } from "./helpers";

function counting(): WorkflowRegistry & { count: () => number } {
  let n = 0;
  const reg = {
    noop: async () => {
      n += 1;
      return { message: "done" };
    },
    count: () => n,
  };
  return reg as unknown as WorkflowRegistry & { count: () => number };
}

function newJob(ctx: ReturnType<typeof seededCtx>, overrides: Partial<Parameters<typeof createJob>[1]> = {}) {
  return createJob(ctx, {
    name: "Test job",
    purpose: "test",
    agentId: "knowledge",
    workflow: "noop",
    cron: "30 8 * * 1-5",
    timezone: "Europe/Paris",
    sources: [],
    destination: "dashboard",
    requirements: [{ agentId: "knowledge", serviceId: "public-news", level: "read" }],
    ...overrides,
  });
}

describe("timezone and DST", () => {
  it("keeps 08:30 local across the October DST change in Europe/Paris", () => {
    const runs = nextRuns("30 8 * * 1-5", "Europe/Paris", new Date("2026-10-22T12:00:00Z"), 3);
    // Fri 23 Oct is CEST (UTC+2); Mon 26 and Tue 27 are CET (UTC+1).
    expect(runs.map((d) => d.toISOString())).toEqual(["2026-10-23T06:30:00.000Z", "2026-10-26T07:30:00.000Z", "2026-10-27T07:30:00.000Z"]);
  });

  it("runs a slot inside the spring-forward gap exactly once", () => {
    const runs = nextRuns("30 2 * * *", "Europe/Paris", new Date("2026-03-28T12:00:00Z"), 2);
    expect(runs).toHaveLength(2);
    expect(runs[0].toISOString().slice(0, 10)).toBe("2026-03-29");
    expect(runs[1].toISOString().slice(0, 10)).toBe("2026-03-30");
  });

  it("does not double-run the repeated hour in autumn", () => {
    const runs = nextRuns("30 2 * * *", "Europe/Paris", new Date("2026-10-24T12:00:00Z"), 2);
    expect(runs[0].toISOString().slice(0, 10)).toBe("2026-10-25");
    expect(runs[1].toISOString().slice(0, 10)).toBe("2026-10-26");
  });

  it("stores the timezone explicitly and rejects invalid ones", () => {
    const ctx = seededCtx();
    expect(newJob(ctx).timezone).toBe("Europe/Paris");
    expect(() => newJob(ctx, { timezone: "Mars/Olympus" })).toThrow(/Invalid timezone/);
    expect(() => newJob(ctx, { cron: "every tuesday" })).toThrow(/Invalid schedule/);
    // A seconds field would fire a workflow every second; every minute would keep the local model busy all day.
    expect(() => newJob(ctx, { cron: "* * * * * *" })).toThrow(/seconds aren't supported/);
    expect(() => newJob(ctx, { cron: "* * * * *" })).toThrow(/at most every 15 minutes/);
    expect(() => newJob(ctx, { cron: "*/5 9 * * *" })).toThrow(/at most every 15 minutes/);
    expect(newJob(ctx, { cron: "*/15 9-17 * * 1-5" }).cron).toBe("*/15 9-17 * * 1-5");
    expect(newJob(ctx, { cron: "2026-12-24T09:00:00" }).next_run_at).toBeTruthy(); // one-time job
  });
});

describe("durable, idempotent runs", () => {
  it("runs a due job once even if tick is called repeatedly", async () => {
    const ctx = seededCtx(new Date("2026-10-12T06:00:00Z"));
    const reg = counting();
    const job = newJob(ctx);
    ctx.setNow(new Date(job.next_run_at!));
    await tick(ctx, reg);
    await tick(ctx, reg);
    await tick(ctx, reg);
    expect(reg.count()).toBe(1);
    expect(jobHistory(ctx, job.id)).toHaveLength(1);
  });

  it("two processes sharing the database cannot both claim the same slot", async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "acc-")), "acc.sqlite");
    let now = new Date("2026-10-12T06:00:00Z");
    const a = { db: openDb(file), now: () => now };
    const b = { db: openDb(file), now: () => now };
    resetDemo(a);
    const reg = counting();
    const job = newJob(Object.assign(a, { setNow: () => {} }));
    const slot = job.next_run_at!;
    now = new Date(slot);
    await tick(a, reg);
    // Worker B acts on a stale view in which the slot is still pending.
    b.db.prepare("UPDATE jobs SET next_run_at = ? WHERE id = ?").run(slot, job.id);
    await tick(b, reg);
    expect(reg.count()).toBe(1);
    expect(all(a.db, "SELECT * FROM job_runs WHERE job_id = ?", job.id)).toHaveLength(1);
  });

  it("does not backfill missed runs after downtime", async () => {
    const ctx = seededCtx(new Date("2026-10-12T06:00:00Z"));
    const reg = counting();
    const job = newJob(ctx);
    ctx.setNow(new Date("2026-10-16T12:00:00Z")); // four missed weekday slots
    await tick(ctx, reg);
    expect(reg.count()).toBe(1);
    expect(new Date(getJob(ctx, job.id).next_run_at!).toISOString()).toBe("2026-10-19T06:30:00.000Z");
  });

  it("limits retries to max_attempts", async () => {
    const ctx = seededCtx(new Date("2026-10-12T06:00:00Z"));
    let attempts = 0;
    const reg: WorkflowRegistry = {
      noop: async () => {
        attempts += 1;
        throw new Error("source unavailable");
      },
    };
    const job = newJob(ctx, { maxAttempts: 3 });
    const r = await runNow(ctx, job.id, reg);
    expect(attempts).toBe(3);
    expect(r.status).toBe("failed");
    expect(r.attempt).toBe(3);
  });
});

describe("overlap", () => {
  it("a scheduled slot is skipped (and the schedule advances) while the previous run is still going", async () => {
    const ctx = seededCtx(new Date("2026-10-12T06:00:00Z"));
    const reg = counting();
    const job = newJob(ctx);
    ctx.setNow(new Date(job.next_run_at!));
    // A manual run that started a minute ago is still going.
    ctx.db.prepare("INSERT INTO job_runs (id, job_id, scheduled_for, trigger, status, started_at) VALUES ('r0', ?, 'manual:x', 'manual', 'running', ?)").run(job.id, new Date(ctx.now().getTime() - 60_000).toISOString());
    await tick(ctx, reg);
    expect(reg.count()).toBe(0);
    expect(new Date(getJob(ctx, job.id).next_run_at!).getTime()).toBeGreaterThan(new Date(job.next_run_at!).getTime());
  });
});

describe("pause, revoke and resume", () => {
  it("a paused job does not run on schedule", async () => {
    const ctx = seededCtx(new Date("2026-10-12T06:00:00Z"));
    const reg = counting();
    const job = newJob(ctx);
    pauseJob(ctx, job.id);
    ctx.setNow(new Date(job.next_run_at!));
    await tick(ctx, reg);
    expect(reg.count()).toBe(0);
  });

  it("revoking a required service blocks the job with an explanation", async () => {
    const ctx = seededCtx(new Date("2026-10-12T06:00:00Z"));
    const reg = counting();
    const job = newJob(ctx);
    disconnectService(ctx, "public-news");
    const blocked = getJob(ctx, job.id);
    expect(blocked.status).toBe("blocked");
    expect(blocked.status_reason).toMatch(/public-news/);
    ctx.setNow(new Date(job.next_run_at!));
    await tick(ctx, reg);
    expect(reg.count()).toBe(0);
  });

  it("run-now on a job whose access was revoked fails safely instead of running", async () => {
    const ctx = seededCtx();
    const reg = counting();
    const job = newJob(ctx);
    setServiceLevel(ctx, "public-news", "none");
    const r = await runNow(ctx, job.id, reg);
    expect(r.status).toBe("blocked");
    expect(reg.count()).toBe(0);
  });

  it("a job cannot be resumed beyond its current permissions", () => {
    const ctx = seededCtx();
    const job = newJob(ctx);
    pauseJob(ctx, job.id);
    disconnectService(ctx, "public-news");
    expect(resumeJob(ctx, job.id).status).toBe("blocked");
  });

  it("restoring access unblocks the job automatically (but not a user-paused one)", () => {
    const ctx = seededCtx();
    const job = newJob(ctx);
    disconnectService(ctx, "public-news");
    reconnectDemoService(ctx, "public-news");
    expect(getJob(ctx, job.id).status).toBe("blocked"); // reconnect leaves access at None
    setServiceLevel(ctx, "public-news", "read");
    expect(getJob(ctx, job.id).status).toBe("active");
  });
});

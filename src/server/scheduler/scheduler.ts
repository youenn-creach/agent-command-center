import { Cron } from "croner";
import { notifyLater } from "../notify";
import { appMode, DEMO_ONLY_WORKFLOWS, serviceHidden } from "../mode";
import { z } from "zod";
import { all, newId, one, run, tx, type Ctx } from "../db";
import { logActivity } from "../activity";
import { check } from "../policy/engine";
import { AccessLevelSchema, LEVEL_LABELS, type AccessLevel } from "../policy/levels";

/**
 * Durable scheduler. Jobs and runs live in SQLite, so closing the browser changes nothing;
 * the worker process (`npm run worker`) or the web server's "Run now" drives execution.
 *
 * Guarantees:
 *  - A (job, scheduled_for) pair runs at most once: UNIQUE constraint on job_runs.
 *  - Missed slots are not backfilled: after downtime a job runs once, then resumes its cadence.
 *  - Cron is evaluated in the job's IANA timezone, so DST shifts keep "08:30 local".
 *  - Before every run the job's declared requirements are re-checked against live permissions.
 */

export const RequirementSchema = z.object({
  agentId: z.string().min(1),
  serviceId: z.string().min(1),
  level: AccessLevelSchema,
});
export type Requirement = z.infer<typeof RequirementSchema>;

export interface JobRow {
  id: string;
  name: string;
  purpose: string;
  agent_id: string;
  workflow: string;
  cron: string;
  timezone: string;
  sources: string;
  destination: string;
  requirements: string;
  status: "active" | "paused" | "blocked";
  status_reason: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  last_result: string | null;
  max_attempts: number;
  simulated: number;
  created_at: string;
}

export interface JobRunRow {
  id: string;
  job_id: string;
  scheduled_for: string;
  trigger: "schedule" | "manual";
  status: "running" | "succeeded" | "failed" | "blocked";
  attempt: number;
  started_at: string;
  finished_at: string | null;
  message: string | null;
}

export interface WorkflowResult {
  message: string;
}
export type Workflow = (ctx: Ctx, job: JobRow) => Promise<WorkflowResult>;
export type WorkflowRegistry = Record<string, Workflow>;

export class SchedulerError extends Error {}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function validateCron(cron: string): boolean {
  try {
    new Cron(cron, { paused: true });
    return true;
  } catch {
    return false;
  }
}

/** Shortest gap allowed between two runs: each run can keep the local model busy for minutes. */
export const MIN_INTERVAL_MINUTES = 15;

/**
 * Checks a schedule a user typed: valid, 5 fields (croner also accepts a seconds field, which would
 * fire a workflow every second) and at least MIN_INTERVAL_MINUTES between runs. An ISO date-time
 * (a one-time job) is fine. Throws a SchedulerError saying what to change.
 */
export function assertSchedule(cron: string, timezone: string, now: Date) {
  if (!isValidTimezone(timezone)) throw new SchedulerError("Invalid timezone");
  if (!validateCron(cron)) throw new SchedulerError("Invalid schedule. Use 5-field cron (e.g. 30 8 * * 1-5) or an ISO date-time for one-time jobs");
  if (cron.trim().split(/\s+/).length > 5) throw new SchedulerError("Use 5 fields (minute hour day month weekday): seconds aren't supported");
  const runs = nextRuns(cron, timezone, now, 6);
  for (let i = 1; i < runs.length; i++) {
    if (runs[i].getTime() - runs[i - 1].getTime() < MIN_INTERVAL_MINUTES * 60_000) {
      throw new SchedulerError(`Runs at most every ${MIN_INTERVAL_MINUTES} minutes: each run can keep the local model busy for minutes`);
    }
  }
}

export function nextRunAfter(cron: string, timezone: string, after: Date): Date | null {
  return new Cron(cron, { timezone, paused: true }).nextRun(after);
}

export function nextRuns(cron: string, timezone: string, after: Date, n: number): Date[] {
  return new Cron(cron, { timezone, paused: true }).nextRuns(n, after);
}

export function getJob(ctx: Ctx, id: string): JobRow {
  const job = one<JobRow>(ctx.db, "SELECT * FROM jobs WHERE id = ?", id);
  if (!job) throw new SchedulerError("Job not found");
  return job;
}

export function listJobs(ctx: Ctx): JobRow[] {
  return all<JobRow>(ctx.db, "SELECT * FROM jobs ORDER BY created_at");
}

export function jobHistory(ctx: Ctx, jobId: string, limit = 20): JobRunRow[] {
  return all<JobRunRow>(ctx.db, "SELECT * FROM job_runs WHERE job_id = ? ORDER BY started_at DESC LIMIT ?", jobId, limit);
}

/** Returns a human-readable reason if any declared requirement is not met by live permissions. */
export function unmetRequirement(ctx: Ctx, job: JobRow): string | null {
  if (appMode() === "personal" && DEMO_ONLY_WORKFLOWS.has(job.workflow)) return "A demo example with fictional content: it doesn't run in the personal app.";
  const reqs = z.array(RequirementSchema).parse(JSON.parse(job.requirements));
  for (const r of reqs) {
    // A service that isn't part of this instance (e.g. the demo inbox in the personal app) can't be
    // required: the workflow skips its demo steps and works with the real services instead.
    if (serviceHidden(ctx, r.serviceId)) continue;
    if (!check(ctx, r.agentId, r.serviceId, r.level)) {
      return `Needs ${LEVEL_LABELS[r.level as AccessLevel]} on ${r.serviceId} for ${r.agentId}; access was revoked or reduced.`;
    }
  }
  return null;
}

export interface CreateJobInput {
  name: string;
  purpose: string;
  agentId: string;
  workflow: string;
  cron: string;
  timezone: string;
  sources: string[];
  destination: string;
  requirements: Requirement[];
  maxAttempts?: number;
  simulated?: boolean;
  createdBy?: "seed" | "user";
}

export function createJob(ctx: Ctx, input: CreateJobInput): JobRow {
  assertSchedule(input.cron, input.timezone, ctx.now());
  const id = newId("job");
  const next = nextRunAfter(input.cron, input.timezone, ctx.now());
  run(
    ctx.db,
    `INSERT INTO jobs (id, name, purpose, agent_id, workflow, cron, timezone, sources, destination, requirements, status,
       next_run_at, max_attempts, simulated, created_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
    id,
    input.name,
    input.purpose,
    input.agentId,
    input.workflow,
    input.cron,
    input.timezone,
    JSON.stringify(input.sources),
    input.destination,
    JSON.stringify(input.requirements),
    next?.toISOString() ?? null,
    Math.min(Math.max(input.maxAttempts ?? 3, 1), 5),
    input.simulated === false ? 0 : 1,
    ctx.now().toISOString(),
    input.createdBy ?? "seed",
  );
  reconcileJobs(ctx);
  return getJob(ctx, id);
}

export const UpdateJobSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  cron: z.string().min(1).max(100).optional(),
  timezone: z.string().min(1).max(64).optional(),
});

export function updateJob(ctx: Ctx, id: string, patch: z.infer<typeof UpdateJobSchema>): JobRow {
  const job = getJob(ctx, id);
  const cron = patch.cron ?? job.cron;
  const timezone = patch.timezone ?? job.timezone;
  if (patch.cron !== undefined || patch.timezone !== undefined) assertSchedule(cron, timezone, ctx.now());
  const next = nextRunAfter(cron, timezone, ctx.now());
  run(
    ctx.db,
    "UPDATE jobs SET name = ?, cron = ?, timezone = ?, next_run_at = ? WHERE id = ?",
    patch.name ?? job.name,
    cron,
    timezone,
    next?.toISOString() ?? null,
    id,
  );
  logActivity(ctx, { actor: "user", kind: "schedule", agentId: job.agent_id, outcome: "info", summary: `Edited schedule "${patch.name ?? job.name}" (${cron}, ${timezone})` });
  return getJob(ctx, id);
}

/** Deletes a schedule and its run history. A running job cannot be deleted mid-run. */
export function deleteJob(ctx: Ctx, id: string) {
  const job = getJob(ctx, id);
  tx(ctx.db, () => {
    if (one(ctx.db, "SELECT id FROM job_runs WHERE job_id = ? AND status = 'running'", id)) throw new SchedulerError("This job is running; try again when it finishes");
    run(ctx.db, "DELETE FROM job_runs WHERE job_id = ?", id);
    run(ctx.db, "DELETE FROM jobs WHERE id = ?", id);
  });
  logActivity(ctx, { actor: "user", kind: "schedule", agentId: job.agent_id, outcome: "info", summary: `Deleted schedule "${job.name}"` });
}

/** Validates a schedule and returns its next run times, for previews before saving. */
export function previewSchedule(cron: string, timezone: string, after: Date, n = 3): string[] {
  assertSchedule(cron, timezone, after);
  return nextRuns(cron, timezone, after, n).map((d) => d.toISOString());
}

export function pauseJob(ctx: Ctx, id: string): JobRow {
  const job = getJob(ctx, id);
  run(ctx.db, "UPDATE jobs SET status = 'paused', status_reason = 'Paused by you' WHERE id = ?", id);
  logActivity(ctx, { actor: "user", kind: "schedule", agentId: job.agent_id, outcome: "info", summary: `Paused "${job.name}"` });
  return getJob(ctx, id);
}

export function resumeJob(ctx: Ctx, id: string): JobRow {
  const job = getJob(ctx, id);
  const next = nextRunAfter(job.cron, job.timezone, ctx.now());
  const unmet = unmetRequirement(ctx, job);
  run(
    ctx.db,
    "UPDATE jobs SET status = ?, status_reason = ?, next_run_at = ? WHERE id = ?",
    unmet ? "blocked" : "active",
    unmet,
    next?.toISOString() ?? null,
    id,
  );
  logActivity(ctx, {
    actor: "user",
    kind: "schedule",
    agentId: job.agent_id,
    outcome: unmet ? "denied" : "info",
    summary: unmet ? `Could not resume "${job.name}": ${unmet}` : `Resumed "${job.name}"`,
  });
  return getJob(ctx, id);
}

/** Called after any permission/connection change: block jobs that now exceed their permissions, unblock ones that fit again. */
export function reconcileJobs(ctx: Ctx) {
  for (const job of all<JobRow>(ctx.db, "SELECT * FROM jobs WHERE status IN ('active','blocked')")) {
    const unmet = unmetRequirement(ctx, job);
    if (unmet && job.status === "active") {
      run(ctx.db, "UPDATE jobs SET status = 'blocked', status_reason = ? WHERE id = ?", unmet, job.id);
      logActivity(ctx, { actor: "system", kind: "schedule", agentId: job.agent_id, outcome: "denied", summary: `Blocked "${job.name}": ${unmet}` });
    } else if (!unmet && job.status === "blocked") {
      run(ctx.db, "UPDATE jobs SET status = 'active', status_reason = NULL WHERE id = ?", job.id);
      logActivity(ctx, { actor: "system", kind: "schedule", agentId: job.agent_id, outcome: "info", summary: `Unblocked "${job.name}": permissions are sufficient again` });
    }
  }
}

const STALE_RUN_MS = 15 * 60 * 1000;

/** Backoff between retries of a failed run: 2 s, 4 s, 8 s… (capped at 30 s). Tests set it to 0. */
let retryDelayMs = (attempt: number) => Math.min(30_000, 1000 * 2 ** (attempt - 1));
export function setRetryDelay(fn: (attempt: number) => number) {
  retryDelayMs = fn;
}

/**
 * One scheduler pass. Safe to call concurrently from several processes: the INSERT into
 * job_runs is the claim, and only the process whose insert succeeds executes the run.
 */
export async function tick(ctx: Ctx, workflows: WorkflowRegistry): Promise<JobRunRow[]> {
  const now = ctx.now();
  run(
    ctx.db,
    "UPDATE job_runs SET status = 'failed', finished_at = ?, message = 'Worker stopped before the run finished' WHERE status = 'running' AND started_at < ?",
    now.toISOString(),
    new Date(now.getTime() - STALE_RUN_MS).toISOString(),
  );
  const due = all<JobRow>(ctx.db, "SELECT * FROM jobs WHERE status = 'active' AND next_run_at IS NOT NULL AND next_run_at <= ?", now.toISOString());
  const results: JobRunRow[] = [];
  for (const job of due) {
    const runRow = claimRun(ctx, job, job.next_run_at!, "schedule");
    if (runRow) results.push(await executeRun(ctx, job, runRow, workflows));
  }
  return results;
}

/** Manual trigger. Also bounded by permissions; works on paused jobs because the user explicitly asked. */
export async function runNow(ctx: Ctx, jobId: string, workflows: WorkflowRegistry): Promise<JobRunRow> {
  const job = getJob(ctx, jobId);
  const runRow = claimRun(ctx, job, `manual:${ctx.now().toISOString()}`, "manual");
  if (!runRow) throw new SchedulerError("This job is already running");
  return executeRun(ctx, job, runRow, workflows);
}

/**
 * Same as runNow, but returns as soon as the run is claimed; the workflow continues in the
 * background and its progress is visible through job_runs (status "running"). Used by the UI,
 * because a local LLM on a laptop CPU can take minutes.
 */
export function startRunNow(ctx: Ctx, jobId: string, workflows: WorkflowRegistry): JobRunRow {
  const job = getJob(ctx, jobId);
  const runRow = claimRun(ctx, job, `manual:${ctx.now().toISOString()}`, "manual");
  if (!runRow) throw new SchedulerError("This job is already running");
  void executeRun(ctx, job, runRow, workflows).catch((err) => console.error("[scheduler] background run failed:", String(err instanceof Error ? err.message : err).replace(/mongodb(\+srv)?:\/\/\S+/gi, "mongodb://[redacted]").slice(0, 300)));
  return runRow;
}

function claimRun(ctx: Ctx, job: JobRow, scheduledFor: string, trigger: "schedule" | "manual"): JobRunRow | null {
  return tx(ctx.db, () => {
    const running = one(ctx.db, "SELECT id FROM job_runs WHERE job_id = ? AND status = 'running'", job.id);
    if (running) {
      if (trigger === "schedule") {
        // Never run the same job twice at once: skip this slot, move on to the next one.
        const next = nextRunAfter(job.cron, job.timezone, ctx.now());
        run(ctx.db, "UPDATE jobs SET next_run_at = ? WHERE id = ?", next?.toISOString() ?? null, job.id);
        logActivity(ctx, { actor: "system", kind: "schedule", agentId: job.agent_id, outcome: "info", summary: `Skipped a scheduled run of "${job.name}": the previous run is still going` });
      }
      return null;
    }
    const id = newId("run");
    const res = run(
      ctx.db,
      `INSERT OR IGNORE INTO job_runs (id, job_id, scheduled_for, trigger, status, started_at) VALUES (?, ?, ?, ?, 'running', ?)`,
      id,
      job.id,
      scheduledFor,
      trigger,
      ctx.now().toISOString(),
    );
    if (res.changes === 0) return null;
    if (trigger === "schedule") {
      // Advance from *now*, not from the missed slot, so downtime never causes a burst of backfilled runs.
      const next = nextRunAfter(job.cron, job.timezone, ctx.now());
      run(ctx.db, "UPDATE jobs SET next_run_at = ? WHERE id = ?", next?.toISOString() ?? null, job.id);
    }
    return one<JobRunRow>(ctx.db, "SELECT * FROM job_runs WHERE id = ?", id)!;
  });
}

async function executeRun(ctx: Ctx, job: JobRow, runRow: JobRunRow, workflows: WorkflowRegistry): Promise<JobRunRow> {
  const finish = (status: JobRunRow["status"], message: string, attempt: number) => {
    run(ctx.db, "UPDATE job_runs SET status = ?, message = ?, attempt = ?, finished_at = ? WHERE id = ?", status, message.slice(0, 500), attempt, ctx.now().toISOString(), runRow.id);
    run(ctx.db, "UPDATE jobs SET last_run_at = ?, last_result = ? WHERE id = ?", ctx.now().toISOString(), `${status}: ${message}`.slice(0, 300), job.id);
    logActivity(ctx, {
      actor: job.agent_id,
      kind: "agent_run",
      agentId: job.agent_id,
      outcome: status === "succeeded" ? "ok" : status === "blocked" ? "denied" : "failed",
      summary: `${job.name} (${runRow.trigger}): ${status}${status === "succeeded" ? "" : ` — ${message.slice(0, 120)}`}`,
      detail: { runId: runRow.id, jobId: job.id, attempt },
    });
    if (status === "failed") notifyLater(ctx, { key: `failure:${runRow.id}`, kind: "failure", title: "A scheduled task failed", summary: "Open the dashboard to see what happened.", detail: `${job.name}: ${message.slice(0, 160)}` });
    return one<JobRunRow>(ctx.db, "SELECT * FROM job_runs WHERE id = ?", runRow.id)!;
  };

  const unmet = unmetRequirement(ctx, job);
  if (unmet) {
    if (job.status === "active") run(ctx.db, "UPDATE jobs SET status = 'blocked', status_reason = ? WHERE id = ?", unmet, job.id);
    return finish("blocked", unmet, 0);
  }

  const workflow = workflows[job.workflow];
  if (!workflow) return finish("failed", `Unknown workflow "${job.workflow}"`, 0);

  let lastError = "Unknown error";
  for (let attempt = 1; attempt <= job.max_attempts; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, retryDelayMs(attempt)));
    try {
      const result = await workflow(ctx, job);
      return finish("succeeded", result.message, attempt);
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      // Permission problems are not transient — retrying would only repeat the denial.
      if ((err as { code?: string }).code === "POLICY_DENIED") return finish("blocked", lastError, attempt);
    }
  }
  return finish("failed", lastError, job.max_attempts);
}

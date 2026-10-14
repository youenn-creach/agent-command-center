import { describe, expect, it } from "vitest";
import { createJob, deleteJob, listJobs, previewSchedule, runNow } from "@/server/scheduler/scheduler";
import { weeklyReview, workflows } from "@/server/agents/chiefOfStaff";
import { WORKFLOW_CATALOG, catalogEntry } from "@/server/agents/catalog";
import { all } from "@/server/db";
import { seededCtx } from "./helpers";

describe("user-created schedules", () => {
  it("previews the next runs and rejects invalid input", () => {
    const next = previewSchedule("0 18 * * 0", "Europe/Paris", new Date("2026-10-12T10:00:00Z"));
    expect(next[0]).toBe("2026-10-18T16:00:00.000Z");
    expect(() => previewSchedule("tomorrow", "Europe/Paris", new Date())).toThrow(/Invalid schedule/);
    expect(() => previewSchedule("0 18 * * 0", "Nowhere/City", new Date())).toThrow(/timezone/);
  });

  it("every catalog workflow exists in the registry and declares its requirements", () => {
    for (const c of WORKFLOW_CATALOG) {
      expect(workflows[c.workflow]).toBeTypeOf("function");
      expect(c.requirements.length).toBeGreaterThan(0);
    }
    expect(catalogEntry("insurance_reminder")).toBeUndefined();
  });

  it("deletes a schedule together with its history", async () => {
    const ctx = seededCtx();
    const entry = catalogEntry("weekly_review")!;
    const job = createJob(ctx, { name: "Mine", purpose: entry.description, agentId: entry.agentId, workflow: entry.workflow, cron: entry.defaultCron, timezone: "Europe/Paris", sources: entry.sources, destination: entry.destination, requirements: entry.requirements, createdBy: "user" });
    await runNow(ctx, job.id, workflows);
    deleteJob(ctx, job.id);
    expect(listJobs(ctx).some((j) => j.id === job.id)).toBe(false);
    expect(all(ctx.db, "SELECT * FROM job_runs WHERE job_id = ?", job.id)).toHaveLength(0);
  });
});

describe("demo reset", () => {
  it("keeps schedules the user created", async () => {
    const ctx = seededCtx();
    const entry = catalogEntry("weekly_review")!;
    const mine = createJob(ctx, { name: "Mine", purpose: entry.description, agentId: entry.agentId, workflow: entry.workflow, cron: entry.defaultCron, timezone: "Europe/Paris", sources: entry.sources, destination: entry.destination, requirements: entry.requirements, createdBy: "user" });
    const { resetDemo } = await import("@/server/seed/seed");
    resetDemo(ctx);
    const jobs = listJobs(ctx);
    expect(jobs.some((j) => j.id === mine.id)).toBe(true);
    expect(jobs.filter((j) => j.name === "Morning tech briefing")).toHaveLength(1);
  });
});

describe("weekly review", () => {
  it("summarizes the week as a 'weekly' briefing without touching the daily one", async () => {
    const ctx = seededCtx();
    const out = await weeklyReview(ctx);
    const b = all<{ kind: string; body: string }>(ctx.db, "SELECT kind, body FROM briefings WHERE id = ?", out.briefingId)[0];
    expect(b.kind).toBe("weekly");
    expect(b.body).toMatch(/Next 7 days/);
    expect(b.body).toMatch(/Dentist check-up/);
    expect(b.body).toMatch(/Still waiting on you/);
  });
});

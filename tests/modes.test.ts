import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "@/server/db";
import { reloadConfig } from "@/server/config";
import { effectiveAccess } from "@/server/policy/engine";
import { setServiceLevel } from "@/server/policy/permissions";
import { dashboardState } from "@/server/state";
import { callTool } from "@/server/tools/registry";
import { RunBudget } from "@/server/tools/budget";
import { addWebhook } from "@/server/connectors/webhooks";
import { setLocation } from "@/server/connectors/weather";
import { ModeError } from "@/server/mode";
import { listDocuments } from "@/server/retrieval/knowledge";
import { dailyBriefing, followupSweep, weeklyReview } from "@/server/agents/chiefOfStaff";
import { listJobs, unmetRequirement } from "@/server/scheduler/scheduler";
import { all } from "@/server/db";
import { seededCtx } from "./helpers";

function withMode(mode: "personal" | "demo" | "mixed") {
  vi.stubEnv("ACC_MODE", mode);
  reloadConfig();
}
afterEach(() => {
  vi.unstubAllEnvs();
  reloadConfig();
});

// Ollama isn't needed: dashboardState only asks it for health, which fails fast and safely.
vi.stubGlobal("fetch", vi.fn(async () => Response.json({ models: [] })));

describe("personal app (ACC_MODE=personal)", () => {
  it("hides the demo-only services from every view and from every agent", async () => {
    withMode("personal");
    const ctx = seededCtx();
    const state = await dashboardState(ctx);
    expect(state.services.map((s) => s.id)).not.toContain("demo-mail");
    expect(state.services.map((s) => s.id)).not.toContain("demo-calendar");
    expect(state.matrix.flatMap((r) => r.cells.map((c) => c.serviceId))).not.toContain("demo-mail");
    // The seeded grant is still stored (switching back restores it), but the policy engine says no.
    expect(effectiveAccess(ctx, "inbox", "demo-mail")).toMatchObject({ level: "none", reason: expect.stringMatching(/personal app/) });
    await expect(callTool(ctx, "inbox", "inbox.list_messages", { limit: 5, needsReplyOnly: false }, new RunBudget(2, 5000))).rejects.toThrow();
  });

  it("shows no fictional rows: agenda, inbox, notes, sample news", async () => {
    withMode("personal");
    const ctx = seededCtx();
    run(ctx.db, "INSERT INTO events (id, title, starts_at, ends_at, location, is_demo, source) VALUES ('g1', 'Real meeting', ?, ?, NULL, 0, 'google-calendar')", ctx.now().toISOString(), ctx.now().toISOString());
    const state = await dashboardState(ctx);
    expect(state.today.events.map((e) => e.title)).toEqual(["Real meeting"]);
    expect(state.today.waiting.every((m) => !m.is_demo)).toBe(true);
    expect(listDocuments(ctx).every((d) => !d.is_demo)).toBe(true);
    const news = await callTool(ctx, "knowledge", "news.list_items", { limit: 5 }, new RunBudget(2, 5000));
    expect(news).toEqual([]); // never the sample feed
  });
});

describe("personal app keeps its scheduled workflows working", () => {
  it("jobs that list the demo inbox/calendar are not blocked by them", async () => {
    withMode("personal");
    const ctx = seededCtx();
    const jobs = listJobs(ctx);
    expect(jobs.map((j) => j.workflow)).toEqual(expect.arrayContaining(["daily_briefing", "followup_sweep", "weekly_review"]));
    for (const j of jobs.filter((x) => x.workflow !== "insurance_reminder")) expect(unmetRequirement(ctx, j), j.name).toBeNull(); // the fictional example is blocked on purpose
    expect((await dashboardState(ctx)).jobs.map((j) => j.workflow)).toContain("followup_sweep");
  });

  it("briefing, sweep and weekly review skip the demo steps instead of logging fake denials", async () => {
    withMode("personal");
    const ctx = seededCtx();
    const llm = { id: "stub", label: "stub", model: "stub", async generate() { return { text: "x", model: "stub", ms: 1 }; } };
    await dailyBriefing(ctx, null, llm);
    const sweep = await followupSweep(ctx, llm);
    await weeklyReview(ctx);
    expect(sweep.message).not.toMatch(/demo message/);
    expect(all(ctx.db, "SELECT summary FROM activity WHERE kind = 'permission_denied'")).toEqual([]);
    const steps = all<{ provenance: string }>(ctx.db, "SELECT provenance FROM briefings").flatMap((b) => (JSON.parse(b.provenance) as { steps: { tool: string }[] }).steps.map((x) => x.tool));
    expect(steps).not.toContain("calendar.list_events");
    expect(steps).not.toContain("inbox.list_messages");
  });
});

describe("demo (ACC_MODE=demo)", () => {
  it("keeps real accounts off, even if the database says otherwise", () => {
    withMode("demo");
    const ctx = seededCtx();
    run(ctx.db, "UPDATE services SET connection_state = 'connected', access_level = 'read' WHERE id = 'gmail'");
    run(ctx.db, "INSERT OR REPLACE INTO agent_permissions VALUES ('inbox', 'gmail', 'read')");
    expect(effectiveAccess(ctx, "inbox", "gmail")).toMatchObject({ level: "none", reason: expect.stringMatching(/off in the demo/) });
    expect(() => addWebhook(ctx, { name: "Todoist", description: "", url: "https://hooks.example.com/abc" })).toThrow(ModeError);
    expect(() => setLocation(ctx, { name: "Paris", country: "FR", latitude: 48.85, longitude: 2.35 })).toThrow(ModeError);
  });

  it("still runs the demo services normally", () => {
    withMode("demo");
    const ctx = seededCtx();
    setServiceLevel(ctx, "demo-mail", "read");
    expect(effectiveAccess(ctx, "inbox", "demo-mail").level).toBe("read");
  });
});

describe("mixed (default)", () => {
  it("is unchanged: demo and real services side by side", async () => {
    withMode("mixed");
    const ctx = seededCtx();
    const ids = (await dashboardState(ctx)).services.map((s) => s.id);
    expect(ids).toEqual(expect.arrayContaining(["demo-mail", "demo-calendar", "gmail", "google-calendar"]));
  });
});

describe("demo reset", () => {
  it("is refused in the personal app (it would wipe real history) and allowed in the demo", async () => {
    const { assertDemoResetAllowed } = await import("@/server/mode");
    withMode("personal");
    expect(() => assertDemoResetAllowed()).toThrow(ModeError);
    withMode("demo");
    expect(() => assertDemoResetAllowed()).not.toThrow();
    withMode("mixed");
    expect(() => assertDemoResetAllowed()).not.toThrow();
  });
});

describe("personal app shows nothing fictional", () => {
  it("hides demo proposals, demo-built briefings and the fictional example job; counts match", async () => {
    withMode("mixed");
    const ctx = seededCtx();
    const llm = { id: "stub", label: "stub", model: "stub", async generate() { return { text: "x", model: "stub", ms: 1 }; } };
    await dailyBriefing(ctx, null, llm); // in mixed mode: demo agenda, demo replies proposed
    expect(all(ctx.db, "SELECT id FROM actions WHERE is_demo = 1").length).toBeGreaterThan(0);

    withMode("personal");
    let state = await dashboardState(ctx);
    expect(state.actions.every((a) => !a.is_demo)).toBe(true);
    expect(state.today.briefing).toBeNull(); // the demo-built one isn't shown
    // ...even if it had live news (not "simulated") but read the demo calendar and inbox.
    ctx.db.prepare("UPDATE briefings SET simulated = 0").run();
    expect((await dashboardState(ctx)).today.briefing).toBeNull();
    expect(state.jobs.map((j) => j.workflow)).not.toContain("insurance_reminder");
    expect(state.jobs.every((j) => !j.simulated && !j.sources.some((src) => /Demo|sample feed/.test(src)))).toBe(true);
    expect(state.knowledge.stats.documents).toBe(0);
    const insurance = listJobs(ctx).find((j) => j.workflow === "insurance_reminder")!;
    expect(unmetRequirement(ctx, insurance)).toMatch(/demo example/);

    // A briefing made in the personal app (no news sources enabled) is real, and shown.
    await dailyBriefing(ctx, null, llm);
    state = await dashboardState(ctx);
    expect(state.today.briefing?.simulated).toBe(0);
  });
});

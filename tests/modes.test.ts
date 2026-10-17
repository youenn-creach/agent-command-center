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

import { agenda, contactLookup, nudge, notesLikely, priorities, subscriptions, trips, waitingOn } from "@/server/agents/assistant";
import { runCommand } from "@/server/agents/command";
import { workflows } from "@/server/agents/chiefOfStaff";

describe("the assistant's own answers in the personal app contain nothing fictional", () => {
  // Every name, address and place of the seeded demo data that an answer could carry.
  const FICTION = /Priya|Maria|Lopez|Jordan|Tom Becker|Riverside Dental|Spokes|Café Lumen|Library|Alfama|Example Air|example\.(?:com|org)|bank\.example|Streaming Example|CloudNotes|Community garden|Lunch with Sam|Long run/i;
  // The user's own words may be echoed back ("no address for “priya”"): only data from the rows counts as a leak.
  const leak = (x: unknown, asked = "") => asked.split(/[^\p{L}]+/u).filter((w) => w.length > 2).reduce((t, w) => t.replace(new RegExp(w, "gi"), ""), JSON.stringify(x)).match(FICTION)?.[0] ?? null;

  it("every read path the assistant uses hides the seeded demo rows", async () => {
    const ctx = seededCtx(); // full fictional data: calendar, inbox, waits, bookings, subscriptions, notes
    withMode("personal");
    const answers: Record<string, unknown> = {
      priorities: await priorities(ctx),
      today: await agenda(ctx, "what's on today"),
      saturday: await agenda(ctx, "what am I doing saturday"),
      week: await agenda(ctx, "what's my week like"),
      next: await agenda(ctx, "when is my next long run"),
      comingUp: await agenda(ctx, "is there a spanish thing coming up"),
      contact: contactLookup(ctx, "priya"),
      waiting: await waitingOn(ctx),
      nudge: await nudge(ctx, "Priya"),
      oldest: await nudge(ctx, "longest"),
      trips: await trips(ctx),
      subscriptions: await subscriptions(ctx),
    };
    const asked: Record<string, string> = { next: "when is my next long run", contact: "priya", nudge: "Priya", comingUp: "is there a spanish thing coming up", saturday: "what am I doing saturday" };
    for (const [name, answer] of Object.entries(answers)) expect([name, leak(answer, asked[name])]).toEqual([name, null]);
    expect(await notesLikely(ctx, "how much is left of the kitchen budget")).toBe(false); // demo notes are not the user's
    expect(all(ctx.db, "SELECT id FROM actions WHERE is_demo = 1 AND status = 'proposed' AND created_at > datetime('now', '-1 minute')")).toHaveLength(0); // no demo follow-up drafted
  });

  it("whole requests through the command bar too (quick rules, no model)", async () => {
    const ctx = seededCtx();
    withMode("personal");
    for (const text of ["what should I do first today", "who hasn't gotten back to me?", "what's on my calendar today?", "what's priya's email", "chase the oldest one", "whats on tmrw"]) {
      const r = await runCommand(ctx, text, workflows);
      expect([text, leak(r, text)]).toEqual([text, null]);
    }
  });
});

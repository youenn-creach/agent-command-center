import { afterEach, describe, expect, it, vi } from "vitest";
import { agenda } from "@/server/agents/assistant";
import { reloadConfig } from "@/server/config";
import { seededCtx } from "./helpers";

// The evaluation world: Thu 15 Oct 2026, 10:30 in Madrid (dentist 09:30 done, lunch with Sam 12:30 at Café Lumen,
// committee 18:00–19:30; Fri bike drop-off 08:15, Spanish exchange 19:00 at the Library café; Sun long run 08:00).
const world = () => {
  vi.stubEnv("ACC_TIMEZONE", "Europe/Madrid");
  reloadConfig();
  return seededCtx(new Date("2026-10-15T08:30:00Z"));
};
afterEach(() => {
  vi.unstubAllEnvs();
  reloadConfig();
});

describe("calendar questions answered, not listed", () => {
  it("a named event: where it is, which day, today or tomorrow", async () => {
    const ctx = world();
    expect((await agenda(ctx, "where's the spanish exchange")).reply).toMatch(/Library café.*tomorrow/);
    expect((await agenda(ctx, "is the dentist today or tomorrow")).reply).toMatch(/today .*09:30.*already over/);
    expect((await agenda(ctx, "on which day are my long runs")).reply).toMatch(/Sunday/);
  });

  it("after lunch, after a time: only what comes after", async () => {
    const ctx = world();
    const r = await agenda(ctx, "anything after lunch today");
    expect(r.items?.map((i) => i.title).join(" ")).toMatch(/committee/);
    expect(r.items?.map((i) => i.title).join(" ")).not.toMatch(/Dentist|Lunch/);
  });

  it("free at a given time: yes or no for that moment", async () => {
    const ctx = world();
    expect((await agenda(ctx, "check if I'm free at 3pm tomorrow")).reply).toMatch(/^Yes: you're free at 15:00/);
    expect((await agenda(ctx, "am I free at 6pm today")).reply).toMatch(/^No: at 18:00 .*committee/i);
  });

  it("leaves the usual questions alone", async () => {
    const ctx = world();
    expect((await agenda(ctx, "what's on tomorrow")).reply).toMatch(/2 events tomorrow/);
  });
});

import { runCommand } from "@/server/agents/command";
import { workflows } from "@/server/agents/chiefOfStaff";
import { all } from "@/server/db";
import { connectFakeGmail } from "../scripts/sim-gmail";
import type { LlmProvider } from "@/server/llm";

describe("reminders placed relative to an event", () => {
  const router = (skill: string): LlmProvider => ({ id: "r", label: "r", generate: async () => ({ text: JSON.stringify({ skill, args: {} }), model: "r", ms: 1 }) });
  const due = (ctx: Parameters<typeof all>[0] extends never ? never : { db: Parameters<typeof all>[0] }) =>
    all<{ text: string; due_at: string }>(ctx.db, "SELECT text, due_at FROM reminders WHERE done_at IS NULL");

  it("the morning of an event only the mail mentions (the weekday read against the day it was sent)", async () => {
    const ctx = world();
    await connectFakeGmail(ctx);
    await runCommand(ctx, "remind me the morning of the boiler inspection to clear the cupboard", workflows, router("reminder"));
    const r = due(ctx);
    expect(r).toHaveLength(1);
    expect(r[0].text).toMatch(/^Clear the cupboard/);
    expect(r[0].due_at).toBe("2026-10-20T06:00:00.000Z"); // Tue 20 Oct, 08:00 in Madrid
  });

  it("before a calendar event: an hour before it starts", async () => {
    const ctx = world();
    await runCommand(ctx, "remind me before the committee to print the minutes", workflows, router("reminder"));
    expect(due(ctx)[0].due_at).toBe("2026-10-15T15:00:00.000Z"); // 17:00 in Madrid, the committee is at 18:00
  });
});

import { correctRoute } from "@/server/agents/command";
import { run } from "@/server/db";

describe("review fixes (2026-10-17)", () => {
  it("a named event on a named day: only that day counts", async () => {
    const ctx = world();
    // The Spanish exchange is tomorrow, not today: asked about today, the answer is not tomorrow's.
    expect((await agenda(ctx, "where is the spanish exchange today")).reply).not.toMatch(/tomorrow|Library café/);
  });

  it("an all-day entry doesn't make an hour busy", async () => {
    const ctx = world();
    run(ctx.db, "INSERT INTO events (id, title, starts_at, ends_at, location, is_demo, source) VALUES ('ad1', 'Mum''s birthday', '2026-10-15T22:00:00.000Z', '2026-10-16T22:00:00.000Z', NULL, 1, 'demo')");
    expect((await agenda(ctx, "am I free at 3pm tomorrow")).reply).toMatch(/^Yes/);
  });

  it("a reminder before a vague period isn't anchored to a newsletter", async () => {
    const ctx = world();
    run(ctx.db, "INSERT INTO messages (id, sender, subject, snippet, received_at, is_demo, source, needs_reply) VALUES ('nl1', 'newsletter@reads.example', 'Your weekend reading', 'Out on Friday', '2026-10-14T08:00:00.000Z', 1, 'demo', 0)");
    await runCommand(ctx, "remind me to water the plants before the weekend", workflows, { id: "r", label: "r", generate: async () => ({ text: '{"skill":"reminder","args":{}}', model: "r", ms: 1 }) });
    const r = all<{ text: string }>(ctx.db, "SELECT text FROM reminders WHERE done_at IS NULL");
    expect(r.map((x) => x.text).join(" ")).not.toMatch(/weekend reading/i);
  });

  it("how-to and travel questions about 'my' things stay on the web", () => {
    expect(correctRoute("how do I renew my passport in Spain", { skill: "web_search", args: {} }).skill).toBe("web_search");
    expect(correctRoute("how far is my hotel from the airport", { skill: "web_search", args: {} }).skill).toBe("web_search");
    expect(correctRoute("what grammar am I working on in spanish", { skill: "web_search", args: {} }).skill).toBe("notes_search");
  });
});

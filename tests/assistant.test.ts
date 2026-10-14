import { describe, expect, it } from "vitest";
import { all, run } from "@/server/db";
import { classify, runCommand } from "@/server/agents/command";
import { workflows } from "@/server/agents/chiefOfStaff";
import { aboutMePrompt, addFact, deleteFact, listFacts, MemoryError } from "@/server/memory";
import { listRequests } from "@/server/requests";
import { addWebhook } from "@/server/connectors/webhooks";
import { setAgentLevel, setServiceLevel } from "@/server/policy/permissions";
import { pruneOldData, setRetention } from "@/server/retention";
import { clearUserData, exportUserData } from "@/server/userData";
import { seededCtx } from "./helpers";

describe("About me", () => {
  it("stores the user's facts and turns them into a prompt block", () => {
    const ctx = seededCtx();
    expect(aboutMePrompt(ctx)).toBe("");
    const f = addFact(ctx, "  I sign emails as Sam  ");
    addFact(ctx, "I prefer short replies");
    expect(listFacts(ctx).map((x) => x.text)).toEqual(["I sign emails as Sam", "I prefer short replies"]);
    expect(aboutMePrompt(ctx)).toMatch(/About the user[\s\S]*- I sign emails as Sam\n- I prefer short replies/);
    deleteFact(ctx, f.id);
    expect(listFacts(ctx)).toHaveLength(1);
    expect(() => deleteFact(ctx, f.id)).toThrow(MemoryError);
  });

  it("is capped and validated", () => {
    const ctx = seededCtx();
    expect(() => addFact(ctx, "x")).toThrow();
    expect(() => addFact(ctx, "y".repeat(301))).toThrow();
    for (let i = 0; i < 50; i++) addFact(ctx, `fact number ${i}`);
    expect(() => addFact(ctx, "one too many")).toThrow(MemoryError);
  });

  it("“remember …” in Ctrl+K saves a fact", async () => {
    const ctx = seededCtx();
    expect(classify("remember that I prefer short replies")).toEqual({ intent: "remember", query: "I prefer short replies" });
    const r = await runCommand(ctx, "remember I work 9:00-17:30 on weekdays", workflows);
    expect(r.intent).toBe("remember");
    expect(listFacts(ctx).map((f) => f.text)).toEqual(["I work 9:00-17:30 on weekdays"]);
  });
});

describe("request board", () => {
  it("follows each request: answered, declined, saved, then an action through approval to done", async () => {
    const ctx = seededCtx();
    await runCommand(ctx, "what's scheduled?", workflows);
    await runCommand(ctx, "approve everything", workflows);
    await runCommand(ctx, "hello there", workflows); // help: not recorded
    const id = addWebhook(ctx, { name: "Todoist", description: "Adds a task", url: "https://hooks.example.com/catch/123" });
    setServiceLevel(ctx, id, "write_with_approval");
    setAgentLevel(ctx, "follow_up", id, "write_with_approval");
    const proposed = await runCommand(ctx, "trigger todoist: buy milk", workflows);
    expect(proposed.ref?.actionId).toBeTruthy();

    const board = () => Object.fromEntries(listRequests(ctx).map((r) => [r.text, r.status]));
    expect(board()).toEqual({
      "trigger todoist: buy milk": "Waiting for your approval",
      "approve everything": "Declined: do this yourself",
      "what's scheduled?": "Answered",
    });
    run(ctx.db, "UPDATE actions SET status = 'executed' WHERE id = ?", proposed.ref!.actionId!);
    expect(board()["trigger todoist: buy milk"]).toBe("Done");
    expect(listRequests(ctx)[0].section).toBe("actions");
  });

  it("follows a started workflow run", async () => {
    const ctx = seededCtx();
    const r = await runCommand(ctx, "brief me", workflows);
    expect(r.ref?.runId).toBeTruthy();
    expect(["Working…", "Done", "Failed", "Blocked"]).toContain(listRequests(ctx)[0].status);
  });
});

describe("history limits and agenda reads", () => {
  it("retention also trims the request board", async () => {
    const ctx = seededCtx();
    await runCommand(ctx, "what's scheduled?", workflows);
    run(ctx.db, "UPDATE requests SET created_at = '2026-01-01T00:00:00.000Z'");
    setRetention(ctx, { activityDays: 30, searchHistoryDays: 0, completedRemindersDays: 0, briefingsDays: 0 });
    pruneOldData(ctx);
    expect(listRequests(ctx)).toEqual([]);
  });
});

describe("your data: export and clear", () => {
  it("About me and requests are exported, and cleared with the rest of your data", async () => {
    const ctx = seededCtx();
    addFact(ctx, "I prefer short replies");
    await runCommand(ctx, "what's scheduled?", workflows);
    const out = exportUserData(ctx);
    expect(out.aboutMe).toMatchObject([{ text: "I prefer short replies" }]);
    expect(out.requests).toMatchObject([{ text: "what's scheduled?" }]);
    expect(JSON.stringify(out)).not.toMatch(/token|secret|ciphertext/i);
    await clearUserData(ctx);
    expect(all(ctx.db, "SELECT * FROM memory_facts")).toEqual([]);
    expect(all(ctx.db, "SELECT * FROM requests")).toEqual([]);
  });
});

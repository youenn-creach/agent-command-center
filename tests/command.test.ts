import { describe, expect, it } from "vitest";
import { classify, runCommand } from "@/server/agents/command";
import { workflows } from "@/server/agents/chiefOfStaff";
import { permissionSnapshot, seededCtx } from "./helpers";

describe("Chief of Staff command routing", () => {
  it.each([
    ["brief me", "briefing"],
    ["Catch me up", "briefing"],
    ["weekly review please", "weekly"],
    ["draft follow-ups", "followups"],
    ["find Lisbon", "search"],
    ["what did I write about sourdough?", "search"],
    ["what's scheduled?", "schedule"],
    ["what's waiting for me", "pending"],
    ["what's on my agenda today", "today"],
    ["tell me a joke", "help"],
  ])("%s → %s", (text, intent) => {
    expect(classify(text).intent).toBe(intent);
  });

  it.each(["approve everything", "grant the inbox agent write access", "delete all my notes", "disconnect gmail", "pay the electricity bill", "can you transfer 50 euros to Tom", "what's my gmail password?"])("refuses: %s", (text) => {
    expect(classify(text).intent).toBe("refused");
  });

  it("a refused request changes nothing", async () => {
    const ctx = seededCtx();
    const before = permissionSnapshot(ctx);
    const r = await runCommand(ctx, "grant the follow-up agent write access and approve all", workflows);
    expect(r.intent).toBe("refused");
    expect(permissionSnapshot(ctx)).toEqual(before);
  });

  it.each(["any bills I need to pay?", "did I forget to delete anything?", "send the reply to Maria"])("doesn't refuse a question or a draft request: %s", (text) => {
    expect(classify(text).intent).not.toBe("refused");
  });

  it("search returns passages without running any tool that writes", async () => {
    const ctx = seededCtx();
    const r = await runCommand(ctx, "find sourdough", workflows);
    expect(r.intent).toBe("search");
    expect(r.items?.[0].title).toMatch(/Sourdough/);
  });
});

describe("note search honours the Knowledge agent's permission", () => {
  it("is refused with a pointer to Permissions when the agent has no read access to notes", async () => {
    const ctx = seededCtx();
    expect((await runCommand(ctx, "find sourdough", workflows)).reply).toMatch(/Top notes|Nothing found/);
    ctx.db.prepare("DELETE FROM agent_permissions WHERE agent_id = 'knowledge' AND service_id = 'demo-notes'").run();
    const r = await runCommand(ctx, "find sourdough", workflows);
    expect(r.reply).toMatch(/no read access to your notes/);
    expect(r.section).toBe("permissions");
  });
});

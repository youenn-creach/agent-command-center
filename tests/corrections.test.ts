import { describe, expect, it } from "vitest";
import { runCommand, ChosenSchema } from "@/server/agents/command";
import { routeRequest } from "@/server/agents/assistant";
import { userExamples } from "@/server/agents/corrections";
import { workflows } from "@/server/agents/chiefOfStaff";
import { clearUserData, exportUserData } from "@/server/userData";
import type { LlmProvider } from "@/server/llm";
import { seededCtx } from "./helpers";

const fake = (id = "local"): LlmProvider & { seen: string[] } => {
  const seen: string[] = [];
  return { id: id as never, label: id, seen, generate: async (_s, user) => (seen.push(user), { text: '{"skill":"agenda","args":{}}', model: id, ms: 1 }) };
};

describe("“not right?”: the user's correction", () => {
  it("runs the request as the kind the user picked, without the nets second-guessing it, and says so", async () => {
    const ctx = seededCtx();
    // "whats left today" would be turned into the agenda by a net if it came from the model as priorities
    const r = await runCommand(ctx, "whats left today", workflows, undefined, undefined, { skill: "priorities", wrong: "agenda" });
    expect(r).toMatchObject({ skill: "priorities", understood: "your choice" });
  });

  it("is kept as an example: the next similar request shows it to the local model, never to the cloud router", async () => {
    const ctx = seededCtx();
    await runCommand(ctx, "anything from the gym lately", workflows, undefined, undefined, { skill: "email_search", wrong: "agenda" });
    expect(userExamples(ctx)).toEqual([["anything from the gym lately", "email_search {}"]]);
    const local = fake();
    await routeRequest(ctx, "anything from the gym this week", local);
    expect(local.seen[0]).toContain('"anything from the gym lately" -> email_search {}');
    const cloud = fake("mistral-api");
    await routeRequest(ctx, "anything from the gym this week", cloud);
    expect(cloud.seen[0]).not.toContain("anything from the gym lately");
  });

  it("only offers the listed kinds (nothing that sends, approves or changes access)", () => {
    expect(ChosenSchema.safeParse({ text: "x", skill: "agenda" }).success).toBe(true);
    expect(ChosenSchema.safeParse({ text: "x", skill: "nudge_all" }).success).toBe(false);
    expect(ChosenSchema.safeParse({ text: "x", skill: "remember" }).success).toBe(false);
  });

  it("is part of the user's data: exported, and erased with it", async () => {
    const ctx = seededCtx();
    await runCommand(ctx, "anything from the gym lately", workflows, undefined, undefined, { skill: "email_search" });
    expect(exportUserData(ctx).corrections).toHaveLength(1);
    await clearUserData(ctx);
    expect(userExamples(ctx)).toEqual([]);
  });
});

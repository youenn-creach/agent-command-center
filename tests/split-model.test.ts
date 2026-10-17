import { describe, expect, it } from "vitest";
import { setSetting } from "@/server/db";
import { modelSplit, ownWords } from "@/server/agents/split";
import { runCommand } from "@/server/agents/command";
import { workflows } from "@/server/agents/chiefOfStaff";
import type { LlmProvider } from "@/server/llm";
import { seededCtx } from "./helpers";

/** A fake model: the splitter's question gets `parts`; a routing question gets the first rule matching the request. */
const fake = (parts: string[] | string, routes: [RegExp, string][] = []): LlmProvider & { asked: string[] } => {
  const asked: string[] = [];
  return {
    id: "f",
    label: "f",
    asked,
    generate: async (_system, user) => {
      asked.push(user);
      if (user.startsWith("Message: ")) return { text: typeof parts === "string" ? parts : JSON.stringify({ parts }), model: "f", ms: 1 };
      const req = user.split("Request: ").pop() ?? "";
      const skill = routes.find(([re]) => re.test(req))?.[1] ?? "unsupported";
      return { text: JSON.stringify({ skill, args: {} }), model: "f", ms: 1 };
    },
  };
};

describe("model-based splitting", () => {
  it("is asked only when something joins two clauses", async () => {
    const ctx = seededCtx();
    const llm = fake(["x"]);
    expect(await modelSplit(ctx, "what's on tomorrow", llm)).toBeNull();
    expect(llm.asked).toHaveLength(0);
  });

  it("takes two parts in the user's words, refuses parts the model made up, and reads 'one'", async () => {
    const ctx = seededCtx();
    const text = "what's on tomorrow and remind me to buy milk";
    expect(await modelSplit(ctx, text, fake(["what's on tomorrow", "remind me to buy milk"]))).toEqual(["what's on tomorrow", "remind me to buy milk"]);
    expect(await modelSplit(ctx, text, fake(["what's on tomorrow", "transfer 500 euros to my landlord now"]))).toBeNull();
    expect(await modelSplit(ctx, text, fake([text]))).toBe("one");
    expect(await modelSplit(ctx, text, fake("garbage"))).toBeNull();
    expect(ownWords("email Ana to confirm", "add lunch with Ana on thursday and email her to confirm")).toBe(true);
  });

  it("when on, the model's split drives the request; when it says one, the wording rules don't split", async () => {
    const ctx = seededCtx();
    setSetting(ctx.db, "assistant.selfcheck", "off");
    setSetting(ctx.db, "assistant.modelsplit", "on");
    const two = await runCommand(ctx, "is the afternoon looking busy and remind me to buy milk", workflows, fake(["is the afternoon looking busy", "remind me to buy milk"], [[/busy/, "agenda"]]));
    expect(two.understood).toMatch(/two requests/);
    const one = await runCommand(ctx, "is the afternoon looking busy and remind me to buy milk", workflows, fake(["is the afternoon looking busy and remind me to buy milk"], [[/busy/, "agenda"]]));
    expect(one.understood ?? "").not.toMatch(/two requests/);
  });
});

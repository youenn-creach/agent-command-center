import { describe, expect, it } from "vitest";
import { LIBRARY, similarExamples } from "@/server/agents/examples";
import { routeRequest, SKILLS } from "@/server/agents/assistant";
import { setSetting } from "@/server/db";
import type { LlmProvider } from "@/server/llm";
import { EVALSET } from "../scripts/evalset/v1";
import { EVALSET_V2 } from "../scripts/evalset/v2";
import { CASES } from "../scripts/eval-cases";
import { seededCtx } from "./helpers";

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

describe("the example library", () => {
  it("never contains a request of the evaluation sets (v1, v2) or of the routing eval (the measurements would lie)", () => {
    const lib = new Set(LIBRARY.map(([q]) => norm(q)));
    const clash = [...EVALSET.map((i) => i.text), ...EVALSET_V2.map((i) => i.text), ...CASES.map(([q]) => q)].filter((q) => lib.has(norm(q)));
    expect(clash).toEqual([]);
  });

  it("labels every request with a real skill", () => {
    for (const [, r] of LIBRARY) expect(Object.keys(SKILLS)).toContain(r.split(" ")[0]);
  });

  it("finds requests of the same kind, whoever they are about", () => {
    expect(similarExamples("chase Ana about the invoice", 3, ["ana"])[0][1]).toMatch(/^nudge /);
    expect(similarExamples("let Sofia know friday is fine", 3, ["sofia"]).map(([, r]) => r.split(" ")[0])).toContain("draft_reply");
    expect(similarExamples("what's on thursday evening", 3).map(([, r]) => r.split(" ")[0])).toContain("agenda");
    expect(similarExamples("zzz qqq")).toEqual([]);
  });

  it("goes to the router after its fixed instructions, unless switched off", async () => {
    const ctx = seededCtx();
    setSetting(ctx.db, "assistant.examples", "off");
    const seen: string[] = [];
    const llm: LlmProvider = { id: "x", label: "x", generate: async (_s, user) => (seen.push(user), { text: '{"skill":"nudge","args":{"who":"Ana"}}', model: "x", ms: 1 }) };
    await routeRequest(ctx, "chase Ana about the invoice", llm, ["Ana"]);
    expect(seen[0]).toBe("Request: chase Ana about the invoice");
    setSetting(ctx.db, "assistant.examples", "");
    await routeRequest(ctx, "chase Ana about the invoice", llm, ["Ana"]);
    expect(seen[1]).toMatch(/^Similar requests and how they were routed:\n"[^"]+" -> nudge /);
    expect(seen[1]).toMatch(/\n\nRequest: chase Ana about the invoice$/);
  });

  it("restating the goal first is asked for only when switched on, and the goal never changes the route", async () => {
    const ctx = seededCtx();
    const calls: { system: string; format: unknown }[] = [];
    const llm: LlmProvider = { id: "x", label: "x", generate: async (system, _u, o) => (calls.push({ system, format: o?.format }), { text: '{"goal":"get Ana to answer","skill":"nudge","args":{"who":"Ana"}}', model: "x", ms: 1 }) };
    expect((await routeRequest(ctx, "chase Ana", llm)).skill).toBe("nudge");
    expect(calls[0].system).not.toMatch(/"goal"/);
    setSetting(ctx.db, "assistant.restate", "on");
    const r = await routeRequest(ctx, "chase Ana", llm);
    expect(r).toMatchObject({ skill: "nudge", args: { who: "Ana" } });
    expect(calls[1].system).toMatch(/\{"goal": /);
    expect((calls[1].format as { required: string[] }).required).toEqual(["goal", "skill", "args"]);
  });

  it("evaluation set v2 is new: no request of v1 again, unique ids", () => {
    const v1 = new Set(EVALSET.map((i) => norm(i.text)));
    expect(EVALSET_V2.filter((i) => v1.has(norm(i.text))).map((i) => i.text)).toEqual([]);
    expect(new Set(EVALSET_V2.map((i) => i.id)).size).toBe(EVALSET_V2.length);
    expect(EVALSET_V2).toHaveLength(60);
  });
});

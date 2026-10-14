import { describe, expect, it } from "vitest";
import { reciprocalRankFusion, retrieve, streamAnswer, type AnswerEvent } from "@/server/retrieval/knowledge";
import type { LlmProvider } from "@/server/llm";
import { seededCtx, failingLlm } from "./helpers";

function streamingLlm(tokens: string[]): LlmProvider {
  return {
    id: "stub",
    label: "stub",
    model: "stub-model",
    async generate() {
      return { text: tokens.join(""), model: "stub-model", ms: 1 };
    },
    async *stream() {
      for (const t of tokens) yield t;
    },
  };
}

async function collect(gen: AsyncGenerator<AnswerEvent>) {
  const out: AnswerEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe("streamed grounded answers", () => {
  it("yields tokens, then stores the full answer on the retrieval run", async () => {
    const ctx = seededCtx();
    const r = await retrieve(ctx, { query: "sourdough starter feeding", provider: "lexical" });
    const events = await collect(streamAnswer(ctx, r.id, undefined, streamingLlm(["Once ", "a week ", "[1]."])));
    expect(events.filter((e) => e.type === "token").map((e) => (e as { text: string }).text)).toEqual(["Once ", "a week ", "[1]."]);
    const done = events.at(-1) as Extract<AnswerEvent, { type: "done" }>;
    expect(done.result.answer).toMatchObject({ text: "Once a week [1].", method: "llm", model: "stub-model" });
    const again = await collect(streamAnswer(ctx, r.id, undefined, streamingLlm([])));
    expect(again.at(-1)?.type).toBe("done");
  });

  it("falls back to an extractive answer when the model is unavailable", async () => {
    const ctx = seededCtx();
    const r = await retrieve(ctx, { query: "sourdough starter feeding", provider: "lexical" });
    const events = await collect(streamAnswer(ctx, r.id, undefined, failingLlm));
    const done = events.at(-1) as Extract<AnswerEvent, { type: "done" }>;
    expect(done.result.answer?.method).toBe("extractive");
  });
});


describe("reciprocal rank fusion", () => {
  it("rewards items ranked well in both lists and records each rank", () => {
    const fused = reciprocalRankFusion([
      ["a", "b", "c"],
      ["c", "a", "d"],
    ]);
    expect(fused.map((f) => f.id)).toEqual(["a", "c", "b", "d"]);
    expect(fused[0].ranks).toEqual([1, 2]);
    expect(fused.find((f) => f.id === "d")!.ranks).toEqual([undefined, 3]);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { all } from "@/server/db";
import { ollamaProvider, LlmOffloadedError } from "@/server/llm";
import { activeLlmCalls, beginLlmCall, offloadModels, offloadPending } from "@/server/llmRuntime";
import { seededCtx } from "./helpers";

/**
 * A fake Ollama: /api/ps reports one loaded model, keep_alive:0 requests are recorded as unloads,
 * and /api/chat hangs until its request is aborted. No real Ollama is ever contacted.
 */
let unloads: string[];
beforeEach(() => {
  unloads = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: URL | string, init?: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/api/ps") return Response.json({ models: [{ name: "gemma3:1b" }] });
      if (path === "/api/generate") {
        unloads.push(JSON.parse(String(init?.body)).model);
        return Response.json({});
      }
      if (path === "/api/chat") {
        return new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      }
      throw new Error(`unexpected ${path}`);
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const offloadLog = (ctx: ReturnType<typeof seededCtx>) => all<{ summary: string }>(ctx.db, "SELECT summary FROM activity WHERE summary LIKE '%ffload%'").map((r) => r.summary);

describe("local model offload", () => {
  it("tracks running calls so the dashboard can show the model thinking", async () => {
    const ctx = seededCtx();
    const call = beginLlmCall(ctx, "gemma3:1b", "interactive");
    expect(activeLlmCalls(ctx)).toMatchObject([{ model: "gemma3:1b", task: "interactive" }]);
    await call.end();
    expect(activeLlmCalls(ctx)).toEqual([]);
  });

  it("unloads straight away when nothing is running", async () => {
    const ctx = seededCtx();
    expect(await offloadModels(ctx, "when-idle")).toEqual({ unloaded: ["gemma3:1b"], waitingFor: 0 });
    expect(unloads).toEqual(["gemma3:1b"]);
  });

  it("'when idle' waits for the running task, then unloads", async () => {
    const ctx = seededCtx();
    const call = beginLlmCall(ctx, "gemma3:1b", "background");
    expect(await offloadModels(ctx, "when-idle")).toEqual({ unloaded: [], waitingFor: 1 });
    expect(offloadPending(ctx)).toBe(true);
    expect(call.signal.aborted).toBe(false); // the running task is left alone
    expect(unloads).toEqual([]);
    await call.end();
    expect(unloads).toEqual(["gemma3:1b"]);
    expect(offloadPending(ctx)).toBe(false);
    expect(offloadLog(ctx).at(-1)).toMatch(/after the running task finished/);
  });

  it("'now' cancels a running generation; the caller gets a clear fallback error and the call is cleaned up", async () => {
    const ctx = seededCtx();
    const llm = ollamaProvider("gemma3:1b", ctx, "background");
    const pending = llm.generate("system", "user").catch((e: unknown) => e);
    await vi.waitFor(() => expect(activeLlmCalls(ctx)).toHaveLength(1));
    const result = await offloadModels(ctx, "now");
    const err = await pending;
    expect(err).toBeInstanceOf(LlmOffloadedError);
    expect((err as { code: string }).code).toBe("LLM_UNAVAILABLE"); // same code callers already fall back on
    expect(activeLlmCalls(ctx)).toEqual([]);
    expect(result.unloaded).toEqual(["gemma3:1b"]);
    expect(offloadLog(ctx).at(-1)).toMatch(/immediately/);
  });

  it("a call started after 'offload now' is not cancelled by it", async () => {
    const ctx = seededCtx();
    await offloadModels(ctx, "now");
    await new Promise((r) => setTimeout(r, 5));
    const call = beginLlmCall(ctx, "gemma3:1b", "background");
    await new Promise((r) => setTimeout(r, 700)); // longer than the 500 ms poll
    expect(call.signal.aborted).toBe(false);
    await call.end();
  });
});

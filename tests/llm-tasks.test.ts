import { describe, expect, it } from "vitest";
import { setSetting } from "@/server/db";
import { localLlm, selectedModel } from "@/server/llm";
import { config } from "@/server/config";
import { seededCtx } from "./helpers";

describe("per-task model choice", () => {
  it("falls back to the configured default, then to the pre-split single choice", () => {
    const ctx = seededCtx();
    expect(selectedModel(ctx, "background")).toBe(config().OLLAMA_CHAT_MODEL);
    setSetting(ctx.db, "llm.model", "gemma3:1b"); // a choice made before the split
    expect(selectedModel(ctx, "background")).toBe("gemma3:1b");
    expect(selectedModel(ctx, "interactive")).toBe("gemma3:1b");
  });

  it("each task uses its own model once chosen", () => {
    const ctx = seededCtx();
    setSetting(ctx.db, "llm.model.background", "ministral-3:3b");
    setSetting(ctx.db, "llm.model.interactive", "gemma3:1b");
    expect(localLlm(ctx, "background").model).toBe("ministral-3:3b");
    expect(localLlm(ctx, "interactive").model).toBe("gemma3:1b");
    expect(localLlm(ctx).model).toBe("ministral-3:3b"); // default task is background
  });
});

describe("thinking models", () => {
  it("turns Qwen3's thinking off, and leaves other models alone", async () => {
    const { thinkingOff } = await import("@/server/llm");
    expect(thinkingOff("qwen3:4b")).toEqual({ think: false });
    expect(thinkingOff("richardyoung/qwen3-14b-abliterated:q4_K_M")).toEqual({ think: false });
    expect(thinkingOff("ministral-3:3b")).toEqual({});
    expect(thinkingOff("hf.co/mradermacher/salamandra-7b-instruct-2606-i1-GGUF:i1-IQ4_XS")).toEqual({});
  });
});

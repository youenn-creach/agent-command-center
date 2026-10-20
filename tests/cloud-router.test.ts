import { afterEach, describe, expect, it, vi } from "vitest";
import { all, setSetting } from "@/server/db";
import { reloadConfig } from "@/server/config";
import { cloudRouter, cloudRouterStatus, setCloudRouter } from "@/server/cloudRouter";
import { runCommand } from "@/server/agents/command";
import { workflows } from "@/server/agents/chiefOfStaff";
import { seededCtx } from "./helpers";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  reloadConfig();
});

const KEY = "test-key-abc123";
const mistral = (status: number, content = '{"skill":"agenda","args":{}}') => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return status === 200 ? Response.json({ choices: [{ message: { content } }] }) : new Response("{}", { status });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
};

describe("cloud help for understanding requests (Mistral API, free tier only)", () => {
  it("is off by default and does nothing without a key", () => {
    const ctx = seededCtx();
    expect(cloudRouterStatus(ctx)).toMatchObject({ enabled: false, hasKey: false, blocked: "no API key saved" });
    expect(cloudRouter(ctx)).toBeNull();
  });

  it("keeps the key sealed: never stored in clear, never returned", () => {
    const ctx = seededCtx();
    const status = setCloudRouter(ctx, { key: KEY, enabled: true });
    expect(JSON.stringify(status)).not.toContain(KEY);
    const raw = all<{ key: string; value: string }>(ctx.db, "SELECT key, value FROM settings WHERE key LIKE 'cloud.%'");
    expect(JSON.stringify(raw)).not.toContain(KEY);
    expect(raw.find((r) => r.key === "cloud.router.key")?.value).toBeTruthy();
  });

  it("sends only the request and the skill prompt, with the key as a bearer token, and counts the day's use", async () => {
    const ctx = seededCtx();
    setCloudRouter(ctx, { key: KEY, enabled: true });
    const m = mistral(200);
    const out = await cloudRouter(ctx, m.fetcher)!.generate("SKILLS…", "Request: what's on tomorrow", { format: { type: "object" }, temperature: 0 });
    expect(out).toMatchObject({ text: '{"skill":"agenda","args":{}}', model: "mistral-api:mistral-small-latest" });
    expect(m.calls[0].url).toBe("https://api.mistral.ai/v1/chat/completions");
    expect((m.calls[0].init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(String(m.calls[0].init.body));
    expect(body.messages).toEqual([
      { role: "system", content: "SKILLS…" },
      { role: "user", content: "Request: what's on tomorrow" },
    ]);
    expect(body.response_format.type).toBe("json_schema");
    expect(cloudRouterStatus(ctx).usedToday).toBe(1);
  });

  it("pauses until tomorrow on a rate-limit, quota or payment answer, and stops at the daily cap", async () => {
    const ctx = seededCtx();
    setCloudRouter(ctx, { key: KEY, enabled: true });
    await expect(cloudRouter(ctx, mistral(429).fetcher)!.generate("s", "u")).rejects.toThrow(/429/);
    expect(cloudRouterStatus(ctx).blocked).toMatch(/paused until tomorrow/);
    expect(cloudRouter(ctx)).toBeNull();
    const ctx2 = seededCtx();
    setCloudRouter(ctx2, { key: KEY, enabled: true });
    setSetting(ctx2.db, "cloud.router.cap", "1");
    await cloudRouter(ctx2, mistral(200).fetcher)!.generate("s", "u");
    expect(cloudRouter(ctx2)).toBeNull();
    expect(cloudRouterStatus(ctx2).blocked).toMatch(/limit of 1/);
  });

  it("is never used in the demo instance", () => {
    vi.stubEnv("ACC_MODE", "demo");
    reloadConfig();
    const ctx = seededCtx();
    setCloudRouter(ctx, { key: KEY, enabled: true });
    expect(cloudRouter(ctx)).toBeNull();
  });

  it("routes a request through the cloud when on, and falls back to the local model when the cloud fails", async () => {
    const ctx = seededCtx();
    setCloudRouter(ctx, { key: KEY, enabled: true });
    setSetting(ctx.db, "assistant.selfcheck", "off");
    vi.stubGlobal("fetch", mistral(200, '{"skill":"agenda","args":{}}').fetcher);
    const r = await runCommand(ctx, "is the afternoon looking busy", workflows);
    expect(r.understood).toMatch(/mistral-api:mistral-small-latest/);
    expect(r.intent).toBe("agenda");
    vi.stubGlobal("fetch", mistral(500).fetcher); // the cloud fails, and so does the (absent) local model: the keyword fallback answers
    const r2 = await runCommand(ctx, "is the evening looking busy", workflows);
    expect(r2.understood).not.toMatch(/mistral-api/);
  });
});

import { draftLlmFor, workLlm } from "@/server/llm";
import { cloudWorker } from "@/server/cloudRouter";
import { warmRouter } from "@/server/agents/assistant";
import { dashboardState } from "@/server/state";

/** A fake network: Mistral answers with `status`, the local Ollama answers "local answer". */
const network = (status: number) => {
  const calls: string[] = [];
  vi.stubGlobal("fetch", (async (url: string | URL) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("api.mistral.ai")) return status === 200 ? Response.json({ choices: [{ message: { content: "cloud answer" } }] }) : new Response("{}", { status });
    if (u.includes("/api/ps")) return Response.json({ models: [] });
    return Response.json({ message: { content: "local answer" }, done: true });
  }) as unknown as typeof fetch);
  return calls;
};

describe("doing the work in the cloud (Mistral API, free tier only, off by default)", () => {
  it("is off by default: the work is local, even with a key saved", () => {
    const ctx = seededCtx();
    expect(cloudRouterStatus(ctx).work).toEqual({ enabled: false, model: "mistral-medium-latest" });
    setCloudRouter(ctx, { key: KEY });
    expect(cloudWorker(ctx)).toBeNull();
    expect(workLlm(ctx).id).toBe("ollama");
  });

  it("on: Mistral's model writes, with the local model behind it; the request wording goes to Mistral too", async () => {
    const ctx = seededCtx();
    setCloudRouter(ctx, { key: KEY, work: true, workModel: "mistral-large-latest" });
    const calls = network(200);
    const llm = workLlm(ctx);
    expect(llm.id).toBe("mistral-api");
    expect(llm.model).toBe("mistral-large-latest");
    const out = await llm.generate("system", "an email to summarize");
    expect(out.text).toBe("cloud answer");
    expect(calls.filter((u) => u.includes("api.mistral.ai"))).toHaveLength(1);
    expect(cloudRouterStatus(ctx).usedToday).toBe(1);
    // Understanding requests follows: the router uses the cloud too, with the work model when only "work" is on.
    expect(cloudRouter(ctx)?.model).toBe("mistral-large-latest");
  });

  it("a refused call falls back to the local model and pauses the cloud until tomorrow", async () => {
    const ctx = seededCtx();
    setCloudRouter(ctx, { key: KEY, work: true });
    network(429);
    const out = await workLlm(ctx).generate("system", "user");
    expect(out.text).toBe("local answer");
    expect(cloudRouterStatus(ctx).blocked).toMatch(/paused until tomorrow/);
    expect(workLlm(ctx).id).toBe("ollama");
  });

  it("the daily cap holds inside one task: once reached, the same provider answers locally", async () => {
    const ctx = seededCtx();
    setCloudRouter(ctx, { key: KEY, work: true });
    setSetting(ctx.db, "cloud.router.cap", "2");
    network(200);
    const llm = workLlm(ctx);
    const texts = [];
    for (let i = 0; i < 3; i++) texts.push((await llm.generate("s", "u")).text);
    expect(texts).toEqual(["cloud answer", "cloud answer", "local answer"]);
  });

  it("never in the demo instance; never without a key; removing the key turns both switches off", () => {
    vi.stubEnv("ACC_MODE", "demo");
    reloadConfig();
    const demo = seededCtx();
    setCloudRouter(demo, { key: KEY, work: true });
    expect(cloudWorker(demo)).toBeNull();
    vi.unstubAllEnvs();
    reloadConfig();
    const ctx = seededCtx();
    setCloudRouter(ctx, { key: KEY, work: true, enabled: true });
    const off = setCloudRouter(ctx, { key: "" });
    expect(off).toMatchObject({ enabled: false, hasKey: false, work: { enabled: false } });
  });

  it("drafts in any language stay with the cloud model (no local per-language model swap)", () => {
    const ctx = seededCtx();
    setCloudRouter(ctx, { key: KEY, work: true });
    setSetting(ctx.db, "llm.model.lang.fr", "gemma3:4b");
    expect(draftLlmFor(ctx, "fr", workLlm(ctx)).id).toBe("mistral-api");
    setCloudRouter(ctx, { work: false });
    expect(draftLlmFor(ctx, "fr", workLlm(ctx)).model).toBe("gemma3:4b");
  });

  it("doesn't load the local model into memory on Ctrl+K while the cloud does the work", () => {
    const ctx = seededCtx();
    setCloudRouter(ctx, { key: KEY, work: true });
    expect(warmRouter(ctx, false)).toEqual({ warming: false });
  });

  it("the dashboard shows the switch's state, never the key", async () => {
    const ctx = seededCtx();
    setCloudRouter(ctx, { key: KEY, work: true });
    network(200);
    const state = await dashboardState(ctx);
    expect(state.cloudRouter.work.enabled).toBe(true);
    expect(JSON.stringify(state)).not.toContain(KEY);
  });
});

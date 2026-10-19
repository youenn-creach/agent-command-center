import { randomUUID } from "node:crypto";
import { all, getSetting, run, setSetting, type Ctx } from "./db";
import { logActivity } from "./activity";
import { config } from "./config";

/**
 * Local-model activity, shared by the web server and the worker through SQLite:
 *  - every Ollama call registers itself while it runs, so the dashboard can show "thinking";
 *  - Settings can offload models from RAM, either now (running calls are cancelled and their
 *    callers fall back to their non-LLM output) or once the running calls have finished.
 */

export interface LlmCall {
  id: string;
  model: string;
  task: string;
  startedAt: string;
  pid: number;
}

/** Longer than any call's own timeout (4 min max), so a crashed process can't leave "thinking" on forever. */
const STALE_MS = 5 * 60_000;
const OFFLOAD_NOW = "llm.offload.now";
const OFFLOAD_PENDING = "llm.offload.pending";

export function activeLlmCalls(ctx: Ctx): LlmCall[] {
  const now = Date.now();
  const calls: LlmCall[] = [];
  for (const row of all<{ key: string; value: string }>(ctx.db, "SELECT key, value FROM settings WHERE key LIKE 'llm.call.%'")) {
    let call: LlmCall | null = null;
    try {
      call = JSON.parse(row.value) as LlmCall;
    } catch {
      // A damaged row (an interrupted write) must not break every dashboard refresh: drop it.
    }
    const started = call ? Date.parse(call.startedAt) : NaN;
    if (!call || !Number.isFinite(started) || now - started > STALE_MS) run(ctx.db, "DELETE FROM settings WHERE key = ?", row.key);
    else calls.push(call);
  }
  return calls;
}

/**
 * Registers a call. The returned signal aborts if someone chooses "Offload now" while it runs;
 * `end()` must be called when the call settles (it also completes a pending "offload when idle").
 */
export function beginLlmCall(ctx: Ctx, model: string, task: string) {
  const call: LlmCall = { id: randomUUID(), model, task, startedAt: new Date().toISOString(), pid: process.pid };
  const key = `llm.call.${call.id}`;
  setSetting(ctx.db, key, JSON.stringify(call));
  const controller = new AbortController();
  // The other process may request the offload, so poll the shared flag (cheap: one indexed read).
  const poll = setInterval(() => {
    const at = getSetting(ctx.db, OFFLOAD_NOW);
    if (at && at > call.startedAt) controller.abort();
  }, 500);
  poll.unref();
  let ended = false;
  return {
    signal: controller.signal,
    async end() {
      if (ended) return;
      ended = true;
      clearInterval(poll);
      run(ctx.db, "DELETE FROM settings WHERE key = ?", key);
      await finishPendingOffload(ctx);
    },
  };
}

/** Asks Ollama to free a model's memory now (keep_alive: 0). Best-effort. */
export async function unloadModel(model: string) {
  try {
    await fetch(new URL("/api/generate", config().OLLAMA_URL), {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({ model, keep_alive: 0 }),
    });
  } catch {
    // Ollama not running: nothing is loaded anyway
  }
}

/** Asks Ollama to free every model it holds. Best-effort; returns the names it unloaded. */
export async function unloadAllModels(): Promise<string[]> {
  try {
    const res = await fetch(new URL("/api/ps", config().OLLAMA_URL), { signal: AbortSignal.timeout(3_000) });
    const { models = [] } = (await res.json()) as { models?: { name: string }[] };
    await Promise.all(models.map((m) => unloadModel(m.name)));
    return models.map((m) => m.name);
  } catch {
    return []; // Ollama not running: nothing is loaded
  }
}

async function unloadEverything(ctx: Ctx, how: string) {
  run(ctx.db, "DELETE FROM settings WHERE key = ?", OFFLOAD_PENDING);
  const names = await unloadAllModels();
  const { unloadNanoModel } = await import("./retrieval/embeddings");
  const nano = await unloadNanoModel();
  const freed = [...names, ...(nano ? ["voyage-4-nano"] : [])];
  logActivity(ctx, { actor: "user", kind: "system", outcome: "info", summary: freed.length ? `Offloaded ${freed.join(", ")} from memory (${how})` : `Offload requested (${how}): no model was loaded` });
  return freed;
}

/** Completes a pending "offload when idle" (also called from the dashboard state, in case a caller crashed). */
export async function finishPendingOffload(ctx: Ctx) {
  if (getSetting(ctx.db, OFFLOAD_PENDING) !== "1" || activeLlmCalls(ctx).length) return;
  await unloadEverything(ctx, "after the running task finished");
}

export function offloadPending(ctx: Ctx) {
  return getSetting(ctx.db, OFFLOAD_PENDING) === "1";
}

/**
 * "now": cancel running calls (their callers fall back), then unload.
 * "when-idle": unload immediately if nothing runs; otherwise when the last running call ends.
 */
export async function offloadModels(ctx: Ctx, mode: "now" | "when-idle"): Promise<{ unloaded: string[]; waitingFor: number }> {
  if (mode === "now") {
    setSetting(ctx.db, OFFLOAD_NOW, new Date().toISOString());
    // Give cancelled calls (possibly in the worker) a moment to stop before unloading.
    for (let i = 0; i < 10 && activeLlmCalls(ctx).length; i++) await new Promise((r) => setTimeout(r, 300));
    return { unloaded: await unloadEverything(ctx, "immediately"), waitingFor: 0 };
  }
  const running = activeLlmCalls(ctx).length;
  if (running === 0) return { unloaded: await unloadEverything(ctx, "nothing was running"), waitingFor: 0 };
  setSetting(ctx.db, OFFLOAD_PENDING, "1");
  logActivity(ctx, { actor: "user", kind: "system", outcome: "info", summary: `Models will be offloaded when ${running} running task(s) finish` });
  return { unloaded: [], waitingFor: running };
}

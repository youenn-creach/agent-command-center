import { afterEach, describe, expect, it, vi } from "vitest";
import { all, one } from "@/server/db";
import { cancelRequest, runInBackground, type CommandResult } from "@/server/agents/command";
import { recordRequest } from "@/server/requests";
import { addReminder } from "@/server/reminders";
import { requestSignal, runInRequestScope, RequestCancelledError } from "@/server/requestScope";
import { ollamaProvider } from "@/server/llm";
import { seededCtx } from "./helpers";

afterEach(() => vi.unstubAllGlobals());

const status = (ctx: ReturnType<typeof seededCtx>, id: string) => one<{ status: string; reply: string }>(ctx.db, "SELECT status, reply FROM requests WHERE id = ?", id)!;
const until = async (check: () => boolean) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 10));
};

/** A background request whose work waits for its model "call" until the request is cancelled (or `release` is called). */
function slowRequest(ctx: ReturnType<typeof seededCtx>, text: string) {
  let started = false;
  let release = () => {};
  const work: NonNullable<CommandResult["background"]> = async () => {
    started = true;
    await new Promise<void>((resolve, reject) => {
      release = resolve;
      requestSignal()?.addEventListener("abort", () => reject(new Error("model call aborted")), { once: true });
    });
    return { reply: `answer to ${text}` };
  };
  const id = recordRequest(ctx, text, { intent: "email_question", reply: "Looking…", background: work })!;
  runInBackground(ctx, id, text, work);
  return { id, started: () => started, release: () => release() };
}

describe("cancelling a request to the Chief of Staff", () => {
  it("a running request: the board says Cancelled at once, its model call stops, and the next request starts", async () => {
    const ctx = seededCtx();
    const first = slowRequest(ctx, "first question");
    const second = slowRequest(ctx, "second question");
    await until(first.started);
    expect(status(ctx, first.id).status).toBe("working");
    expect(cancelRequest(ctx, first.id)).toEqual({ ok: true });
    expect(status(ctx, first.id)).toEqual({ status: "cancelled", reply: "Cancelled by you." });
    await until(second.started);
    expect(second.started()).toBe(true);
    second.release();
    await until(() => status(ctx, second.id).status === "done");
    expect(status(ctx, second.id).status).toBe("done");
    // The cancelled one never turns into "done" or "failed" later.
    expect(status(ctx, first.id).status).toBe("cancelled");
    expect(all<{ summary: string }>(ctx.db, "SELECT summary FROM activity WHERE summary LIKE 'Cancelled a request%'")).toHaveLength(1);
  });

  it("a request still waiting its turn never starts", async () => {
    const ctx = seededCtx();
    const first = slowRequest(ctx, "first");
    const queued = slowRequest(ctx, "queued");
    await until(first.started);
    cancelRequest(ctx, queued.id);
    first.release();
    await until(() => status(ctx, first.id).status === "done");
    await new Promise((r) => setTimeout(r, 30));
    expect(queued.started()).toBe(false);
    expect(status(ctx, queued.id).status).toBe("cancelled");
  });

  it("a finished request can't be cancelled; an unknown one says so", async () => {
    const ctx = seededCtx();
    const r = slowRequest(ctx, "quick");
    await until(r.started);
    r.release();
    await until(() => status(ctx, r.id).status === "done");
    expect(() => cancelRequest(ctx, r.id)).toThrow(/already finished/);
    expect(() => cancelRequest(ctx, "req_nope")).toThrow(/no longer exists/);
  });

  it("a cancelled request creates nothing more: no reminder, no action", async () => {
    const ctx = seededCtx();
    const cancel = new AbortController();
    cancel.abort();
    await expect(runInRequestScope("req_x", cancel.signal, async () => addReminder(ctx, "buy milk"))).rejects.toBeInstanceOf(RequestCancelledError);
    expect(all(ctx.db, "SELECT 1 FROM reminders WHERE text = 'buy milk'")).toEqual([]);
    // Outside a cancelled request nothing changes.
    expect(() => addReminder(ctx, "buy milk")).not.toThrow();
  });

  it("the local model call itself gets the request's cancel signal", async () => {
    const ctx = seededCtx();
    let seen: AbortSignal | undefined;
    vi.stubGlobal("fetch", (async (url: string | URL, init?: RequestInit) => {
      if (String(url).includes("/api/ps")) return Response.json({ models: [] });
      seen = init?.signal ?? undefined;
      return Response.json({ message: { content: "ok" }, done: true });
    }) as unknown as typeof fetch);
    const cancel = new AbortController();
    await runInRequestScope("req_y", cancel.signal, () => ollamaProvider("m", ctx).generate("s", "u"));
    expect(seen).toBeDefined();
    cancel.abort();
    expect(seen!.aborted).toBe(true);
  });
});

import { runCommand } from "@/server/agents/command";
import { workflows } from "@/server/agents/chiefOfStaff";
describe("cancelling while the request is being understood", () => {
  it("the model call stops, nothing is guessed from keywords, nothing is run or recorded", async () => {
    const ctx = seededCtx();
    const llm = {
      id: "stub",
      label: "stub",
      generate: () => new Promise<never>((_, reject) => requestSignal()?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })),
    };
    const cancel = new AbortController();
    const pending = runInRequestScope("understanding", cancel.signal, () => runCommand(ctx, "what bills do I have coming up", workflows, llm));
    setTimeout(() => cancel.abort(), 20);
    await expect(pending).rejects.toBeInstanceOf(RequestCancelledError);
    expect(all(ctx.db, "SELECT 1 FROM requests")).toEqual([]);
  });
});

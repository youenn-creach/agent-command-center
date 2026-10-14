import { openDb, all, type Ctx } from "@/server/db";
import { resetDemo } from "@/server/seed/seed";
import type { LlmProvider } from "@/server/llm";
import { setRetryDelay } from "@/server/scheduler/scheduler";
import { setNotifyDeps } from "@/server/notify";

// No real waiting between retries in tests.
setRetryDelay(() => 0);
// Never show a real desktop notification or push to a phone from a test.
setNotifyDeps({ desktop: async () => {}, push: async () => 200 });

export function makeCtx(start = new Date("2026-10-12T10:00:00Z"), file = ":memory:"): Ctx & { setNow(d: Date): void } {
  let now = start;
  const ctx = {
    db: openDb(file),
    now: () => now,
    setNow(d: Date) {
      now = d;
    },
  };
  return ctx;
}

export function seededCtx(start?: Date) {
  const ctx = makeCtx(start);
  resetDemo(ctx);
  return ctx;
}

export function permissionSnapshot(ctx: Ctx) {
  return {
    services: all(ctx.db, "SELECT id, connection_state, access_level FROM services ORDER BY id"),
    grants: all(ctx.db, "SELECT * FROM agent_permissions ORDER BY agent_id, service_id"),
  };
}

/** An LLM stub. `reply` lets a test simulate a model that has been "convinced" by injected text. */
export function stubLlm(reply = "Stub answer [1]"): LlmProvider & { calls: { system: string; user: string }[] } {
  const calls: { system: string; user: string }[] = [];
  return {
    id: "stub",
    label: "stub",
    calls,
    async generate(system, user) {
      calls.push({ system, user });
      return { text: reply, model: "stub", ms: 1 };
    },
  };
}

export const failingLlm: LlmProvider = {
  id: "down",
  label: "down",
  async generate() {
    throw new Error("connection refused");
  },
};

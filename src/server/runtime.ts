import { openDb, type Ctx } from "./db";
import { config } from "./config";
import { isSeeded, resetDemo } from "./seed/seed";
import { enforceAgentProfiles } from "./policy/permissions";

/** One database handle per server process (survives Next.js dev hot reloads). */
const globalForCtx = globalThis as unknown as { __accCtx?: Ctx };

export function getCtx(): Ctx {
  if (!globalForCtx.__accCtx) {
    config(); // validate configuration at startup; throws with a clear message if invalid
    const ctx: Ctx = { db: openDb(), now: () => new Date() };
    if (!isSeeded(ctx)) resetDemo(ctx);
    enforceAgentProfiles(ctx);
    globalForCtx.__accCtx = ctx;
  }
  return globalForCtx.__accCtx;
}

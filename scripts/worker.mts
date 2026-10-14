import "./_env.mts";
import { openDb, setSetting } from "@/server/db";
import { config } from "@/server/config";
import { tick } from "@/server/scheduler/scheduler";
import { workflows } from "@/server/agents/chiefOfStaff";
import { isSeeded, resetDemo } from "@/server/seed/seed";
import { pruneOldData } from "@/server/retention";

/**
 * The scheduler worker. Run it alongside the web app (`npm run worker`) — or on its own: schedules
 * fire whether or not a browser is open. It wakes every 30 s, does one bounded pass, and sleeps.
 * Safe to run more than one by accident: run claims are unique per (job, slot).
 */

const INTERVAL_MS = 30_000;
config();
const ctx = { db: openDb(), now: () => new Date() };
if (!isSeeded(ctx)) resetDemo(ctx);

let stopping = false;
let lastPrune = 0;
let timer: NodeJS.Timeout | undefined;

async function loop() {
  try {
    setSetting(ctx.db, "worker.heartbeat", new Date().toISOString());
    const runs = await tick(ctx, workflows);
    // Retention housekeeping, at most once an hour.
    if (Date.now() - lastPrune > 3_600_000) {
      lastPrune = Date.now();
      pruneOldData(ctx);
    }
    for (const r of runs) console.log(`[worker] ${new Date().toISOString()} ${r.job_id} → ${r.status}: ${r.message ?? ""}`);
  } catch (err) {
    console.error("[worker] tick failed:", err instanceof Error ? err.message : err);
  }
  if (!stopping) timer = setTimeout(loop, INTERVAL_MS);
}

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    stopping = true;
    clearTimeout(timer);
    console.log("[worker] stopped");
    process.exit(0);
  });
}

console.log(`[worker] scheduler running (every ${INTERVAL_MS / 1000}s, timezone default ${config().timezone}). Ctrl+C to stop.`);
void loop();

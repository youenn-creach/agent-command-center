import "./_env.mts";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { openDb } from "@/server/db";
import { quickRoute, routeRequest, type Skill } from "@/server/agents/assistant";
import { classify } from "@/server/agents/command";
import { CASES } from "./eval-cases";

/**
 * How well the Chief of Staff understands everyday requests, measured with the real local model:
 * each request must land on the right skill (some accept two). Run on a throwaway data folder:
 *   ACC_DATA_DIR=.e2e-data/eval-assistant npx tsx scripts/assistant-eval.mts
 * Requests that have an exact form ("add event: …") skip the model in the app and are marked as such.
 */



process.env.ACC_MODE = process.env.ACC_MODE ?? "mixed";
const ctx = { db: openDb(), now: () => new Date() };
type Row = { request: string; want: string; got: string; ok: boolean; ms: number; exact: boolean; args: string };
const rows: Row[] = [];
const EXACT = new Set(["draft", "event", "remember", "slots", "automation", "flights", "refused"]);
for (const [request, want] of CASES) {
  const wanted = Array.isArray(want) ? want : [want];
  const fast = classify(request);
  const quick = quickRoute(request);
  if (quick && !EXACT.has(fast.intent)) {
    rows.push({ request, want: wanted.join("|"), got: `${quick.skill} (quick rule)`, ok: wanted.includes(quick.skill), ms: 0, exact: true, args: JSON.stringify(quick.args) });
  } else if (EXACT.has(fast.intent)) {
    const mapped = { event: "add_event", flights: "add_flights", remember: "remember", slots: "propose_times", draft: "draft_reply" }[fast.intent as string] ?? fast.intent;
    rows.push({ request, want: wanted.join("|"), got: `${mapped} (exact command)`, ok: wanted.includes(mapped as Skill), ms: 0, exact: true, args: "" });
  } else {
    const t = Date.now();
    let got = "error";
    let args = "";
    try {
      const r = await routeRequest(ctx, request);
      got = r.skill;
      args = JSON.stringify(r.args);
    } catch (err) {
      got = `error: ${err instanceof Error ? err.message.slice(0, 60) : err}`;
    }
    rows.push({ request, want: wanted.join("|"), got, ok: wanted.includes(got as Skill), ms: Date.now() - t, exact: false, args });
  }
  const r = rows.at(-1)!;
  console.log(`${r.ok ? "ok " : "BAD"} ${String(r.ms).padStart(6)}ms  ${r.want.padEnd(28)} ${r.got.padEnd(28)} ${r.args.slice(0, 60)} | ${request.slice(0, 60)}`);
}
const routed = rows.filter((r) => !r.exact);
const ok = rows.filter((r) => r.ok).length;
const avg = Math.round(routed.reduce((s, r) => s + r.ms, 0) / Math.max(1, routed.length));
console.log(`\n${ok}/${rows.length} understood correctly (${Math.round((ok / rows.length) * 100)}%); ${routed.length} went through the local model, avg ${Math.round(avg / 1000)} s each.`);
const out = path.join(process.env.ACC_DATA_DIR ?? "data", "assistant-eval.json");
writeFileSync(out, JSON.stringify({ ranAt: new Date().toISOString(), ok, total: rows.length, avgMs: avg, rows }, null, 2));
console.log(`Saved to ${out}`);
process.exit(0);

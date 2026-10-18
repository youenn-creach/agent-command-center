import "./_env.mts";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { all, openDb, run, setSetting } from "@/server/db";
import { config } from "@/server/config";
import { resetDemo } from "@/server/seed/seed";
import { setNotifyDeps } from "@/server/notify";
import { runCommand } from "@/server/agents/command";
import { workflows } from "@/server/agents/chiefOfStaff";
import { routerModel, warmRouter } from "@/server/agents/assistant";
import { listRequests } from "@/server/requests";
import { setServiceLevel, setAgentLevel } from "@/server/policy/permissions";
import { listActions } from "@/server/approvals";
import { connectFakeGmail } from "./sim-gmail";
import { EVALSET } from "./evalset/v1";
import { EVALSET_V2 } from "./evalset/v2";
import { EVALSET_V3 } from "./evalset/v3";
import { EVALSET_V4 } from "./evalset/v4";
import { EVALSET_V5 } from "./evalset/v5";
import type { EvalItem, EvalResult } from "./evalset/types";

/**
 * Runs the fixed evaluation set through the real command path and the real local model, and grades every request
 * automatically (docs/ACCURACY_PLAN.md, phase A). Each request starts from freshly reset fictional data at the fixed
 * evaluation clock, so requests never influence each other and expectations never go stale.
 *
 *   EVAL_SPLIT=dev|test|all ACC_DATA_DIR=.e2e-data/eval-x OLLAMA_CHAT_MODEL=ministral-3:8b npx tsx scripts/eval-run.mts [first-last]
 * Optional: EVAL_SET=v2|v3|v4|v5 (later held-out sets; v5 is the newest), EVAL_SELFCHECK=on (off by default), EVAL_EXAMPLES=off (the example library is on by default), EVAL_RESTATE=on (goal restated before the skill), EVAL_MODELSPLIT=on (the model splits two-part requests), EVAL_OUT=<file.json>. Prints one line per request and a summary per category and failure kind.
 * Works with scripts/sim-supervisor.mts (it prints "#n [intent]" headers and resumes with a range).
 */
// Always the fictional data: never the personal mode a local .env.local may set for the real app.
process.env.ACC_MODE = "mixed";
setNotifyDeps({ desktop: async () => {}, push: async () => 200 });
// The clock restarts at the evaluation time for every request (see the loop): expectations like "in 2 hours" are written
// against 10:30, and a run lasts hours.
let started = Date.now();
const fixed = Date.parse(process.env.SIM_NOW ?? "2026-10-15T08:30:00Z");
const ctx = { db: openDb(path.join(process.env.ACC_DATA_DIR ?? ".e2e-data/eval", "acc.sqlite")), now: () => new Date(fixed + (Date.now() - started)) };
resetDemo(ctx);
await connectFakeGmail(ctx);
setServiceLevel(ctx, "web-search", "read");
setAgentLevel(ctx, "knowledge", "web-search", "read");
if (process.env.EVAL_SELFCHECK) setSetting(ctx.db, "assistant.selfcheck", process.env.EVAL_SELFCHECK);
if (process.env.EVAL_EXAMPLES) setSetting(ctx.db, "assistant.examples", process.env.EVAL_EXAMPLES);
if (process.env.EVAL_RESTATE === "on") setSetting(ctx.db, "assistant.restate", "on");
if (process.env.EVAL_MODELSPLIT === "on") setSetting(ctx.db, "assistant.modelsplit", "on");

const split = process.env.EVAL_SPLIT ?? "dev";
// EVAL_SET=v2 to v5: the later held-out sets (test only; v5 is the newest); v1 by default.
const items: EvalItem[] = (process.env.EVAL_SET === "v5" ? EVALSET_V5 : process.env.EVAL_SET === "v4" ? EVALSET_V4 : process.env.EVAL_SET === "v3" ? EVALSET_V3 : process.env.EVAL_SET === "v2" ? EVALSET_V2 : EVALSET).filter((i) => split === "all" || i.split === split);
const range = process.argv[2]?.match(/^(\d+)-(\d+)$/);
const picked = items.map((item, i) => ({ item, n: i + 1 })).filter((r) => !range || (r.n >= +range[1] && r.n <= +range[2]));

// Warm the router like the app does when Ctrl+K opens.
warmRouter(ctx, false);
for (let i = 0; i < 90; i++) {
  const loaded = await fetch(new URL("/api/ps", process.env.OLLAMA_URL ?? "http://127.0.0.1:11434")).then((r) => r.json() as Promise<{ models?: { name: string }[] }>).catch(() => ({ models: [] }));
  if (loaded.models?.some((m) => m.name === routerModel(ctx))) break;
  await new Promise((r) => setTimeout(r, 10_000));
}

const tz = config().timezone;
const local = (iso: string) => {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
};
const queue = () => (globalThis as { __accBackground?: { tail: Promise<void> } }).__accBackground?.tail ?? Promise.resolve();

const results: EvalResult[] = [];
for (const { item, n } of picked) {
  started = Date.now();
  resetDemo(ctx); // a clean fictional world for every request, at the evaluation clock
  // The request board too: every request starts at the same clock time, so "the newest entries" can't tell them apart.
  run(ctx.db, "DELETE FROM requests");
  const t = Date.now();
  const before = new Set(listActions(ctx).map((a) => a.id));
  let direct: Awaited<ReturnType<typeof runCommand>>;
  try {
    direct = await runCommand(ctx, item.text, workflows);
  } catch (err) {
    direct = { intent: "help", reply: `ERROR ${String(err).slice(0, 200)}` } as never;
  }
  await queue();
  const board = listRequests(ctx).find((r) => r.text === item.text);
  const answer = (board?.answer?.reply ?? direct.reply).replace(/\s+/g, " ");
  const shownItems = (board?.answer?.items ?? direct.items ?? []).map((i) => `${i.title}${i.detail ? ` — ${i.detail}` : ""}`);
  const actions = listActions(ctx).filter((a) => !before.has(a.id));
  const reminders = all<{ text: string; due_at: string | null }>(ctx.db, "SELECT text, due_at FROM reminders WHERE done_at IS NULL ORDER BY created_at");
  const event = direct.event ? [`EVENT ${direct.event.title} ${direct.event.start}${direct.event.location ? ` @ ${direct.event.location}` : ""}`] : [];
  const shown = [answer, ...shownItems, ...actions.map((a) => `ACTION ${a.title}`), ...reminders.map((r) => `REMINDER ${r.text}${r.due_at ? ` due ${local(r.due_at)}` : ""}`), ...event].join("\n");
  const asked = Boolean(direct.asked);

  const fails: string[] = [];
  if (asked) fails.push("asked");
  if (/^ERROR /.test(direct.reply)) fails.push("error");
  if (item.skills && !item.skills.includes(direct.intent)) fails.push(`understanding (${direct.intent}, wanted ${item.skills.join("|")})`);
  for (const re of item.must ?? []) if (!re.test(shown)) fails.push(`missing ${re}`);
  for (const re of item.never ?? []) if (re.test(shown)) fails.push(`forbidden ${re}`);
  if (item.reminders) {
    if (reminders.length !== item.reminders.count) fails.push(`reminders: ${reminders.length}, wanted ${item.reminders.count}`);
    else if (item.reminders.due && !(reminders[0]?.due_at && local(reminders[0].due_at).startsWith(item.reminders.due))) fails.push(`reminder due ${reminders[0]?.due_at ? local(reminders[0].due_at) : "none"}, wanted ${item.reminders.due}`);
    if (item.reminders.text && reminders[0] && !item.reminders.text.test(reminders[0].text)) fails.push(`reminder text “${reminders[0].text}”`);
  }
  if (item.actions === "none" && actions.length) fails.push(`actions: ${actions.length}, wanted none`);
  if (typeof item.actions === "number" && actions.length !== item.actions) fails.push(`actions: ${actions.length}, wanted ${item.actions}`);

  const r: EvalResult = { id: item.id, split: item.split, cat: item.cat, text: item.text, intent: direct.intent, asked, ms: Date.now() - t, shown: shown.slice(0, 1500), pass: fails.length === 0, fails };
  results.push(r);
  console.log(`#${n} [${direct.intent}] ${r.pass ? "PASS" : "FAIL"} ${Math.round(r.ms / 1000)}s ${item.id} | ${item.text}${r.pass ? "" : `\n   ✗ ${fails.join("; ")}\n   → ${shown.replace(/\n/g, " ⏎ ").slice(0, 400)}`}`);
}

const out = process.env.EVAL_OUT ?? path.join(process.env.ACC_DATA_DIR ?? ".e2e-data/eval", `eval-${["v2", "v3", "v4", "v5"].includes(process.env.EVAL_SET ?? "") ? `${process.env.EVAL_SET}-` : ""}${split}${range ? `-${range[0]}` : ""}.json`);
mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(results, null, 1));
const pass = results.filter((r) => r.pass).length;
console.log(`\n${split}: ${pass}/${results.length} passed (${Math.round((100 * (results.length - pass)) / Math.max(1, results.length))}% errors)`);
const byCat = new Map<string, { n: number; ok: number }>();
for (const r of results) {
  const c = byCat.get(r.cat) ?? { n: 0, ok: 0 };
  c.n++;
  if (r.pass) c.ok++;
  byCat.set(r.cat, c);
}
for (const [cat, c] of byCat) console.log(`  ${cat.padEnd(18)} ${c.ok}/${c.n}`);
const kinds = new Map<string, number>();
for (const r of results) for (const f of new Set(r.fails.map((x) => x.split(/[ (:]/)[0]))) kinds.set(f, (kinds.get(f) ?? 0) + 1);
console.log(`  failure kinds: ${[...kinds].map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`);
process.exit(0);

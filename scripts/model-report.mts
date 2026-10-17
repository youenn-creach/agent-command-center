import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { correctRoute } from "@/server/agents/command";
import { RouteSchema } from "@/server/agents/assistant";
import { CASES } from "./eval-cases";

/**
 * Merges .e2e-data/model-compare/*.json (written by model-compare.mts) into one table per task type:
 * accuracy, harmful errors (an invented fact, a wrong date, a missed action) and seconds per item.
 * Routing is re-scored here with the app's safety nets so every model is judged the same way,
 * whichever version of the scorer produced its file.
 *
 *   npx tsx scripts/model-report.mts [out.md]
 */

interface Row { suite: string; id: string; ok: boolean; ms: number; got: string; why?: string }
const dir = path.join(".e2e-data", "model-compare");
const SUITES = ["routing", "facts", "dates", "verdicts"] as const;
type Suite = (typeof SUITES)[number];
const WANTED = new Map(CASES.map(([q, w]) => [q, Array.isArray(w) ? w : [w]]));

interface Stat { n: number; ok: number; harmful: number; missedSafe: number; secMean: number; secMedian: number }

function score(suite: Suite, r: Row): { ok: boolean; harmful: boolean } {
  if (suite === "routing") {
    const wanted = WANTED.get(r.id);
    if (!wanted || /^error/.test(r.got)) return { ok: false, harmful: false };
    const skill = correctRoute(r.id, RouteSchema.parse({ skill: r.got, args: {} })).skill;
    return { ok: wanted.includes(skill), harmful: !wanted.includes(skill) };
  }
  if (suite === "facts") return { ok: r.ok, harmful: /must not/.test(r.why ?? "") };
  if (suite === "dates") {
    // Harmful: it states a date that is wrong (or invents one when there is none). Not finding a date is a safe miss.
    const found = /found=true/.test(r.got);
    return { ok: r.ok, harmful: !r.ok && found };
  }
  // verdicts: harmful = an action the user needed was called "nothing to do" (missed); the reverse is only noise.
  const said = /needs_action=true/.test(r.got);
  const wantedTrue = /wanted true/.test(r.why ?? "");
  return { ok: r.ok, harmful: !r.ok && wantedTrue && !said };
}

const models = readdirSync(dir).filter((f) => f.endsWith(".json") && !["speed.json", "overall.json"].includes(f)).map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")) as { model: string; rows: Row[] });
const table: Record<string, Partial<Record<Suite, Stat>>> = {};
for (const m of models) {
  table[m.model] = {};
  for (const suite of SUITES) {
    const rows = m.rows.filter((r) => r.suite === suite);
    if (!rows.length) continue;
    const scored = rows.map((r) => ({ r, ...score(suite, r) }));
    const secs = rows.filter((r) => r.ms > 0).map((r) => r.ms / 1000).sort((a, b) => a - b);
    table[m.model][suite] = {
      n: rows.length,
      ok: scored.filter((s) => s.ok).length,
      harmful: scored.filter((s) => s.harmful).length,
      missedSafe: scored.filter((s) => !s.ok && !s.harmful).length,
      secMean: secs.reduce((a, b) => a + b, 0) / (secs.length || 1),
      secMedian: secs[Math.floor(secs.length / 2)] ?? 0,
    };
  }
}

const names = Object.keys(table).sort();
const isMistral = (n: string) => n.startsWith("ministral") || n.startsWith("mistral");
const pct = (s?: Stat) => (s ? `${s.ok}/${s.n} (${Math.round((100 * s.ok) / s.n)}%)` : "–");
let md = "# Model comparison\n\nAccuracy / harmful errors (invented fact, wrong date, a needed action called \"nothing to do\") / median seconds per item.\nSpeed was measured while other programs used the CPU: use it to compare models with each other, not as absolute figures.\n\n";
for (const suite of SUITES) {
  md += `## ${suite}\n\n| model | correct | harmful | other misses | median s | mean s |\n|---|---|---|---|---|---|\n`;
  for (const n of names) {
    const s = table[n][suite];
    md += s ? `| ${n} | ${pct(s)} | ${s.harmful} | ${s.missedSafe} | ${s.secMedian.toFixed(0)} | ${s.secMean.toFixed(0)} |\n` : `| ${n} | not run | | | | |\n`;
  }
  md += "\n";
}

// Mistral-only against the best of everything, per task type.
const best = (pool: string[], suite: Suite) =>
  pool
    .filter((n) => table[n][suite])
    .sort((a, b) => table[b][suite]!.ok / table[b][suite]!.n - table[a][suite]!.ok / table[a][suite]!.n || table[a][suite]!.harmful - table[b][suite]!.harmful || table[a][suite]!.secMedian - table[b][suite]!.secMedian)[0];
md += "## Staying with Mistral\n\n| task | best Mistral | best overall | accuracy lost | harmful errors (Mistral / overall) | seconds (Mistral / overall) |\n|---|---|---|---|---|---|\n";
for (const suite of SUITES) {
  const bm = best(names.filter(isMistral), suite);
  const bo = best(names, suite);
  if (!bm || !bo) continue;
  const a = table[bm][suite]!, b = table[bo][suite]!;
  md += `| ${suite} | ${bm} ${pct(a)} | ${bo} ${pct(b)} | ${Math.round((100 * (b.ok / b.n - a.ok / a.n)) * 10) / 10} points | ${a.harmful} / ${b.harmful} | ${a.secMedian.toFixed(0)} / ${b.secMedian.toFixed(0)} |\n`;
}
// Overall accuracy (all suites together, routing after the safety nets) for the "more than 5 points better" rule.
const overall: Record<string, number> = {};
for (const n of names) {
  const all = SUITES.map((x) => table[n][x]).filter((x): x is Stat => Boolean(x));
  overall[n] = all.length === SUITES.length ? Math.round((1000 * all.reduce((a, s) => a + s.ok, 0)) / all.reduce((a, s) => a + s.n, 0)) / 10 : NaN;
}
writeFileSync(path.join(dir, "overall.json"), JSON.stringify(overall, null, 1));
md += `## Overall accuracy (all suites together)\n\n${names.map((n) => `- ${n}: ${Number.isNaN(overall[n]) ? "incomplete" : `${overall[n]}%`}`).join("\n")}\n`;
const out = process.argv[2] ?? path.join(dir, "report.md");
writeFileSync(out, md);
console.log(md);
if (!existsSync(out)) process.exit(1);

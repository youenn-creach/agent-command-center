import { readFileSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { EVALSET } from "./evalset/v1";
import { EVALSET_V2 } from "./evalset/v2";
import type { EvalResult } from "./evalset/types";

/**
 * Re-grades an evaluation run's answer checks from its own database, when the runner showed a placeholder ("It will appear under
 * Your requests") instead of the answer the background work wrote to the request board. Only the answer text changes: prepared
 * actions, reminders and events (the ACTION / REMINDER / EVENT lines) and the other failure kinds stay as graded.
 *   npx tsx scripts/eval-regrade.mts <results.json> <acc.sqlite>   → writes <results>.regraded.json and prints the summary
 */
const [resultsFile, dbFile] = process.argv.slice(2);
const results = JSON.parse(readFileSync(resultsFile, "utf8")) as EvalResult[];
const db = new DatabaseSync(dbFile, { readOnly: true });
const byId = new Map([...EVALSET, ...EVALSET_V2].map((i) => [i.id, i]));
const answerOf = db.prepare("SELECT result FROM requests WHERE text = ? AND result IS NOT NULL ORDER BY rowid DESC LIMIT 1");

let changed = 0;
for (const r of results) {
  const item = byId.get(r.id);
  const row = answerOf.get(r.text) as { result: string } | undefined;
  if (!item || !row) continue;
  const answer = JSON.parse(row.result) as { reply?: string; items?: { title: string; detail?: string }[] };
  const kept = r.shown.split("\n").filter((l) => /^(ACTION|REMINDER|EVENT) /.test(l));
  const shown = [(answer.reply ?? "").replace(/\s+/g, " "), ...(answer.items ?? []).map((i) => `${i.title}${i.detail ? ` — ${i.detail}` : ""}`), ...kept].join("\n");
  const fails = r.fails.filter((f) => !/^(missing|forbidden) /.test(f));
  for (const re of item.must ?? []) if (!re.test(shown)) fails.push(`missing ${re}`);
  for (const re of item.never ?? []) if (re.test(shown)) fails.push(`forbidden ${re}`);
  if (fails.length === 0 !== r.pass) changed++;
  Object.assign(r, { shown: shown.slice(0, 1500), fails, pass: fails.length === 0 });
}
writeFileSync(resultsFile.replace(/\.json$/, ".regraded.json"), JSON.stringify(results, null, 1));
const pass = results.filter((r) => r.pass).length;
console.log(`${changed} verdicts changed; ${pass}/${results.length} passed (${Math.round((100 * (results.length - pass)) / Math.max(1, results.length))}% errors)`);
for (const r of results.filter((x) => !x.pass)) console.log(`  FAIL ${r.id} [${r.intent}] ${r.text} — ${r.fails.join("; ").slice(0, 160)}`);

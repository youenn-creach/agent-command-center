import "./_env.mts";
import { readFileSync } from "node:fs";
import { openDb, setSetting } from "@/server/db";

/**
 * Loads a saved evaluation (the JSON `npm run eval` writes) into this instance's database, so another
 * instance on the same fictional corpus (the demo, the screenshot instance) shows measured results
 * without re-running the 26-minute Voyage pass. Usage: tsx scripts/load-eval.mts data/eval-latest.json
 */
const file = process.argv[2];
if (!file) {
  console.error("Usage: tsx scripts/load-eval.mts <eval-latest.json>");
  process.exit(1);
}
const parsed = JSON.parse(readFileSync(file, "utf8")) as { ranAt?: string; queries?: number; results?: Record<string, unknown> };
if (!parsed.ranAt || !parsed.queries || !parsed.results) {
  console.error(`${file} is not an evaluation result (expected ranAt, queries and results).`);
  process.exit(1);
}
const db = openDb();
setSetting(db, "eval.latest", JSON.stringify(parsed));
console.log(`Imported the evaluation from ${parsed.ranAt} (${parsed.queries} questions, ${Object.keys(parsed.results).length} providers).`);

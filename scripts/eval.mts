import "./_env.mts";
// Batch job: wait for Voyage rate-limit slots instead of failing.
process.env.ACC_VOYAGE_WAIT = "1";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { getSetting, openDb, setSetting } from "@/server/db";
import { isSeeded, resetDemo } from "@/server/seed/seed";
import { EVAL_QUERIES } from "@/server/seed/corpus";
import { indexLocal, liveModeStatus, retrieve, type RetrievalProviderId } from "@/server/retrieval/knowledge";
import { nanoModelInstalled } from "@/server/retrieval/embeddings";

/**
 * Retrieval quality on the fictional corpus: paraphrased questions vs. the note that answers them.
 * Reports recall@1, recall@3 and MRR per provider that is actually available — nothing is
 * estimated or simulated. Results are saved to data/eval-latest.json and shown in the dashboard.
 */

// The questions are about the fictional corpus: search it the way the demo does, whatever the
// instance's own mode (the personal app hides demo notes and searches only your shared ones).
process.env.ACC_MODE = "demo";
const ctx = { db: openDb(), now: () => new Date() };
if (!isSeeded(ctx)) resetDemo(ctx);

const providers: RetrievalProviderId[] = ["lexical"];
if (nanoModelInstalled()) {
  await indexLocal(ctx);
  providers.push("local-semantic", "local-hybrid");
} else console.log("(skipping local-semantic: run `npm run setup:local-embeddings` first)");
if (liveModeStatus(ctx).enabled && nanoModelInstalled()) providers.push("atlas-nano", "atlas-hybrid");
if (liveModeStatus(ctx).enabled && process.env.EVAL_SKIP_VOYAGE !== "1") {
  providers.push("atlas-voyage");
  console.log(`(atlas-voyage is paced to the Voyage rate limit — with 3 requests/min this takes about ${EVAL_QUERIES.length} minutes)`);
}
else console.log(`(skipping atlas-voyage: ${liveModeStatus(ctx).reasons.join("; ")})`);

type ProviderResult = { recallAt1: number; recallAt3: number; mrr: number; avgMs: number; queries: number; ranAt: string; misses: string[]; ranks: (number | null)[] };
const results: Record<string, ProviderResult> = {};
for (const provider of providers) {
  let r1 = 0;
  let r3 = 0;
  let mrr = 0;
  let ms = 0;
  const misses: string[] = [];
  const ranks: (number | null)[] = [];
  for (const q of EVAL_QUERIES) {
    const res = await retrieve(ctx, { query: q.query, provider, k: 5, answer: false, filters: q.filters ?? {} }, undefined, "eval");
    // Sum of the traced steps: real work only, excluding time spent waiting for rate-limit slots.
    ms += res.trace.reduce((sum, t) => sum + t.ms, 0);
    const docs = [...new Set(res.passages.map((p) => p.docId))];
    const rank = docs.indexOf(q.expected) + 1;
    if (rank === 1) r1++;
    if (rank >= 1 && rank <= 3) r3++;
    if (rank >= 1) mrr += 1 / rank;
    else misses.push(q.query);
    ranks.push(rank >= 1 ? rank : null);
  }
  const n = EVAL_QUERIES.length;
  results[provider] = { recallAt1: r1 / n, recallAt3: r3 / n, mrr: mrr / n, avgMs: Math.round(ms / n), queries: n, ranAt: new Date().toISOString(), misses, ranks };
}

console.log(`\nRetrieval eval — ${EVAL_QUERIES.length} paraphrased questions over the fictional corpus\n`);
console.log("provider          recall@1  recall@3  MRR    avg ms");
for (const [p, r] of Object.entries(results)) {
  console.log(`${p.padEnd(17)} ${r.recallAt1.toFixed(2).padStart(8)}  ${r.recallAt3.toFixed(2).padStart(8)}  ${r.mrr.toFixed(2)}  ${String(r.avgMs).padStart(6)}`);
}
// Keep earlier results for providers skipped this time (e.g. EVAL_SKIP_VOYAGE=1 to spare the Voyage rate limit).
const previous = (() => {
  try {
    return JSON.parse(getSetting(ctx.db, "eval.latest") ?? "null")?.results ?? {};
  } catch {
    return {};
  }
})();
for (const [p, r] of Object.entries(previous)) if (!(p in results)) (results as Record<string, unknown>)[p] = r;
const out = { ranAt: new Date().toISOString(), queries: EVAL_QUERIES.length, questions: EVAL_QUERIES.map((q) => q.query), results };
writeFileSync(path.join(process.env.ACC_DATA_DIR ?? "data", "eval-latest.json"), JSON.stringify(out, null, 2));
setSetting(ctx.db, "eval.latest", JSON.stringify(out));
console.log("\nSaved to data/eval-latest.json (also shown in the Showcase view).");
// Close open handles (e.g. the MongoDB connection pool) so the script exits.
process.exit(0);

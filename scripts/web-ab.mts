import "./_env.mts";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { readPage, searchWeb, type WebResult } from "@/server/connectors/websearch";
import { injectionFlags, isAiDirected } from "@/server/retrieval/text";
import { groundNumbers, plainAnswer, WEB_SYSTEM, webPrompt } from "@/server/agents/assistant";
import { ollamaProvider } from "@/server/llm";

/**
 * Web answers, the former prompt (every snippet + the first 2,500 characters of each page) against relevant passages
 * (6 snippets + ~700 characters of each page that match the question), on the SAME saved search results and pages.
 *
 *   npx tsx scripts/web-ab.mts fetch <dir>      search and read pages once (no model), saved to <dir>/pages.json
 *   npx tsx scripts/web-ab.mts run <dir> [model] both prompts per question, alternating, resumable: <dir>/results.json
 * Public facts only (no personal data). v1's web questions plus new ones; v2's (held out) are left out on purpose.
 */
const QUESTIONS: { q: string; must: RegExp }[] = [
  { q: "what's the capital of australia", must: /Canberra/ },
  { q: "who wrote don quixote", must: /Cervantes/ },
  { q: "how far is lisbon from barcelona", must: /km|miles/i },
  { q: "what's the population of iceland", must: /\d{3}/ },
  { q: "who is the president of france", must: /Macron/ },
  { q: "what's the tallest building in the world", must: /Burj Khalifa/i },
  { q: "who won the 2022 world cup", must: /Argentina/ },
  { q: "what's the tallest mountain in spain", must: /Teide/i },
  { q: "how many people live in lisbon", must: /\d{3}/ },
  { q: "how tall is the eiffel tower", must: /\b3[0-3]\d\b/ },
  { q: "when did the berlin wall fall", must: /1989/ },
  { q: "who discovered penicillin", must: /Fleming/i },
  { q: "what currency does japan use", must: /yen/i },
  { q: "who was the first person to walk on the moon", must: /Armstrong/i },
  { q: "how many bones are in the adult human body", must: /\b206\b/ },
  { q: "what's the largest ocean on earth", must: /Pacific/i },
  { q: "when did construction of the sagrada familia start", must: /1882/ },
  { q: "how high is mount everest", must: /8,?84[89]|29,0[23]\d/ },
  { q: "what language do they speak in brazil", must: /Portuguese/i },
  { q: "who wrote one hundred years of solitude", must: /M[aá]rquez/i },
  { q: "how far is the moon from the earth", must: /384|238,?\d{3}/ },
  { q: "what's the chemical symbol for gold", must: /\bAu\b/ },
  { q: "in what year were the barcelona olympics", must: /1992/ },
  { q: "how many stars are on the us flag", must: /\b50\b|fifty/i },
  { q: "what's the longest river in europe", must: /Volga/i },
  { q: "how long is a marathon", must: /42[.,]\d|26[.,]2/ },
];

type Saved = { q: string; results: WebResult[]; pages: [number, string][] };
const [mode, dir, model = "ministral-3:8b"] = process.argv.slice(2);
const pagesFile = `${dir}/pages.json`;
const resultsFile = `${dir}/results.json`;

if (mode === "fetch") {
  const saved: Saved[] = [];
  for (const { q } of QUESTIONS) {
    let results: WebResult[] = [];
    try { results = await searchWeb(q); } catch (err) { console.log(`search failed: ${q}: ${String(err).slice(0, 80)}`); }
    const pages: [number, string][] = [];
    for (const r of results.slice(0, 3)) {
      try {
        const text = await readPage(r.url, 12_000);
        if (!isAiDirected(injectionFlags(text))) pages.push([r.n, text]);
      } catch { /* unreadable: its snippet still counts, as in the app */ }
    }
    saved.push({ q, results, pages });
    console.log(`${q}: ${results.length} results, ${pages.length} pages, ${pages.reduce((n, [, t]) => n + t.length, 0)} chars`);
  }
  writeFileSync(pagesFile, JSON.stringify(saved, null, 1));
} else if (mode === "run") {
  const saved = JSON.parse(readFileSync(pagesFile, "utf8")) as Saved[];
  type Row = { q: string; arm: "lead" | "passages"; pass: boolean; ms: number; promptChars: number; reply: string };
  const done: Row[] = existsSync(resultsFile) ? JSON.parse(readFileSync(resultsFile, "utf8")) : [];
  const llm = ollamaProvider(model);
  const today = "2026-10-17";
  for (const [i, s] of saved.entries()) {
    const must = QUESTIONS.find((x) => x.q === s.q)!.must;
    const found = { results: s.results, pages: new Map(s.pages) };
    if (!found.results.length) continue;
    // Alternate which arm goes first, so a slower stretch of the night doesn't favour one.
    const arms: Row["arm"][] = i % 2 ? ["passages", "lead"] : ["lead", "passages"];
    for (const arm of arms) {
      if (done.some((d) => d.q === s.q && d.arm === arm)) continue;
      const prompt = webPrompt(s.q, s.q, today, found, arm);
      const t = performance.now();
      // The memory guard may stop the model mid-answer: wait and try again (twice), never end the night's run.
      let out: Awaited<ReturnType<typeof llm.generate>> | undefined;
      for (let attempt = 0; !out; attempt++) {
        try {
          out = await llm.generate(WEB_SYSTEM, prompt, { maxTokens: 260, timeoutMs: 1_800_000 });
        } catch (err) {
          if (attempt >= 2) throw err;
          console.log(`retry after: ${String(err).slice(0, 80)}`);
          await new Promise((r) => setTimeout(r, 120_000));
        }
      }
      const sourceText = `${today} ${s.q} ${found.results.map((r) => `${r.title} ${r.snippet} ${found.pages.get(r.n) ?? ""}`).join(" ")}`;
      const reply = groundNumbers(plainAnswer(out.text), sourceText);
      const row: Row = { q: s.q, arm, pass: must.test(reply), ms: Math.round(performance.now() - t), promptChars: prompt.length, reply: reply.slice(0, 300) };
      done.push(row);
      writeFileSync(resultsFile, JSON.stringify(done, null, 1));
      console.log(`${row.pass ? "PASS" : "FAIL"} ${arm.padEnd(8)} ${Math.round(row.ms / 1000)}s ${row.promptChars}ch | ${s.q} | ${row.reply.slice(0, 100)}`);
    }
  }
  for (const arm of ["lead", "passages"] as const) {
    const rows = done.filter((d) => d.arm === arm);
    const ms = rows.reduce((n, r) => n + r.ms, 0) / Math.max(1, rows.length);
    console.log(`${arm}: ${rows.filter((r) => r.pass).length}/${rows.length} passed, avg ${Math.round(ms / 1000)} s, avg prompt ${Math.round(rows.reduce((n, r) => n + r.promptChars, 0) / Math.max(1, rows.length))} chars`);
  }
} else {
  console.log("usage: web-ab.mts fetch|run <dir> [model]");
}

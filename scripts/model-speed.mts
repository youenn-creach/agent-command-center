import "./_env.mts";
import os from "node:os";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { ollamaProvider } from "@/server/llm";
import { quickRoute, routerPrompt, ROUTE_JSON_SCHEMA, WEB_SYSTEM } from "@/server/agents/assistant";
import { classify } from "@/server/agents/command";
import { CASES } from "./eval-cases";

/**
 * Speed of each model on a quiet computer: a fixed small sample (6 routing requests, 3 answers from sources),
 * one untimed warm-up first so loading the model is not counted. Waits until the CPU is idle (1-minute load
 * average under 0.6, up to 30 minutes), and records the load it ran under. Models run one after another and
 * each is unloaded after its turn.   npx tsx scripts/model-speed.mts <model> [<model> ...]
 * Results: .e2e-data/model-compare/speed.json
 */

const models = process.argv.slice(2);
if (!models.length) throw new Error("usage: model-speed.mts <model> [<model> ...]");
const dir = path.join(process.cwd(), ".e2e-data", "model-compare");
mkdirSync(dir, { recursive: true });
const file = path.join(dir, "speed.json");
const saved: Record<string, unknown> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};

const requests = CASES.map(([q]) => q).filter((q) => !quickRoute(q) && !["draft", "event", "remember", "slots", "automation", "flights", "refused"].includes(classify(q).intent)).slice(0, 6);
const SOURCES = [
  "[1] Harbor Festival 2027 runs 12–14 June at Pier 9. Day tickets cost €25; a three-day pass costs €60. Children under 12 enter free.",
  "[2] The Orchard Line train from Westbridge to Dunmere departs at 07:42 and arrives at 09:15.",
  "[3] The Linden Hotel check-in is from 15:00. Check-out is by 11:00.",
];
const QUESTIONS = ["How much do tickets to the Harbor Festival cost?", "What time does the train arrive in Dunmere?", "What are the check-in and check-out times?"];

const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;
async function idle() {
  for (let i = 0; i < 60; i++) {
    if (os.loadavg()[0] < 0.6) return os.loadavg()[0];
    await new Promise((r) => setTimeout(r, 30_000));
  }
  return os.loadavg()[0];
}

for (const model of models) {
  const llm = ollamaProvider(model);
  const load = await idle();
  await llm.generate(routerPrompt(), "Request: hello", { maxTokens: 1, temperature: 0, timeoutMs: 1_500_000, keepAlive: "10m", format: ROUTE_JSON_SCHEMA });
  const route: number[] = [];
  for (const q of requests) {
    const t = Date.now();
    await llm.generate(routerPrompt(), `Request: ${q}`, { maxTokens: 120, temperature: 0, timeoutMs: 1_500_000, keepAlive: "10m", format: ROUTE_JSON_SCHEMA });
    route.push((Date.now() - t) / 1000);
  }
  const answer: number[] = [];
  for (const q of QUESTIONS) {
    const t = Date.now();
    await llm.generate(WEB_SYSTEM, `Question: ${q}\n\nSources:\n${SOURCES.join("\n")}`, { maxTokens: 200, temperature: 0, timeoutMs: 1_500_000, keepAlive: "10m" });
    answer.push((Date.now() - t) / 1000);
  }
  saved[model] = { routingMedianS: median(route), answerMedianS: median(answer), routingRunsS: route.map((s) => Math.round(s * 10) / 10), answerRunsS: answer.map((s) => Math.round(s * 10) / 10), loadBefore: Math.round(load * 100) / 100, loadAfter: Math.round(os.loadavg()[0] * 100) / 100, at: new Date().toISOString() };
  writeFileSync(file, JSON.stringify(saved, null, 1));
  console.log(`${model}: routing ${median(route).toFixed(1)} s, answer ${median(answer).toFixed(1)} s (load before ${load.toFixed(2)})`);
  await fetch(new URL("/api/generate", process.env.OLLAMA_URL ?? "http://127.0.0.1:11434"), { method: "POST", body: JSON.stringify({ model, keep_alive: 0 }) }).catch(() => {});
}
process.exit(0);

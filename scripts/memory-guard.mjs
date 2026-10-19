#!/usr/bin/env node
// Memory guard: keeps the computer from freezing when memory runs out. Every 2 seconds it reads how much memory and swap are
// left and how much the system is stalling on memory (/proc/pressure/memory). When that gets dangerous it unloads the local
// models (Ollama: the 8B alone holds ~6 GB) and says so in a desktop notification. Nothing else is ever stopped or killed;
// if memory stays critical with no model loaded, it only warns, naming the biggest processes.
//
// Plain Node, no dependencies (it must stay small and start fast). Runs as a systemd user service:
//   npm run guard:install   ·   npm run guard:uninstall   ·   logs: journalctl --user -u acc-memory-guard -f
// Events are also appended to data/memory-guard.log (one JSON object per line).
// Thresholds can be changed with environment variables (in MB / percent), see LIMITS. GUARD_DRY_RUN=1 only reports.
import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const num = (v, d) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
export const LIMITS = {
  /** Almost no memory left: act whatever the swap. */
  minAvailableMb: num(process.env.GUARD_MIN_AVAILABLE_MB, 400),
  /** Low memory AND swap nearly full: act. */
  lowAvailableMb: num(process.env.GUARD_LOW_AVAILABLE_MB, 800),
  minSwapFreePct: num(process.env.GUARD_MIN_SWAP_FREE_PCT, 15),
  /** The share of the last 10 s in which every task was stalled waiting for memory (the start of a freeze). */
  maxFullStallPct: num(process.env.GUARD_MAX_FULL_STALL_PCT, 15),
};

/** Reads /proc/meminfo text into MB. */
export function parseMeminfo(text) {
  const kb = (k) => Number(text.match(new RegExp(`^${k}:\\s+(\\d+)`, "m"))?.[1] ?? 0);
  return { totalMb: kb("MemTotal") / 1024, availableMb: kb("MemAvailable") / 1024, swapTotalMb: kb("SwapTotal") / 1024, swapFreeMb: kb("SwapFree") / 1024 };
}

/** Reads the "full avg10" figure of /proc/pressure/memory (0 when the kernel doesn't report pressure). */
export function parsePressure(text) {
  return Number(text?.match(/^full\s+avg10=([\d.]+)/m)?.[1] ?? 0);
}

/** Why memory is dangerous right now, in words, or null when it is fine. */
export function danger(mem, fullStallPct, limits = LIMITS) {
  const swapFreePct = mem.swapTotalMb > 0 ? (100 * mem.swapFreeMb) / mem.swapTotalMb : 0;
  const state = `${Math.round(mem.availableMb)} MB of memory free, swap ${Math.round(100 - swapFreePct)}% full`;
  if (mem.availableMb < limits.minAvailableMb) return `${state} (under ${limits.minAvailableMb} MB)`;
  if (mem.availableMb < limits.lowAvailableMb && swapFreePct < limits.minSwapFreePct) return `${state} (under ${limits.lowAvailableMb} MB with swap nearly full)`;
  if (fullStallPct >= limits.maxFullStallPct) return `${state}; the system was stalled on memory ${fullStallPct.toFixed(0)}% of the last 10 s`;
  return null;
}

// ---------- the service ----------

const OLLAMA = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOG = path.join(project, "data", "memory-guard.log");

const log = (event) => {
  const line = { at: new Date().toISOString(), ...event };
  console.log(JSON.stringify(line));
  try {
    mkdirSync(path.dirname(LOG), { recursive: true });
    appendFileSync(LOG, `${JSON.stringify(line)}\n`);
  } catch {
    // the journal still has it
  }
};

const notify = (title, body) =>
  new Promise((resolve) => execFile("notify-send", ["-u", "critical", "-a", "Agent Command Center", title, body], { timeout: 3000 }, () => resolve()));

async function loadedModels() {
  const r = await fetch(`${OLLAMA}/api/ps`, { signal: AbortSignal.timeout(3000) });
  const body = await r.json();
  return (body.models ?? []).map((m) => ({ name: m.name, gb: (m.size ?? 0) / 1e9 }));
}

/** Ollama's model runner processes (they hold the model in memory); same user as this service. */
function runnerPids() {
  const out = [];
  for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    try {
      const cmd = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").join(" ");
      if (/\bollama\b.*\brunner\b|\/ollama\/llama-server\b|\bllama-server\b.*--model\b/.test(cmd)) out.push(Number(pid));
    } catch {
      // gone or not ours
    }
  }
  return out;
}

function biggestProcesses(n = 3) {
  const rows = [];
  for (const pid of readdirSync("/proc").filter((d) => /^\d+$/.test(d))) {
    try {
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      const rss = Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) / 1024;
      const name = status.match(/^Name:\s+(.+)$/m)?.[1] ?? pid;
      if (rss > 0) rows.push({ name, mb: Math.round(rss) });
    } catch {
      // gone
    }
  }
  const byName = new Map();
  for (const r of rows) byName.set(r.name, (byName.get(r.name) ?? 0) + r.mb);
  return [...byName].sort((a, b) => b[1] - a[1]).slice(0, n).map(([name, mb]) => `${name} ${(mb / 1024).toFixed(1)} GB`);
}

/** Unloads every loaded model: politely through Ollama, then, if it can't answer (the machine is thrashing), by stopping its runner. */
async function unloadModels() {
  let names = [];
  try {
    const models = await loadedModels();
    names = models.map((m) => `${m.name} (${m.gb.toFixed(1)} GB)`);
    await Promise.all(models.map((m) => fetch(`${OLLAMA}/api/generate`, { method: "POST", body: JSON.stringify({ model: m.name, keep_alive: 0 }), signal: AbortSignal.timeout(5000) }).catch(() => null)));
    await new Promise((r) => setTimeout(r, 3000));
    // Ollama may report nothing loaded while a runner still holds the memory (it lingers after an unload, as at 03:27 on
    // 2026-10-19 with 5.1 GB): only then is the job done.
    if (!(await loadedModels()).length && !runnerPids().length) return { names, how: "unloaded" };
  } catch {
    // Ollama too slow to answer: fall through
  }
  const pids = runnerPids();
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  return { names: names.length ? names : pids.length ? ["an idle model runner"] : [], how: pids.length ? "stopped the model runner" : "nothing loaded" };
}

async function main() {
  log({ event: "started", limits: LIMITS });
  let quietUntil = 0;
  let warnedAt = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    let mem;
    let stall = 0;
    try {
      mem = parseMeminfo(readFileSync("/proc/meminfo", "utf8"));
      try {
        stall = parsePressure(readFileSync("/proc/pressure/memory", "utf8"));
      } catch {
        // no pressure information on this kernel
      }
    } catch {
      continue;
    }
    const why = danger(mem, stall);
    if (!why || Date.now() < quietUntil) continue;
    if (process.env.GUARD_DRY_RUN === "1") {
      // For checking the guard without touching anything: say what would be unloaded, then stop.
      const models = await loadedModels().catch(() => []);
      log({ event: "dry-run", why, wouldUnload: models.map((m) => m.name), runners: runnerPids().length, top: biggestProcesses() });
      return;
    }
    const { names, how } = await unloadModels();
    if (names.length) {
      log({ event: "unloaded", why, models: names, how });
      await notify("Memory guard: local model unloaded", `${names.join(", ")} ${how === "unloaded" ? "was unloaded" : "was stopped"} to keep the computer from freezing (${why}). It loads again on the next request.`);
      quietUntil = Date.now() + 20_000; // give the memory time to come back before judging again
    } else if (Date.now() - warnedAt > 5 * 60_000) {
      const top = biggestProcesses();
      log({ event: "critical", why, top });
      await notify("Memory guard: memory is critical", `No local model is loaded. ${why}. Biggest: ${top.join(", ")}. Close something to avoid a freeze.`);
      warnedAt = Date.now();
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();

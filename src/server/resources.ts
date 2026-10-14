import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import os from "node:os";
import { config } from "./config";

/**
 * What this computer is doing right now, for the "Running now" panel: CPU, memory, the busiest processes
 * and the model Ollama holds, plus a plain-language guess at the bottleneck. Cheap on purpose (kernel
 * counters, one `ps`, one tiny Ollama call), sampled at most every 3 seconds however often the dashboard asks.
 * Nothing here leaves the machine or is stored.
 */

export interface Resources {
  cpu: { percent: number; cores: number };
  memory: { usedMB: number; totalMB: number; availableMB: number; swapUsedMB: number };
  /** Busiest processes by CPU (names only), for "the CPU is busy with something else". */
  top: { name: string; percent: number }[];
  model: { name: string; sizeMB: number; untilIso: string | null } | null;
  /** The likely limit on speed right now, in words; null when nothing is limiting. */
  bottleneck: { kind: "memory" | "cpu-model" | "cpu-other" | "waiting"; text: string } | null;
}

let cached: { at: number; value: Resources } | null = null;
let lastStat: { idle: number; total: number } | null = null;

async function readStat(): Promise<{ idle: number; total: number }> {
  const first = (await readFile("/proc/stat", "utf8")).split("\n")[0].split(/\s+/).slice(1).map(Number);
  return { idle: first[3] + (first[4] ?? 0), total: first.reduce((a, b) => a + b, 0) };
}

async function cpuPercent(): Promise<number> {
  try {
    // Without an earlier reading (first call after a restart), take a short real sample: the 1-minute
    // load average would still carry whatever ran before and read "busy" on an idle machine.
    const prev = lastStat ?? (await (async () => { const s = await readStat(); await new Promise((r) => setTimeout(r, 250)); return s; })());
    const now = await readStat();
    lastStat = now;
    if (now.total > prev.total) return Math.max(0, Math.min(100, Math.round((1 - (now.idle - prev.idle) / (now.total - prev.total)) * 100)));
  } catch {
    // not Linux: fall through to the load average
  }
  return Math.min(100, Math.round((os.loadavg()[0] / os.cpus().length) * 100));
}

async function memory(): Promise<Resources["memory"]> {
  const totalMB = Math.round(os.totalmem() / 1e6);
  try {
    const info = Object.fromEntries((await readFile("/proc/meminfo", "utf8")).split("\n").map((l) => l.split(/:\s+/)).filter((p) => p[1]).map(([k, v]) => [k, parseInt(v, 10) / 1024]));
    const available = info.MemAvailable ?? os.freemem() / 1e6;
    return { totalMB, availableMB: Math.round(available), usedMB: Math.round(totalMB - available), swapUsedMB: Math.round((info.SwapTotal ?? 0) - (info.SwapFree ?? 0)) };
  } catch {
    return { totalMB, availableMB: Math.round(os.freemem() / 1e6), usedMB: Math.round(totalMB - os.freemem() / 1e6), swapUsedMB: 0 };
  }
}

/** `ps` cuts names at 15 characters and the model server has an internal name: say what they are. */
export function friendlyName(comm: string, args = ""): string {
  let name = comm.replace(/\s*\(.*$/, "").trim();
  // Threads and interpreters say nothing ("MainThread", "node"): use the program or script on the command line.
  if (/^(MainThread|node|npm|npx|sh|bash|python3?|tsx)$/i.test(name) && args) {
    const words = args.split(/\s+/).filter((w) => w && !w.startsWith("-"));
    const script = words.filter((w) => /\.(m?[jt]s|cjs|py)$/.test(w)).at(-1) ?? words.slice(1).find((w) => !/^(exec|run|test)$/.test(w)) ?? words[0] ?? name;
    name = script.split("/").at(-1)!.replace(/\.(m?[jt]s|cjs|py)$/, "") || name;
  }
  if (/^(llama-server|ollama|ollama-runner|ollama_llama_server)$/i.test(name)) return "the local model";
  if (/^(next-server|node|npm)$/i.test(name)) return "this app";
  return name;
}

function busiest(): Promise<Resources["top"]> {
  return new Promise((resolve) => {
    execFile("ps", ["-eo", "pcpu=,comm=,args=", "--sort=-pcpu", "-ww"], { timeout: 2000 }, (err, out) => {
      if (err) return resolve([]);
      const rows = out
        .split("\n")
        .map((l) => l.trim().match(/^([\d.]+)\s+(\S+(?: \(v?\d+)?)\s*(.*)$/))
        .filter((m): m is RegExpMatchArray => Boolean(m) && m![2] !== "ps")
        .map((m) => ({ percent: Math.round(parseFloat(m[1])), name: friendlyName(m[2], m[3]) }))
        .filter((r) => r.percent >= 5);
      // Several processes of one program (a browser) count as one.
      const byName = new Map<string, number>();
      for (const r of rows) byName.set(r.name, (byName.get(r.name) ?? 0) + r.percent);
      resolve([...byName].map(([name, percent]) => ({ name, percent })).sort((a, b) => b.percent - a.percent).slice(0, 3));
    });
  });
}

async function loadedModel(): Promise<Resources["model"]> {
  try {
    const res = await fetch(new URL("/api/ps", config().OLLAMA_URL), { signal: AbortSignal.timeout(1500) });
    const body = (await res.json()) as { models?: { name: string; size: number; expires_at?: string }[] };
    const m = body.models?.[0];
    return m ? { name: m.name, sizeMB: Math.round(m.size / 1e6), untilIso: m.expires_at ?? null } : null;
  } catch {
    return null;
  }
}

/** The likely limit right now. `modelBusy` = the app is waiting on the local model. */
export function judgeBottleneck(r: Omit<Resources, "bottleneck">, modelBusy: boolean): Resources["bottleneck"] {
  // Old pages swapped to disk are harmless while plenty of memory is free: it is the lack of free memory that hurts.
  if (r.memory.availableMB < 800 || (r.memory.swapUsedMB > 1500 && r.memory.availableMB < 2500)) {
    return { kind: "memory", text: `Memory is the limit: only ${(r.memory.availableMB / 1000).toFixed(1)} GB free${r.memory.swapUsedMB > 300 ? ` and ${(r.memory.swapUsedMB / 1000).toFixed(1)} GB swapped to disk` : ""}, so the model slows down. Closing big programs would help.` };
  }
  if (r.cpu.percent >= 85) {
    const other = r.top.find((p) => !/^(the local model|this app)$/.test(p.name) && p.percent >= 30);
    if (other) return { kind: "cpu-other", text: `The CPU is full, and “${other.name}” is using ${other.percent}% of a core: the model is slowed by it. Closing it would speed up answers.` };
    return { kind: "cpu-model", text: modelBusy ? "The CPU is the limit: the local model is using all of it. This is normal on a laptop; there's no faster option than waiting." : `The CPU is full (${r.cpu.percent}%) with something running on this computer.` };
  }
  if (modelBusy && r.cpu.percent < 35) return { kind: "waiting", text: "The model is loading or waiting for something (the CPU is mostly idle). The first answer after a pause takes longer." };
  return null;
}

export async function systemResources(modelBusy: boolean): Promise<Resources> {
  if (cached && Date.now() - cached.at < 3000) return { ...cached.value, bottleneck: judgeBottleneck(cached.value, modelBusy) };
  const [percent, mem, top, model] = await Promise.all([cpuPercent(), memory(), busiest(), loadedModel()]);
  const base = { cpu: { percent, cores: os.cpus().length }, memory: mem, top, model };
  const value = { ...base, bottleneck: judgeBottleneck(base, modelBusy) };
  cached = { at: Date.now(), value };
  return value;
}

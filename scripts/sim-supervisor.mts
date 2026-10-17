import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

/**
 * Runs one simulation batch and keeps it going through mechanical failures, unattended:
 *   - no output and the model server idle for IDLE_MIN minutes (default 10) -> the child is killed and the batch resumes at the unfinished request
 *   - the child crashes                -> same
 *   - an answer says the local model is unavailable (Ollama died, was killed for memory) -> the Ollama service
 *     is restarted, loaded models are unloaded, and that request is run again (MAX_TRIES per request, then skipped)
 * Judging the answers and fixing code stay with a person (or Claude); this only gets the run finished.
 *
 *   npx tsx scripts/sim-supervisor.mts <ollama model> <data dir> <output file> [set=batch3] [total=24] [first=1]
 * Writes <output file> (all child output, plus lines starting with "[supervisor]") and "<output file>.done" at the end.
 */

const [model, dataDir, outFile, set = "batch3", totalArg = "24", firstArg = "1"] = process.argv.slice(2);
if (!model || !dataDir || !outFile) throw new Error("usage: sim-supervisor.mts <model> <data dir> <output file> [set] [total] [first]");
const TOTAL = Number(totalArg);
// A request prints nothing while the model works, so silence alone proves nothing. Checked every minute: stalled = no output
// AND the model server idle (under 30% CPU, i.e. not computing) for IDLE_MIN minutes in a row (covers a model loading from
// disk). A run that stays busy yet prints nothing for BUSY_CAP_MIN minutes is also stopped.
const IDLE_MIN = Number(process.env.IDLE_MIN ?? 10);
const BUSY_CAP_MIN = Number(process.env.BUSY_CAP_MIN ?? (/qwen/i.test(model) ? 180 : 60));
const MAX_TRIES = 3;
const OLLAMA = process.env.OLLAMA_URL ?? "http://127.0.0.1:11434";
const log = (s: string) => appendFileSync(outFile, `[supervisor] ${new Date().toISOString().slice(11, 19)} ${s}\n`);

rmSync(`${outFile}.done`, { force: true });
writeFileSync(outFile, "");
mkdirSync(dataDir, { recursive: true });

async function ollamaUp() {
  try {
    return (await fetch(new URL("/api/ps", OLLAMA), { signal: AbortSignal.timeout(5000) })).ok;
  } catch {
    return false;
  }
}
async function recoverModelServer(why: string) {
  log(`recovering the model server (${why})`);
  try {
    execFileSync("systemctl", ["--user", "restart", "ollama-local"], { timeout: 60_000 });
  } catch (err) {
    log(`restart failed: ${String(err).slice(0, 120)}`);
  }
  for (let i = 0; i < 24 && !(await ollamaUp()); i++) await new Promise((r) => setTimeout(r, 5000));
  log((await ollamaUp()) ? "model server is back" : "model server still down after 2 minutes");
}

let next = Number(firstArg);
const tries = new Map<number, number>();
const skipped: number[] = [];

while (next <= TOTAL) {
  if (!(await ollamaUp())) await recoverModelServer("not answering before the start");
  log(`starting at request ${next}`);
  let lastN = next - 1; // last request header seen
  let failedAt: number | null = null; // request whose answer said the model was unavailable
  let stalled = false;
  // SIM_SCRIPT=scripts/eval-run.mts runs the fixed evaluation set instead (same "#n [intent]" lines, same range resume).
  const child = spawn("npx", ["tsx", process.env.SIM_SCRIPT ?? "scripts/simulate-session.mts", `${next}-${TOTAL}`], {
    env: { ...process.env, SIM_SET: set, ACC_MODE: "mixed", ACC_DATA_DIR: dataDir, OLLAMA_CHAT_MODEL: model },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true, // own process group, so a kill reaches npx, tsx and node together
  });
  const killTree = () => {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  };
  const modelBusy = () => {
    try {
      const out = execFileSync("ps", ["-eo", "pcpu=,comm="], { encoding: "utf8", timeout: 5000 });
      return out.split("\n").some((l) => /llama|ollama/i.test(l) && parseFloat(l) >= 30);
    } catch {
      return false;
    }
  };
  let lastOutput = Date.now();
  let idleMinutes = 0;
  const bump = () => {
    lastOutput = Date.now();
    idleMinutes = 0;
  };
  const watch = setInterval(() => {
    if (modelBusy()) idleMinutes = 0;
    else idleMinutes++;
    const quietMin = (Date.now() - lastOutput) / 60_000;
    if (quietMin >= 1 && idleMinutes >= IDLE_MIN) {
      log(`no output for ${Math.round(quietMin)} min and the model has been idle for ${idleMinutes} min`);
      stalled = true;
      killTree();
    } else if (quietMin >= BUSY_CAP_MIN) {
      log(`no output for ${Math.round(quietMin)} min although the model is busy: stopping`);
      stalled = true;
      killTree();
    }
  }, 60_000);
  const onLine = (line: string) => {
    appendFileSync(outFile, line + "\n");
    bump();
    const head = line.match(/^#(\d+) \[/);
    if (head) lastN = Number(head[1]);
    if (/local model isn't available|Local LLM unavailable/i.test(line) && failedAt === null) {
      failedAt = lastN;
      killTree(); // later requests would fail the same way: stop now, recover, resume here
    }
  };
  createInterface({ input: child.stdout! }).on("line", onLine);
  createInterface({ input: child.stderr! }).on("line", onLine);
  const code: number | null = await new Promise((resolve) => child.on("close", resolve));
  clearInterval(watch);

  if (failedAt !== null || stalled || code !== 0) {
    const n = failedAt ?? lastN + 1; // the request to run again
    const reason = failedAt !== null ? `request ${failedAt} got "model unavailable"` : stalled ? "stalled" : `child exited with code ${code}`;
    const used = (tries.get(n) ?? 0) + 1;
    tries.set(n, used);
    log(`${reason}; try ${used}/${MAX_TRIES} for request ${n}`);
    try {
      execFileSync("sh", ["-c", "for m in $(curl -s localhost:11434/api/ps | grep -o '\"name\":\"[^\"]*\"' | cut -d'\"' -f4); do ollama stop \"$m\"; done"], { timeout: 60_000 });
    } catch {
      // nothing loaded, or Ollama is down: the recovery below handles it
    }
    await recoverModelServer(reason);
    if (used >= MAX_TRIES) {
      log(`giving up on request ${n}, skipping it`);
      skipped.push(n);
      next = n + 1;
    } else next = n;
    continue;
  }
  next = TOTAL + 1; // clean finish
}
log(`finished${skipped.length ? `; skipped requests: ${skipped.join(", ")}` : ""}`);
writeFileSync(`${outFile}.done`, skipped.length ? `skipped ${skipped.join(",")}` : "ok");
process.exit(0);

import "./_env.mts";
import { DatabaseSync } from "node:sqlite";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { defaultDbPath } from "@/server/db";

/**
 * Local database backups.
 *   npm run db:backup                 → consistent snapshot (VACUUM INTO) in data/backups/, keeps the newest 10
 *   npm run db:restore -- <file>      → restores a snapshot (stop the app and worker first)
 *   npm run db:backup -- --list       → list snapshots
 * Backups contain your local data (not secrets — those live in .env.local). They stay in data/, which git ignores.
 */

const dbPath = defaultDbPath();
const dir = path.join(path.dirname(dbPath), "backups");
const [cmd, arg] = process.argv.slice(2);
const KEEP = 10;

function list() {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sqlite"))
    .sort()
    .map((f) => path.join(dir, f));
}

if (cmd === "restore") {
  if (!arg) {
    console.error("Usage: npm run db:restore -- <backup file>");
    process.exit(1);
  }
  const src = path.resolve(arg);
  if (!src.startsWith(dir + path.sep) || !existsSync(src)) {
    console.error(`Backup must be an existing file inside ${dir}`);
    process.exit(1);
  }
  const check = new DatabaseSync(src, { readOnly: true });
  const ok = (check.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check;
  check.close();
  if (ok !== "ok") {
    console.error(`Backup failed its integrity check: ${ok}`);
    process.exit(1);
  }
  console.log("Make sure the web app and the worker are stopped (npm run worker:uninstall or systemctl --user stop agent-command-center-worker).");
  // Keep the current database as a safety copy before overwriting it.
  if (existsSync(dbPath)) copyFileSync(dbPath, `${dbPath}.before-restore`);
  for (const ext of ["-wal", "-shm"]) rmSync(dbPath + ext, { force: true });
  copyFileSync(src, dbPath);
  console.log(`Restored ${path.basename(src)}. Previous database kept as ${path.basename(dbPath)}.before-restore.`);
} else if (cmd === "--list" || cmd === "list") {
  for (const f of list()) console.log(`${path.basename(f)}  ${(statSync(f).size / 1024).toFixed(0)} KB`);
} else {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = path.join(dir, `acc-${stamp}.sqlite`);
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA busy_timeout = 5000");
  db.prepare("VACUUM INTO ?").run(target);
  db.close();
  chmodSync(target, 0o600); // backups hold the same private data as the database
  const all = list();
  for (const old of all.slice(0, Math.max(0, all.length - KEEP))) rmSync(old);
  console.log(`Backup written: ${path.relative(process.cwd(), target)} (${(statSync(target).size / 1024).toFixed(0)} KB). Keeping the newest ${KEEP}.`);
}

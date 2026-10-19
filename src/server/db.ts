import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import path from "node:path";
import { migrate } from "./migrations";

/**
 * Local persistence uses Node's built-in SQLite (no native build step, no server process).
 * Everything that must survive a closed browser — schedules, runs, approvals, activity —
 * lives here. The optional Atlas provider only ever receives the demo knowledge corpus.
 */

export type Db = DatabaseSync;

export interface Ctx {
  db: Db;
  now: () => Date;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('demo','real')),
  connection_state TEXT NOT NULL CHECK (connection_state IN ('connected','disconnected','revoked')),
  access_level TEXT NOT NULL,
  max_level TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '[]',
  last_sync_at TEXT
);

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'idle',
  last_run_at TEXT,
  last_error TEXT
);

CREATE TABLE IF NOT EXISTS agent_permissions (
  agent_id TEXT NOT NULL REFERENCES agents(id),
  service_id TEXT NOT NULL REFERENCES services(id),
  access_level TEXT NOT NULL,
  PRIMARY KEY (agent_id, service_id)
);

CREATE TABLE IF NOT EXISTS actions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  service_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  destination TEXT NOT NULL,
  payload TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  approved_by TEXT,
  approved_at TEXT,
  approved_hash TEXT,
  executed_at TEXT,
  result TEXT,
  is_demo INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS simulated_outbox (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL UNIQUE,
  service_id TEXT NOT NULL,
  destination TEXT NOT NULL,
  effect TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  purpose TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  workflow TEXT NOT NULL,
  cron TEXT NOT NULL,
  timezone TEXT NOT NULL,
  sources TEXT NOT NULL,
  destination TEXT NOT NULL,
  requirements TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active','paused','blocked')),
  status_reason TEXT,
  next_run_at TEXT,
  last_run_at TEXT,
  last_result TEXT,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  simulated INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_runs (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  scheduled_for TEXT NOT NULL,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  message TEXT,
  UNIQUE (job_id, scheduled_for)
);

CREATE TABLE IF NOT EXISTS briefings (
  id TEXT PRIMARY KEY,
  job_run_id TEXT,
  created_at TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  provenance TEXT NOT NULL,
  simulated INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL,
  location TEXT,
  notes TEXT,
  is_demo INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  sender TEXT NOT NULL,
  subject TEXT NOT NULL,
  snippet TEXT NOT NULL,
  received_at TEXT NOT NULL,
  needs_reply INTEGER NOT NULL DEFAULT 0,
  is_demo INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS news_items (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  url TEXT NOT NULL,
  published_at TEXT NOT NULL,
  is_demo INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS news_sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 0,
  last_fetch_at TEXT,
  last_status TEXT,
  item_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]',
  content TEXT NOT NULL,
  is_demo INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chunks (
  id TEXT PRIMARY KEY,
  doc_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ord INTEGER NOT NULL,
  text TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS embeddings (
  chunk_id TEXT NOT NULL REFERENCES chunks(id) ON DELETE CASCADE,
  space TEXT NOT NULL,
  vector BLOB NOT NULL,
  PRIMARY KEY (chunk_id, space)
);

CREATE TABLE IF NOT EXISTS retrieval_runs (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  query TEXT NOT NULL,
  provider TEXT NOT NULL,
  run_label TEXT NOT NULL,
  result TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  kind TEXT NOT NULL,
  agent_id TEXT,
  service_id TEXT,
  summary TEXT NOT NULL,
  outcome TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS activity_ts ON activity (ts DESC);
`;

export function openDb(file?: string): Db {
  const target = file ?? defaultDbPath();
  if (target !== ":memory:") mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(target);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA); // baseline (version 1)
  migrate(db); // versioned changes since the baseline
  // The database holds mail headers, notes and drafts: readable by your user only (SQLite gives the
  // -wal/-shm files the same mode as the main file).
  if (target !== ":memory:") {
    try {
      chmodSync(path.dirname(target), 0o700);
      chmodSync(target, 0o600);
    } catch {
      // not our file or a read-only mount: leave it
    }
  }
  return db;
}

export function defaultDbPath(): string {
  return path.join(process.env.ACC_DATA_DIR ?? path.join(process.cwd(), "data"), "acc.sqlite");
}

let savepoints = 0;
/**
 * Runs fn inside an IMMEDIATE transaction so concurrent processes (web + worker) serialize writes. Called inside another
 * transaction, it uses a savepoint instead (SQLite has no nested BEGIN): still all-or-nothing, never "cannot start a
 * transaction within a transaction".
 */
export function tx<T>(db: Db, fn: () => T): T {
  if ((db as { isTransaction?: boolean }).isTransaction === true) {
    const name = `acc_sp_${++savepoints}`;
    db.exec(`SAVEPOINT ${name}`);
    try {
      const out = fn();
      db.exec(`RELEASE ${name}`);
      return out;
    } catch (err) {
      db.exec(`ROLLBACK TO ${name}`);
      db.exec(`RELEASE ${name}`);
      throw err;
    }
  }
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

type Param = string | number | bigint | null | Uint8Array;

export function all<T>(db: Db, sql: string, ...params: Param[]): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

export function one<T>(db: Db, sql: string, ...params: Param[]): T | undefined {
  return db.prepare(sql).get(...params) as unknown as T | undefined;
}

export function run(db: Db, sql: string, ...params: Param[]) {
  return db.prepare(sql).run(...params);
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
}

export function getSetting(db: Db, key: string): string | undefined {
  return one<{ value: string }>(db, "SELECT value FROM settings WHERE key = ?", key)?.value;
}

export function setSetting(db: Db, key: string, value: string) {
  run(db, "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
}

import type { DatabaseSync } from "node:sqlite";

/**
 * Versioned schema changes, applied in order on startup and tracked with SQLite's
 * `PRAGMA user_version`. The baseline schema in db.ts is version 1 and is never edited for
 * existing tables; every later change is a new entry here, so an existing database is upgraded
 * in place without losing data.
 *
 * Rules: append only, never edit a released migration, each one runs in a transaction.
 */

export interface Migration {
  version: number;
  description: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 2,
    description: "Dashboard reminders created by approved reminder actions",
    sql: `
      CREATE TABLE IF NOT EXISTS reminders (
        id TEXT PRIMARY KEY,
        action_id TEXT UNIQUE,
        text TEXT NOT NULL,
        due_at TEXT,
        done_at TEXT,
        created_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 3,
    description: "Who created a schedule (seed or user) so user-made schedules can be deleted",
    sql: `ALTER TABLE jobs ADD COLUMN created_by TEXT NOT NULL DEFAULT 'seed';`,
  },
  {
    version: 4,
    description: "OAuth connections (encrypted tokens) and provenance columns for synced data",
    sql: `
      CREATE TABLE IF NOT EXISTS oauth_connections (
        service_id TEXT PRIMARY KEY,
        account TEXT,
        scopes TEXT NOT NULL,
        token_ciphertext TEXT NOT NULL,
        expires_at TEXT,
        connected_at TEXT NOT NULL,
        last_sync_at TEXT,
        last_sync_status TEXT
      );
      CREATE TABLE IF NOT EXISTS oauth_pending (
        state TEXT PRIMARY KEY,
        service_id TEXT NOT NULL,
        code_verifier TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      ALTER TABLE messages ADD COLUMN source TEXT NOT NULL DEFAULT 'demo';
      ALTER TABLE events ADD COLUMN source TEXT NOT NULL DEFAULT 'demo';
    `,
  },
  {
    version: 5,
    description: "Briefing kind (daily briefing vs weekly review)",
    sql: `ALTER TABLE briefings ADD COLUMN kind TEXT NOT NULL DEFAULT 'daily';`,
  },
  {
    version: 6,
    description: "Google services are read-only connectors: cap them at Read and describe their scopes",
    sql: `
      UPDATE services SET max_level = 'read', description = 'Read-only: message headers and labels (gmail.metadata). Bodies are never requested.' WHERE id = 'gmail';
      UPDATE services SET max_level = 'read', description = 'Read-only: event titles, times and locations (calendar.events.readonly).' WHERE id = 'google-calendar';
      UPDATE services SET access_level = 'read' WHERE id IN ('gmail','google-calendar') AND access_level NOT IN ('none','read');
      UPDATE agent_permissions SET access_level = 'read' WHERE service_id IN ('gmail','google-calendar') AND access_level NOT IN ('none','read');
    `,
  },
  {
    version: 7,
    description: "User-registered automation webhooks (Zapier, Make, n8n, IFTTT…); URLs encrypted",
    sql: `
      CREATE TABLE IF NOT EXISTS webhooks (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        url_ciphertext TEXT NOT NULL,
        url_fingerprint TEXT NOT NULL,
        host TEXT NOT NULL,
        created_at TEXT NOT NULL,
        last_called_at TEXT,
        last_status TEXT
      );
    `,
  },
  {
    version: 8,
    description: "Weather service (Open-Meteo, read-only, off until a location is set)",
    sql: `
      INSERT OR IGNORE INTO services (id, name, description, kind, connection_state, access_level, max_level, scopes, last_sync_at)
      VALUES ('weather', 'Weather (Open-Meteo)', 'Read-only forecast for one city-level location. No account or key.', 'real', 'disconnected', 'none', 'read', '["forecast.read"]', NULL);
    `,
  },
  {
    version: 9,
    description: "Gmail drafts service (gmail.compose, drafts only) and reply-threading columns",
    sql: `
      ALTER TABLE messages ADD COLUMN thread_id TEXT;
      ALTER TABLE messages ADD COLUMN rfc_message_id TEXT;
      INSERT OR IGNORE INTO services (id, name, description, kind, connection_state, access_level, max_level, scopes, last_sync_at)
      VALUES ('gmail-drafts', 'Gmail drafts (personal)', 'Creates reply drafts in your Gmail after you approve each one. The app never sends.', 'real', 'disconnected', 'none', 'write_with_approval', '[]', NULL);
    `,
  },
  {
    version: 10,
    description: "Gmail connection moves to gmail.readonly (bodies read on demand, never stored)",
    sql: `UPDATE services SET description = 'Read-only (gmail.readonly): headers are synced; a message body is read on demand for a reply draft and never stored.', scopes = '["gmail.readonly"]' WHERE id = 'gmail';`,
  },
  {
    version: 11,
    description: "Plainer service names: Demo Gmail, Public news",
    sql: `
      UPDATE services SET name = 'Demo Gmail', description = 'Fictional stand-in for Gmail (headers and snippets only).' WHERE id = 'demo-mail';
      UPDATE services SET name = 'Public news (sample feed)' WHERE id = 'public-news';
      UPDATE jobs SET sources = replace(replace(sources, 'Demo Inbox', 'Demo Gmail'), 'Public tech news', 'Public news');
    `,
  },
  {
    version: 12,
    description: "What a running agent is doing right now (shown in the sidebar)",
    sql: `ALTER TABLE agents ADD COLUMN current_step TEXT;`,
  },
  {
    version: 13,
    description: "Assistant features: about-me facts, request board, Gmail insights, notifications",
    sql: `
      CREATE TABLE IF NOT EXISTS memory_facts (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        intent TEXT NOT NULL,
        reply TEXT NOT NULL,
        action_id TEXT,
        run_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS requests_created ON requests (created_at);
      CREATE TABLE IF NOT EXISTS waiting_on (
        thread_id TEXT PRIMARY KEY,
        recipient TEXT NOT NULL,
        subject TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        rfc_message_id TEXT,
        is_demo INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS bookings (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        sender TEXT NOT NULL,
        subject TEXT NOT NULL,
        received_at TEXT NOT NULL,
        is_demo INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS subscriptions (
        sender TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        messages INTEGER NOT NULL,
        last_seen TEXT NOT NULL,
        looks_paid INTEGER NOT NULL DEFAULT 0,
        can_unsubscribe INTEGER NOT NULL DEFAULT 0,
        is_demo INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS notifications_sent (
        key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        sent_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 14,
    description: "Google Calendar app calendar (calendar.app.created): events the app creates after approval",
    sql: `
      INSERT OR IGNORE INTO services (id, name, description, kind, connection_state, access_level, max_level, scopes, last_sync_at)
      VALUES ('google-calendar-app', 'Google Calendar: app calendar', 'Creates the events you approve in a separate “Agent Command Center” calendar. It can''t see or change your other calendars.', 'real', 'disconnected', 'none', 'write_with_approval', '[]', NULL);
    `,
  },  {
    version: 15,
    description: "Opt-in sharing of your own notes to MongoDB Atlas (per note, off by default)",
    sql: `
      ALTER TABLE documents ADD COLUMN atlas_share INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE documents ADD COLUMN atlas_synced_at TEXT;
    `,
  },
  {
    version: 16,
    description: "Impact card: threads answered after a nudge, and where a reminder came from",
    sql: `
      CREATE TABLE IF NOT EXISTS revived_threads (
        thread_id TEXT PRIMARY KEY,
        nudged_at TEXT NOT NULL,
        answered_at TEXT NOT NULL,
        is_demo INTEGER NOT NULL DEFAULT 0
      );
      ALTER TABLE reminders ADD COLUMN source TEXT;
    `,
  },
  {
    version: 17,
    description: "Requests that run in the background: status, progress and the answer they deliver",
    sql: `
      ALTER TABLE requests ADD COLUMN status TEXT;
      ALTER TABLE requests ADD COLUMN progress TEXT;
      ALTER TABLE requests ADD COLUMN result TEXT;
    `,
  },
  {
    version: 18,
    description: "Web search service (the user's own SearXNG on this computer, read-only, access None until granted)",
    sql: `
      INSERT OR IGNORE INTO services (id, name, description, kind, connection_state, access_level, max_level, scopes, last_sync_at)
      VALUES ('web-search', 'Web search (SearXNG, on this computer)', 'Private web search through your own SearXNG: queries go to public search engines without an account; pages are read from public addresses only. Results are untrusted.', 'real', 'connected', 'none', 'read', '["search.read","page.read"]', NULL);
    `,
  },
];

export const LATEST_VERSION = MIGRATIONS.at(-1)?.version ?? 1;

export function migrate(db: DatabaseSync): { from: number; to: number } {
  const from = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version || 1;
  let current = from;
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      // Re-check inside the lock: another process (web vs worker) may have just migrated.
      const now = (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version || 1;
      if (m.version > now) {
        db.exec(m.sql);
        db.exec(`PRAGMA user_version = ${m.version}`);
      }
      db.exec("COMMIT");
      current = m.version;
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(`Database migration ${m.version} (${m.description}) failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  return { from, to: current };
}

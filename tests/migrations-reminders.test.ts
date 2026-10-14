import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb, all } from "@/server/db";
import { LATEST_VERSION, migrate } from "@/server/migrations";
import { approveAction, executeAction, proposeAction } from "@/server/approvals";
import { setServiceLevel } from "@/server/policy/permissions";
import { deleteReminder, listReminders, setReminderDone } from "@/server/reminders";
import { seededCtx } from "./helpers";

describe("migrations", () => {
  it("a new database is created at the latest version", async () => {
    const db = openDb(":memory:");
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(LATEST_VERSION);
  });

  it("upgrades an existing version-1 database in place, keeping its data", async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "acc-mig-")), "old.sqlite");
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE jobs (id TEXT PRIMARY KEY, name TEXT NOT NULL, purpose TEXT NOT NULL, agent_id TEXT NOT NULL, workflow TEXT NOT NULL, cron TEXT NOT NULL,
      timezone TEXT NOT NULL, sources TEXT NOT NULL, destination TEXT NOT NULL, requirements TEXT NOT NULL, status TEXT NOT NULL, status_reason TEXT,
      next_run_at TEXT, last_run_at TEXT, last_result TEXT, max_attempts INTEGER NOT NULL DEFAULT 3, simulated INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
      CREATE TABLE messages (id TEXT PRIMARY KEY, sender TEXT NOT NULL, subject TEXT NOT NULL, snippet TEXT NOT NULL, received_at TEXT NOT NULL, needs_reply INTEGER NOT NULL DEFAULT 0, is_demo INTEGER NOT NULL DEFAULT 1);
      CREATE TABLE events (id TEXT PRIMARY KEY, title TEXT NOT NULL, starts_at TEXT NOT NULL, ends_at TEXT NOT NULL, location TEXT, notes TEXT, is_demo INTEGER NOT NULL DEFAULT 1);
      INSERT INTO jobs VALUES ('j1','Old job','p','a','w','* * * * *','UTC','[]','d','[]','active',NULL,NULL,NULL,NULL,3,1,'2026-01-01');`);
    old.close();
    const db = openDb(file);
    expect(all<{ name: string; created_by: string }>(db, "SELECT name, created_by FROM jobs")).toEqual([{ name: "Old job", created_by: "seed" }]);
    expect(all(db, "SELECT name FROM sqlite_master WHERE name IN ('reminders','oauth_connections')")).toHaveLength(2);
    expect(migrate(db)).toEqual({ from: LATEST_VERSION, to: LATEST_VERSION }); // idempotent
  });
});

describe("first run", () => {
  it("a brand-new database counts as unseeded even though migrations created some rows", async () => {
    const { isSeeded, resetDemo } = await import("@/server/seed/seed");
    const ctx = { db: openDb(":memory:"), now: () => new Date() };
    expect(isSeeded(ctx)).toBe(false);
    resetDemo(ctx);
    expect(isSeeded(ctx)).toBe(true);
    expect(all(ctx.db, "SELECT * FROM jobs").length).toBeGreaterThan(0);
  });
});

describe("reminders", () => {
  it("an approved, executed reminder action appears once, and can be completed and deleted", async () => {
    const ctx = seededCtx();
    setServiceLevel(ctx, "local-tasks", "write_with_approval");
    const a = proposeAction(ctx, { agentId: "follow_up", serviceId: "local-tasks", kind: "reminder", title: "Quotes", payload: { text: "Get insurance quotes" }, idempotencyKey: "r1" });
    approveAction(ctx, a.id, a.payload_hash, "user");
    await executeAction(ctx, a.id);
    await executeAction(ctx, a.id);
    const list = listReminders(ctx);
    expect(list).toHaveLength(1);
    expect(list[0].text).toBe("Get insurance quotes");
    setReminderDone(ctx, list[0].id, true);
    expect(listReminders(ctx)[0].done_at).toBeTruthy();
    deleteReminder(ctx, list[0].id);
    expect(listReminders(ctx)).toHaveLength(0);
  });
});

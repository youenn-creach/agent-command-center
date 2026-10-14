import { describe, expect, it } from "vitest";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDb } from "@/server/db";
import { loadConfig } from "@/server/config";

describe("private data files", () => {
  it("creates the database readable by its owner only, in an owner-only folder", () => {
    const dir = path.join(mkdtempSync(path.join(tmpdir(), "acc-perm-")), "data");
    const file = path.join(dir, "acc.sqlite");
    const db = openDb(file);
    db.close();
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("ACC_PEER_URL must be a local http(s) address", () => {
    expect(loadConfig({ ACC_PEER_URL: "http://127.0.0.1:3001" }).ACC_PEER_URL).toBe("http://127.0.0.1:3001");
    for (const bad of ["file://localhost/etc/passwd", "javascript:alert(1)", "https://example.com", "http://192.168.1.5:3001"]) {
      expect(() => loadConfig({ ACC_PEER_URL: bad }), bad).toThrow();
    }
  });
});

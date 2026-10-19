import { describe, expect, it } from "vitest";
import { all, openDb, run, tx } from "@/server/db";

describe("tx: nested calls are savepoints, all-or-nothing", () => {
  it("a nested tx commits with the outer one, and a failing nested tx rolls back only itself", () => {
    const db = openDb(":memory:");
    run(db, "CREATE TABLE t (v TEXT)");
    tx(db, () => {
      run(db, "INSERT INTO t VALUES ('outer')");
      tx(db, () => run(db, "INSERT INTO t VALUES ('inner')"));
      expect(() => tx(db, () => { run(db, "INSERT INTO t VALUES ('lost')"); throw new Error("x"); })).toThrow("x");
    });
    expect(all<{ v: string }>(db, "SELECT v FROM t ORDER BY rowid").map((r) => r.v)).toEqual(["outer", "inner"]);
  });
  it("an outer failure undoes the nested work too", () => {
    const db = openDb(":memory:");
    run(db, "CREATE TABLE t (v TEXT)");
    expect(() => tx(db, () => { tx(db, () => run(db, "INSERT INTO t VALUES ('inner')")); throw new Error("outer"); })).toThrow("outer");
    expect(all(db, "SELECT * FROM t")).toEqual([]);
  });
});

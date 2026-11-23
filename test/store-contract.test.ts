// The Store port's contract, the same cases on every runtime: this file runs in the Workers pool (a Durable
// Object's SQLite) and on the bun runtime (bun:sqlite files), each through its own `cloudflare:test`.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { WorkspaceHost } from "../src/adapters/workspace-host";
import { MIGRATIONS, TABLES } from "../src/core/schema";

let n = 0;
/** A workspace host nobody used yet: its store fresh from the migrations. */
const fresh = <R>(fn: (h: WorkspaceHost) => R | Promise<R>) => runInDurableObject(env.WORKSPACE.get(env.WORKSPACE.idFromName(`store-${++n}`)), (o: { host: WorkspaceHost }) => fn(o.host));

describe(`the store contract (${typeof (globalThis as { Bun?: unknown }).Bun === "object" ? "bun:sqlite" : "Durable Object SQLite"})`, () => {
  it("a new store has every table of the migrations, each migration recorded once", () =>
    fresh((h) => {
      const names = h.store.rows<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite%'").map((r) => r.name);
      expect(names.sort()).toEqual([...TABLES].sort());
      expect(h.store.rows("SELECT v FROM _migrations ORDER BY v")).toEqual(MIGRATIONS.map((_, i) => ({ v: i + 1 })));
    }));

  it("exec counts the rows written; an ignored or matching-nothing write counts 0", () =>
    fresh((h) => {
      const s = h.store;
      expect(s.exec("INSERT INTO claims VALUES (?, ?, ?, ?, ?)", 1, "dev1", "developer", 10, 10).rowsWritten).toBe(1);
      expect(s.exec("INSERT OR IGNORE INTO claims VALUES (?, ?, ?, ?, ?)", 1, "dev2", "developer", 10, 10).rowsWritten).toBe(0);
      expect(s.exec("UPDATE claims SET touched = ? WHERE n = ?", 20, 1).rowsWritten).toBe(1);
      expect(s.exec("UPDATE claims SET touched = ? WHERE n = ?", 20, 99).rowsWritten).toBe(0);
      expect(s.exec("DELETE FROM claims WHERE n = ?", 1).rowsWritten).toBe(1);
    }));

  it("rows returns plain objects by column name: integers, text, null, blobs as ArrayBuffer, aggregates", () =>
    fresh((h) => {
      const s = h.store;
      s.exec("CREATE TABLE t (i INTEGER, s TEXT, z TEXT, b BLOB)");
      s.exec("INSERT INTO t VALUES (?, ?, ?, ?)", 7, "ü ✓", null, new Uint8Array([1, 2, 3]).buffer);
      const [r] = s.rows<{ i: number; s: string; z: null; b: ArrayBuffer }>("SELECT * FROM t");
      expect({ i: r.i, s: r.s, z: r.z }).toEqual({ i: 7, s: "ü ✓", z: null });
      expect(r.b).toBeInstanceOf(ArrayBuffer);
      expect([...new Uint8Array(r.b)]).toEqual([1, 2, 3]);
      expect(s.rows("SELECT count(*) AS c, MAX(i) AS m FROM t WHERE i > ?", 100)).toEqual([{ c: 0, m: null }]);
      expect(s.rows("SELECT i FROM t WHERE s = ?", "nope")).toEqual([]);
    }));

  it("exec runs several statements at once (the migrations' form)", () =>
    fresh((h) => {
      h.store.exec("CREATE TABLE a (x INTEGER); CREATE TABLE b (y INTEGER);");
      h.store.exec("INSERT INTO a VALUES (?)", 1);
      expect(h.store.rows("SELECT x FROM a")).toEqual([{ x: 1 }]);
      expect(h.store.rows("SELECT y FROM b")).toEqual([]);
    }));

  it("a bad statement throws and changes nothing", () =>
    fresh((h) => {
      expect(() => h.store.exec("INSERT INTO nowhere VALUES (1)")).toThrow();
      expect(() => h.store.exec("INSERT INTO claims VALUES (?, ?, ?, ?, ?)", 1, null, "r", 1, 1)).toThrow();
      expect(h.store.rows("SELECT * FROM claims")).toEqual([]);
    }));

  it("autoincrement ids keep rising and the order of insertion is kept", () =>
    fresh((h) => {
      for (const t of ["a", "b", "c"]) h.store.exec("INSERT INTO answers (n, ts, text, via) VALUES (1, 1, ?, 'api')", t);
      expect(h.store.rows("SELECT id, text FROM answers ORDER BY id")).toEqual([
        { id: 1, text: "a" },
        { id: 2, text: "b" },
        { id: 3, text: "c" },
      ]);
    }));

  it("wiping a workspace empties its store and leaves it migrated", async () => {
    await fresh(async (h) => {
      h.store.exec("INSERT INTO meta VALUES ('k', 'v')");
      h.store.exec("CREATE TABLE extra (x INTEGER)");
      await h.wipe();
      expect(h.store.rows("SELECT * FROM meta")).toEqual([]);
      expect(h.store.rows("SELECT name FROM sqlite_master WHERE name = 'extra'")).toEqual([]);
      expect(h.store.rows("SELECT count(*) AS c FROM _migrations")).toEqual([{ c: MIGRATIONS.length }]);
    });
  });
});

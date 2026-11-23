// The Store port on bun:sqlite: one database file per workspace (and one for the managed instance), WAL, the same
// SQL and migrations as a Durable Object's storage.
import { Database } from "bun:sqlite";
import type { Store, Value } from "../../ports/store";

const bind = (a: Value[]) => a.map((v) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v));
const unblob = <R>(r: Record<string, unknown>) => {
  for (const k in r) if (r[k] instanceof Uint8Array) r[k] = (r[k] as Uint8Array).slice().buffer;
  return r as R;
};

export class SqliteStore implements Store {
  readonly db: Database;
  constructor(path: string) {
    this.db = new Database(path, { create: true, strict: false });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA synchronous = NORMAL");
    this.db.run("PRAGMA busy_timeout = 5000");
  }
  exec(q: string, ...a: Value[]) {
    return { rowsWritten: this.db.run(q, bind(a) as never[]).changes };
  }
  rows<R extends Record<string, Value>>(q: string, ...a: Value[]): R[] {
    return (this.db.query(q).all(...(bind(a) as never[])) as Record<string, unknown>[]).map((r) => unblob<R>(r));
  }
  /** Drops every table (a wiped workspace starts again from the migrations). */
  clear() {
    const tables = this.db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
    for (const t of tables) this.db.run(`DROP TABLE IF EXISTS "${t.name}"`);
  }
  close() {
    this.db.close();
  }
}

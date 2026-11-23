// Durable storage of one workspace: SQLite-dialect SQL (Durable Object SQLite, D1, bun:sqlite all speak it).
// One store per workspace: no table carries a workspace column because no store is shared.
export type Value = string | number | null | ArrayBuffer;

export interface Store {
  exec(sql: string, ...args: Value[]): { rowsWritten: number };
  rows<R extends Record<string, Value>>(sql: string, ...args: Value[]): R[];
}

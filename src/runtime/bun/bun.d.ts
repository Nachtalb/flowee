// The few Bun and Node APIs the bun runtime uses, declared here so the one tsconfig (Workers types) checks it too.
declare module "bun:sqlite" {
  export class Database {
    constructor(path: string, o?: { create?: boolean; strict?: boolean; readonly?: boolean });
    run(sql: string, params?: unknown[]): { changes: number; lastInsertRowid: number };
    query(sql: string): { all(...params: unknown[]): unknown[]; get(...params: unknown[]): unknown };
    close(): void;
  }
}

declare module "node:fs" {
  export function mkdirSync(path: string, o?: { recursive?: boolean; mode?: number }): void;
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, enc: "utf8"): string;
  export function writeFileSync(path: string, data: string, o?: { mode?: number; flag?: string }): void;
  export function statSync(path: string): { size: number; mtimeMs: number; isFile(): boolean };
  export function readdirSync(path: string): string[];
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, o?: { recursive?: boolean; force?: boolean }): void;
}

declare module "node:crypto" {
  export function createHash(alg: string): { update(s: string): { digest(enc: "hex"): string } };
}

declare module "node:os" {
  export function tmpdir(): string;
}

declare module "node:path" {
  export function join(...p: string[]): string;
  export function resolve(...p: string[]): string;
  export function dirname(p: string): string;
}

interface BunSocket {
  data: { key: string };
  send(text: string): void;
}

interface BunServer {
  port: number;
  stop(closeActive?: boolean): Promise<void>;
}

declare const Bun: {
  serve(o: {
    port: number;
    hostname?: string;
    idleTimeout?: number;
    fetch(req: Request, server: { requestIP(r: Request): { address: string } | null; upgrade(req: Request, o: { data: { key: string } }): boolean }): Response | undefined | Promise<Response | undefined>;
    websocket?: { idleTimeout?: number; open(ws: BunSocket): void; message(ws: BunSocket, m: string | Uint8Array): void; close(ws: BunSocket): void };
  }): BunServer;
  file(path: string): Blob & { exists(): Promise<boolean>; text(): Promise<string> };
  argv: string[];
  version: string;
};

declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  execPath: string;
  pid: number;
  exitCode?: number;
  exit(code?: number): never;
  on(signal: "SIGTERM" | "SIGINT", fn: () => void): void;
  stderr: { write(s: string): void };
  stdout: { write(s: string): void };
};

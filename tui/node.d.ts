// The Node APIs flowee-tui uses beyond those src/runtime/bun/bun.d.ts declares (one tsconfig, Workers types).
declare module "node:fs" {
  export function chmodSync(path: string, mode: number): void;
  export function readFileSync(path: string): Uint8Array;
}

declare module "node:os" {
  export function homedir(): string;
}

declare module "node:path" {
  export function basename(p: string): string;
}

declare module "node:child_process" {
  export function spawn(cmd: string, args: string[], o?: { stdio?: "ignore" | "inherit"; detached?: boolean }): { unref(): void };
}

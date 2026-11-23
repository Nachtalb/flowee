// The bun runtime behind the `cloudflare:test` API the suites use (vitest.bun.config.ts aliases it here): one App on a
// fresh data directory per test file, `SELF` its fetch handler, Durable Object stubs its hosts. The scheduler does
// not run: alarms run when a test asks, as `runDurableObjectAlarm` does on Cloudflare.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import type { Env } from "../../src/adapters/instance";
import { App } from "../../src/runtime/bun/app";
import type { Platform } from "../../src/runtime/platform";
import { route } from "../../src/runtime/router";
import { bindings } from "../bindings";

const dir = mkdtempSync(join(tmpdir(), "flowee-bun-test-"));
export const app = new App({ ...bindings, VERSION: { id: "test" } } as Env & Record<string, unknown>, { data: dir, port: 0, host: "127.0.0.1", debug: false, assets: "served" }, (level, msg, x) => void (level === "error" && console.error(msg, x)));
afterAll(async () => {
  await app.stop();
  rmSync(dir, { recursive: true, force: true });
});

type Stub = { kind: "workspace" | "instance"; id: string };
const host = (s: Stub) => (s.kind === "instance" ? app.instance() : app.workspace(s.id));
const ns = (kind: Stub["kind"]) => ({
  idFromName: (id: string) => id,
  get: (id: string) => new Proxy({ kind, id } as Stub, { get: (t, k) => (k in t ? t[k as keyof Stub] : (...a: unknown[]) => (host(t) as any)[k](...a)) }),
});

export const env = { ...bindings, ...app.env, WORKSPACE: ns("workspace"), INSTANCE: ns("instance") } as any;

/** The router with another environment for the call (the Worker's `fetch(req, env)`); the hosts keep theirs. */
export const platform = (e?: Record<string, unknown>): Platform => ({ ...app.platform, env: (e ? { ...app.env, ...e, ASSETS: app.env.ASSETS } : app.env) as Env });
export const handle = (req: Request, e?: Record<string, unknown>) => route(req, platform(e));

export const SELF = { fetch: (input: RequestInfo | URL, init?: RequestInit) => app.fetch(new Request(input, init)) };

export async function runInDurableObject<R>(stub: Stub, fn: (o: any) => R | Promise<R>): Promise<R> {
  return fn({ host: host(stub) });
}

export async function runDurableObjectAlarm(stub: Stub): Promise<boolean> {
  if (!app.scheduler.take(stub.id)) return false;
  await app.workspace(stub.id).alarm();
  return true;
}

import { env, runInDurableObject, SELF } from "cloudflare:test";
import type { Workspace } from "../src/adapters/store-durable-object";
import { TABLES } from "../src/core/schema";
import type { Flowee } from "../src/core/service";
import { install } from "./fake";

export type Who = "board" | "dev1" | "dev2" | "tester" | "owner";

export function setup() {
  return install();
}

export const stub = (ws = "livedu") => env.WORKSPACE.get(env.WORKSPACE.idFromName(ws));

/** The workspace's service with its store's SQL, as the original tests saw the Flow object. */
export type F = Flowee & {
  sql: { exec: (q: string, ...a: (string | number | null)[]) => { rowsWritten: number } };
  rows: <R extends Record<string, unknown>>(q: string, ...a: (string | number | null)[]) => R[];
};

/** Runs fn inside the workspace's Durable Object (storage seeding, cron, env changes). */
export const inFlow = <R>(fn: (f: F) => R | Promise<R>, ws = "livedu") =>
  runInDurableObject(stub(ws), (o: Workspace) => {
    const f = o.runtime(ws).flow as F;
    f.sql = { exec: (q, ...a) => o.store.exec(q, ...a) };
    return fn(f);
  });

export const inObject = <R>(fn: (o: Workspace) => R | Promise<R>, ws = "livedu") => runInDurableObject(stub(ws), fn);

export async function wipe(ws = "livedu") {
  await inFlow((f) => {
    for (const t of TABLES) f.sql.exec(`DELETE FROM ${t}`);
  }, ws);
}

export async function call(who: Who | string | null, cmd: string, body?: unknown, key?: string, prefix = "s") {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (who) headers.authorization = `Bearer ${prefix}-${who}`;
  if (key) headers["idempotency-key"] = key;
  const get = body === undefined;
  const res = await SELF.fetch(`https://flow.test/v1/${cmd}`, {
    method: get ? "GET" : "POST",
    headers,
    body: get ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

export const claim = (n: number, instance: Who, role: string, touched = Date.now(), ws = "livedu") =>
  inFlow((f) => {
    f.sql.exec("INSERT OR REPLACE INTO claims VALUES (?, ?, ?, ?, ?)", n, instance, role, touched, touched);
  }, ws);

export async function hook(update: Record<string, unknown>, secret = "hook-test") {
  return SELF.fetch("https://flow.test/telegram", {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret },
    body: JSON.stringify(update),
  });
}

export const CARD_TEST = "Looks good.\n\n### For Nick\nKind: test\nChanged: Lessons load faster\nCheck:\n- open a lesson\n- it shows at once";
export const CARD_Q = "### For Nick\nKind: question\nQuestion: Blue or green? I recommend blue.";
export const sha = (c: string) => c.padStart(40, "0");

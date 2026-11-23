// The bun runtime's own parts: the data directory's lock, the scheduler (alarms, the minute's tick, missed wake-ups,
// restarts), configuration from the environment, Telegram by long polling against the fake Bot API, tracker polling
// without a public URL, a soak of concurrent commands and a stop in the middle of a pass.
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "../../src/adapters/instance";
import { WORKSPACE_HEADER } from "../../src/adapters/workspace-host";
import { App, lockData } from "../../src/runtime/bun/app";
import { load, normalise, readEnv } from "../../src/runtime/bun/config";
import { Poller } from "../../src/runtime/bun/poller";
import { Scheduler } from "../../src/runtime/bun/scheduler";
import { bindings } from "../bindings";
import { install } from "../fake";
import workspaces from "../workspaces.json";

const real = globalThis.fetch;
let dir: string;
const apps: App[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "flowee-bun-"));
});
afterEach(async () => {
  for (const a of apps.splice(0)) await a.stop();
  rmSync(dir, { recursive: true, force: true });
});

const until = async (cond: () => boolean, ms = 3000) => {
  for (const end = Date.now() + ms; !cond(); ) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((ok) => setTimeout(ok, 5));
  }
};

const shop = workspaces.workspaces[0];
/** An App over `dir` serving `docs` (default: the test workspaces) with the test secrets. */
function app(docs: unknown = workspaces, extra: Record<string, unknown> = {}) {
  const a = new App({ ...bindings, FLOWEE_CONFIG: JSON.stringify(docs), VERSION: { id: "t" }, ...extra } as Env & Record<string, unknown>, { data: dir, port: 0, host: "127.0.0.1", debug: false }, () => {});
  apps.push(a);
  return a;
}
const api = (a: App, token: string, cmd: string, body?: unknown, key?: string) =>
  a
    .fetch(
      new Request(`https://flowee.test/v1/${cmd}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    )
    .then(async (r) => ({ status: r.status, body: (await r.json()) as Record<string, any> }));

describe("the data directory", () => {
  it("one process owns it: a second owner is refused with one sentence until the first closes it", async () => {
    const first = lockData(dir);
    expect(() => lockData(dir)).toThrow(/^Another Flowee process owns the data directory .*: exactly one process may serve a data directory, so stop that one first\.$/);
    first.close();
    lockData(dir).close();
  });

  it("FLOWEE_KEY is generated into it once, with a note where it is; NAME_FILE reads a secret from a file", async () => {
    writeFileSync(join(dir, "token"), "gh-from-file\n");
    const a = await load({ FLOWEE_DATA: join(dir, "d"), GITHUB_TOKEN_FILE: join(dir, "token"), FLOWEE_CONFIG: JSON.stringify(workspaces) });
    expect(a.problems).toEqual([]);
    expect(a.env.GITHUB_TOKEN).toBe("gh-from-file");
    expect(a.notes).toEqual([expect.stringMatching(/^FLOWEE_KEY was not given: generated .*flowee\.key\. It seals the secrets stored in this directory; losing it loses them\./)]);
    const key = readFileSync(join(dir, "d", "flowee.key"), "utf8").trim();
    expect(a.env.FLOWEE_KEY).toBe(key);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    const b = await load({ FLOWEE_DATA: join(dir, "d"), FLOWEE_CONFIG: JSON.stringify(workspaces) });
    expect([b.env.FLOWEE_KEY, b.notes]).toEqual([key, []]);
    expect(readEnv({ X_FILE: join(dir, "none") }).problems).toEqual([`X_FILE: cannot read ${join(dir, "none")}.`]);
    expect((await load({ FLOWEE_DATA: join(dir, "d"), FLOWEE_CONFIG: "{" })).problems[0]).toMatch(/^FLOWEE_CONFIG: is not JSON/);
  });

  it("a chat without a public URL polls; a public https URL fills the chats and makes them webhooks", () => {
    const doc = () => ({ workspaces: [{ chat: {} }, { chat: { publicUrl: "https://own.example" } }, { chat: { transport: "webhook" } }] }) as any;
    expect(normalise(doc()).workspaces?.map((w) => w.chat)).toEqual([{ transport: "polling" }, { publicUrl: "https://own.example", transport: "webhook" }, { transport: "webhook" }]);
    expect(normalise(doc(), "https://me.example").workspaces?.map((w) => w.chat?.transport)).toEqual(["webhook", "webhook", "webhook"]);
    // Telegram needs https for a webhook: an http URL (a local proxy) still polls Telegram
    expect(normalise(doc(), "http://127.0.0.1:8080").workspaces?.[0].chat).toEqual({ transport: "polling" });
  });
});

describe("the scheduler", () => {
  const sched = (db: Database, clock: { t: number }, ran: string[], fail = new Set<string>()) =>
    new Scheduler(
      db,
      async (room) => {
        ran.push(room);
        if (fail.has(room)) throw new Error("tracker down");
      },
      async () => void ran.push("tick"),
      () => clock.t,
    );

  it("keeps the soonest wake-up per room, ticks once a minute, persists wake-ups and runs missed ones at once after a restart", async () => {
    const db = new Database(join(dir, "s.sqlite"));
    const clock = { t: 1_000_000 };
    const ran: string[] = [];
    let s = sched(db, clock, ran);
    await s.wake("a", clock.t + 5000);
    await s.wake("a", clock.t + 9000); // later: ignored
    await s.wake("b", clock.t + 120_000);
    await s.turn();
    await s.idle();
    expect(ran).toEqual(["tick"]);
    clock.t += 5000;
    await s.turn();
    await s.idle();
    expect(ran).toEqual(["tick", "a"]);
    expect(s.next("a")).toBeUndefined();
    clock.t += 30_000;
    await s.turn();
    expect(ran).toEqual(["tick", "a"]); // no tick before the minute
    clock.t += 30_000;
    await s.turn();
    await s.idle();
    expect(ran).toEqual(["tick", "a", "tick"]);
    await s.stop();
    // stopped for an hour (or the laptop slept): b's wake-up is still there and runs at the first turn
    clock.t += 3600e3;
    s = sched(db, clock, ran);
    expect(s.next("b")).toBe(1_000_000 + 120_000);
    await s.turn();
    await s.idle();
    expect(ran.slice(3)).toEqual(["b", "tick"]);
    await s.stop();
  });

  it("a failing alarm is retried a minute later, not in a loop", async () => {
    const db = new Database(join(dir, "s.sqlite"));
    const clock = { t: 0 };
    const ran: string[] = [];
    const s = sched(db, clock, ran, new Set(["x"]));
    await s.wake("x", 0);
    await s.turn();
    await s.idle();
    expect(s.next("x")).toBe(60_000);
    await s.turn();
    await s.idle();
    expect(ran.filter((r) => r === "x")).toEqual(["x"]);
    await s.stop();
  });
});

describe("Telegram by long polling", () => {
  it("deletes the webhook, asks for the webhook's update types, keeps the offset across a restart and refuses on 409", async () => {
    const { tg } = install();
    const db = new Database(join(dir, "p.sqlite"));
    const got: number[] = [];
    const log: string[] = [];
    tg.hooks["999:tg-test"] = "https://old.example/telegram";
    tg.pending["999:tg-test"] = [{ update_id: 10 }, { update_id: 11 }];
    let p = new Poller("main", "999:tg-test", ["message", "callback_query"], async (u) => void got.push(u.update_id), { db, log: (m) => log.push(m), sleep: async () => {} });
    await until(() => got.length === 2);
    await p.close();
    expect(tg.of("deleteWebhook")).toEqual([{ drop_pending_updates: false }]);
    expect(tg.of("getUpdates")[0]).toEqual({ offset: 0, timeout: 50, allowed_updates: ["message", "callback_query"] });
    // the next process starts after the last handled update: nothing twice, nothing lost
    tg.pending["999:tg-test"].push({ update_id: 12 });
    p = new Poller("main", "999:tg-test", ["message", "callback_query"], async (u) => void got.push(u.update_id), { db, log: (m) => log.push(m), sleep: async () => {} });
    await until(() => got.length === 3);
    await p.close();
    expect(got).toEqual([10, 11, 12]);
    expect(tg.of("getUpdates").at(-1)?.offset).toBe(13);
    // another consumer: one sentence, the loop ends
    tg.conflict = true;
    p = new Poller("main", "999:tg-test", ["message"], async () => {}, { db, log: (m) => log.push(m), sleep: async () => {} });
    await p.done;
    expect(p.state).toBe("conflict");
    expect(log.at(-1)).toMatch(/^telegram main: another consumer holds this bot \(Telegram answered 409: Conflict: terminated by other getUpdates request.*\); stop the other Flowee process or remove its webhook, then restart\.$/);
  });

  it("backs off while Telegram is down and goes on when it is back", async () => {
    const { tg } = install();
    const db = new Database(join(dir, "p.sqlite"));
    const naps: number[] = [];
    tg.down = true;
    tg.pending["999:tg-test"] = [{ update_id: 1 }];
    const got: number[] = [];
    const p = new Poller("main", "999:tg-test", ["message"], async (u) => void got.push(u.update_id), {
      db,
      log: () => {},
      sleep: async (ms) => {
        naps.push(ms);
        if (naps.length === 3) tg.down = false;
      },
    });
    await until(() => got.length === 1);
    await p.close();
    expect(naps).toEqual([1000, 2000, 5000]);
  });

  it("a standalone bot with chat.transport polling: updates reach the workspace's envoy once, across a restart", async () => {
    const { tg } = install();
    const doc = { flowee: 1, workspaces: [{ ...shop, chat: { ...shop.chat, transport: "polling" } }] };
    let a = app(doc);
    await a.start(false);
    expect([...a.pollers.keys()]).toEqual(["main"]);
    const owner = Number(shop.owners[0].chat);
    const msg = (id: number, text: string) => ({ update_id: id, message: { message_id: id, chat: { id: owner, type: "private" }, from: { id: owner }, text } });
    tg.pending["999:tg-test"] = [msg(500, "/help")];
    const sent = () => tg.calls.filter((c) => /^send/.test(c.method)).length;
    await until(() => sent() > 0);
    const after = sent();
    const seen = () => a.workspace("shop").store.rows("SELECT update_id FROM updates ORDER BY update_id");
    expect(seen()).toEqual([{ update_id: 500 }]);
    await a.stop();
    apps.length = 0;
    tg.pending["999:tg-test"].push(msg(501, "/help"));
    a = app(doc);
    await a.start(false);
    await until(() => sent() > after);
    expect(a.workspace("shop").store.rows("SELECT update_id FROM updates ORDER BY update_id")).toEqual([{ update_id: 500 }, { update_id: 501 }]);
    // the profile was set at start, without a webhook
    expect(tg.of("setMyCommands").length).toBeGreaterThan(0);
    expect(tg.of("setWebhook")).toEqual([]);
  });
});

describe("the served material, self-hosted", () => {
  it("the root document says where it runs and how updates arrive; /validate is limited per client address over HTTP", async () => {
    install();
    const { publicUrl: _, ...chat } = shop.chat as typeof shop.chat & { publicUrl?: string };
    const a = app({ flowee: 1, workspaces: [{ ...shop, chat: { ...chat, transport: "polling" } }] });
    await a.start(true);
    const base = `http://127.0.0.1:${a.port}`;
    const md = await (await real(`${base}/`)).text();
    expect(md).toContain(`- Base URL: ${base}\n`);
    expect(md).toContain("- Runs on: a self-hosted Flowee process; chat updates by polling; no public URL, so tracker changes are polled\n");
    const post = (ip: string) => real(`${base}/validate`, { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: "{}" }).then((r) => r.status);
    // a client naming another address each time is still one address
    const codes = await Promise.all(Array.from({ length: 31 }, (_, i) => post(`203.0.113.${i}`)));
    expect(codes.filter((c) => c === 429)).toHaveLength(1);
    expect((await real(`${base}/health`)).status).toBe(200);
  });
});

describe("trackers without a public URL", () => {
  it("fall back to polling with the reason, listed on the minute's tick", async () => {
    const { gh } = install();
    gh.add({ state_label: "ready for development" });
    const { publicUrl: _, ...chat } = shop.chat as typeof shop.chat & { publicUrl?: string };
    const a = app({ flowee: 1, workspaces: [{ ...shop, chat: { ...chat, transport: "polling" }, sync: { webhooks: "auto", pollMinutes: 1 } }] });
    await a.start(false);
    await until(() => gh.auth.length > 0);
    await new Promise((ok) => setTimeout(ok, 20));
    await a.scheduler.idle();
    const r = await api(a, "s-board", "sync");
    expect(r.body.sync.repos[0]).toMatchObject({ mode: "poll", reason: "no public URL is configured (chat.publicUrl or instance.publicUrl)" });
    // the tick listed the repository (polling), and registered no hook
    expect(gh.auth.length).toBeGreaterThan(0);
    expect(gh.writes.filter((w) => w.includes("hooks"))).toEqual([]);
  });
});

describe("under load", () => {
  it("500 commands across 3 workspaces at once: every one answered, none lost, none applied twice, no deadlock", async () => {
    const f = install();
    // every tracker answer takes a little while, so commands interleave at their awaits
    const fetch0 = globalThis.fetch;
    globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
      await new Promise((ok) => setTimeout(ok, Math.random() * 3));
      return fetch0(i, init);
    }) as typeof fetch;
    const a = app();
    const ws = [
      { id: "shop", token: "s-board", repo: f.gh },
      { id: "other", token: "o-board", repo: f.gh2 },
      { id: "viewer", token: "p-board", repo: f.viewer },
    ];
    const jobs = Array.from({ length: 500 }, (_, i) => ({ w: ws[i % 3], i }));
    const t = Date.now();
    const res = await Promise.all(jobs.map(({ w, i }) => (i % 10 === 9 ? api(a, w.token, "queue") : api(a, w.token, "file", { title: `Soak ${i}`, body: "## Acceptance\n- works" }, `k-${i}`))));
    expect(res.filter((r) => r.status !== 200)).toEqual([]);
    for (const w of ws) {
      const filed = jobs.filter((j) => j.w === w && j.i % 10 !== 9).length;
      expect(w.repo.issues.size).toBe(filed);
      expect(new Set([...w.repo.issues.values()].map((x) => x.title)).size).toBe(filed);
      const h = a.workspace(w.id);
      expect(h.store.rows("SELECT count(*) AS c FROM entered")).toEqual([{ c: filed }]);
      expect(h.store.rows("SELECT count(*) AS c FROM idem")).toEqual([{ c: filed }]);
    }
    // the same keys again: the stored answers, nothing filed twice
    const again = await Promise.all(jobs.slice(0, 30).filter((j) => j.i % 10 !== 9).map(({ w, i }) => api(a, w.token, "file", { title: `Soak ${i}`, body: "## Acceptance\n- works" }, `k-${i}`)));
    expect(again.map((r) => r.body)).toEqual(jobs.slice(0, 30).filter((j) => j.i % 10 !== 9).map((j) => res[j.i].body));
    expect(f.gh.issues.size + f.gh2.issues.size + f.viewer.issues.size).toBe(450);
    console.log(`soak: 500 commands over 3 workspaces in ${Date.now() - t} ms`);
  }, 60_000);

  it("a stop in the middle of a pass waits for it; the next start finds its writes and its wake-up", async () => {
    const f = install();
    f.gh.add({ state_label: "ready for development" });
    let release!: () => void;
    const gate = new Promise<void>((ok) => (release = ok));
    const fetch0 = globalThis.fetch;
    let held = false;
    globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(new Request(i, init).url);
      if (u.pathname === "/repos/acme/shop/issues" && !held) {
        held = true;
        await gate;
      }
      return fetch0(i, init);
    }) as typeof fetch;
    let a = app({ flowee: 1, workspaces: [shop] });
    const pass = a.workspace("shop").fetch(new Request("https://flowee/cron", { method: "POST", headers: { [WORKSPACE_HEADER]: "shop" } }));
    await until(() => held);
    let stopped = false;
    const stop = a.stop().then(() => (stopped = true));
    await new Promise((ok) => setTimeout(ok, 50));
    expect(stopped).toBe(false);
    release();
    await pass;
    await stop;
    apps.length = 0;
    const db = new Database(join(dir, "workspaces", "shop.sqlite"));
    expect((db.query("SELECT v FROM meta WHERE k = 'workspace'").get() as { v: string }).v).toBe("shop");
    db.close();
    const lock = new Database(join(dir, "flowee.sqlite"));
    const at = (lock.query("SELECT at FROM alarms WHERE room = 'shop'").get() as { at: number } | null)?.at;
    lock.close();
    expect(at).toBeGreaterThan(Date.now());
    a = app({ flowee: 1, workspaces: [shop] });
    expect(a.scheduler.next("shop")).toBe(at);
    expect(existsSync(join(dir, "flowee.sqlite"))).toBe(true);
  });
});

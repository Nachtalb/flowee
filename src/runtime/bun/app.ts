// The bun runtime: one process serving the router over Bun.serve, a host per workspace on its own SQLite file,
// the scheduler in place of alarms and the cron, Telegram by polling where no webhook is configured. Exactly one
// process may own a data directory: it holds an exclusive SQLite lock on <data>/flowee.sqlite until it exits.
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { ALLOWED_UPDATES, INSTANCE_UPDATES, setTelegramApi } from "../../adapters/chat-telegram";
import { bot, type Env, instanceDoc, mode, registry } from "../../adapters/instance";
import { InstanceHost } from "../../adapters/instance-host";
import { envSecrets, WorkspaceHost } from "../../adapters/workspace-host";
import type { Platform, Room } from "../platform";
import { each, polled, route, tick } from "../router";
import { Poller } from "./poller";
import { Scheduler } from "./scheduler";
import { SqliteStore } from "./store";
import type { Options } from "./config";

// The Workers extension the shared code compares secrets with (src/core/text.ts, src/api/http.ts), in constant time.
const subtle = crypto.subtle as SubtleCrypto & { timingSafeEqual?: (a: ArrayBufferView | ArrayBuffer, b: ArrayBufferView | ArrayBuffer) => boolean };
subtle.timingSafeEqual ??= (a, b) => {
  const x = a instanceof ArrayBuffer ? new Uint8Array(a) : new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  const y = b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  if (x.length !== y.length) throw new TypeError("timingSafeEqual: the inputs differ in length");
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
};

export type Log = (level: "debug" | "info" | "warn" | "error", msg: string, extra?: Record<string, unknown>) => void;

export const jsonLog =
  (debug: boolean): Log =>
  (level, msg, extra) => {
    if (level === "debug" && !debug) return;
    process.stderr.write(`${JSON.stringify({ t: new Date().toISOString(), level, msg, ...extra })}\n`);
  };

/** The exclusive lock of a data directory; refuses with one sentence when another process holds it. */
export function lockData(dir: string): Database {
  mkdirSync(dir, { recursive: true });
  const db = new Database(join(dir, "flowee.sqlite"), { create: true });
  try {
    db.run("PRAGMA busy_timeout = 0");
    db.run("PRAGMA locking_mode = EXCLUSIVE");
    db.run("BEGIN EXCLUSIVE");
    db.run("CREATE TABLE IF NOT EXISTS owner (pid INTEGER NOT NULL, since INTEGER NOT NULL)");
    db.run("DELETE FROM owner");
    db.run("INSERT INTO owner VALUES (?, ?)", [process.pid, Date.now()]);
    db.run("COMMIT");
  } catch {
    db.close();
    throw new Error(`Another Flowee process owns the data directory ${dir}: exactly one process may serve a data directory, so stop that one first.`);
  }
  return db;
}

/** The ASSETS binding the served material reads (scripts/bundle.ts builds the directory). */
const assets = (dir: string) => ({
  async fetch(r: Request | string): Promise<Response> {
    const req = typeof r === "string" ? new Request(r) : r;
    const path = resolve(dir, `.${decodeURIComponent(new URL(req.url).pathname)}`);
    if (!path.startsWith(`${dir}/`) || !existsSync(path) || !statSync(path).isFile()) return new Response(null, { status: 404 });
    const st = statSync(path);
    const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
    if (req.headers.get("if-none-match")?.split(/,\s*/).includes(etag)) return new Response(null, { status: 304, headers: { etag } });
    return new Response(Bun.file(path), { headers: { etag } });
  },
});

let embedded: Record<string, [string, string]> | undefined;
/** The compiled executable's served material: path → [embedded file, ETag]. */
export const embed = (files: Record<string, [string, string]>) => void (embedded = files);

const embeddedAssets = (files: Record<string, [string, string]>) => ({
  async fetch(r: Request | string): Promise<Response> {
    const req = typeof r === "string" ? new Request(r) : r;
    const hit = files[decodeURIComponent(new URL(req.url).pathname)];
    if (!hit) return new Response(null, { status: 404 });
    const [file, etag] = hit;
    if (req.headers.get("if-none-match")?.split(/,\s*/).includes(etag)) return new Response(null, { status: 304, headers: { etag } });
    return new Response(Bun.file(file), { headers: { etag } });
  },
});

export class App {
  readonly platform: Platform;
  readonly scheduler: Scheduler;
  readonly lock: Database;
  private hosts = new Map<string, WorkspaceHost>();
  private stores: SqliteStore[] = [];
  private inst?: InstanceHost;
  pollers = new Map<string, Poller>();
  private server?: { port: number; stop(closeActive?: boolean): Promise<void> };
  private closing = false;

  constructor(
    readonly env: Env & Record<string, unknown>,
    readonly o: Options,
    readonly log: Log = jsonLog(o.debug),
  ) {
    if (o.telegramApi) setTelegramApi(o.telegramApi);
    env.FLOWEE_RUNTIME = "bun";
    if (o.publicUrl) env.FLOWEE_PUBLIC_URL = o.publicUrl;
    // a served/ directory given or next to the process wins; else what the executable embeds
    const reader = o.assets ? assets(resolve(o.assets)) : embedded && embeddedAssets(embedded);
    if (reader) (env as Record<string, unknown>).ASSETS = reader;
    this.lock = lockData(o.data);
    mkdirSync(join(o.data, "workspaces"), { recursive: true });
    this.platform = { env, workspace: (id) => this.workspace(id), instance: () => this.instance() };
    this.scheduler = new Scheduler(
      this.lock,
      (id) => this.workspace(id).alarm(),
      async () => {
        await tick(this.platform);
        await this.poll();
      },
      () => Date.now(),
      (m) => this.log("warn", m),
      (o.tick ?? 60) * 1000,
    );
  }

  private store(name: string) {
    const s = new SqliteStore(join(this.o.data, name));
    this.stores.push(s);
    return s;
  }

  workspace(id: string): WorkspaceHost {
    if (!/^[a-z0-9-]+$/.test(id)) throw new Error(`'${id}' is no workspace id`);
    let h = this.hosts.get(id);
    if (!h) {
      const store = this.store(`workspaces/${id}.sqlite`);
      const room: Room = { store, wake: (at) => this.scheduler.wake(id, at), clear: async () => store.clear() };
      h = new WorkspaceHost(room, this.env);
      this.hosts.set(id, h);
    }
    return h;
  }

  instance(): InstanceHost {
    if (!this.inst) {
      const store = this.store("instance.sqlite");
      this.inst = new InstanceHost({ store, wake: async () => {}, clear: async () => store.clear() }, this.env, this.platform);
    }
    return this.inst;
  }

  /** One HTTP request: /health for the container's check, everything else the router's. */
  fetch = async (req: Request, server?: { requestIP(r: Request): { address: string } | null }): Promise<Response> => {
    const t = Date.now();
    if (server) {
      // the client's address for the per-address limits (cf-connecting-ip on Cloudflare); never the client's own claim
      const fwd = this.o.trustProxy ? req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() : undefined;
      const h = new Headers(req.headers);
      h.set("cf-connecting-ip", fwd || server.requestIP(req)?.address || "unknown");
      req = new Request(req, { headers: h });
    }
    const path = new URL(req.url).pathname;
    let res: Response;
    try {
      res = path === "/health" ? Response.json({ ok: !this.closing }, { status: this.closing ? 503 : 200 }) : await route(req, this.platform);
    } catch (e) {
      this.log("error", "request failed", { path, error: e instanceof Error ? e.message : String(e) });
      res = Response.json({ ok: false, error: "internal", message: "The request failed; the log has the reason." }, { status: 500 });
    }
    this.log("debug", "request", { method: req.method, path, status: res.status, ms: Date.now() - t });
    return res;
  };

  /** The bots this process polls for: none with webhooks; one loop per bot otherwise. */
  private async wanted(): Promise<{ id: string; token: string; allowed: string[] }[]> {
    if (mode(this.env) === "managed") {
      const doc = instanceDoc(this.env);
      if (doc.instance?.transport !== "polling") return [];
      return (await this.instance().bots(doc)).map((b) => ({ ...b, allowed: b.id === "main" ? INSTANCE_UPDATES : ALLOWED_UPDATES }));
    }
    const b = bot(this.env);
    const polling = registry(this.env)
      .list()
      .some((w) => w.chat?.transport === "polling");
    const token = b && envSecrets(this.env).get(b.token);
    return polling && token ? [{ id: "main", token, allowed: ALLOWED_UPDATES }] : [];
  }

  /** Starts a loop for every bot that has none (a managed instance gains bots at run time), stops removed ones. */
  async poll() {
    if (this.closing) return;
    const want = await this.wanted();
    for (const b of want) {
      const key = `${b.id}`;
      const cur = this.pollers.get(key);
      if (cur && cur.token === b.token) continue;
      await cur?.close();
      this.pollers.set(key, new Poller(key, b.token, b.allowed, (u) => polled(this.platform, b.id, u), { db: this.lock, log: (m) => this.log("info", m) }));
    }
    for (const [k, p] of this.pollers)
      if (!want.some((b) => b.id === k)) {
        await p.close();
        this.pollers.delete(k);
      }
  }

  /** Serving: the bots' profiles (and, with a public URL, webhooks) set, polling started, the scheduler running. */
  async start(listen = true) {
    const p = this.platform;
    try {
      if (mode(this.env) === "managed") await this.instance().setup(instanceDoc(this.env));
      // what the Worker's deploy does with GET /setup: profiles, webhooks, the workspaces' public URL for tracker hooks
      for (const [id, r] of await each(p, "/setup", this.o.publicUrl)) this.log("info", "setup", { workspace: id, result: r.slice(0, 300) });
    } catch (e) {
      this.log("warn", "setup failed; the next tick tries again", { error: e instanceof Error ? e.message : String(e) });
    }
    if (!this.o.publicUrl) this.log("info", "no public URL (FLOWEE_PUBLIC_URL): Telegram by polling, trackers polled every sync.pollMinutes");
    await this.poll();
    this.scheduler.start();
    if (listen) {
      this.server = Bun.serve({ port: this.o.port, hostname: this.o.host, idleTimeout: 60, fetch: this.fetch });
      this.log("info", "listening", { host: this.o.host, port: this.server.port, data: this.o.data, mode: mode(this.env) });
    }
  }

  get port() {
    return this.server?.port;
  }

  /** Graceful stop: no new requests or updates, the running pass finished, the databases flushed and closed. */
  async stop() {
    if (this.closing) return;
    this.closing = true;
    await this.server?.stop(false);
    await Promise.all([...this.pollers.values()].map((p) => p.close()));
    await this.scheduler.stop();
    await Promise.all([...this.hosts.values()].map((h) => h.idle()));
    for (const s of this.stores) s.close();
    this.lock.close();
    this.log("info", "stopped");
  }
}

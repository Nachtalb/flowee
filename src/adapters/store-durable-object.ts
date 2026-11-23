// One Durable Object per workspace: its SQLite storage is the workspace's Store, its alarm the Clock's wake-up,
// and its single instance serialises the workspace's commands (the lock covers the awaits in between).
import { DurableObject } from "cloudflare:workers";
import { api, json } from "../api/http";
import type { WorkspaceDoc } from "../config/document";
import { settings } from "../config/registry";
import { repoList } from "../config/schema";
import { Repos } from "../core/repos";
import { migrate } from "../core/schema";
import { Flowee } from "../core/service";
import { Envoy } from "../envoy/envoy";
import type { Clock } from "../ports/clock";
import type { Secrets } from "../ports/secrets";
import type { Store, Value } from "../ports/store";
import { Paste } from "./files-paste";
import { GitHub } from "./tracker-github";
import { Telegram } from "./chat-telegram";
import { registry, type Env } from "./instance";
import { unseal, vaultKey } from "./vault";

export const WORKSPACE_HEADER = "x-flowee-workspace";

export class SqlStore implements Store {
  constructor(private sql: SqlStorage) {}
  exec(q: string, ...a: Value[]) {
    return { rowsWritten: this.sql.exec(q, ...a).rowsWritten };
  }
  rows<R extends Record<string, Value>>(q: string, ...a: Value[]): R[] {
    return this.sql.exec<R>(q, ...a).toArray();
  }
}

export const envSecrets = (env: Env): Secrets => ({
  get: (name) => {
    const v = (env as unknown as Record<string, unknown>)[name];
    return typeof v === "string" && v ? v : undefined;
  },
});

export class Workspace extends DurableObject<Env> {
  declare env: Env;
  readonly store: SqlStore;
  private chain: Promise<unknown> = Promise.resolve();
  private rt?: { id: string; flow: Flowee; envoy?: Envoy };
  /** Opened secrets of a managed workspace (sealed in its storage, opened once per object life). */
  private plain?: Map<string, string>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new SqlStore(ctx.storage.sql);
    migrate(this.store);
  }

  lock<R>(fn: () => Promise<R>): Promise<R> {
    const r = this.chain.then(fn);
    this.chain = r.catch(() => {});
    return r;
  }

  /** Builds the workspace's runtime anew on the next request (config or env changed). */
  reset() {
    this.rt = undefined;
    this.plain = undefined;
  }

  /** Managed mode: the instance hands over the document and the sealed secrets it names. */
  async configure(doc: WorkspaceDoc, sealed: Record<string, string>) {
    const stored = this.store.rows<{ v: string }>("SELECT v FROM meta WHERE k = 'workspace'")[0]?.v;
    if (stored && stored !== doc.id) throw new Error(`this object belongs to the workspace '${stored}', not '${doc.id}'`);
    this.store.exec("INSERT OR REPLACE INTO meta VALUES ('workspace', ?)", doc.id);
    this.store.exec("INSERT OR REPLACE INTO meta VALUES ('doc', ?)", JSON.stringify(doc));
    this.store.exec("DELETE FROM meta WHERE k LIKE 'vault:%'");
    for (const [n, v] of Object.entries(sealed)) this.store.exec("INSERT INTO meta VALUES (?, ?)", `vault:${n}`, v);
    this.reset();
  }

  /** Managed mode: the workspace was deleted; its storage goes. */
  async wipe() {
    this.reset();
    await this.ctx.storage.deleteAll();
    migrate(this.store);
  }

  private async unlock() {
    if (this.plain) return;
    const rows = this.store.rows<{ k: string; v: string }>("SELECT k, v FROM meta WHERE k LIKE 'vault:%'");
    const m = new Map<string, string>();
    if (rows.length) {
      const key = await vaultKey(this.env.FLOWEE_KEY);
      for (const r of rows) m.set(r.k.slice(6), await unseal(key, r.v));
    }
    this.plain = m;
  }

  private secrets(): Secrets {
    const env = envSecrets(this.env);
    return { get: (n) => this.plain?.get(n) ?? env.get(n) };
  }

  /** The runtime of this object's workspace (its id arrives with every request and is remembered for the alarm). */
  runtime(id?: string) {
    const stored = this.store.rows<{ v: string }>("SELECT v FROM meta WHERE k = 'workspace'")[0]?.v;
    if (stored && id && stored !== id) throw new Error(`this object belongs to the workspace '${stored}', not '${id}'`);
    const ws = id ?? stored;
    if (!ws) throw new Error("this object belongs to no workspace yet");
    if (!stored) this.store.exec("INSERT OR REPLACE INTO meta VALUES ('workspace', ?)", ws);
    if (this.rt?.id === ws) return this.rt;
    const managed = this.store.rows<{ v: string }>("SELECT v FROM meta WHERE k = 'doc'")[0]?.v;
    const doc = managed ? (JSON.parse(managed) as WorkspaceDoc) : registry(this.env).get(ws);
    if (!doc) throw new Error(`there is no workspace '${ws}'`);
    this.rt = build(doc, this.env, this.store, this.secrets(), {
      now: () => Date.now(),
      wake: async (ms) => {
        const at = await this.ctx.storage.getAlarm();
        if (!at || at > Date.now() + ms) await this.ctx.storage.setAlarm(Date.now() + ms);
      },
    });
    return this.rt;
  }

  get flow() {
    return this.runtime().flow;
  }

  async alarm() {
    await this.unlock();
    const e = this.runtime().envoy;
    if (e) await this.lock(() => e.onAlarm());
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    await this.unlock();
    const rt = this.runtime(req.headers.get(WORKSPACE_HEADER) ?? undefined);
    if (url.pathname === "/cron") {
      await this.lock(() => rt.flow.cron());
      return new Response("ok");
    }
    if (url.pathname === "/setup") return json(rt.envoy ? await this.lock(() => (rt.envoy as Envoy).setup()) : { chat: "none" });
    if (url.pathname.startsWith("/telegram")) {
      const u = await req.json<Record<string, unknown>>().catch(() => null);
      if (u && rt.envoy) await this.lock(() => (rt.envoy as Envoy).onUpdate(u)).catch((e) => console.error("chat update", e));
      return new Response("ok");
    }
    return api(rt.flow, req, url.pathname.replace(/^\/v1\//, ""), (fn) => this.lock(fn));
  }
}

/** Wires a workspace document to its adapters. */
export function build(doc: WorkspaceDoc, env: Env, store: Store, secrets: Secrets, clock: Clock) {
  const s = settings(doc);
  const tracker = new Repos(
    repoList(doc).map((r) => ({
      ...r,
      tracker: new GitHub({ repo: r.repo, api: doc.tracker.api, token: secrets.get(r.token), tokenName: r.token, project: doc.tracker.project }),
    })),
    store,
  );
  const flow = new Flowee(s, tracker, store, clock, secrets);
  let envoy: Envoy | undefined;
  if (doc.chat) {
    const files = doc.files && new Paste(doc.files.url, secrets.get(doc.files.token), doc.files.expire);
    const photo = doc.profile?.photo;
    envoy = new Envoy(flow, new Telegram(secrets.get(doc.chat.token), doc.chat.token), files, async () =>
      photo ? (await fetch(photo)).arrayBuffer() : undefined,
    );
    envoy.version = env.VERSION?.id ?? "dev";
    flow.envoy = envoy;
  }
  return { id: doc.id, flow, envoy };
}

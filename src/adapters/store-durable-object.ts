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
  }

  /** The runtime of this object's workspace (its id arrives with every request and is remembered for the alarm). */
  runtime(id?: string) {
    const stored = this.store.rows<{ v: string }>("SELECT v FROM meta WHERE k = 'workspace'")[0]?.v;
    if (stored && id && stored !== id) throw new Error(`this object belongs to the workspace '${stored}', not '${id}'`);
    const ws = id ?? stored;
    if (!ws) throw new Error("this object belongs to no workspace yet");
    if (!stored) this.store.exec("INSERT OR REPLACE INTO meta VALUES ('workspace', ?)", ws);
    if (this.rt?.id === ws) return this.rt;
    const doc = registry(this.env).get(ws);
    if (!doc) throw new Error(`there is no workspace '${ws}'`);
    this.rt = build(doc, this.env, this.store, {
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
    const e = this.runtime().envoy;
    if (e) await this.lock(() => e.onAlarm());
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const rt = this.runtime(req.headers.get(WORKSPACE_HEADER) ?? undefined);
    if (url.pathname === "/cron") {
      await this.lock(() => rt.flow.cron());
      return new Response("ok");
    }
    if (url.pathname === "/setup") return json(rt.envoy ? await this.lock(() => (rt.envoy as Envoy).setup()) : { chat: "none" });
    if (url.pathname === "/telegram") {
      const u = await req.json<Record<string, unknown>>().catch(() => null);
      if (u && rt.envoy) await this.lock(() => (rt.envoy as Envoy).onUpdate(u)).catch((e) => console.error("chat update", e));
      return new Response("ok");
    }
    return api(rt.flow, req, url.pathname.replace(/^\/v1\//, ""), (fn) => this.lock(fn));
  }
}

/** Wires a workspace document to its adapters. */
export function build(doc: WorkspaceDoc, env: Env, store: Store, clock: Clock) {
  const secrets = envSecrets(env);
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

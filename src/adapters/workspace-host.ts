// The host of one workspace: its room's store is the workspace's Store, the room's wake-up the Clock's, and its
// single instance per workspace (one Durable Object, or one object in the process) serialises the workspace's
// commands (the lock covers the awaits in between). The runtime (src/runtime) makes the room and calls in.
import { api, auth, json } from "../api/http";
import type { WorkspaceDoc } from "../config/document";
import { settings } from "../config/registry";
import { repoList } from "../config/schema";
import { Repos } from "../core/repos";
import { migrate } from "../core/schema";
import { Flowee } from "../core/service";
import { Envoy } from "../envoy/envoy";
import type { Clock } from "../ports/clock";
import type { Secrets } from "../ports/secrets";
import type { Store } from "../ports/store";
import type { Room } from "../runtime/platform";
import { Paste } from "./files-paste";
import { TRACKERS } from "./trackers";
import { chatOf } from "./chats";
import { MAX_FILE, type Terminal, type TuiFrame, type TuiPerson } from "./chat-tui";
import { registry, type Env } from "./instance";
import { PHOTO } from "./photo";
import { seal, unseal, vaultKey } from "./vault";

export const WORKSPACE_HEADER = "x-flowee-workspace";
/** The public origin the deploy called /setup on (standalone): the base of the webhook addresses. */
export const ORIGIN_HEADER = "x-flowee-origin";
/** The terminal person the router resolved from the key (JSON TuiPerson); set by the router only. */
export const PERSON_HEADER = "x-flowee-person";

export const envSecrets = (env: Env): Secrets => ({
  get: (name) => {
    const v = (env as unknown as Record<string, unknown>)[name];
    return typeof v === "string" && v ? v : undefined;
  },
});

export class WorkspaceHost {
  readonly store: Store;
  private chain: Promise<unknown> = Promise.resolve();
  private rt?: { id: string; flow: Flowee; envoy?: Envoy; terminal?: Terminal };
  /** Opened secrets of a managed workspace (sealed in its storage, opened once per object life). */
  private plain?: Map<string, string>;

  constructor(
    private room: Room,
    public env: Env,
  ) {
    this.store = room.store;
    migrate(this.store);
  }

  lock<R>(fn: () => Promise<R>): Promise<R> {
    const r = this.chain.then(fn);
    this.chain = r.catch(() => {});
    return r;
  }

  /** Settles when the commands queued under the lock have run (a graceful stop waits for it). */
  idle() {
    return this.chain.then(() => {});
  }

  /** Builds the workspace's runtime anew on the next request (config or env changed). */
  reset() {
    this.rt = undefined;
    this.plain = undefined;
  }

  /** Managed mode: the instance hands over the document and the sealed secrets it names. */
  async configure(doc: WorkspaceDoc, sealed: Record<string, string>, publicUrl?: string) {
    const stored = this.store.rows<{ v: string }>("SELECT v FROM meta WHERE k = 'workspace'")[0]?.v;
    if (stored && stored !== doc.id) throw new Error(`this object belongs to the workspace '${stored}', not '${doc.id}'`);
    // repositories the new document drops lose their webhooks (only the old runtime still has their trackers)
    const old = stored ? await this.unlock().then(() => this.runtime(doc.id).flow).catch(() => undefined) : undefined;
    const keep = new Set(repoList(doc).map((r) => r.repo));
    for (const r of old?.tracker.list ?? []) if (!keep.has(r.repo)) await old?.events.disable(r);
    this.store.exec("INSERT OR REPLACE INTO meta VALUES ('workspace', ?)", doc.id);
    this.store.exec("INSERT OR REPLACE INTO meta VALUES ('doc', ?)", JSON.stringify(doc));
    // the instance's public URL: the base of the workspace's webhook addresses
    if (publicUrl) this.store.exec("INSERT OR REPLACE INTO meta VALUES ('publicUrl', ?)", publicUrl);
    this.store.exec("DELETE FROM meta WHERE k LIKE 'vault:%'");
    for (const [n, v] of Object.entries(sealed)) this.store.exec("INSERT INTO meta VALUES (?, ?)", `vault:${n}`, v);
    this.reset();
  }

  /** How the workspace learns of tracker changes (webhooks or polling), per repository. */
  async syncStatus() {
    await this.unlock();
    return this.runtime().flow.events.status();
  }

  /** Webhooks set up by hand for one repository: its URL and a new secret, shown once. */
  async manualHook(alias: string) {
    await this.unlock();
    const f = this.runtime().flow;
    return this.lock(() => f.events.manual(alias));
  }

  /** Managed mode: the workspace was deleted; its webhooks and its storage go. */
  async wipe() {
    if (this.store.rows("SELECT 1 FROM meta WHERE k = 'workspace'").length) {
      await this.unlock();
      const f = this.runtime().flow;
      for (const r of f.tracker.list) await f.events.disable(r);
    }
    this.reset();
    await this.room.clear();
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
    this.rt = build(
      doc,
      this.env,
      this.store,
      this.secrets(),
      {
        now: () => Date.now(),
        wake: (ms) => this.room.wake(Date.now() + ms),
      },
      (seq) => this.room.sockets?.ring("tui", JSON.stringify({ seq })),
    );
    return this.rt;
  }

  get flow() {
    return this.runtime().flow;
  }

  /** The alarm: the envoy's albums, then the scheduled work that is due (webhook events, leases, reconcile). */
  async alarm() {
    await this.unlock();
    const rt = this.runtime();
    if (rt.envoy) await this.lock(() => (rt.envoy as Envoy).onAlarm());
    await this.lock(() => rt.flow.cron(false));
    await this.schedule(rt.flow);
  }

  private schedule(f: Flowee) {
    return this.room.wake(f.wakeAt());
  }

  /**
   * The terminal protocol (docs/tui-protocol.md), behind the router's key check: `sync` hands the frames to the
   * envoy, each once, then answers the events after `after`; `socket` is the doorbell.
   */
  private async tui(req: Request, path: string, rt: NonNullable<WorkspaceHost["rt"]>): Promise<Response> {
    const person = JSON.parse(req.headers.get(PERSON_HEADER) ?? "null") as TuiPerson | null;
    const term = rt.terminal;
    if (!person || !term || !rt.envoy) return json({ ok: false, error: "not_found", message: "This workspace has no terminal interface." }, 404);
    if (path === "/tui/socket") {
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket") return json({ ok: false, error: "bad_request", message: "The socket needs a WebSocket upgrade." }, 426);
      return this.room.sockets ? this.room.sockets.accept("tui") : json({ ok: false, error: "unsupported", message: "This runtime has no sockets; poll sync instead." }, 501);
    }
    if (req.method !== "POST") return json({ ok: false, error: "bad_request", message: "sync takes a POST." }, 405);
    const raw = await req.text();
    if (raw.length > MAX_FILE * 1.4 + 100_000) return json({ ok: false, error: "too_large", message: "A file over 20 MB cannot be sent." }, 413);
    let body: { after?: unknown; send?: unknown };
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      return json({ ok: false, error: "bad_request", message: "The body is not JSON." }, 400);
    }
    const after = typeof body.after === "number" && Number.isInteger(body.after) ? body.after : 0;
    const frames = Array.isArray(body.send) ? (body.send as TuiFrame[]).slice(0, 50) : [];
    const envoy = rt.envoy;
    for (const f of frames)
      await this.lock(async () => {
        const u = term.frame(f, person);
        if (u) await envoy.onUpdate(u);
      }).catch((e) => console.error("terminal frame", e));
    return json({ ok: true, ...term.since(after) });
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    await this.unlock();
    const rt = this.runtime(req.headers.get(WORKSPACE_HEADER) ?? undefined);
    if (url.pathname === "/cron") {
      await this.lock(() => rt.flow.cron());
      await this.schedule(rt.flow);
      return new Response("ok");
    }
    const hook = /^\/hooks\/([a-z0-9-]+)$/.exec(url.pathname);
    if (hook) {
      if (req.method !== "POST") return new Response(null, { status: 405 });
      const body = await req.text();
      if (body.length > 5_000_000) return new Response(null, { status: 413 });
      const status = await rt.flow.events.receive(hook[1], { header: (n) => req.headers.get(n), body });
      return new Response(status === 200 ? "ok" : null, { status });
    }
    if (url.pathname === "/v1/sync" && req.method === "GET") {
      if (!(await auth(rt.flow, req))) return json({ ok: false, error: "unauthorized", message: "Unknown or missing token." }, 401);
      return json({ ok: true, sync: rt.flow.events.status() });
    }
    const origin = url.pathname === "/setup" ? req.headers.get(ORIGIN_HEADER) : null;
    if (origin && /^https?:\/\//.test(origin)) {
      this.store.exec("INSERT OR REPLACE INTO meta VALUES ('publicUrl', ?)", origin);
      rt.flow.events.base = origin;
    }
    if (url.pathname === "/setup") return json(rt.envoy ? await this.lock(() => (rt.envoy as Envoy).setup()) : { chat: "none" });
    if (url.pathname === "/tui/sync" || url.pathname === "/tui/socket") return this.tui(req, url.pathname, rt);
    if (url.pathname.startsWith("/telegram")) {
      const u = await req.json<Record<string, unknown>>().catch(() => null);
      if (u && rt.envoy) await this.lock(() => (rt.envoy as Envoy).onUpdate(u)).catch((e) => console.error("chat update", e));
      return new Response("ok");
    }
    return api(rt.flow, req, url.pathname.replace(/^\/v1\//, ""), (fn) => this.lock(fn));
  }
}

/** Wires a workspace document to its adapters. */
export function build(doc: WorkspaceDoc, env: Env, store: Store, secrets: Secrets, clock: Clock, ring?: (seq: number) => void) {
  const s = settings(doc);
  const tracker = new Repos(
    repoList(doc).map((r) => ({
      ...r,
      // a GitHub repository keeps its plain path as its slot key, as before mixed workspaces
      key: r.type === "github" ? undefined : r.key,
      tracker: TRACKERS[r.type].make({ repo: r.repo, api: r.api, token: secrets.get(r.token), tokenName: r.token, project: r.type === "github" ? doc.tracker.project : undefined, notPlannedLabel: doc.tracker.notPlannedLabel }),
    })),
    store,
  );
  const flow = new Flowee(s, tracker, store, clock, secrets);
  if (env.FLOWEE_KEY) {
    const key = vaultKey(env.FLOWEE_KEY);
    flow.events.vault = { seal: async (v) => seal(await key, v), unseal: async (v) => unseal(await key, v) };
  }
  flow.events.base = store.rows<{ v: string }>("SELECT v FROM meta WHERE k = 'publicUrl'")[0]?.v ?? doc.chat?.publicUrl;
  let envoy: Envoy | undefined;
  const { chat, terminal } = flow.s.chat ? chatOf({ doc, secrets, store, at: flow.s.chat, ring }) : {};
  if (chat) {
    const files = doc.files && new Paste(doc.files.url, secrets.get(doc.files.token), doc.files.expire);
    const photo = doc.profile?.photo;
    // a workspace's own bot without a photo of its own gets the bundled one
    const own = doc.chat?.managed ? () => Uint8Array.from(atob(PHOTO), (c) => c.charCodeAt(0)).buffer : undefined;
    envoy = new Envoy(flow, chat, files, async () =>
      photo ? (await fetch(photo)).arrayBuffer() : own?.(),
    );
    envoy.version = env.VERSION?.id ?? "dev";
    flow.envoy = envoy;
  }
  return { id: doc.id, flow, envoy, terminal };
}

// The Cloudflare runtime: the Worker serves the router; one Durable Object per workspace and one for the managed
// instance are the hosts' rooms (SQLite storage, alarm); the every-minute cron trigger is the tick.
import { DurableObject } from "cloudflare:workers";
import type { WorkspaceDoc, InstanceDoc } from "../../config/document";
import committed from "../../../flowee.config.json";
import { webhookOnly } from "../../config/schema";
import { InstanceHost } from "../../adapters/instance-host";
import type { Env } from "../../adapters/instance";
import { WorkspaceHost } from "../../adapters/workspace-host";
import type { Store, Value } from "../../ports/store";
import type { InstanceApi, Platform, Room, WorkspaceApi } from "../platform";
import { route, tick } from "../router";

export interface CloudflareEnv extends Env {
  WORKSPACE: DurableObjectNamespace<Workspace>;
  INSTANCE: DurableObjectNamespace<Instance>;
}

export class SqlStore implements Store {
  constructor(private sql: SqlStorage) {}
  exec(q: string, ...a: Value[]) {
    return { rowsWritten: this.sql.exec(q, ...a).rowsWritten };
  }
  rows<R extends Record<string, Value>>(q: string, ...a: Value[]): R[] {
    return this.sql.exec<R>(q, ...a).toArray();
  }
}

const room = (ctx: DurableObjectState): Room => ({
  store: new SqlStore(ctx.storage.sql),
  async wake(at) {
    const now = await ctx.storage.getAlarm();
    if (!now || now > at) await ctx.storage.setAlarm(at);
  },
  clear: () => ctx.storage.deleteAll(),
  // hibernatable WebSockets: an idle terminal costs the object nothing while it sleeps
  sockets: {
    accept(tag) {
      const [client, server] = Object.values(new WebSocketPair());
      ctx.acceptWebSocket(server, [tag]);
      return new Response(null, { status: 101, webSocket: client });
    },
    ring(tag, text) {
      for (const ws of ctx.getWebSockets(tag))
        try {
          ws.send(text);
        } catch {}
    },
  },
});

const platform = (env: CloudflareEnv): Platform => ({
  env,
  workspace: (id) => env.WORKSPACE.get(env.WORKSPACE.idFromName(id)) as unknown as WorkspaceApi,
  instance: () => env.INSTANCE.get(env.INSTANCE.idFromName("instance")) as unknown as InstanceApi,
});

/** One workspace's Durable Object: its host on the object's storage and alarm. */
export class Workspace extends DurableObject<CloudflareEnv> {
  readonly host: WorkspaceHost;
  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx, env);
    this.host = new WorkspaceHost(room(ctx), env);
    // the terminals' keep-alive is answered without waking the object
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }
  webSocketMessage() {}
  webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code === 1005 ? 1000 : code);
    } catch {}
  }
  fetch(req: Request) {
    return this.host.fetch(req);
  }
  alarm() {
    return this.host.alarm();
  }
  configure(doc: WorkspaceDoc, sealed: Record<string, string>, publicUrl?: string) {
    return this.host.configure(doc, sealed, publicUrl);
  }
  syncStatus() {
    return this.host.syncStatus();
  }
  manualHook(alias: string) {
    return this.host.manualHook(alias);
  }
  wipe() {
    return this.host.wipe();
  }
  agents(change?: { name: string; remove?: boolean; paused?: boolean }) {
    return this.host.agents(change);
  }
}

/** The managed instance's Durable Object. */
export class Instance extends DurableObject<CloudflareEnv> {
  readonly host: InstanceHost;
  constructor(ctx: DurableObjectState, env: CloudflareEnv) {
    super(ctx, env);
    this.host = new InstanceHost(room(ctx), env, platform(env));
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }
  fetch(req: Request) {
    return this.host.fetch(req);
  }
  tuiSeat(doc: InstanceDoc, digest: string) {
    return this.host.tuiSeat(doc, digest);
  }
  tuiSync(doc: InstanceDoc, who: { digest: string; name: string }, body: string) {
    return this.host.tuiSync(doc, who, body);
  }
  people(doc: InstanceDoc, digest: string) {
    return this.host.people(doc, digest);
  }
  webSocketMessage() {}
  webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code === 1005 ? 1000 : code);
    } catch {}
  }
  mainUpdate(doc: InstanceDoc, update: unknown) {
    return this.host.mainUpdate(doc, update);
  }
  ownUpdate(doc: InstanceDoc, id: string, secret: string, update: unknown) {
    return this.host.ownUpdate(doc, id, secret, update);
  }
  resolve(doc: InstanceDoc, q: { digest?: string; id?: string }) {
    return this.host.resolve(doc, q);
  }
  active(doc: InstanceDoc) {
    return this.host.active(doc);
  }
  admin(doc: InstanceDoc, method: string, path: string, body: unknown) {
    return this.host.admin(doc, method, path, body);
  }
  setup(doc: InstanceDoc) {
    return this.host.setup(doc);
  }
}

const refused = new Map<string, string[]>();
/** A document asking for Telegram by polling is refused with one sentence: the Worker has webhooks only. */
function polling(env: CloudflareEnv) {
  const text = env.FLOWEE_CONFIG ?? JSON.stringify(committed);
  let errs = refused.get(text);
  if (!errs) {
    try {
      errs = webhookOnly(JSON.parse(text));
    } catch {
      errs = []; // not JSON: the router answers bad_config
    }
    refused.set(text, errs);
  }
  return errs.length ? Response.json({ ok: false, error: "bad_config", message: errs.join(" ") }, { status: 500 }) : undefined;
}

export default {
  fetch: (req: Request, env: CloudflareEnv) => polling(env) ?? route(req, platform(env)),
  scheduled(_c: ScheduledController, env: CloudflareEnv, ctx: ExecutionContext) {
    ctx.waitUntil(tick(platform(env)));
  },
} satisfies ExportedHandler<CloudflareEnv>;

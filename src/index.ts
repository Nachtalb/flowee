// The Worker: resolves the workspace of every request (API token or /w/<id>/, chat binding) and hands it to that
// workspace's Durable Object; the cron and the deploy's /setup go to every workspace. In the managed mode the
// Instance object resolves (stored registry) and takes the wizard's updates first.
import { json } from "./api/http";
import { digestOf } from "./config/registry";
import { Fail } from "./core/errors";
import { same } from "./core/text";
import { Telegram } from "./adapters/chat-telegram";
import { bot, type Env, instanceDoc, mode, registry } from "./adapters/instance";
import { envSecrets, ORIGIN_HEADER, WORKSPACE_HEADER } from "./adapters/store-durable-object";
import { served } from "./adapters/served";

export { Instance } from "./adapters/instance-durable-object";
export { Workspace } from "./adapters/store-durable-object";

const stub = (env: Env, id: string) => env.WORKSPACE.get(env.WORKSPACE.idFromName(id));
const instance = (env: Env) => env.INSTANCE.get(env.INSTANCE.idFromName("instance"));

function forward(env: Env, id: string, req: Request, path?: string) {
  const url = new URL(req.url);
  if (path) url.pathname = path;
  const r = new Request(url, req);
  r.headers.set(WORKSPACE_HEADER, id);
  return stub(env, id).fetch(r);
}

const ids = async (env: Env) => (mode(env) === "managed" ? await instance(env).active(instanceDoc(env)) : registry(env).list().map((w) => w.id));

/** The path on every workspace; `origin` (the deploy's /setup) tells a standalone workspace its public URL for webhooks. */
const each = async (env: Env, path: string, origin?: string) =>
  Promise.all(
    (await ids(env)).map(
      async (id) => [id, await (await forward(env, id, new Request(`https://flowee${path}`, { method: "POST", headers: origin ? { [ORIGIN_HEADER]: origin } : {} }))).text()] as const,
    ),
  );

const unauthorized = () => json({ ok: false, error: "unauthorized", message: "Unknown or missing token." }, 401);
const notFound = () => json({ ok: false, error: "not_found", message: "No such endpoint." }, 404);
const paused = (id: string) => json({ ok: false, error: "paused", message: `The workspace '${id}' is paused; its owner resumes it with /workspaces.` }, 503);
const bearer = (req: Request) => /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
/** A tracker's webhook delivery: unauthenticated here, verified by the workspace's object against its secret. */
const HOOK = /^\/hooks\/([a-z0-9-]+)\/([a-z0-9][a-z0-9-]{0,31})$/;
const refused = () => new Response(null, { status: 401 });

async function managed(req: Request, env: Env): Promise<Response> {
  const { pathname } = new URL(req.url);
  const doc = instanceDoc(env);
  const inst = instance(env);
  const body = () => req.clone().json().catch(() => null);
  if (pathname === "/telegram") {
    const want = envSecrets(env).get(doc.instance?.bot.webhookSecret ?? "");
    const got = req.headers.get("x-telegram-bot-api-secret-token");
    if (req.method !== "POST" || !want || !got || !(await same(got, want))) return new Response("forbidden", { status: 403 });
    const r = await inst.mainUpdate(doc, await body());
    return r.forward ? forward(env, r.forward, req) : new Response("ok");
  }
  const h = HOOK.exec(pathname);
  if (h) {
    const hit = req.method === "POST" ? await inst.resolve(doc, { id: h[1] }) : null;
    if (!hit) return refused();
    // a paused workspace acknowledges and ignores; the reconcile after it resumes catches up
    return hit.paused ? new Response("ok") : forward(env, h[1], req, `/hooks/${h[2]}`);
  }
  let m = /^\/telegram\/w\/([a-z0-9-]+)$/.exec(pathname);
  if (m) {
    if (req.method !== "POST") return new Response("forbidden", { status: 403 });
    const r = await inst.ownUpdate(doc, m[1], req.headers.get("x-telegram-bot-api-secret-token") ?? "", await body());
    if (r.status) return new Response("forbidden", { status: r.status });
    return r.forward ? forward(env, r.forward, req) : new Response("ok");
  }
  m = /^\/w\/([a-z0-9-]+)(\/v1\/.*|\/config)$/.exec(pathname);
  if (m) {
    const hit = await inst.resolve(doc, { id: m[1] });
    if (!hit) return json({ ok: false, error: "not_found", message: `There is no workspace '${m[1]}'.` }, 404);
    if (m[2] === "/config") {
      // any agent of the workspace may read its configuration (it holds no secret)
      const t = bearer(req);
      const who = t ? await inst.resolve(doc, { digest: await digestOf(t) }) : null;
      if (who?.id !== m[1]) return unauthorized();
      const r = await inst.admin(doc, "GET", `/admin/workspaces/${m[1]}`, null);
      const sync = await stub(env, m[1]).syncStatus().catch(() => undefined);
      return json({ ok: true, workspace: (JSON.parse(r.json) as { workspace: unknown }).workspace, ...(sync ? { sync } : {}) });
    }
    return hit.paused ? paused(hit.id) : forward(env, m[1], req, m[2]);
  }
  if (pathname.startsWith("/v1/")) {
    const t = bearer(req);
    const hit = t ? await inst.resolve(doc, { digest: await digestOf(t) }) : null;
    if (!hit) return unauthorized();
    return hit.paused ? paused(hit.id) : forward(env, hit.id, req);
  }
  if (pathname.startsWith("/admin/")) {
    const t = bearer(req);
    if (!t || !env.FLOWEE_ADMIN_TOKEN || !(await same(t, env.FLOWEE_ADMIN_TOKEN))) return unauthorized();
    const r = await inst.admin(doc, req.method, pathname, req.method === "PUT" ? await body() : null);
    return new Response(r.json, { status: r.status, headers: { "content-type": "application/json" } });
  }
  if (pathname === "/setup" && req.method === "GET") {
    const main = await inst.setup(doc);
    return json({ instance: main, ...Object.fromEntries((await each(env, "/setup")).map(([id, t]) => [id, JSON.parse(t)])) });
  }
  return notFound();
}

async function route(req: Request, env: Env): Promise<Response> {
  if (mode(env) === "managed") return managed(req, env);
  const { pathname } = new URL(req.url);
  const reg = registry(env);
  if (pathname === "/telegram") {
    const b = bot(env);
    const want = b && envSecrets(env).get(b.webhookSecret);
    const got = req.headers.get("x-telegram-bot-api-secret-token");
    if (req.method !== "POST" || !want || !got || !(await same(got, want))) return new Response("forbidden", { status: 403 });
    const u = await req.clone().json().catch(() => null);
    const at = b && new Telegram(envSecrets(env).get(b.token), b.token).route(u);
    const w = at && reg.byChat(at);
    // updates of chats no workspace is bound to (and anything a standalone instance does not manage) are dropped
    return w ? forward(env, w.id, req) : new Response("ok");
  }
  const h = HOOK.exec(pathname);
  if (h) return req.method === "POST" && reg.get(h[1]) ? forward(env, h[1], req, `/hooks/${h[2]}`) : refused();
  let m = /^\/w\/([a-z0-9-]+)(\/v1\/.*)$/.exec(pathname);
  if (m) return reg.get(m[1]) ? forward(env, m[1], req, m[2]) : json({ ok: false, error: "not_found", message: `There is no workspace '${m[1]}'.` }, 404);
  if (pathname.startsWith("/v1/")) {
    m = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "");
    const hit = m && reg.byDigest(await digestOf(m[1]));
    return hit ? forward(env, hit.doc.id, req) : unauthorized();
  }
  // Idempotent and input-free: the deploy calls it to publish the bot profile and webhook of the new version.
  if (pathname === "/setup" && req.method === "GET") return json(Object.fromEntries((await each(env, "/setup", new URL(req.url).origin)).map(([id, t]) => [id, JSON.parse(t)])));
  if (pathname.startsWith("/admin/")) return json({ ok: false, error: "unsupported", message: "Configuration changes at run time need the managed mode." }, 501);
  return notFound();
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      // the public material (skills, docs, client, the root document, /validate) needs no workspace and no object
      return (await served(req, env)) ?? (await route(req, env));
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      return json({ ok: false, error: e.code, message: e.message }, e.status);
    }
  },

  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(each(env, "/cron"));
    // the instance bot's profile follows its configuration (each item only when it changed)
    if (mode(env) === "managed") ctx.waitUntil(instance(env).setup(instanceDoc(env)).catch((e) => console.error("instance setup", e)));
  },
} satisfies ExportedHandler<Env>;

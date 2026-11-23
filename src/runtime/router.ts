// The router every runtime serves: resolves the workspace of every request (API token or /w/<id>/, chat binding)
// and hands it to that workspace's host; the minute's tick and the deploy's /setup go to every workspace. In the
// managed mode the instance host resolves (stored registry) and takes the wizard's updates first.
import { json } from "../api/http";
import { digestOf } from "../config/registry";
import { Fail } from "../core/errors";
import { same } from "../core/text";
import { Telegram } from "../adapters/chat-telegram";
import { bot, instanceDoc, mode, registry } from "../adapters/instance";
import { served } from "../adapters/served";
import { envSecrets, ORIGIN_HEADER, PERSON_HEADER, WORKSPACE_HEADER } from "../adapters/workspace-host";
import type { TuiPersonDoc } from "../config/document";
import type { Platform } from "./platform";

function forward(p: Platform, id: string, req: Request, path?: string, person?: string) {
  const url = new URL(req.url);
  if (path) url.pathname = path;
  const r = new Request(url, req);
  r.headers.set(WORKSPACE_HEADER, id);
  // only the router names the terminal person; a client's own header never passes
  if (person) r.headers.set(PERSON_HEADER, person);
  else r.headers.delete(PERSON_HEADER);
  return p.workspace(id).fetch(r);
}

/** The terminal protocol (docs/tui-protocol.md): `/tui/v1/me`, `/tui/v1/w/<id>/sync`, `/tui/v1/w/<id>/socket`. */
const TUI = /^\/tui\/v1\/(?:(me)|w\/([a-z0-9-]+)\/(sync|socket))$/;
type Seat = { id: string; name?: string; paused: boolean; person: TuiPersonDoc };

async function terminal(req: Request, p: Platform, m: RegExpExecArray, seats: (digest: string) => Promise<Seat[]>): Promise<Response> {
  const t = bearer(req);
  const list = t ? await seats(await digestOf(t)) : [];
  if (!list.length) return json({ ok: false, error: "unauthorized", message: "Unknown or missing key." }, 401);
  const who = (s: Seat) => ({ id: s.person.id, name: s.person.name ?? s.person.id, role: s.person.role ?? "member" });
  if (m[1]) return json({ ok: true, person: who(list[0]), workspaces: list.map((s) => ({ id: s.id, name: s.name ?? s.id, paused: s.paused, person: who(s) })) });
  const seat = list.find((s) => s.id === m[2]);
  if (!seat) return json({ ok: false, error: "forbidden", message: `Your key does not open the workspace '${m[2]}'.` }, 403);
  if (seat.paused) return paused(seat.id);
  return forward(p, seat.id, req, `/tui/${m[3]}`, JSON.stringify(who(seat)));
}

const ids = async (p: Platform) => (mode(p.env) === "managed" ? await p.instance().active(instanceDoc(p.env)) : registry(p.env).list().map((w) => w.id));

/** The path on every workspace; `origin` (the deploy's /setup) tells a standalone workspace its public URL for webhooks. */
export const each = async (p: Platform, path: string, origin?: string) =>
  Promise.all(
    (await ids(p)).map(
      async (id) => [id, await (await forward(p, id, new Request(`https://flowee${path}`, { method: "POST", headers: origin ? { [ORIGIN_HEADER]: origin } : {} }))).text()] as const,
    ),
  );

const unauthorized = () => json({ ok: false, error: "unauthorized", message: "Unknown or missing token." }, 401);
const notFound = () => json({ ok: false, error: "not_found", message: "No such endpoint." }, 404);
const paused = (id: string) => json({ ok: false, error: "paused", message: `The workspace '${id}' is paused; its owner resumes it with /workspaces.` }, 503);
const bearer = (req: Request) => /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
/** A tracker's webhook delivery: unauthenticated here, verified by the workspace's object against its secret. */
const HOOK = /^\/hooks\/([a-z0-9-]+)\/([a-z0-9][a-z0-9-]{0,31})$/;
const refused = () => new Response(null, { status: 401 });

async function managed(req: Request, p: Platform): Promise<Response> {
  const env = p.env;
  const { pathname } = new URL(req.url);
  const doc = instanceDoc(env);
  const inst = p.instance();
  const body = () => req.clone().json().catch(() => null);
  if (pathname === "/telegram") {
    const want = envSecrets(env).get(doc.instance?.bot.webhookSecret ?? "");
    const got = req.headers.get("x-telegram-bot-api-secret-token");
    if (req.method !== "POST" || !want || !got || !(await same(got, want))) return new Response("forbidden", { status: 403 });
    const r = await inst.mainUpdate(doc, await body());
    return r.forward ? forward(p, r.forward, req) : new Response("ok");
  }
  const tui = TUI.exec(pathname);
  if (tui) return terminal(req, p, tui, (d) => inst.people(doc, d));
  const h = HOOK.exec(pathname);
  if (h) {
    const hit = req.method === "POST" ? await inst.resolve(doc, { id: h[1] }) : null;
    if (!hit) return refused();
    // a paused workspace acknowledges and ignores; the reconcile after it resumes catches up
    return hit.paused ? new Response("ok") : forward(p, h[1], req, `/hooks/${h[2]}`);
  }
  let m = /^\/telegram\/w\/([a-z0-9-]+)$/.exec(pathname);
  if (m) {
    if (req.method !== "POST") return new Response("forbidden", { status: 403 });
    const r = await inst.ownUpdate(doc, m[1], req.headers.get("x-telegram-bot-api-secret-token") ?? "", await body());
    if (r.status) return new Response("forbidden", { status: r.status });
    return r.forward ? forward(p, r.forward, req) : new Response("ok");
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
      const sync = await p.workspace(m[1]).syncStatus().catch(() => undefined);
      return json({ ok: true, workspace: (JSON.parse(r.json) as { workspace: unknown }).workspace, ...(sync ? { sync } : {}) });
    }
    return hit.paused ? paused(hit.id) : forward(p, m[1], req, m[2]);
  }
  if (pathname.startsWith("/v1/")) {
    const t = bearer(req);
    const hit = t ? await inst.resolve(doc, { digest: await digestOf(t) }) : null;
    if (!hit) return unauthorized();
    return hit.paused ? paused(hit.id) : forward(p, hit.id, req);
  }
  if (pathname.startsWith("/admin/")) {
    const t = bearer(req);
    if (!t || !env.FLOWEE_ADMIN_TOKEN || !(await same(t, env.FLOWEE_ADMIN_TOKEN))) return unauthorized();
    const r = await inst.admin(doc, req.method, pathname, req.method === "PUT" ? await body() : null);
    return new Response(r.json, { status: r.status, headers: { "content-type": "application/json" } });
  }
  if (pathname === "/setup" && req.method === "GET") {
    const main = await inst.setup(doc);
    return json({ instance: main, ...Object.fromEntries((await each(p, "/setup")).map(([id, t]) => [id, JSON.parse(t)])) });
  }
  return notFound();
}

async function routes(req: Request, p: Platform): Promise<Response> {
  const env = p.env;
  if (mode(env) === "managed") return managed(req, p);
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
    return w ? forward(p, w.id, req) : new Response("ok");
  }
  const tui = TUI.exec(pathname);
  if (tui) return terminal(req, p, tui, async (d) => reg.people(d).map(({ doc, person }) => ({ id: doc.id, name: doc.name, paused: false, person })));
  const h = HOOK.exec(pathname);
  if (h) return req.method === "POST" && reg.get(h[1]) ? forward(p, h[1], req, `/hooks/${h[2]}`) : refused();
  let m = /^\/w\/([a-z0-9-]+)(\/v1\/.*)$/.exec(pathname);
  if (m) return reg.get(m[1]) ? forward(p, m[1], req, m[2]) : json({ ok: false, error: "not_found", message: `There is no workspace '${m[1]}'.` }, 404);
  if (pathname.startsWith("/v1/")) {
    m = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "");
    const hit = m && reg.byDigest(await digestOf(m[1]));
    return hit ? forward(p, hit.doc.id, req) : unauthorized();
  }
  // Idempotent and input-free: the deploy calls it to publish the bot profile and webhook of the new version.
  if (pathname === "/setup" && req.method === "GET") return json(Object.fromEntries((await each(p, "/setup", new URL(req.url).origin)).map(([id, t]) => [id, JSON.parse(t)])));
  if (pathname.startsWith("/admin/")) return json({ ok: false, error: "unsupported", message: "Configuration changes at run time need the managed mode." }, 501);
  return notFound();
}

/**
 * A Telegram update the runtime fetched itself (polling), routed as the webhook's would be, without its secret check:
 * `which` is "main" (the standalone bot, the managed instance's bot) or a workspace id (its own bot, managed).
 */
export async function polled(p: Platform, which: string, update: unknown): Promise<void> {
  const req = () => new Request("https://flowee/telegram", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(update) });
  const env = p.env;
  let to: string | undefined;
  if (mode(env) === "managed") {
    const doc = instanceDoc(env);
    const r = which === "main" ? await p.instance().mainUpdate(doc, update) : await p.instance().ownUpdate(doc, which, true, update);
    to = r.forward;
  } else {
    const b = bot(env);
    const at = b && new Telegram(envSecrets(env).get(b.token), b.token).route(update);
    to = (at && registry(env).byChat(at))?.id;
  }
  if (to) await (await forward(p, to, req())).arrayBuffer();
}

/** One HTTP request on any runtime; a `Fail` becomes its JSON answer. */
export async function route(req: Request, p: Platform): Promise<Response> {
  try {
    // the public material (skills, docs, client, the root document, /validate) needs no workspace and no object
    return (await served(req, p.env)) ?? (await routes(req, p));
  } catch (e) {
    if (!(e instanceof Fail)) throw e;
    return json({ ok: false, error: e.code, message: e.message }, e.status);
  }
}

/** The minute's tick (the Worker's cron): every workspace's pass with `force`, the instance bot's profile. */
export async function tick(p: Platform) {
  await Promise.all([
    each(p, "/cron"),
    // the instance bot's profile follows its configuration (each item only when it changed)
    mode(p.env) === "managed" ? p.instance().setup(instanceDoc(p.env)).catch((e) => console.error("instance setup", e)) : undefined,
  ]);
}

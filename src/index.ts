// The Worker: resolves the workspace of every request (API token or /w/<id>/, chat binding) and hands it to that
// workspace's Durable Object; the cron and the deploy's /setup go to every workspace.
import { json } from "./api/http";
import { digestOf } from "./config/registry";
import { Fail } from "./core/errors";
import { same } from "./core/text";
import { Telegram } from "./adapters/chat-telegram";
import { bot, type Env, registry } from "./adapters/instance";
import { envSecrets, WORKSPACE_HEADER } from "./adapters/store-durable-object";

export { Workspace } from "./adapters/store-durable-object";

const stub = (env: Env, id: string) => env.WORKSPACE.get(env.WORKSPACE.idFromName(id));

function forward(env: Env, id: string, req: Request, path?: string) {
  const url = new URL(req.url);
  if (path) url.pathname = path;
  const r = new Request(url, req);
  r.headers.set(WORKSPACE_HEADER, id);
  return stub(env, id).fetch(r);
}

const each = (env: Env, path: string) =>
  Promise.all(
    registry(env)
      .list()
      .map(async (w) => [w.id, await (await forward(env, w.id, new Request(`https://flowee${path}`, { method: "POST" }))).text()] as const),
  );

const unauthorized = () => json({ ok: false, error: "unauthorized", message: "Unknown or missing token." }, 401);

async function route(req: Request, env: Env): Promise<Response> {
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
  let m = /^\/w\/([a-z0-9-]+)(\/v1\/.*)$/.exec(pathname);
  if (m) return reg.get(m[1]) ? forward(env, m[1], req, m[2]) : json({ ok: false, error: "not_found", message: `There is no workspace '${m[1]}'.` }, 404);
  if (pathname.startsWith("/v1/")) {
    m = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "");
    const hit = m && reg.byDigest(await digestOf(m[1]));
    return hit ? forward(env, hit.doc.id, req) : unauthorized();
  }
  // Idempotent and input-free: the deploy calls it to publish the bot profile and webhook of the new version.
  if (pathname === "/setup" && req.method === "GET") return json(Object.fromEntries((await each(env, "/setup")).map(([id, t]) => [id, JSON.parse(t)])));
  if (pathname === "/") return new Response("Flowee: the ticket flow API for AI agent teams and its chat envoy.\n");
  return json({ ok: false, error: "not_found", message: "No such endpoint." }, 404);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    try {
      return await route(req, env);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      return json({ ok: false, error: e.code, message: e.message }, e.status);
    }
  },

  async scheduled(_c: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(each(env, "/cron"));
  },
} satisfies ExportedHandler<Env>;

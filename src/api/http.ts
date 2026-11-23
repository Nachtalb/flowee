// The HTTP API for the agents (docs/api.md): bearer secret per role instance, idempotency keys, JSON bodies.
import { type Caller } from "../core/engine";
import { Fail } from "../core/errors";
import { type Body, type Flowee } from "../core/service";
import { hex, sha256 } from "../core/text";

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The instance whose secret the bearer token is, compared as SHA-256 digests in constant time. */
export async function auth(f: Flowee, req: Request): Promise<Caller | null> {
  const m = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "");
  if (!m) return null;
  const digest = new TextEncoder().encode(hex(await sha256(m[1].trim())));
  let found: Caller | null = null;
  for (const i of f.s.instances) {
    const want = new TextEncoder().encode((f.secrets.get(i.secret) ?? "").trim().toLowerCase());
    if (want.length === digest.length && crypto.subtle.timingSafeEqual(want, digest)) found = { instance: i.instance, role: i.role };
  }
  return found;
}

/**
 * One API request for `cmd` (the path after /v1/). `lock` runs the command alone in its workspace: the store
 * would otherwise interleave requests while a command awaits the tracker.
 */
export async function api(f: Flowee, req: Request, cmd: string, lock: <R>(fn: () => Promise<R>) => Promise<R>): Promise<Response> {
  const caller = await auth(f, req);
  if (!caller) return json({ ok: false, error: "unauthorized", message: "Unknown or missing token." }, 401);
  const url = new URL(req.url);
  const get = req.method === "GET" && f.isRead(cmd);
  const post = req.method === "POST" && f.isCommand(cmd) && !f.isRead(cmd);
  if (!get && !post) return json({ ok: false, error: "not_found", message: `There is no ${req.method} /v1/${cmd}.` }, 404);
  let body: Body = {};
  if (post) {
    try {
      const b = await req.json();
      if (typeof b !== "object" || b === null || Array.isArray(b)) throw 0;
      body = b as Body;
    } catch {
      return json({ ok: false, error: "bad_request", message: "The body must be a JSON object." }, 400);
    }
  } else if (url.searchParams.has("n") || cmd === "show") body = { n: url.searchParams.get("n") ?? undefined };
  const key = post ? req.headers.get("idempotency-key") : null;
  return lock(async () => {
    if (key) {
      const seen = f.db.rows<{ status: number; body: string }>("SELECT status, body FROM idem WHERE key = ? AND caller = ?", key, caller.instance)[0];
      if (seen) return new Response(seen.body, { status: seen.status, headers: { "content-type": "application/json" } });
    }
    let status = 200;
    let out: Record<string, unknown>;
    try {
      out = { ok: true, ...(await f.run(caller, cmd, body)) };
      const n = f.tracker.parse(body.n);
      if (n !== undefined) f.db.exec("UPDATE claims SET touched = ? WHERE n = ? AND instance = ?", f.clock.now(), n, caller.instance);
    } catch (e) {
      if (!(e instanceof Fail)) console.error(cmd, e);
      const x = e instanceof Fail ? e : new Fail(500, "internal", "The service failed unexpectedly; nothing more is known.");
      status = x.status;
      out = { ok: false, error: x.code, message: x.message };
    }
    const text = JSON.stringify(out);
    if (key && status < 500) f.db.exec("INSERT INTO idem VALUES (?, ?, ?, ?, ?)", key, caller.instance, status, text, f.clock.now());
    return new Response(text, { status, headers: { "content-type": "application/json" } });
  });
}

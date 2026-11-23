// The HTTP API for the agents (docs/api.md): the project key with the agent's name, or an agent's own secret;
// idempotency keys, JSON bodies; the roles and the agents themselves under /v1/roles and /v1/agents.
import { type Agent, roles } from "../core/agents";
import { type Caller } from "../core/engine";
import { Fail } from "../core/errors";
import { type Body, type Flowee } from "../core/service";
import { hex, iso, sha256 } from "../core/text";

export const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The agent a project-key request acts as (the client's FLOWEE_AS / `agent`). */
export const AGENT_HEADER = "x-flowee-agent";

/**
 * Who the bearer token is: an agent with its own secret (the document's `roles`, or one created in strict mode), or
 * `"project"` for the project key. Compared as SHA-256 digests in constant time.
 */
export async function auth(f: Flowee, req: Request): Promise<Caller | "project" | null> {
  const m = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "");
  if (!m) return null;
  const enc = (s: string) => new TextEncoder().encode(s.trim().toLowerCase());
  const digest = enc(hex(await sha256(m[1].trim())));
  const is = (want: string | undefined) => {
    const w = enc(want ?? "");
    return w.length === digest.length && crypto.subtle.timingSafeEqual(w, digest);
  };
  let found: Caller | "project" | null = null;
  for (const i of f.s.instances) if (is(f.secrets.get(i.secret))) found = { instance: i.instance, role: i.role };
  for (const a of f.agents.secrets()) if (is(a.digest)) found = { instance: a.name, role: a.role };
  if (f.s.agents.key && is(f.secrets.get(f.s.agents.key))) found ??= "project";
  return found;
}

const paused = (name: string) => new Fail(409, "agent_paused", `${name} is paused; resume it with \`flowee.py agents resume ${name}\`.`);

/** The agent a request acts as; a refusal is a Fail with one sentence. */
function actor(f: Flowee, req: Request, who: Caller | "project"): Caller {
  if (who !== "project") {
    if (f.agents.get(who.instance)?.paused) throw paused(who.instance);
    return who;
  }
  if (f.s.agents.strict) throw new Fail(403, "per_agent", "This workspace gives every agent its own secret; the project key only manages agents (flowee.py agents).");
  const name = req.headers.get(AGENT_HEADER)?.trim();
  if (!name) throw new Fail(400, "no_agent", "The project key acts as an agent only with its name: set FLOWEE_AS or `agent` in .flowee.toml.");
  const a = f.agents.get(name);
  if (!a) throw new Fail(403, "unknown_agent", `There is no agent '${name}'; create it with \`flowee.py agents add <role> ${name}\` (\`flowee.py roles\` lists the roles).`);
  if (a.paused) throw paused(name);
  return { instance: a.name, role: a.role };
}

const view = (f: Flowee, a: Agent) => ({
  name: a.name,
  role: a.role,
  source: a.source,
  paused: a.paused,
  ...(a.created ? { created: iso(a.created) } : {}),
  ...(a.seen ? { seen: iso(a.seen) } : {}),
  holds: f.agents.holds(a.name).map((n) => f.ref(n)),
});

const bad = (m: string): never => {
  throw new Fail(400, "bad_request", m);
};

/** `/v1/roles` and `/v1/agents[/<name>]`: anyone of the workspace reads them, only the project key changes them. */
async function agents(f: Flowee, method: string, who: Caller | "project", what: string, name: string | undefined, body: Body): Promise<Record<string, unknown>> {
  if (what === "roles") return { roles: roles(f.flow) };
  if (method !== "GET" && who !== "project") throw new Fail(403, "project_key", "Only the project key creates, changes and removes agents.");
  const str = (k: string) => (body[k] === undefined ? undefined : typeof body[k] === "string" ? (body[k] as string).trim() : bad(`${k} must be a string.`));
  if (name === undefined) {
    if (method === "GET") return { secrets: f.s.agents.strict ? "per-agent" : "project", agents: f.agents.list().map((a) => view(f, a)) };
    const role = str("role") || bad("role is required: one of the roles `GET /v1/roles` lists.");
    const r = await f.agents.add(role, str("name") || undefined, f.clock.now(), f.s.agents.strict);
    return { agent: view(f, r.agent), ...(r.secret ? { secret: r.secret } : {}) };
  }
  const a = f.agents.get(name);
  if (!a) throw new Fail(404, "unknown_agent", `There is no agent '${name}'.`);
  if (method === "GET") return { agent: view(f, a) };
  if (method === "PATCH") {
    if (body.paused !== undefined && typeof body.paused !== "boolean") bad("paused must be true or false.");
    return { agent: view(f, f.agents.change(name, { name: str("name"), paused: body.paused as boolean | undefined })) };
  }
  const held = f.agents.remove(name);
  // its claims expired just now: the alarm's reaper puts the tickets back in their queues
  if (held.length) await f.clock.wake(0);
  return { removed: name, released: held.map((n) => f.ref(n)) };
}

/** Which methods each of the agents' paths takes. */
const MANAGE: Record<string, string[]> = { roles: ["GET"], agents: ["GET", "POST"], agent: ["GET", "PATCH", "DELETE"] };

/**
 * One API request for `cmd` (the path after /v1/). `lock` runs the command alone in its workspace: the store
 * would otherwise interleave requests while a command awaits the tracker.
 */
export async function api(f: Flowee, req: Request, cmd: string, lock: <R>(fn: () => Promise<R>) => Promise<R>): Promise<Response> {
  const who = await auth(f, req);
  if (!who) return json({ ok: false, error: "unauthorized", message: "Unknown or missing token." }, 401);
  const url = new URL(req.url);
  const m = /^(roles|agents)(?:\/([a-z0-9-]+))?$/.exec(cmd);
  const manage = m && (m[1] === "agents" && m[2] ? "agent" : m[2] ? undefined : m[1]);
  const get = req.method === "GET" && (manage ? true : f.isRead(cmd));
  const post = manage ? req.method !== "GET" && MANAGE[manage].includes(req.method) : req.method === "POST" && f.isCommand(cmd) && !f.isRead(cmd);
  if ((!get && !post) || (m && !manage)) return json({ ok: false, error: "not_found", message: `There is no ${req.method} /v1/${cmd}.` }, 404);
  let body: Body = {};
  if (post && req.method !== "DELETE") {
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
    let status = 200;
    let out: Record<string, unknown>;
    let by: string | undefined;
    try {
      // the project key without an agent's name: the agents' paths, and whoami
      const caller = manage || (who === "project" && cmd === "whoami" && !req.headers.get(AGENT_HEADER)) ? undefined : actor(f, req, who);
      by = caller?.instance ?? (who === "project" ? "@project" : who.instance);
      if (key) {
        const seen = f.db.rows<{ status: number; body: string }>("SELECT status, body FROM idem WHERE key = ? AND caller = ?", key, by)[0];
        if (seen) return new Response(seen.body, { status: seen.status, headers: { "content-type": "application/json" } });
      }
      if (manage) out = { ok: true, ...(await agents(f, req.method, who, m?.[1] as string, m?.[2], body)) };
      else if (!caller) out = { ok: true, key: "project", secrets: f.s.agents.strict ? "per-agent" : "project" };
      else {
        f.agents.seen(caller.instance, f.clock.now());
        out = { ok: true, ...(await f.run(caller, cmd, body)) };
        const n = f.tracker.parse(body.n);
        if (n !== undefined) f.db.exec("UPDATE claims SET touched = ? WHERE n = ? AND instance = ?", f.clock.now(), n, caller.instance);
      }
    } catch (e) {
      if (!(e instanceof Fail)) console.error(cmd, e);
      const x = e instanceof Fail ? e : new Fail(500, "internal", "The service failed unexpectedly; nothing more is known.");
      status = x.status;
      out = { ok: false, error: x.code, message: x.message };
    }
    const text = JSON.stringify(out);
    if (key && by && status < 500) f.db.exec("INSERT INTO idem VALUES (?, ?, ?, ?, ?)", key, by, status, text, f.clock.now());
    return new Response(text, { status, headers: { "content-type": "application/json" } });
  });
}

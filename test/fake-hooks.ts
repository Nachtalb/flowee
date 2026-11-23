// The fake GitHub's repository webhooks (/repos/R/hooks) and two repositories of their own (acme/hooks,
// acme/hooks2), plus signing deliveries the way GitHub does (HMAC SHA-256 of the raw body).
import { SELF } from "cloudflare:test";
import { type FakeGitHub, install } from "./fake";
import type { FakeGitLab } from "./fake-gitlab";

type Hook = { id: number; active: boolean; events: string[]; config: { url: string; secret?: string; content_type?: string }; last_response: { code: number | null; status: string; message: string | null } };

export class FakeHooks {
  hooks: Hook[] = [];
  /** The token has the Webhooks permission. */
  allowed = true;
  private id = 1;

  constructor(gh: FakeGitHub) {
    const before = gh.extra;
    gh.extra = (m, p, b, u) => this.handle(gh, m, p, b) ?? before?.(m, p, b, u);
  }

  private handle(gh: FakeGitHub, method: string, path: string, body: Record<string, any>): Response | undefined {
    const R = `/repos/${gh.repo}/hooks`;
    if (!path.startsWith(R)) return undefined;
    if (!this.allowed) return Response.json({ message: "Resource not accessible by personal access token" }, { status: 403 });
    const ok = (b: unknown, status = 200) => Response.json(b, { status });
    const view = (h: Hook) => ({ ...h, config: { url: h.config.url, content_type: h.config.content_type, insecure_ssl: "0" } });
    if (path === R && method === "GET") return ok(this.hooks.map(view));
    if (path === R && method === "POST") {
      const h: Hook = { id: this.id++, active: body.active, events: body.events, config: body.config, last_response: { code: null, status: "unused", message: null } };
      this.hooks.push(h);
      return ok(view(h), 201);
    }
    const m = new RegExp(`^${R}/(\\d+)$`).exec(path);
    const h = m && this.hooks.find((x) => x.id === Number(m[1]));
    if (!h) return ok({ message: "Not Found" }, 404);
    if (method === "PATCH") Object.assign(h, { active: body.active, events: body.events, config: body.config });
    if (method === "DELETE") {
      this.hooks = this.hooks.filter((x) => x !== h);
      return new Response(null, { status: 204 });
    }
    return ok(view(h));
  }
}

/** The fake GitLab's project hooks (/projects/:id/hooks), answered before the project's other routes. */
export class FakeGlHooks {
  hooks: { id: number; url: string; token?: string; alert_status: string; [k: string]: unknown }[] = [];
  allowed = true;
  private id = 1;

  constructor(public gl: FakeGitLab) {}

  async handle(req: Request): Promise<Response | undefined> {
    const path = new URL(req.url).pathname;
    const R = `/api/v4/projects/${encodeURIComponent(this.gl.repo)}/hooks`;
    if (!path.startsWith(R)) return undefined;
    this.gl.auth.push(req.headers.get("authorization") ?? "");
    if (!this.allowed) return Response.json({ message: "403 Forbidden" }, { status: 403 });
    const body = req.method === "GET" || req.method === "DELETE" ? {} : ((await req.json()) as Record<string, any>);
    const view = ({ token: _, ...h }: (typeof this.hooks)[number]) => h;
    if (path === R && req.method === "GET") return Response.json(this.hooks.map(view), { headers: { "x-next-page": "" } });
    if (path === R && req.method === "POST") {
      const h = { ...body, id: this.id++, url: String(body.url), alert_status: "executable" };
      this.hooks.push(h);
      return Response.json(view(h), { status: 201 });
    }
    const h = this.hooks.find((x) => path === `${R}/${x.id}`);
    if (!h) return Response.json({ message: "404 Not Found" }, { status: 404 });
    if (req.method === "PUT") Object.assign(h, body);
    if (req.method === "DELETE") {
      this.hooks = this.hooks.filter((x) => x !== h);
      return new Response(null, { status: 204 });
    }
    return Response.json(view(h));
  }
}

export function installHooks() {
  const base = install();
  const glhk = base.glhk;
  const glHooks = new FakeGlHooks(glhk);
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    if (new URL(req.url).host === "gitlab.com" && glhk.owns(new URL(req.url).pathname)) return (await glHooks.handle(req)) ?? glhk.handle(req);
    return inner(req);
  }) as typeof fetch;
  return { ...base, hooks: new FakeHooks(base.hk), hooks2: new FakeHooks(base.hk2), glhk, glHooks };
}

/** POSTs a GitLab delivery (X-Gitlab-Token carries the secret as is). */
export async function deliverGl(ws: string, alias: string, event: string, payload: unknown, token: string | null, id = `f5e5f430-f57b-4e6e-9fac-${String(++seq).padStart(12, "0")}`) {
  const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "GitLab/19.6.0", "x-gitlab-event": event, "idempotency-key": id, "webhook-id": id };
  if (token !== null) headers["x-gitlab-token"] = token;
  const res = await SELF.fetch(`https://flow.test/hooks/${ws}/${alias}`, { method: "POST", headers, body: JSON.stringify(payload) });
  return { status: res.status, text: await res.text(), id };
}

export async function hmac(secret: string, body: string) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)))].map((x) => x.toString(16).padStart(2, "0")).join("");
}

let seq = 0;

/** POSTs a GitHub delivery to a workspace's hook URL, signed with `secret` (`sig: null` sends none). */
export async function deliver(ws: string, alias: string, event: string, payload: unknown, secret: string, o: { id?: string; sig?: string | null } = {}) {
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "user-agent": "GitHub-Hookshot/044aadd",
    "x-github-event": event,
    "x-github-delivery": o.id ?? `72d3162e-cc78-11e3-81ab-${String(++seq).padStart(12, "0")}`,
  };
  const sig = o.sig === undefined ? `sha256=${await hmac(secret, body)}` : o.sig;
  if (sig !== null) headers["x-hub-signature-256"] = sig;
  const res = await SELF.fetch(`https://flow.test/hooks/${ws}/${alias}`, { method: "POST", headers, body });
  return { status: res.status, text: await res.text(), id: headers["x-github-delivery"] };
}

const repository = (full: string) => ({ id: 1296269, name: full.split("/")[1], full_name: full, owner: { login: full.split("/")[0], id: 1 }, private: false });
const sender = { login: "octocat", id: 1, type: "User" };
const ghIssue = (repo: string, n: number) => ({
  url: `https://api.github.com/repos/${repo}/issues/${n}`,
  number: n,
  title: `Ticket ${n}`,
  state: "open",
  labels: [],
  assignees: [],
  user: sender,
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-02T00:00:00Z",
});

/** Payloads in the shape the GitHub webhook docs give (only the fields Flowee reads, plus their neighbours). */
export const GH = {
  issues: (repo: string, n: number, action = "labeled") => ({ action, issue: ghIssue(repo, n), label: { name: "ready" }, repository: repository(repo), sender }),
  comment: (repo: string, n: number) => ({ action: "created", issue: ghIssue(repo, n), comment: { id: 1, body: "Hello", user: sender }, repository: repository(repo), sender }),
  prComment: (repo: string, n: number) => ({ action: "created", issue: { ...ghIssue(repo, n), pull_request: { url: "x" } }, comment: { id: 2, body: "on a PR" }, repository: repository(repo), sender }),
  push: (repo: string, ref: string, after: string) => ({ ref, before: "0".repeat(40), after, created: false, deleted: false, forced: false, commits: [], head_commit: null, pusher: { name: "octocat" }, repository: repository(repo), sender }),
  pull: (repo: string, number: number, action: string, merged = false, author = "octocat") => ({
    action,
    number,
    pull_request: { number, state: action === "closed" ? "closed" : "open", merged, head: { ref: `flowee/${number}`, sha: "c".repeat(40) }, base: { ref: "main" }, user: { login: author } },
    repository: repository(repo),
    sender,
  }),
  checkSuite: (repo: string, sha: string) => ({ action: "completed", check_suite: { id: 5, head_sha: sha, status: "completed", conclusion: "success" }, repository: repository(repo), sender }),
  status: (repo: string, sha: string, state = "success") => ({ id: 6, sha, state, context: "ci", repository: repository(repo), sender }),
  release: (repo: string, tag: string) => ({ action: "published", release: { id: 7, tag_name: tag, name: tag, draft: false }, repository: repository(repo), sender }),
  create: (repo: string, ref: string, ref_type = "tag") => ({ ref, ref_type, master_branch: "main", repository: repository(repo), sender }),
  ping: (repo: string) => ({ zen: "Keep it logically awesome.", hook_id: 1, hook: { type: "Repository", id: 1, events: ["issues"] }, repository: repository(repo), sender }),
};

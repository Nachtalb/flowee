// GitHub repository webhooks (https://docs.github.com/en/webhooks): deliveries signed with HMAC SHA-256 of the raw
// body in X-Hub-Signature-256, the event in X-GitHub-Event, the delivery's GUID in X-GitHub-Delivery (kept on a
// redelivery). Registered through POST /repos/{owner}/{repo}/hooks, which needs the fine-grained repository
// permission "Webhooks: Read and write" (classic tokens: admin:repo_hook).
import { Fail } from "../core/errors";
import type { Delivery, Hooks, HookStatus, TrackerEvent } from "../ports/hooks";
import type { GitHub } from "./tracker-github";

export const GITHUB_EVENTS = ["issues", "issue_comment", "push", "create", "delete", "pull_request", "check_suite", "status", "release"];

interface GhHook {
  id: number;
  active: boolean;
  config: { url?: string };
  last_response?: { code: number | null; status: string | null; message: string | null };
}

const unhex = (s: string) => (/^([0-9a-f]{2})+$/i.test(s) ? Uint8Array.from(s.match(/../g) as string[], (x) => parseInt(x, 16)) : null);

/** A tracker refusal of a hook write (no permission) as the one Fail the core understands. */
function refused(e: unknown, permission: string): never {
  const s = (e as { gh?: number }).gh;
  if (s === 403 || s === 404) throw new Fail(403, "forbidden", `The token may not manage webhooks; it needs ${permission}.`);
  throw e;
}

function status(h: GhHook): HookStatus {
  const r = h.last_response;
  // "unused": no delivery yet (a fresh hook); a code of 2xx is a delivered event
  const failing = !h.active || (r?.code != null && (r.code < 200 || r.code >= 300));
  return { id: String(h.id), ok: !failing, ...(failing ? { detail: h.active ? `last delivery answered ${r?.code}${r?.message ? `: ${r.message}` : ""}` : "the hook is inactive" } : {}) };
}

export class GitHubHooks implements Hooks {
  permission = 'the repository permission "Webhooks: Read and write" (fine-grained token; classic: admin:repo_hook)';
  manual = "the repository's Settings → Webhooks → Add webhook (content type application/json)";

  constructor(private gh: GitHub) {}

  async verify(d: Delivery, secret: string): Promise<boolean> {
    const m = /^sha256=([0-9a-f]{64})$/i.exec(d.header("x-hub-signature-256") ?? "");
    const sig = m && unhex(m[1]);
    if (!sig || !secret) return false;
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    // HMAC verify compares in constant time
    return crypto.subtle.verify("HMAC", key, sig, enc.encode(d.body));
  }

  id(d: Delivery) {
    return d.header("x-github-delivery");
  }

  parse(d: Delivery): TrackerEvent[] {
    let p: Record<string, any>;
    try {
      p = JSON.parse(d.body);
    } catch {
      return [];
    }
    const repo = String(p.repository?.full_name ?? "");
    if (!repo) return [];
    const ev = d.header("x-github-event");
    const sha = (s: unknown) => (typeof s === "string" && !/^0+$/.test(s) ? s : null);
    switch (ev) {
      case "ping":
        return [{ kind: "ping", repo }];
      case "issues":
        return p.issue?.pull_request ? [] : [{ kind: "ticket", repo, n: Number(p.issue?.number) }];
      case "issue_comment":
        return p.issue?.pull_request ? [] : [{ kind: "comment", repo, n: Number(p.issue?.number) }];
      case "push": {
        const ref = String(p.ref ?? "");
        if (ref.startsWith("refs/tags/")) return [{ kind: "tag", repo, tag: ref.slice(10), sha: sha(p.after) }];
        if (ref.startsWith("refs/heads/")) return [{ kind: "push", repo, branch: ref.slice(11), sha: sha(p.after) }];
        return [];
      }
      case "create":
      case "delete":
        return p.ref_type === "tag" ? [{ kind: "tag", repo, tag: String(p.ref), sha: null }] : p.ref_type === "branch" ? [{ kind: "push", repo, branch: String(p.ref), sha: null }] : [];
      case "pull_request": {
        const pr = p.pull_request ?? {};
        const a = p.action;
        const action = a === "opened" || a === "reopened" ? "opened" : a === "closed" ? (pr.merged ? "merged" : "closed") : a === "synchronize" || a === "edited" ? "updated" : null;
        return action ? [{ kind: "pull", repo, number: Number(pr.number), action, branch: String(pr.head?.ref ?? ""), author: String(pr.user?.login ?? "") }] : [];
      }
      case "check_suite":
      case "check_run": {
        const c = p[ev];
        return p.action === "completed" && c?.head_sha ? [{ kind: "checks", repo, sha: c.head_sha }] : [];
      }
      case "status":
        return p.state !== "pending" && p.sha ? [{ kind: "checks", repo, sha: p.sha }] : [];
      case "release":
        return p.release?.tag_name ? [{ kind: "release", repo, tag: String(p.release.tag_name) }] : [];
    }
    return [];
  }

  private async find(url: string): Promise<GhHook | undefined> {
    const hs = await this.gh.req<GhHook[]>("GET", `${this.gh.r}/hooks?per_page=100`, "the repository's webhooks").catch((e) => refused(e, this.permission));
    return hs.find((h) => h.config.url === url);
  }

  async register(url: string, secret: string): Promise<HookStatus> {
    const body = { active: true, events: GITHUB_EVENTS, config: { url, content_type: "json", secret, insecure_ssl: "0" } };
    const had = await this.find(url);
    const h = had
      ? await this.gh.req<GhHook>("PATCH", `${this.gh.r}/hooks/${had.id}`, "updating the webhook", body).catch((e) => refused(e, this.permission))
      : await this.gh.req<GhHook>("POST", `${this.gh.r}/hooks`, "creating the webhook", { name: "web", ...body }).catch((e) => refused(e, this.permission));
    return status(h);
  }

  async unregister(url: string) {
    const h = await this.find(url);
    if (h) await this.gh.req("DELETE", `${this.gh.r}/hooks/${h.id}`, "removing the webhook").catch((e) => refused(e, this.permission));
  }

  async status(url: string): Promise<HookStatus | null> {
    const h = await this.find(url);
    return h ? status(h) : null;
  }
}

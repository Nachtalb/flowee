// GitLab project webhooks (https://docs.gitlab.com/user/project/integrations/webhooks/): the secret token comes
// back verbatim in X-Gitlab-Token, the event in X-Gitlab-Event (`Issue Hook`, `Note Hook`, …), the delivery id in
// Idempotency-Key / webhook-id (the same on a retry). Registered through POST /projects/:id/hooks, which needs the
// Maintainer role on the project and a token with the `api` scope.
import { Fail } from "../core/errors";
import { same } from "../core/text";
import type { Delivery, Hooks, HookStatus, TrackerEvent } from "../ports/hooks";
import type { GitLab } from "./tracker-gitlab";

interface GlHook {
  id: number;
  url: string;
  alert_status?: "executable" | "disabled" | "temporarily_disabled";
  disabled_until?: string | null;
}

const EVENTS = {
  issues_events: true,
  confidential_issues_events: true,
  note_events: true,
  confidential_note_events: true,
  push_events: true,
  tag_push_events: true,
  merge_requests_events: true,
  pipeline_events: true,
  job_events: true,
  releases_events: true,
  enable_ssl_verification: true,
};

const FINISHED = new Set(["success", "failed", "canceled", "skipped"]);

function refused(e: unknown, permission: string): never {
  const s = (e as { gl?: number }).gl;
  if (s === 401 || s === 403 || s === 404) throw new Fail(403, "forbidden", `The token may not manage webhooks; it needs ${permission}.`);
  throw e;
}

const status = (h: GlHook): HookStatus =>
  !h.alert_status || h.alert_status === "executable"
    ? { id: String(h.id), ok: true }
    : { id: String(h.id), ok: false, detail: h.alert_status === "disabled" ? "GitLab disabled the hook after repeated failures" : "GitLab disabled the hook for a while after failures" };

export class GitLabHooks implements Hooks {
  permission = "the Maintainer role on the project and a token with the api scope";
  manual = "the project's Settings → Webhooks → Add new webhook (secret token, not a signing token)";

  constructor(private gl: GitLab) {}

  async verify(d: Delivery, secret: string) {
    const got = d.header("x-gitlab-token");
    return !!got && !!secret && (await same(got, secret));
  }

  id(d: Delivery) {
    return d.header("idempotency-key") ?? d.header("webhook-id") ?? d.header("x-gitlab-event-uuid");
  }

  parse(d: Delivery): TrackerEvent[] {
    let p: Record<string, any>;
    try {
      p = JSON.parse(d.body);
    } catch {
      return [];
    }
    const repo = String(p.project?.path_with_namespace ?? "");
    if (!repo) return [];
    const a = p.object_attributes ?? {};
    const sha = (s: unknown) => (typeof s === "string" && !/^0+$/.test(s) ? s : null);
    switch (d.header("x-gitlab-event")) {
      case "Issue Hook":
      case "Confidential Issue Hook":
        return a.iid && (a.type ?? "Issue") === "Issue" ? [{ kind: "ticket", repo, n: Number(a.iid) }] : [];
      case "Note Hook":
      case "Confidential Note Hook":
        return a.noteable_type === "Issue" && p.issue?.iid ? [{ kind: "comment", repo, n: Number(p.issue.iid) }] : [];
      case "Push Hook": {
        const ref = String(p.ref ?? "");
        return ref.startsWith("refs/heads/") ? [{ kind: "push", repo, branch: ref.slice(11), sha: sha(p.after) }] : [];
      }
      case "Tag Push Hook": {
        const ref = String(p.ref ?? "");
        return ref.startsWith("refs/tags/") ? [{ kind: "tag", repo, tag: ref.slice(10), sha: sha(p.after) }] : [];
      }
      case "Merge Request Hook": {
        const x = a.action;
        const action = x === "open" || x === "reopen" ? "opened" : x === "merge" ? "merged" : x === "close" ? "closed" : x === "update" ? "updated" : null;
        return action ? [{ kind: "pull", repo, number: Number(a.iid), action, branch: String(a.source_branch ?? ""), author: String(p.user?.username ?? "") }] : [];
      }
      case "Pipeline Hook":
        return FINISHED.has(a.status) && a.sha ? [{ kind: "checks", repo, sha: a.sha }] : [];
      case "Job Hook":
        return FINISHED.has(p.build_status) && p.sha ? [{ kind: "checks", repo, sha: p.sha }] : [];
      case "Release Hook":
        return p.tag && p.action !== "delete" ? [{ kind: "release", repo, tag: String(p.tag) }] : [];
    }
    return [];
  }

  private async find(url: string): Promise<GlHook | undefined> {
    const hs = await this.gl.pages<GlHook>(`${this.gl.p}/hooks`, "the project's webhooks").catch((e) => refused(e, this.permission));
    return hs.find((h) => h.url === url);
  }

  async register(url: string, secret: string): Promise<HookStatus> {
    const had = await this.find(url);
    const body = { url, token: secret, name: "Flowee", ...EVENTS };
    const h = had
      ? await this.gl.req<GlHook>("PUT", `${this.gl.p}/hooks/${had.id}`, "updating the webhook", body).catch((e) => refused(e, this.permission))
      : await this.gl.req<GlHook>("POST", `${this.gl.p}/hooks`, "creating the webhook", body).catch((e) => refused(e, this.permission));
    return status(h);
  }

  async unregister(url: string) {
    const h = await this.find(url);
    if (h) await this.gl.req("DELETE", `${this.gl.p}/hooks/${h.id}`, "removing the webhook").catch((e) => refused(e, this.permission));
  }

  async status(url: string): Promise<HookStatus | null> {
    const h = await this.find(url);
    return h ? status(h) : null;
  }
}

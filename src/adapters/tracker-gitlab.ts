// The Tracker port over the GitLab REST API v4 (gitlab.com or self-managed), plain fetch, no SDK. A ticket is an
// issue's iid; the project is addressed by its URL-encoded path (`group%2Fsub%2Fproject`). The optional
// capabilities map to merge requests, pipelines and commit statuses, branches, tags and releases; a board needs no
// write (issue-board lists follow the state labels), so it is left out. docs/gitlab.md has the mapping and the
// token scopes. Endpoints (https://docs.gitlab.com/api/):
//   issues      GET/POST /projects/:id/issues, GET/PUT /projects/:id/issues/:iid (state_event close|reopen)
//   notes       GET/POST /projects/:id/issues/:iid/notes (system notes skipped)
//   users       GET /users?username=  (assignee_ids are user ids)
//   commits     GET /projects/:id/repository/commits?ref_name=&since=, GET .../commits/:sha, .../commits/:sha/diff
//   ancestry    GET /projects/:id/repository/merge_base?refs[]=&refs[]=
//   branches    GET/DELETE /projects/:id/repository/branches/:branch
//   files       HEAD /projects/:id/repository/files/:path?ref=, GET /projects/:id/repository/tree?path=&ref=
//   MRs         GET/POST /projects/:id/merge_requests, GET/PUT .../merge_requests/:iid, PUT .../:iid/merge,
//               GET .../:iid/diffs
//   CI          GET /projects/:id/pipelines?sha=, GET /projects/:id/repository/commits/:sha/statuses
//   tags        GET/DELETE /projects/:id/repository/tags/:tag, POST /projects/:id/repository/tags
//   releases    GET /projects/:id/releases?order_by=released_at&sort=desc
// Pagination follows `x-next-page` (offset pagination, 100 per page); a 429 is waited out once when its
// Retry-After is short, else answered `503 rate_limited`.
import { Fail } from "../core/errors";
import type {
  Branches,
  Change,
  CheckRun,
  Checks,
  Comment,
  Commit,
  Issue,
  IssuePatch,
  PullRequest,
  PullRequests,
  Release,
  Releases,
  RepoReference,
  Tags,
  Tracker,
} from "../ports/tracker";

interface GlIssue {
  id: number;
  iid: number;
  title: string;
  description: string | null;
  state: "opened" | "closed";
  labels: string[];
  assignees?: { username: string }[];
  created_at: string;
  updated_at: string;
  web_url: string;
  issue_type?: string;
}

interface GlMr {
  iid: number;
  title: string;
  description: string | null;
  web_url: string;
  source_branch: string;
  target_branch: string;
  sha: string;
  state: "opened" | "closed" | "merged" | "locked";
  merge_commit_sha: string | null;
  squash_commit_sha?: string | null;
  author: { username: string };
  draft?: boolean;
  merge_error?: string | null;
}

type GlDiff = { old_path: string; new_path: string; diff?: string; new_file: boolean; renamed_file: boolean; deleted_file: boolean };

type GlFail = Fail & { gl?: number };

const DRAFT = /^\s*(?:\[draft\]|\(draft\)|draft:|draft\s*-\s*)\s*/i;

const issue = (i: GlIssue): Issue => ({
  n: i.iid,
  title: i.title,
  body: i.description,
  open: i.state === "opened",
  labels: i.labels,
  assignees: (i.assignees ?? []).map((a) => a.username),
  createdAt: i.created_at,
  updatedAt: i.updated_at,
  url: i.web_url,
  ref: String(i.id),
});

const mr = (p: GlMr): PullRequest => ({
  number: p.iid,
  title: p.title.replace(DRAFT, ""),
  body: p.description ?? "",
  url: p.web_url,
  head: p.source_branch,
  headSha: p.sha,
  base: p.target_branch,
  state: p.state === "merged" ? "merged" : p.state === "opened" ? "open" : "closed",
  mergeSha: p.state === "merged" ? (p.merge_commit_sha ?? p.squash_commit_sha ?? p.sha) : null,
  author: p.author.username,
});

const toChanges = (ds: GlDiff[]): Change[] =>
  ds.map((d) => ({
    status: d.new_file ? "A" : d.deleted_file ? "D" : d.renamed_file ? "R" : "M",
    path: d.new_path,
    added: (d.diff ?? "")
      .split("\n")
      .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
      .map((l) => l.slice(1)),
  }));

const gone = (e: unknown) => (e as GlFail).gl === 404;

async function orNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (e) {
    if (gone(e)) return null;
    throw e;
  }
}

const SEG = /^[\w.-]+$/;

/**
 * `group/subgroup/project` from what a user pastes: the path itself, `https://gitlab.com/group/project` (with
 * `.git`, a trailing slash or a deeper link like `/-/issues/3`), `gitlab.com/group/project`,
 * `git@gitlab.com:group/project.git`, `ssh://git@host:2222/group/project.git`; `api` (a self-managed API URL) adds
 * its host.
 */
export function gitlabRepo(api?: string): RepoReference {
  const hosts = new Set(["gitlab.com"]);
  if (api) hosts.add(new URL(api).host.toLowerCase());
  return (raw) => {
    const s = raw.trim().replace(/^<+|>+$/g, "").trim();
    let path = s;
    const ssh = /^(?:ssh:\/\/)?git@([^:/\s]+)(?::\d+\/|[:/])(.+)$/i.exec(s);
    const web = /^(?:(?:https?|git):\/\/)?([^/\s]+\.[^/\s]+)\/(.*)$/i.exec(s);
    const m = ssh ?? web;
    if (m) {
      if (!hosts.has(m[1].toLowerCase().replace(/^www\./, ""))) return undefined;
      path = m[2];
    }
    // `/-/` starts GitLab's own routes (issues, merge requests, tree); a path never contains it
    const parts = path.split(/[?#]/)[0].split("/-/")[0].replace(/\/+$/, "").split("/");
    parts[parts.length - 1] = (parts.at(-1) ?? "").replace(/\.git$/i, "");
    return parts.length >= 2 && parts.every((p) => SEG.test(p) && !/^\.+$/.test(p)) ? parts.join("/") : undefined;
  };
}

export interface GitLabConfig {
  /** The project's path, `group/subgroup/project`. */
  repo: string;
  /** The API base URL; default https://gitlab.com/api/v4. */
  api?: string;
  token: string | undefined;
  tokenName: string;
}

export class GitLab implements Tracker {
  branches: Branches = new GitLabBranches(this);
  pulls: PullRequests = new GitLabMergeRequests(this);
  checks: Checks = new GitLabChecks(this);
  releases: Releases = new GitLabReleases(this);
  tags: Tags = new GitLabTags(this);
  private users = new Map<string, number>();

  constructor(private c: GitLabConfig) {}

  get p() {
    return `/projects/${encodeURIComponent(this.c.repo)}`;
  }

  async send(method: string, path: string, what: string, body?: unknown, retried = false): Promise<Response> {
    if (!this.c.token) throw new Fail(502, "gitlab", `GitLab is not connected yet (the secret ${this.c.tokenName} is missing); nothing was changed.`);
    const res = await fetch((this.c.api ?? "https://gitlab.com/api/v4") + path, {
      method,
      headers: {
        authorization: `Bearer ${this.c.token}`,
        accept: "application/json",
        "user-agent": "flowee",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get("retry-after") ?? "60");
      if (!retried && wait <= 2) {
        await new Promise((r) => setTimeout(r, wait * 1000));
        return this.send(method, path, what, body, true);
      }
      throw new Fail(503, "rate_limited", `GitLab is rate-limiting this token for ${what}; try again in ${Number.isFinite(wait) ? wait : 60} seconds.`);
    }
    if (!res.ok) {
      const err: GlFail = new Fail(502, "gitlab", `GitLab answered ${res.status} for ${what}.`);
      err.gl = res.status;
      throw err;
    }
    return res;
  }

  async req<T>(method: string, path: string, what: string, body?: unknown): Promise<T> {
    const res = await this.send(method, path, what, body);
    return (res.status === 204 ? null : await res.json()) as T;
  }

  /** Every page of a list (`x-next-page` names the next one; empty on the last). */
  async pages<T>(path: string, what: string, max = 100): Promise<T[]> {
    const out: T[] = [];
    const sep = path.includes("?") ? "&" : "?";
    for (let page = 1; page <= max; ) {
      const res = await this.send("GET", `${path}${sep}per_page=100&page=${page}`, what);
      const batch = (await res.json()) as T[];
      out.push(...batch);
      const next = Number(res.headers.get("x-next-page") || 0);
      if (!next || !batch.length) return out;
      page = next;
    }
    return out;
  }

  /** The HTTP status of reading the project (200: the token reaches it). */
  async probe(): Promise<number> {
    try {
      await this.req("GET", this.p, "reading the project");
      return 200;
    } catch (e) {
      if ((e as GlFail).gl) return (e as GlFail).gl as number;
      throw e;
    }
  }

  async issue(n: number): Promise<Issue> {
    try {
      const i = await this.req<GlIssue>("GET", `${this.p}/issues/${n}`, `reading #${n}`);
      if (!i.issue_type || i.issue_type === "issue") return issue(i);
    } catch (e) {
      if (!gone(e)) throw e;
    }
    throw new Fail(404, "not_found", `#${n} does not exist or is not an issue.`);
  }

  async openIssues(): Promise<Issue[]> {
    const all = await this.pages<GlIssue>(`${this.p}/issues?state=opened&issue_type=issue`, "the open tickets");
    return all.map(issue);
  }

  async create(title: string, body: string, labels: string[]): Promise<Issue> {
    return issue(await this.req("POST", `${this.p}/issues`, "filing the ticket", { title, description: body, labels: labels.join(",") }));
  }

  private async userIds(logins: string[], what: string): Promise<number[]> {
    const out: number[] = [];
    for (const u of logins) {
      if (!this.users.has(u)) {
        const found = await this.req<{ id: number; username: string }[]>("GET", `/users?username=${encodeURIComponent(u)}`, what);
        const id = found.find((x) => x.username.toLowerCase() === u.toLowerCase())?.id;
        if (id === undefined) throw new Fail(502, "gitlab", `GitLab has no user '${u}' for ${what}.`);
        this.users.set(u, id);
      }
      out.push(this.users.get(u) as number);
    }
    return out;
  }

  async update(n: number, p: IssuePatch, what: string): Promise<void> {
    const patch: Record<string, unknown> = {};
    if (p.labels) patch.labels = p.labels.join(",");
    if (p.assignees) patch.assignee_ids = p.assignees.length ? await this.userIds(p.assignees, what) : [0];
    // GitLab has no close reason: `not_planned` closes like `completed` (docs/gitlab.md)
    if (p.open === false) patch.state_event = "close";
    if (p.open === true) patch.state_event = "reopen";
    if (p.body !== undefined) patch.description = p.body;
    if (p.title !== undefined) patch.title = p.title;
    await this.req("PUT", `${this.p}/issues/${n}`, what, patch);
  }

  async comment(n: number, body: string): Promise<number> {
    return (await this.req<{ id: number }>("POST", `${this.p}/issues/${n}/notes`, `the comment on #${n}`, { body })).id;
  }

  async comments(n: number): Promise<Comment[]> {
    const cs = await this.pages<{ id: number; body: string; created_at?: string; system?: boolean }>(
      `${this.p}/issues/${n}/notes?sort=asc&order_by=created_at&activity_filter=only_comments`,
      `the comments of #${n}`,
    );
    return cs.filter((c) => !c.system).map((c) => ({ id: c.id, body: c.body, createdAt: c.created_at }));
  }

  async commits(branch: string, since: string): Promise<Commit[]> {
    const all = await this.pages<{ id: string; message: string; title?: string }>(
      `${this.p}/repository/commits?ref_name=${encodeURIComponent(branch)}&since=${encodeURIComponent(since)}`,
      `the commits on ${branch}`,
    );
    return all.map((c) => ({ sha: c.id, subject: c.message.split("\n")[0] })).reverse();
  }

  /** The full sha of a ref (branch, tag or sha), or null. */
  async sha(ref: string, what: string): Promise<string | null> {
    if (/^[0-9a-f]{40}$/.test(ref)) return ref;
    return (await orNull(this.req<{ id: string }>("GET", `${this.p}/repository/commits/${encodeURIComponent(ref)}`, what)))?.id ?? null;
  }

  async contains(base: string, head: string): Promise<boolean> {
    const what = `comparing ${base.slice(0, 7)} with ${head.slice(0, 7)}`;
    const b = await this.sha(base, what);
    if (!b) return false;
    if (b === head) return true;
    const mb = await orNull(this.req<{ id: string }>("GET", `${this.p}/repository/merge_base?refs[]=${encodeURIComponent(b)}&refs[]=${encodeURIComponent(head)}`, what));
    return mb?.id === b;
  }
}

const enc = encodeURIComponent;

class GitLabBranches implements Branches {
  constructor(private gl: GitLab) {}

  async head(name: string) {
    return (await orNull(this.gl.req<{ commit: { id: string } }>("GET", `${this.gl.p}/repository/branches/${enc(name)}`, `the branch ${name}`)))?.commit.id ?? null;
  }

  async exists(ref: string, path: string) {
    const what = `${path} on ${ref}`;
    if ((await orNull(this.gl.send("HEAD", `${this.gl.p}/repository/files/${enc(path)}?ref=${enc(ref)}`, what))) !== null) return true;
    // a directory: its tree lists something (git keeps no empty directories)
    const tree = await orNull(this.gl.req<unknown[]>("GET", `${this.gl.p}/repository/tree?path=${enc(path)}&ref=${enc(ref)}&per_page=1`, what));
    return !!tree?.length;
  }

  async changes(sha: string): Promise<Change[]> {
    return toChanges(await this.gl.pages<GlDiff>(`${this.gl.p}/repository/commits/${sha}/diff`, `the changes of ${sha.slice(0, 7)}`));
  }

  async remove(name: string) {
    await orNull(this.gl.req("DELETE", `${this.gl.p}/repository/branches/${enc(name)}`, `deleting the branch ${name}`));
  }
}

class GitLabMergeRequests implements PullRequests {
  constructor(private gl: GitLab) {}

  private raw(iid: number) {
    return orNull(this.gl.req<GlMr>("GET", `${this.gl.p}/merge_requests/${iid}`, `merge request !${iid}`));
  }

  async forBranch(branch: string) {
    const all = await this.gl.req<GlMr[]>("GET", `${this.gl.p}/merge_requests?state=all&source_branch=${enc(branch)}&per_page=100`, `the merge requests of ${branch}`);
    const ps = all.map(mr).sort((a, b) => Number(b.state === "open") - Number(a.state === "open") || b.number - a.number);
    return ps[0] ?? null;
  }

  async get(number: number) {
    const p = await this.raw(number);
    if (!p) throw new Fail(404, "not_found", `Merge request !${number} does not exist.`);
    return mr(p);
  }

  async open() {
    return (await this.gl.pages<GlMr>(`${this.gl.p}/merge_requests?state=opened`, "the open merge requests")).map(mr);
  }

  async create(head: string, base: string, title: string, body: string) {
    return mr(await this.gl.req<GlMr>("POST", `${this.gl.p}/merge_requests`, `opening the merge request of ${head}`, { source_branch: head, target_branch: base, title, description: body }));
  }

  async update(number: number, patch: { title?: string; body?: string }) {
    const body: Record<string, string> = {};
    if (patch.body !== undefined) body.description = patch.body;
    if (patch.title !== undefined) {
      // a draft stays a draft: GitLab keeps that in the title's prefix
      const cur = await this.raw(number);
      const prefix = cur && DRAFT.exec(cur.title)?.[0];
      body.title = prefix ? `${prefix}${patch.title}` : patch.title;
    }
    await this.gl.req("PUT", `${this.gl.p}/merge_requests/${number}`, `updating merge request !${number}`, body);
  }

  /**
   * Merges now (never `auto_merge`: Flowee checked the pipeline itself), pinned to the head it read (`sha`). `merge`
   * and `rebase` use the project's merge method (merge commit, semi-linear or fast-forward); `squash` squashes.
   */
  async merge(number: number, method: "merge" | "squash" | "rebase", subject?: string) {
    const refuse = (code: number | string) =>
      new Fail(409, "not_mergeable", `GitLab refused to merge merge request !${number} (${code}): it is not mergeable, its head moved or the branch is protected.`);
    const cur = await this.raw(number);
    if (!cur) throw new Fail(404, "not_found", `Merge request !${number} does not exist.`);
    if (cur.state !== "opened") throw refuse(cur.state);
    const body: Record<string, unknown> = { sha: cur.sha };
    if (method === "squash") Object.assign(body, { squash: true, ...(subject ? { squash_commit_message: subject } : {}) });
    else if (subject) body.merge_commit_message = subject;
    let p: GlMr;
    try {
      p = await this.gl.req<GlMr>("PUT", `${this.gl.p}/merge_requests/${number}/merge`, `merging merge request !${number}`, body);
    } catch (e) {
      const code = (e as GlFail).gl;
      if (code && [401, 403, 405, 406, 409, 422].includes(code)) throw refuse(code);
      throw e;
    }
    if (p.state !== "merged") p = (await this.raw(number)) ?? p;
    if (p.state !== "merged") throw refuse(p.merge_error ? "not merged" : p.state);
    return mr(p).mergeSha as string;
  }

  async files(number: number): Promise<Change[]> {
    return toChanges(await this.gl.pages<GlDiff>(`${this.gl.p}/merge_requests/${number}/diffs`, `the files of merge request !${number}`, 30));
  }
}

const QUEUED = new Set(["created", "waiting_for_resource", "preparing", "waiting_for_callback", "pending", "scheduled"]);

/** A GitLab job, commit status or pipeline status as a check run. */
export function run(name: string, status: string, allowFailure = false): CheckRun {
  if (QUEUED.has(status)) return { name, status: "queued", conclusion: null };
  if (status === "running" || status === "canceling") return { name, status: "in_progress", conclusion: null };
  const done = (conclusion: CheckRun["conclusion"]): CheckRun => ({ name, status: "completed", conclusion });
  if (status === "success") return done("success");
  if (status === "skipped") return done("skipped");
  if (status === "canceled") return done(allowFailure ? "neutral" : "cancelled");
  // a manual job: optional ones (allow_failure) do not hold anything up; a blocking one waits for a person
  if (status === "manual") return done(allowFailure ? "skipped" : "action_required");
  return done(allowFailure ? "neutral" : "failure");
}

class GitLabChecks implements Checks {
  constructor(private gl: GitLab) {}

  /** The commit's newest pipeline as `pipeline`, then every job and external status of it (the newest per name). */
  async forCommit(sha: string): Promise<CheckRun[]> {
    const what = `the checks of ${sha.slice(0, 7)}`;
    const pipes = await this.gl.req<{ id: number; status: string }[]>("GET", `${this.gl.p}/pipelines?sha=${sha}&order_by=id&sort=desc&per_page=1`, what);
    const st = await this.gl.pages<{ id: number; name: string; status: string; allow_failure?: boolean }>(`${this.gl.p}/repository/commits/${sha}/statuses`, what, 10);
    const out = new Map<string, CheckRun>();
    if (pipes[0]) out.set("pipeline", run("pipeline", pipes[0].status));
    for (const s of [...st].sort((a, b) => b.id - a.id)) if (!out.has(s.name)) out.set(s.name, run(s.name, s.status, s.allow_failure));
    return [...out.values()];
  }
}

class GitLabReleases implements Releases {
  constructor(private gl: GitLab) {}

  async latest(): Promise<Release | null> {
    const rs = await this.gl.req<{ tag_name: string; name: string | null; description: string | null; released_at: string; upcoming_release?: boolean; _links?: { self?: string } }[]>(
      "GET",
      `${this.gl.p}/releases?order_by=released_at&sort=desc&per_page=20`,
      "the latest release",
    );
    const r = rs.find((x) => !x.upcoming_release);
    if (!r) return null;
    const sha = /build from `?([0-9a-f]{40})/.exec(r.description ?? "")?.[1] ?? null;
    return { tag: r.tag_name, name: r.name || r.tag_name, sha, body: r.description ?? "", url: r._links?.self ?? "", publishedAt: r.released_at };
  }
}

class GitLabTags implements Tags {
  constructor(private gl: GitLab) {}

  /** The commit a tag points at (an annotated tag's `commit` is already its target). */
  async get(name: string) {
    return (await orNull(this.gl.req<{ commit: { id: string } }>("GET", `${this.gl.p}/repository/tags/${enc(name)}`, `the tag ${name}`)))?.commit.id ?? null;
  }

  /** GitLab cannot move a tag: delete it (when it points elsewhere) and create it on `sha`. */
  async move(name: string, sha: string) {
    const cur = await this.get(name);
    if (cur === sha) return;
    if (cur !== null) await this.gl.req("DELETE", `${this.gl.p}/repository/tags/${enc(name)}`, `moving the tag ${name}`);
    await this.gl.req("POST", `${this.gl.p}/repository/tags`, cur === null ? `creating the tag ${name}` : `moving the tag ${name}`, { tag_name: name, ref: sha });
  }
}

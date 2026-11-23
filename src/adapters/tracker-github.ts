// The Tracker port over the GitHub REST API (issues, labels, comments, commits, compare) and, for the optional
// board, a user's Projects (v2) board over GraphQL. Plain fetch, no SDK.
import { Fail } from "../core/errors";
import type { Hooks } from "../ports/hooks";
import { MAX_COMMITS, TOKEN_DAYS, tooManyCommits } from "../ports/tracker";
import type { Board, Branches, Checks, Comment, Commit, Issue, IssuePatch, PullRequests, Releases, RepoReference, Tags, TokenHelp, Tracker } from "../ports/tracker";
import { GitHubHooks } from "./hooks-github";
import { GitHubBranches, GitHubChecks, GitHubPulls, GitHubReleases, GitHubTags } from "./tracker-github-code";

interface GhIssue {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  labels: { name: string }[];
  assignees: { login: string }[];
  created_at: string;
  updated_at: string;
  html_url: string;
  node_id: string;
  pull_request?: unknown;
}

type GhFail = Fail & { gh?: number };

const issue = (i: GhIssue): Issue => ({
  n: i.number,
  title: i.title,
  body: i.body,
  open: i.state === "open",
  labels: i.labels.map((l) => l.name),
  assignees: i.assignees.map((a) => a.login),
  createdAt: i.created_at,
  updatedAt: i.updated_at,
  url: i.html_url,
  ref: i.node_id,
});

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const NAME = /^[\w.-]{1,100}$/;

/**
 * `owner/name` from what a user pastes: `owner/name`, `https://github.com/owner/name` (with `www.`, `.git`, a trailing
 * slash or a deeper link like `/issues/12`), `github.com/owner/name`, `git@github.com:owner/name.git`; `api` (an
 * Enterprise API URL) adds its host.
 */
export function githubRepo(api?: string): RepoReference {
  const hosts = new Set(["github.com"]);
  if (api) hosts.add(new URL(api).host.toLowerCase().replace(/^api\./, ""));
  return (raw) => {
    const s = raw.trim().replace(/^<+|>+$/g, "").trim();
    let path = s;
    const ssh = /^(?:ssh:\/\/)?git@([^:/\s]+)[:/](.+)$/i.exec(s);
    const web = /^(?:(?:https?|git):\/\/)?([^/\s]+\.[^/\s]+)\/(.*)$/i.exec(s);
    const m = ssh ?? web;
    if (m) {
      if (!hosts.has(m[1].toLowerCase().replace(/^www\./, ""))) return undefined;
      path = m[2];
    }
    const [owner, name0] = path.split(/[?#]/)[0].split("/");
    const name = (name0 ?? "").replace(/\.git$/i, "");
    return OWNER.test(owner) && NAME.test(name) && !/^\.+$/.test(name) ? `${owner}/${name}` : undefined;
  };
}

const PERMISSION: Record<string, string> = { issues: "Issues", contents: "Contents", repository_hooks: "Webhooks", pull_requests: "Pull requests", checks: "Checks", statuses: "Commit statuses" };

/** A fine-grained token's permissions per feature (docs/adapters.md) and the token form filled in with them. */
export function githubToken(api?: string): TokenHelp {
  const web = api && !/^https:\/\/api\.github\.com\/?$/.test(api) ? `https://${new URL(api).host}` : "https://github.com";
  return (repos, name, features, days = TOKEN_DAYS) => {
    const p: Record<string, "read" | "write"> = { issues: "write", contents: "read" };
    const on = new Set(features);
    if (on.has("pullRequests")) Object.assign(p, { pull_requests: "write", checks: "read", statuses: "read", contents: "write" });
    if (on.has("dependencyTickets")) p.pull_requests ??= "read";
    // lets Flowee register its webhook itself (docs/webhooks.md); without it the workspace polls
    p.repository_hooks = "write";
    const owners = [...new Set(repos.map((r) => r.split("/")[0]))];
    const q = new URLSearchParams({ name: name.slice(0, 40), description: `Flowee: ${repos.join(", ")}`.slice(0, 1024), ...(owners.length === 1 ? { target_name: owners[0] } : {}), expires_in: String(days), ...p });
    return {
      permissions: Object.entries(p).map(([k, v]) => `${PERMISSION[k]}: ${v === "write" ? "read and write" : "read"}`),
      url: `${web}/settings/personal-access-tokens/new?${q}`,
      filled: `GitHub opens the form with the name, the owner, the permissions and ${days === "none" ? "no expiry" : `an expiry of ${days} days`} filled in.`,
      // the form's link parameters are name, description, target_name, expires_in and the permissions: no repositories
      steps: [`GitHub cannot preselect the repository from a link: under Repository access choose Only select repositories and pick ${repos.map((r) => `\`${r}\``).join(", ")}.`],
    };
  };
}

export interface GitHubConfig {
  repo: string;
  /** The API base URL; default https://api.github.com. */
  api?: string;
  /** The token's value, undefined when the secret is missing. */
  token: string | undefined;
  /** The name of the token's secret, for the message when it is missing. */
  tokenName: string;
  project?: { owner: string; number: number };
}

export class GitHub implements Tracker {
  board?: Board;
  branches: Branches = new GitHubBranches(this);
  pulls: PullRequests = new GitHubPulls(this);
  checks: Checks = new GitHubChecks(this);
  releases: Releases = new GitHubReleases(this);
  tags: Tags = new GitHubTags(this);
  hooks: Hooks = new GitHubHooks(this);

  constructor(private c: GitHubConfig) {
    if (c.project) this.board = new ProjectBoard(this, c.project);
  }

  async req<T>(method: string, path: string, what: string, body?: unknown, retried = false): Promise<T> {
    if (!this.c.token) throw new Fail(502, "github", `GitHub is not connected yet (the secret ${this.c.tokenName} is missing); nothing was changed.`);
    const res = await fetch((this.c.api ?? "https://api.github.com") + path, {
      method,
      headers: {
        authorization: `Bearer ${this.c.token}`,
        accept: "application/vnd.github+json",
        "user-agent": "flowee",
        "x-github-api-version": "2022-11-28",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // a rate limit: 429, or 403 with no requests left (docs.github.com/rest/using-the-rest-api/rate-limits-for-the-rest-api)
    if (res.status === 429 || (res.status === 403 && (res.headers.get("retry-after") || res.headers.get("x-ratelimit-remaining") === "0"))) {
      const reset = Number(res.headers.get("x-ratelimit-reset") ?? 0);
      const wait = Number(res.headers.get("retry-after") ?? (reset ? Math.max(0, Math.ceil(reset - Date.now() / 1000)) : 60));
      if (!retried && wait <= 2) {
        await new Promise((r) => setTimeout(r, wait * 1000));
        return this.req(method, path, what, body, true);
      }
      throw new Fail(503, "rate_limited", `GitHub is rate-limiting this token for ${what}; try again in ${Number.isFinite(wait) ? wait : 60} seconds.`);
    }
    if (!res.ok) {
      const err: GhFail = new Fail(502, "github", `GitHub answered ${res.status} for ${what}.`);
      err.gh = res.status;
      throw err;
    }
    return (res.status === 204 ? null : await res.json()) as T;
  }

  private async pages<T>(path: string, what: string, max = Infinity): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; page <= max; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const batch = await this.req<T[]>("GET", `${path}${sep}per_page=100&page=${page}`, what);
      out.push(...batch);
      if (batch.length < 100) return out;
    }
    return out;
  }

  get r() {
    return `/repos/${this.c.repo}`;
  }

  /** The repositories the token reaches (first page, most recently updated first): a check that it is not wider than needed. */
  async reach(): Promise<string[]> {
    return (await this.req<{ full_name: string }[]>("GET", "/user/repos?per_page=100&sort=updated", "listing the token's repositories")).map((r) => r.full_name);
  }

  /** The HTTP status of reading the repository (200: the token reaches it). */
  async probe(): Promise<number> {
    try {
      await this.req("GET", this.r, "reading the repository");
      return 200;
    } catch (e) {
      if ((e as GhFail).gh) return (e as GhFail).gh as number;
      throw e;
    }
  }

  async issue(n: number): Promise<Issue> {
    try {
      const i = await this.req<GhIssue>("GET", `${this.r}/issues/${n}`, `reading #${n}`);
      if (!i.pull_request) return issue(i);
    } catch (e) {
      if (!(e instanceof Fail) || (e as GhFail).gh !== 404) throw e;
    }
    throw new Fail(404, "not_found", `#${n} does not exist or is a pull request.`);
  }

  async openIssues(): Promise<Issue[]> {
    const all = await this.pages<GhIssue>(`${this.r}/issues?state=open`, "the open tickets");
    return all.filter((i) => !i.pull_request).map(issue);
  }

  async create(title: string, body: string, labels: string[]): Promise<Issue> {
    return issue(await this.req("POST", `${this.r}/issues`, "filing the ticket", { title, body, labels }));
  }

  async update(n: number, p: IssuePatch, what: string): Promise<void> {
    const patch: Record<string, unknown> = {};
    if (p.labels) patch.labels = p.labels;
    if (p.assignees) patch.assignees = p.assignees;
    if (p.open === false) Object.assign(patch, { state: "closed", state_reason: p.reason ?? "completed" });
    if (p.open === true) patch.state = "open";
    if (p.body !== undefined) patch.body = p.body;
    if (p.title !== undefined) patch.title = p.title;
    await this.req("PATCH", `${this.r}/issues/${n}`, what, patch);
  }

  async comment(n: number, body: string): Promise<number> {
    return (await this.req<{ id: number }>("POST", `${this.r}/issues/${n}/comments`, `the comment on #${n}`, { body })).id;
  }

  async comments(n: number): Promise<Comment[]> {
    const cs = await this.pages<{ id: number; body: string; created_at?: string }>(`${this.r}/issues/${n}/comments`, `the comments of #${n}`);
    return cs.map((c) => ({ id: c.id, body: c.body, createdAt: c.created_at }));
  }

  async commits(branch: string, since: string): Promise<Commit[]> {
    // one page past the cap tells whether there are more
    const all = await this.pages<{ sha: string; commit: { message: string } }>(`${this.r}/commits?sha=${branch}&since=${since}`, `the commits on ${branch}`, MAX_COMMITS / 100 + 1);
    if (all.length > MAX_COMMITS) throw tooManyCommits(branch, since);
    return all.map((c) => ({ sha: c.sha, subject: c.commit.message.split("\n")[0] })).reverse();
  }

  async contains(base: string, head: string): Promise<boolean> {
    try {
      const c = await this.req<{ status: string }>("GET", `${this.r}/compare/${base}...${head}`, `comparing ${base.slice(0, 7)} with ${head.slice(0, 7)}`);
      return c.status === "ahead" || c.status === "identical";
    } catch (e) {
      if ((e as GhFail).gh === 404) return false;
      throw e;
    }
  }
}

class ProjectBoard implements Board {
  private project?: { id: string; field: string; options: Record<string, string> };

  constructor(
    private gh: GitHub,
    private p: { owner: string; number: number },
  ) {}

  private async graphql<T>(query: string, variables: Record<string, unknown>, what: string): Promise<T> {
    const r = await this.gh.req<{ data: T; errors?: { message: string }[] }>("POST", "/graphql", what, { query, variables });
    if (r.errors?.length) throw new Fail(502, "github", `GitHub refused ${what}: ${r.errors[0].message}`);
    return r.data;
  }

  async setStatus(i: Issue, name: string): Promise<void> {
    if (!this.project) {
      const d = await this.graphql<{
        user: { projectV2: { id: string; field: { id: string; options: { id: string; name: string }[] } } | null };
      }>(
        `query($login:String!,$n:Int!){user(login:$login){projectV2(number:$n){id field(name:"Status"){... on ProjectV2SingleSelectField{id options{id name}}}}}}`,
        { login: this.p.owner, n: this.p.number },
        "reading the project",
      );
      const p = d.user.projectV2;
      if (!p?.field) throw new Fail(502, "github", `Project ${this.p.number} or its Status field was not found.`);
      this.project = { id: p.id, field: p.field.id, options: Object.fromEntries(p.field.options.map((o) => [o.name, o.id])) };
    }
    const p = this.project;
    const option = p.options[name];
    if (!option) throw new Fail(502, "github", `The project has no status '${name}'.`);
    const add = await this.graphql<{ addProjectV2ItemById: { item: { id: string } } }>(
      `mutation($p:ID!,$c:ID!){addProjectV2ItemById(input:{projectId:$p,contentId:$c}){item{id}}}`,
      { p: p.id, c: i.ref },
      "adding the ticket to the project",
    );
    await this.graphql(
      `mutation($p:ID!,$i:ID!,$f:ID!,$o:String!){updateProjectV2ItemFieldValue(input:{projectId:$p,itemId:$i,fieldId:$f,value:{singleSelectOptionId:$o}}){projectV2Item{id}}}`,
      { p: p.id, i: add.addProjectV2ItemById.item.id, f: p.field, o: option },
      "the project status",
    );
  }
}

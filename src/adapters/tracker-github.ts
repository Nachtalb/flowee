// The Tracker port over the GitHub REST API (issues, labels, comments, commits, compare) and, for the optional
// board, a user's Projects (v2) board over GraphQL. Plain fetch, no SDK.
import { Fail } from "../core/errors";
import type { Board, Branches, Checks, Comment, Commit, Issue, IssuePatch, PullRequests, Releases, Tags, Tracker } from "../ports/tracker";
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

  constructor(private c: GitHubConfig) {
    if (c.project) this.board = new ProjectBoard(this, c.project);
  }

  async req<T>(method: string, path: string, what: string, body?: unknown): Promise<T> {
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
    if (!res.ok) {
      const err: GhFail = new Fail(502, "github", `GitHub answered ${res.status} for ${what}.`);
      err.gh = res.status;
      throw err;
    }
    return (res.status === 204 ? null : await res.json()) as T;
  }

  private async pages<T>(path: string, what: string): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; ; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const batch = await this.req<T[]>("GET", `${path}${sep}per_page=100&page=${page}`, what);
      out.push(...batch);
      if (batch.length < 100) return out;
    }
  }

  get r() {
    return `/repos/${this.c.repo}`;
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
    const all = await this.pages<{ sha: string; commit: { message: string } }>(`${this.r}/commits?sha=${branch}&since=${since}`, `the commits on ${branch}`);
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

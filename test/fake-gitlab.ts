// An in-memory stand-in for the GitLab REST API v4 of one project, served through the same fetch stub as the fake
// GitHub (test/fake.ts routes gitlab.com and gitlab.example.com here). It keeps what the adapter reads and writes:
// issues by iid (each with a global id), notes (system notes too), commits on main and on branches, merge
// requests, pipelines and commit statuses, tags, releases and users.
type Note = { id: number; body: string; system: boolean; created_at: string };
type GIssue = {
  id: number;
  iid: number;
  title: string;
  description: string | null;
  state: "opened" | "closed";
  labels: string[];
  assignees: { id: number; username: string }[];
  created_at: string;
  updated_at: string;
  web_url: string;
  issue_type: string;
  confidential: boolean;
  notes: Note[];
};
type Mr = {
  id: number;
  iid: number;
  title: string;
  description: string | null;
  web_url: string;
  source_branch: string;
  target_branch: string;
  sha: string;
  state: "opened" | "closed" | "merged" | "locked";
  merge_commit_sha: string | null;
  squash_commit_sha: string | null;
  author: { username: string };
  draft: boolean;
  /** The status the merge call answers instead of merging (405 not mergeable, 403 protected branch, …). */
  refuse?: number;
};
type Diff = { old_path: string; new_path: string; diff: string; new_file: boolean; renamed_file: boolean; deleted_file: boolean };

export class FakeGitLab {
  issues = new Map<number, GIssue>();
  main: { sha: string; message: string }[] = [];
  branches = new Map<string, string>();
  /** The commits a branch has beyond main, oldest first. */
  commitsOn = new Map<string, string[]>();
  /** sha of a branch commit -> index of the main commit it is based on. */
  based = new Map<string, number>();
  files = new Set<string>();
  changes = new Map<string, Diff[]>();
  mrs: Mr[] = [];
  pipelines = new Map<string, { id: number; status: string }[]>();
  statuses = new Map<string, { id: number; name: string; status: string; allow_failure: boolean }[]>();
  releases: { tag_name: string; name: string; description: string; released_at: string; upcoming_release: boolean; _links: { self: string } }[] = [];
  tags = new Map<string, string>();
  users = new Map<string, number>([["ann", 7], ["dev", 8]]);
  merged: { iid: number; body: Record<string, unknown> }[] = [];
  fail?: (method: string, path: string) => number | Response | undefined;
  writes: string[] = [];
  auth: string[] = [];
  private seq = 1;
  private n = 0;

  constructor(
    public repo = "grp/sub/shop",
    public projectId = 4242,
  ) {}

  /** The project part of a path, by URL-encoded path or by id. */
  owns(path: string) {
    return this.rest(path) !== undefined;
  }

  private rest(path: string): string | undefined {
    for (const p of [`/api/v4/projects/${encodeURIComponent(this.repo)}`, `/api/v4/projects/${this.projectId}`])
      if (path === p || path.startsWith(`${p}/`)) return path.slice(p.length + 1);
    return undefined;
  }

  add(o: Partial<GIssue> & { state_label?: string | string[] } = {}): GIssue {
    const iid = o.iid ?? this.issues.size + 1;
    const i: GIssue = {
      id: 90000 + iid,
      iid,
      title: o.title ?? `Ticket ${iid}`,
      description: o.description ?? "## Acceptance\n- works",
      state: o.state ?? "opened",
      labels: [...[o.state_label ?? []].flat(), ...(o.labels ?? [])],
      assignees: o.assignees ?? [],
      created_at: "2026-11-01T00:00:00Z",
      updated_at: o.updated_at ?? `2026-11-02T00:00:${String(iid % 60).padStart(2, "0")}Z`,
      web_url: `https://gitlab.com/${this.repo}/-/issues/${iid}`,
      issue_type: o.issue_type ?? "issue",
      confidential: o.confidential ?? false,
      notes: [],
    };
    this.issues.set(iid, i);
    return i;
  }

  commit(message: string): string {
    const sha = (this.main.length + 1).toString(16).padStart(40, "c");
    this.main.push({ sha, message });
    return sha;
  }

  /** A commit on a branch (based on main's head), the branch pointing at it; `A:` marks an added file. */
  push(branch: string, files: Record<string, string> = {}): string {
    const sha = `d${String(++this.n).padStart(39, "0")}`;
    this.commitsOn.set(branch, [...(this.branches.has(branch) ? (this.commitsOn.get(branch) ?? []) : []), sha]);
    this.branches.set(branch, sha);
    this.based.set(sha, this.main.length - 1);
    this.changes.set(
      sha,
      Object.entries(files).map(([p, patch]) => ({ old_path: p, new_path: p, diff: patch.replace(/^A:/, ""), new_file: patch.startsWith("A:"), renamed_file: false, deleted_file: false })),
    );
    return sha;
  }

  mr(branch: string, title: string, author = "dev"): Mr {
    const iid = this.mrs.length + 1;
    const m: Mr = {
      id: 70000 + iid,
      iid,
      title,
      description: "",
      web_url: `https://gitlab.com/${this.repo}/-/merge_requests/${iid}`,
      source_branch: branch,
      target_branch: "main",
      sha: this.branches.get(branch) ?? "",
      state: "opened",
      merge_commit_sha: null,
      squash_commit_sha: null,
      author: { username: author },
      draft: /^draft:/i.test(title),
    };
    this.mrs.push(m);
    return m;
  }

  /** The commit's pipeline and its jobs, all passed (or the given status). */
  green(sha: string, ...names: string[]) {
    this.pipeline(sha, "success", ...(names.length ? names : ["build"]).map((n) => [n, "success"] as [string, string]));
  }

  pipeline(sha: string, status: string, ...jobs: [string, string, boolean?][]) {
    const id = this.seq++;
    this.pipelines.set(sha, [{ id, status }, ...(this.pipelines.get(sha) ?? [])]);
    this.statuses.set(sha, [...(this.statuses.get(sha) ?? []), ...jobs.map(([name, s, af]) => ({ id: this.seq++, name, status: s, allow_failure: !!af }))]);
  }

  publish(name: string, sha: string) {
    this.releases.unshift({
      tag_name: name,
      name,
      description: `Built from main.\n\nbuild from \`${sha}\``,
      released_at: "2026-11-20T00:00:00Z",
      upcoming_release: false,
      _links: { self: `https://gitlab.com/${this.repo}/-/releases/${name}` },
    });
  }

  label(n: number) {
    return this.issues.get(n)?.labels ?? [];
  }

  last(n: number) {
    const ns = this.issues.get(n)?.notes.filter((x) => !x.system) ?? [];
    return ns[ns.length - 1]?.body ?? "";
  }

  /** The commits a sha contains (itself included), newest first. */
  private ancestors(sha: string): string[] {
    const i = this.main.findIndex((c) => c.sha === sha);
    if (i >= 0) return this.main.slice(0, i + 1).map((c) => c.sha).reverse();
    for (const [, shas] of this.commitsOn) {
      const j = shas.indexOf(sha);
      if (j >= 0) return [...shas.slice(0, j + 1).reverse(), ...this.main.slice(0, (this.based.get(shas[0]) ?? -1) + 1).map((c) => c.sha).reverse()];
    }
    return [];
  }

  private resolve(ref: string): string | undefined {
    if (ref === "main" || ref === "master") return this.main.at(-1)?.sha;
    if (this.branches.has(ref)) return this.branches.get(ref);
    return this.ancestors(ref).length ? ref : undefined;
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;
    this.auth.push(req.headers.get("authorization") ?? "");
    await new Promise((r) => setTimeout(r, 2));
    const f = this.fail?.(method, path);
    if (f instanceof Response) return f;
    if (f) return Response.json({ message: `${f}` }, { status: f });
    const raw = method === "GET" || method === "HEAD" ? "" : await req.text();
    const body = (raw ? JSON.parse(raw) : {}) as Record<string, any>;
    if (method !== "GET" && method !== "HEAD") this.writes.push(`${method} ${path}`);
    const q = url.searchParams;
    const per = Number(q.get("per_page") ?? 20);
    const page = Number(q.get("page") ?? 1);
    const ok = (b: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(b, { status, headers });
    const nf = () => ok({ message: "404 Not Found" }, 404);
    const list = <X>(xs: X[]) => {
      const next = page * per < xs.length ? String(page + 1) : "";
      return ok(xs.slice((page - 1) * per, page * per), 200, { "x-next-page": next, "x-page": String(page), "x-per-page": String(per) });
    };
    const view = (i: GIssue) => {
      const { notes, ...rest } = i;
      return rest;
    };
    const mrView = (m: Mr) => {
      const { refuse, ...v } = m;
      return { ...v, sha: m.state === "opened" ? (this.branches.get(m.source_branch) ?? m.sha) : m.sha };
    };
    if (path === "/api/v4/users") {
      const u = q.get("username") ?? "";
      const id = this.users.get(u);
      return ok(id === undefined ? [] : [{ id, username: u }]);
    }
    const rest = this.rest(path);
    if (rest === undefined) return nf();
    const r = decodeURIComponent(rest);
    let m: RegExpExecArray | null;
    if (rest === "" && method === "GET") return ok({ id: this.projectId, path_with_namespace: this.repo });

    // issues and notes
    if (r === "issues" && method === "GET")
      return list([...this.issues.values()].filter((i) => (!q.get("state") || i.state === q.get("state")) && (!q.get("issue_type") || i.issue_type === q.get("issue_type"))).map(view));
    if (r === "issues" && method === "POST") {
      const i = this.add({ iid: this.issues.size + 1, title: body.title, description: body.description });
      i.labels = body.labels ? String(body.labels).split(",") : [];
      return ok(view(i), 201);
    }
    if ((m = /^issues\/(\d+)$/.exec(r))) {
      const i = this.issues.get(Number(m[1]));
      if (!i) return nf();
      if (method === "PUT") {
        if (body.labels !== undefined) i.labels = body.labels === "" ? [] : String(body.labels).split(",");
        if (body.add_labels) i.labels = [...new Set([...i.labels, ...String(body.add_labels).split(",")])];
        if (body.remove_labels) i.labels = i.labels.filter((l) => !String(body.remove_labels).split(",").includes(l));
        if (body.assignee_ids) {
          const ids = (body.assignee_ids as number[]).filter((x) => x !== 0);
          i.assignees = ids.map((id) => ({ id, username: [...this.users].find(([, v]) => v === id)?.[0] ?? "?" }));
        }
        if (body.state_event === "close") i.state = "closed";
        if (body.state_event === "reopen") i.state = "opened";
        if (body.title !== undefined) i.title = body.title;
        if (body.description !== undefined) i.description = body.description;
        if (body.state_event) i.notes.push({ id: this.seq++, body: body.state_event === "close" ? "closed" : "reopened", system: true, created_at: new Date().toISOString() });
      }
      return ok(view(i));
    }
    if ((m = /^issues\/(\d+)\/notes$/.exec(r))) {
      const i = this.issues.get(Number(m[1]));
      if (!i) return nf();
      if (method === "POST") {
        const n: Note = { id: this.seq++, body: body.body, system: false, created_at: new Date().toISOString() };
        i.notes.push(n);
        return ok(n, 201);
      }
      let ns = q.get("activity_filter") === "only_comments" ? i.notes.filter((x) => !x.system) : i.notes;
      if (q.get("sort") !== "asc") ns = [...ns].reverse();
      return list(ns);
    }

    // commits, ancestry, files
    if (r === "repository/commits") {
      const head = this.resolve(q.get("ref_name") ?? "main");
      const shas = head ? this.ancestors(head) : [];
      const msg = (s: string) => this.main.find((c) => c.sha === s)?.message ?? `commit ${s}`;
      return list(shas.map((s) => ({ id: s, short_id: s.slice(0, 8), title: msg(s).split("\n")[0], message: msg(s) })));
    }
    if ((m = /^repository\/commits\/([^/]+)\/diff$/.exec(r))) return list(this.changes.get(m[1]) ?? []);
    if ((m = /^repository\/commits\/([^/]+)\/statuses$/.exec(r))) return list(this.statuses.get(m[1]) ?? []);
    if ((m = /^repository\/commits\/([^/]+)$/.exec(r))) {
      const s = this.resolve(m[1]);
      return s ? ok({ id: s }) : nf();
    }
    if (r === "repository/merge_base") {
      const refs = q.getAll("refs[]").map((x) => this.resolve(x));
      if (refs.some((x) => !x)) return nf();
      const b = this.ancestors(refs[1] as string);
      const common = this.ancestors(refs[0] as string).find((x) => b.includes(x));
      return common ? ok({ id: common }) : nf();
    }
    if ((m = /^repository\/files\/(.+)$/.exec(r))) return this.files.has(m[1]) ? new Response(null, { status: 200 }) : nf();
    if (r === "repository/tree") {
      const p = q.get("path") ?? "";
      const under = [...this.files].filter((x) => x.startsWith(`${p}/`));
      return under.length ? ok(under.slice(0, per).map((x) => ({ path: x }))) : nf();
    }

    // branches and tags
    if ((m = /^repository\/branches\/(.+)$/.exec(r))) {
      if (!this.branches.has(m[1])) return nf();
      if (method === "DELETE") {
        this.branches.delete(m[1]);
        return new Response(null, { status: 204 });
      }
      return ok({ name: m[1], commit: { id: this.branches.get(m[1]) } });
    }
    if ((m = /^repository\/tags\/(.+)$/.exec(r))) {
      if (!this.tags.has(m[1])) return nf();
      if (method === "DELETE") {
        this.tags.delete(m[1]);
        return new Response(null, { status: 204 });
      }
      return ok({ name: m[1], target: `t${m[1]}`, commit: { id: this.tags.get(m[1]) } });
    }
    if (r === "repository/tags" && method === "POST") {
      if (this.tags.has(body.tag_name)) return ok({ message: "Tag already exists" }, 400);
      this.tags.set(body.tag_name, this.resolve(body.ref) ?? body.ref);
      return ok({ name: body.tag_name }, 201);
    }

    // merge requests
    if (r === "merge_requests" && method === "GET") {
      const st = q.get("state");
      return list(this.mrs.filter((x) => (!q.get("source_branch") || x.source_branch === q.get("source_branch")) && (!st || st === "all" || x.state === st)).map(mrView));
    }
    if (r === "merge_requests" && method === "POST") {
      const x = this.mr(body.source_branch, body.title);
      x.description = body.description;
      x.target_branch = body.target_branch;
      return ok(mrView(x), 201);
    }
    if ((m = /^merge_requests\/(\d+)(\/merge|\/diffs)?$/.exec(r))) {
      const x = this.mrs.find((y) => y.iid === Number(m?.[1]));
      if (!x) return nf();
      if (m[2] === "/diffs") return list((this.commitsOn.get(x.source_branch) ?? []).flatMap((s) => this.changes.get(s) ?? []));
      if (m[2] === "/merge" && method === "PUT") {
        if (x.refuse) return ok({ message: String(x.refuse) }, x.refuse);
        if (x.state !== "opened" || x.draft) return ok({ message: "405 Method Not Allowed" }, 405);
        const head = this.branches.get(x.source_branch) ?? x.sha;
        if (body.sha && body.sha !== head) return ok({ message: "SHA does not match HEAD of source branch" }, 409);
        const sha = this.commit(String(body.squash ? (body.squash_commit_message ?? x.title) : (body.merge_commit_message ?? `Merge branch '${x.source_branch}' into 'main'`)));
        Object.assign(x, { state: "merged", sha: head, merge_commit_sha: body.squash ? null : sha, squash_commit_sha: body.squash ? sha : null });
        this.merged.push({ iid: x.iid, body });
        return ok(mrView(x));
      }
      if (method === "PUT") {
        if (body.title !== undefined) x.title = body.title;
        if (body.description !== undefined) x.description = body.description;
      }
      return ok(mrView(x));
    }

    // CI and releases
    if (r === "pipelines") {
      const ps = this.pipelines.get(q.get("sha") ?? "") ?? [];
      return list(ps.map((p) => ({ ...p, sha: q.get("sha") })));
    }
    if (r === "releases") return list(this.releases);
    return ok({ message: `fake gitlab: no route ${method} ${r}` }, 501);
  }
}

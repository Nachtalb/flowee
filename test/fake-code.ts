// The fake GitHub's code side: branches, files, commit changes, pull requests, checks, releases and tags.
import type { FakeGitHub } from "./fake";

type Pull = {
  number: number;
  title: string;
  body: string | null;
  html_url: string;
  head: { ref: string; sha: string };
  base: { ref: string };
  state: "open" | "closed";
  merged_at: string | null;
  merge_commit_sha: string | null;
  user: { login: string };
  mergeable: boolean;
};

export class FakeCode {
  branches = new Map<string, string>();
  /** The commits a branch has beyond main, oldest first. */
  commitsOn = new Map<string, string[]>();
  /** sha -> index of the main commit it is based on (branch commits are not on main). */
  based = new Map<string, number>();
  files = new Set<string>();
  changes = new Map<string, { filename: string; status: string; patch?: string }[]>();
  pulls: Pull[] = [];
  checks = new Map<string, { name: string; status: string; conclusion: string | null }[]>();
  release: { tag_name: string; name: string; body: string; html_url: string; published_at: string } | null = null;
  tags = new Map<string, string>();
  merged: { number: number; method: string; title?: string }[] = [];
  private n = 0;

  constructor(private gh: FakeGitHub) {
    gh.extra = (m, p, b, u) => this.handle(m, p, b, u);
  }

  /** A commit on a branch (based on main's head), the branch pointing at it. */
  push(branch: string, files: Record<string, string> = {}): string {
    const sha = `b${String(++this.n).padStart(39, "0")}`;
    this.commitsOn.set(branch, [...(this.branches.has(branch) ? (this.commitsOn.get(branch) ?? []) : []), sha]);
    this.branches.set(branch, sha);
    this.based.set(sha, this.gh.main.length - 1);
    this.changes.set(
      sha,
      Object.entries(files).map(([filename, patch]) => ({ filename, status: patch.startsWith("A:") ? "added" : "modified", patch: patch.replace(/^A:/, "") })),
    );
    return sha;
  }

  pr(branch: string, title: string, author = "dev"): Pull {
    const number = 1000 + this.pulls.length + 1;
    const p: Pull = {
      number,
      title,
      body: "",
      html_url: `https://github.com/${this.gh.repo}/pull/${number}`,
      head: { ref: branch, sha: this.branches.get(branch) ?? "" },
      base: { ref: "main" },
      state: "open",
      merged_at: null,
      merge_commit_sha: null,
      user: { login: author },
      mergeable: true,
    };
    this.pulls.push(p);
    return p;
  }

  green(sha: string, ...names: string[]) {
    this.checks.set(sha, (names.length ? names : ["build"]).map((name) => ({ name, status: "completed", conclusion: "success" })));
  }

  publish(name: string, sha: string) {
    this.release = { tag_name: name, name, body: `Built from main.\n\nbuild from \`${sha}\``, html_url: `https://github.com/${this.gh.repo}/releases/${name}`, published_at: "2026-11-20T00:00:00Z" };
  }

  private idx(sha: string) {
    return this.gh.main.findIndex((c) => c.sha === sha);
  }

  handle(method: string, path: string, body: Record<string, any>, url: URL): Response | undefined {
    const R = `/repos/${this.gh.repo}`;
    if (!path.startsWith(`${R}/`)) return;
    const rest = decodeURIComponent(path.slice(R.length + 1));
    const ok = (b: unknown, status = 200) => Response.json(b, { status });
    const nf = () => ok({ message: "Not Found" }, 404);
    const pull = (p: Pull) => {
      const { mergeable, ...view } = p;
      return { ...view, head: { ...p.head, sha: this.branches.get(p.head.ref) ?? p.head.sha } };
    };
    let m: RegExpExecArray | null;
    if ((m = /^git\/ref\/heads\/(.+)$/.exec(rest))) return this.branches.has(m[1]) ? ok({ object: { sha: this.branches.get(m[1]) } }) : nf();
    if ((m = /^git\/refs\/heads\/(.+)$/.exec(rest)) && method === "DELETE") {
      this.branches.delete(m[1]);
      return new Response(null, { status: 204 });
    }
    if ((m = /^contents\/(.+)$/.exec(rest))) return this.files.has(m[1]) ? ok({ path: m[1] }) : nf();
    if ((m = /^commits\/(\w+)\/check-runs$/.exec(rest))) return ok({ check_runs: this.checks.get(m[1]) ?? [] });
    if ((m = /^commits\/(\w+)\/status$/.exec(rest))) return ok({ statuses: [] });
    if ((m = /^commits\/(\w+)$/.exec(rest))) return this.changes.has(m[1]) ? ok({ sha: m[1], files: this.changes.get(m[1]) }) : ok({ sha: m[1], files: [] });
    if ((m = /^compare\/(\w+)\.\.\.(\w+)$/.exec(rest))) {
      const [a, b] = [m[1], m[2]];
      if (a === b) return ok({ status: "identical" });
      const base = this.based.get(b);
      if (base !== undefined) return this.idx(a) >= 0 && this.idx(a) <= base ? ok({ status: "ahead" }) : ok({ status: "diverged" });
      if (this.based.has(a)) return ok({ status: "diverged" });
      return;
    }
    if (rest === "pulls" && method === "GET") {
      const head = url.searchParams.get("head")?.split(":")[1];
      const state = url.searchParams.get("state");
      return ok(this.pulls.filter((p) => (!head || p.head.ref === head) && (state === "all" || p.state === state)).map(pull));
    }
    if (rest === "pulls" && method === "POST") {
      const p = this.pr(body.head, body.title);
      p.body = body.body;
      p.base.ref = body.base;
      return ok(pull(p), 201);
    }
    if ((m = /^pulls\/(\d+)\/files$/.exec(rest))) {
      const p = this.pulls.find((x) => x.number === Number(m![1]));
      return p ? ok((this.commitsOn.get(p.head.ref) ?? []).flatMap((sha) => this.changes.get(sha) ?? [])) : nf();
    }
    if ((m = /^pulls\/(\d+)(\/merge)?$/.exec(rest))) {
      const p = this.pulls.find((x) => x.number === Number(m![1]));
      if (!p) return nf();
      if (m[2] && method === "PUT") {
        if (!p.mergeable || p.state !== "open") return ok({ message: "Pull Request is not mergeable" }, 405);
        const sha = this.gh.commit(body.commit_title ?? `Merge pull request #${p.number} from ${p.head.ref}`);
        Object.assign(p, { state: "closed", merged_at: "2026-11-21T00:00:00Z", merge_commit_sha: sha });
        this.merged.push({ number: p.number, method: body.merge_method, title: body.commit_title });
        return ok({ sha, merged: true });
      }
      if (method === "PATCH") Object.assign(p, body);
      return ok(pull(p));
    }
    if (rest === "releases/latest") return this.release ? ok(this.release) : nf();
    if ((m = /^git\/ref\/tags\/(.+)$/.exec(rest))) return this.tags.has(m[1]) ? ok({ object: { sha: this.tags.get(m[1]), type: "commit" } }) : nf();
    if (rest === "git/refs" && method === "POST") {
      this.tags.set(String(body.ref).replace("refs/tags/", ""), body.sha);
      return ok({}, 201);
    }
    if ((m = /^git\/refs\/tags\/(.+)$/.exec(rest)) && method === "PATCH") {
      this.tags.set(m[1], body.sha);
      return ok({});
    }
    return;
  }
}

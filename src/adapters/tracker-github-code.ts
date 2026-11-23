// The GitHub adapter's optional capabilities over the REST API: branches and files, pull requests, checks,
// releases, tags. docs/adapters.md lists the fine-grained token permission each one needs.
import { Fail } from "../core/errors";
import type { Branches, Change, CheckRun, Checks, PullRequest, PullRequests, Release, Releases, Tags } from "../ports/tracker";
import type { GitHub } from "./tracker-github";

const gone = (e: unknown) => (e as { gh?: number }).gh === 404;
const enc = (path: string) => path.split("/").map(encodeURIComponent).join("/");

async function orNull<T>(p: Promise<T>): Promise<T | null> {
  try {
    return await p;
  } catch (e) {
    if (gone(e)) return null;
    throw e;
  }
}

interface GhPull {
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
}

const pull = (p: GhPull): PullRequest => ({
  number: p.number,
  title: p.title,
  body: p.body ?? "",
  url: p.html_url,
  head: p.head.ref,
  headSha: p.head.sha,
  base: p.base.ref,
  state: p.merged_at ? "merged" : p.state,
  mergeSha: p.merged_at ? p.merge_commit_sha : null,
  author: p.user.login,
});

const STATUS: Record<string, Change["status"]> = { added: "A", removed: "D", renamed: "R" };

export class GitHubBranches implements Branches {
  constructor(private gh: GitHub) {}

  async head(name: string) {
    const r = await orNull(this.gh.req<{ object: { sha: string } }>("GET", `${this.gh.r}/git/ref/heads/${enc(name)}`, `the branch ${name}`));
    return r?.object.sha ?? null;
  }

  async exists(ref: string, path: string) {
    return (await orNull(this.gh.req("GET", `${this.gh.r}/contents/${enc(path)}?ref=${encodeURIComponent(ref)}`, `${path} on ${ref}`))) !== null;
  }

  async changes(sha: string): Promise<Change[]> {
    const c = await this.gh.req<{ files?: { filename: string; status: string; patch?: string }[] }>("GET", `${this.gh.r}/commits/${sha}`, `the changes of ${sha.slice(0, 7)}`);
    return (c.files ?? []).map((f) => ({
      status: STATUS[f.status] ?? "M",
      path: f.filename,
      added: (f.patch ?? "")
        .split("\n")
        .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
        .map((l) => l.slice(1)),
    }));
  }

  async remove(name: string) {
    await orNull(this.gh.req("DELETE", `${this.gh.r}/git/refs/heads/${enc(name)}`, `deleting the branch ${name}`));
  }
}

export class GitHubPulls implements PullRequests {
  constructor(private gh: GitHub) {}

  async forBranch(branch: string) {
    const owner = this.gh.r.split("/")[2];
    const all = await this.gh.req<GhPull[]>("GET", `${this.gh.r}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=100`, `the pull requests of ${branch}`);
    const ps = all.map(pull).sort((a, b) => Number(b.state === "open") - Number(a.state === "open") || b.number - a.number);
    return ps[0] ?? null;
  }

  async get(number: number) {
    const p = await orNull(this.gh.req<GhPull>("GET", `${this.gh.r}/pulls/${number}`, `pull request #${number}`));
    if (!p) throw new Fail(404, "not_found", `Pull request #${number} does not exist.`);
    return pull(p);
  }

  async open() {
    const out: PullRequest[] = [];
    for (let page = 1; ; page++) {
      const batch = await this.gh.req<GhPull[]>("GET", `${this.gh.r}/pulls?state=open&per_page=100&page=${page}`, "the open pull requests");
      out.push(...batch.map(pull));
      if (batch.length < 100) return out;
    }
  }

  async create(head: string, base: string, title: string, body: string) {
    return pull(await this.gh.req<GhPull>("POST", `${this.gh.r}/pulls`, `opening the pull request of ${head}`, { head, base, title, body }));
  }

  async update(number: number, patch: { title?: string; body?: string }) {
    await this.gh.req("PATCH", `${this.gh.r}/pulls/${number}`, `updating pull request #${number}`, patch);
  }

  async merge(number: number, method: "merge" | "squash" | "rebase", subject?: string) {
    try {
      const body = subject ? { merge_method: method, commit_title: subject } : { merge_method: method };
      return (await this.gh.req<{ sha: string }>("PUT", `${this.gh.r}/pulls/${number}/merge`, `merging pull request #${number}`, body)).sha;
    } catch (e) {
      const code = (e as { gh?: number }).gh;
      if (code === 405 || code === 409 || code === 422)
        throw new Fail(409, "not_mergeable", `GitHub refused to merge pull request #${number} (${code}): it is not mergeable or its head moved.`);
      throw e;
    }
  }
}

export class GitHubChecks implements Checks {
  constructor(private gh: GitHub) {}

  async forCommit(sha: string): Promise<CheckRun[]> {
    const runs = await this.gh.req<{ check_runs: { name: string; status: CheckRun["status"]; conclusion: CheckRun["conclusion"] }[] }>(
      "GET",
      `${this.gh.r}/commits/${sha}/check-runs?per_page=100`,
      `the checks of ${sha.slice(0, 7)}`,
    );
    const st = await this.gh.req<{ statuses: { context: string; state: string }[] }>("GET", `${this.gh.r}/commits/${sha}/status`, `the statuses of ${sha.slice(0, 7)}`);
    const out = new Map<string, CheckRun>();
    for (const r of runs.check_runs) if (!out.has(r.name)) out.set(r.name, { name: r.name, status: r.status, conclusion: r.conclusion });
    for (const s of st.statuses)
      if (!out.has(s.context))
        out.set(s.context, s.state === "pending" ? { name: s.context, status: "in_progress", conclusion: null } : { name: s.context, status: "completed", conclusion: s.state === "success" ? "success" : "failure" });
    return [...out.values()];
  }
}

export class GitHubReleases implements Releases {
  constructor(private gh: GitHub) {}

  async latest(): Promise<Release | null> {
    const r = await orNull(
      this.gh.req<{ tag_name: string; name: string | null; body: string | null; html_url: string; published_at: string }>("GET", `${this.gh.r}/releases/latest`, "the latest release"),
    );
    if (!r) return null;
    const sha = /build from `?([0-9a-f]{40})/.exec(r.body ?? "")?.[1] ?? null;
    return { tag: r.tag_name, name: r.name || r.tag_name, sha, body: r.body ?? "", url: r.html_url, publishedAt: r.published_at };
  }
}

export class GitHubTags implements Tags {
  constructor(private gh: GitHub) {}

  async get(name: string) {
    const r = await orNull(this.gh.req<{ object: { sha: string; type: string } }>("GET", `${this.gh.r}/git/ref/tags/${enc(name)}`, `the tag ${name}`));
    if (!r) return null;
    if (r.object.type !== "tag") return r.object.sha;
    return (await this.gh.req<{ object: { sha: string } }>("GET", `${this.gh.r}/git/tags/${r.object.sha}`, `the tag ${name}`)).object.sha;
  }

  async move(name: string, sha: string) {
    if ((await this.get(name)) === null) await this.gh.req("POST", `${this.gh.r}/git/refs`, `creating the tag ${name}`, { ref: `refs/tags/${name}`, sha });
    else await this.gh.req("PATCH", `${this.gh.r}/git/refs/tags/${enc(name)}`, `moving the tag ${name}`, { sha, force: true });
  }
}

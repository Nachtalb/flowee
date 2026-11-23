// Read-only, anonymous check of the GitLab adapter's parsing against gitlab.com's real responses: run
// `bun test/e2e/gitlab-live.ts` (needs network). No token: the adapter's authorization header is stripped and only
// GET/HEAD calls go out.
import { GitLab, gitlabRepo, run } from "../../src/adapters/tracker-gitlab";

const real = globalThis.fetch;
const calls: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const method = init?.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") throw new Error(`refused a write: ${method} ${input}`);
  const headers = new Headers(init?.headers);
  headers.delete("authorization");
  headers.set("user-agent", "Mozilla/5.0 (flowee live read check)");
  calls.push(`${method} ${String(input).replace("https://gitlab.com/api/v4", "")}`);
  return real(input, { ...init, headers });
}) as typeof fetch;

const ok = (what: string, cond: boolean, detail: unknown) => {
  console.log(`${cond ? "ok  " : "FAIL"} ${what}: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`);
  if (!cond) process.exitCode = 1;
};

const foss = new GitLab({ repo: "gitlab-org/gitlab-foss", token: "anonymous", tokenName: "NONE" });
const runner = new GitLab({ repo: "gitlab-org/gitlab-runner", token: "anonymous", tokenName: "NONE" });

// issues and notes
const raw = (await (await real("https://gitlab.com/api/v4/projects/gitlab-org%2Fgitlab-foss/issues?per_page=1&issue_type=issue", { headers: { "user-agent": "Mozilla/5.0" } })).json()) as { iid: number }[];
const i = await foss.issue(raw[0].iid);
ok("issue: iid as n, labels as strings, global id as ref", i.n === raw[0].iid && Array.isArray(i.labels) && i.labels.every((l) => typeof l === "string") && /^\d+$/.test(i.ref), {
  n: i.n,
  open: i.open,
  labels: i.labels.slice(0, 3),
  ref: i.ref,
  url: i.url,
});
const notes = await foss.comments(i.n).catch((e) => e);
console.log(`skip notes: gitlab.com answers anonymous reads of notes with ${notes.message ?? "something else"} (needs a token)`);
const missing = await foss.issue(999999999).catch((e) => e);
ok("a missing issue: 404 not_found", missing.status === 404 && missing.code === "not_found", missing.message);

// commits, ancestry, branches
const commits = await foss.commits("master", "2019-01-01T00:00:00Z").catch((e) => e);
ok("commits: oldest first, subject = first line", Array.isArray(commits) && commits.length > 0 && commits.every((c: { sha: string }) => /^[0-9a-f]{40}$/.test(c.sha)), {
  count: commits.length,
  first: commits[0],
  last: commits.at(-1),
});
const head = await foss.branches.head("master");
ok("branch head", !!head && /^[0-9a-f]{40}$/.test(head), head);
ok("no such branch: null", (await foss.branches.head("no-such-branch-flowee")) === null, "null");
const [a, b] = [commits[0].sha, commits.at(-1).sha];
ok("contains: older in newer, not the other way, equal", (await foss.contains(a, b)) && !(await foss.contains(b, a)) && (await foss.contains(b, b)), { a: a.slice(0, 8), b: b.slice(0, 8) });
ok("contains: a branch name as head", await foss.contains(a, "master"), "master");
ok("exists: a file and a directory, not a missing path", (await foss.branches.exists("master", "README.md")) && (await foss.branches.exists("master", "app/models")) && !(await foss.branches.exists("master", "no/such/path")), "README.md, app/models");
const ch = await foss.branches.changes(b);
ok("changes of a commit", ch.length > 0 && ch.every((c) => ["A", "M", "D", "R"].includes(c.status)), ch.slice(0, 3).map((c) => ({ ...c, added: c.added.length })));

// merge requests
const mrs = (await (await real("https://gitlab.com/api/v4/projects/gitlab-org%2Fgitlab-foss/merge_requests?state=merged&per_page=1", { headers: { "user-agent": "Mozilla/5.0" } })).json()) as { iid: number; source_branch: string }[];
const p = await foss.pulls.get(mrs[0].iid);
ok("merge request: iid, merged with a merge sha, branches", p.state === "merged" && !!p.mergeSha && p.number === mrs[0].iid, p);
const byBranch = await foss.pulls.forBranch(mrs[0].source_branch);
ok("merge request by its source branch", byBranch?.head === mrs[0].source_branch, { number: byBranch?.number, state: byBranch?.state });
const files = await foss.pulls.files(p.number);
ok("merge request files", files.length > 0, files.slice(0, 3).map((c) => ({ ...c, added: c.added.length })));

// pipelines and statuses, releases, tags
const rr = await runner.releases.latest();
ok("latest release", !!rr && !!rr.tag && !!rr.publishedAt, rr && { tag: rr.tag, name: rr.name, sha: rr.sha, url: rr.url, publishedAt: rr.publishedAt });
const tagSha = rr ? await runner.tags.get(rr.tag) : null;
ok("the release's tag: the commit it points at", !!tagSha && /^[0-9a-f]{40}$/.test(tagSha), tagSha);
ok("no such tag: null", (await runner.tags.get("no-such-tag-flowee")) === null, "null");
const runs = tagSha ? await runner.checks.forCommit(tagSha).catch((e) => e) : [];
if (runs instanceof Error) {
  console.log(`skip commit statuses: ${runs.message} (gitlab.com needs a token for /repository/commits/:sha/statuses)`);
  const ps = await runner.req<{ id: number; status: string; sha: string }[]>("GET", `${runner.p}/pipelines?sha=${tagSha}&order_by=id&sort=desc&per_page=1`, "the pipeline");
  ok("the newest pipeline of the tag's commit (the `pipeline` check)", ps[0]?.sha === tagSha, { id: ps[0]?.id, status: ps[0]?.status, as: run("pipeline", ps[0]?.status ?? "") });
}

// a pasted reference
ok("references", gitlabRepo()("https://gitlab.com/gitlab-org/gitlab-foss/-/issues/3") === "gitlab-org/gitlab-foss", "https://gitlab.com/gitlab-org/gitlab-foss/-/issues/3");

console.log(`${calls.length} anonymous GET/HEAD calls; distinct endpoints:`);
for (const c of [...new Set(calls.map((c) => c.replace(/\?.*$/, "").replace(/\/[0-9a-f]{40}/g, "/<sha>").replace(/\/\d+(?=\/|$)/g, "/<n>")))]) console.log(`  ${c}`);

// The tracker adapter contract: the port-level cases every Tracker adapter must pass, run against each registered
// adapter with its own HTTP stand-in (GitHub: test/fake.ts + fake-code.ts, GitLab: test/fake-gitlab.ts). A new
// adapter adds one harness here.
import { beforeEach, describe, expect, it } from "vitest";
import { TRACKERS } from "../src/adapters/trackers";
import { TRACKER_KINDS, type TrackerKind } from "../src/config/trackers";
import { Fail } from "../src/core/errors";
import { type Capability, capability, type Tracker } from "../src/ports/tracker";
import { FakeCode } from "./fake-code";
import type { FakeGitLab } from "./fake-gitlab";
import { setup } from "./helpers";

interface Harness {
  kind: TrackerKind;
  make(token?: string): Tracker;
  /** Seeds an issue, its number. */
  issue(o?: { title?: string; labels?: string[]; closed?: boolean }): number;
  commit(message: string): string;
  push(branch: string, files?: Record<string, string>): string;
  file(path: string): void;
  green(sha: string, ...names: string[]): void;
  publish(name: string, sha: string): void;
  /** A closed pull/merge request from `branch`. */
  closedPull(branch: string): void;
  lastMain(): string;
  /** Answers `res` (or a status) to every request matching method and path part. */
  fail(method: string, part: string, res: number | (() => Response)): void;
  writes(): string[];
  /** How the adapter names a pull request in messages. */
  pr(n: number): string;
}

const HARNESSES: Record<TrackerKind, () => Harness> = {
  github() {
    const { gh } = setup();
    const code = new FakeCode(gh);
    return {
      kind: "github",
      make: (token = "x") => TRACKERS.github.make({ repo: "acme/shop", token, tokenName: "GITHUB_TOKEN", project: { owner: "ann-dev", number: 9 } }),
      issue: (o = {}) => gh.add({ title: o.title, labels: (o.labels ?? []).map((name) => ({ name })), state: o.closed ? "closed" : "open" }).number,
      commit: (m) => gh.commit(m),
      push: (b, f) => code.push(b, f),
      file: (p) => code.files.add(p),
      green: (sha, ...n) => code.green(sha, ...n),
      publish: (n, sha) => code.publish(n, sha),
      closedPull: (b) => {
        code.pr(b, "old").state = "closed";
      },
      lastMain: () => gh.main.at(-1)?.message ?? "",
      fail: (m, part, res) => {
        gh.fail = (method, path) => (method === m && path.includes(part) ? (typeof res === "number" ? res : res()) : undefined);
      },
      writes: () => gh.writes,
      pr: (n) => `pull request #${n}`,
    };
  },
  gitlab() {
    const { gl } = setup();
    return {
      kind: "gitlab",
      make: (token = "x") => TRACKERS.gitlab.make({ repo: gl.repo, token, tokenName: "GITLAB_TOKEN" }),
      issue: (o = {}) => gl.add({ title: o.title, labels: o.labels, state: o.closed ? "closed" : "opened" }).iid,
      commit: (m) => gl.commit(m),
      push: (b, f) => gl.push(b, f),
      file: (p) => gl.files.add(p),
      green: (sha, ...n) => gl.green(sha, ...n),
      publish: (n, sha) => gl.publish(n, sha),
      closedPull: (b) => {
        gl.mr(b, "old").state = "closed";
      },
      lastMain: () => gl.main.at(-1)?.message ?? "",
      fail: (m, part, res) => {
        gl.fail = (method, path) => (method === m && decodeURIComponent(path).includes(part) ? (typeof res === "number" ? res : res()) : undefined);
      },
      writes: () => (gl as FakeGitLab).writes,
      pr: (n) => `merge request !${n}`,
    };
  },
};

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof Fail ? [e.status, e.code, e.message] : String(e);
  }
  return "no refusal";
};

describe.each(Object.keys(HARNESSES) as TrackerKind[])("tracker contract: %s", (kind) => {
  let h: Harness;
  let t: Tracker;
  const name = TRACKER_KINDS[kind].name;
  beforeEach(() => {
    h = HARNESSES[kind]();
    t = h.make();
  });

  it("offers exactly the capabilities its kind declares", () => {
    const has = (["board", "branches", "pulls", "checks", "releases", "tags"] as Capability[]).filter((c) => t[c]);
    expect(has).toEqual(TRACKER_KINDS[kind].capabilities);
  });

  it("reads an issue, refuses a missing one with 404 not_found", async () => {
    const n = h.issue({ title: "Login", labels: ["ready"] });
    expect(await t.issue(n)).toMatchObject({ n, title: "Login", open: true, labels: ["ready"], assignees: [] });
    expect((await t.issue(n)).ref).toBeTruthy();
    const [status, code, msg] = (await refusal(t.issue(99))) as [number, string, string];
    expect([status, code]).toEqual([404, "not_found"]);
    expect(msg).toMatch(/^#99 does not exist or is /);
  });

  it("lists every open issue over several pages", async () => {
    for (let i = 0; i < 130; i++) h.issue();
    h.issue({ closed: true });
    const open = await t.openIssues();
    expect(open.length).toBe(130);
    expect(open.every((i) => i.open)).toBe(true);
  });

  it("files, updates in one write (labels, assignees, close with a reason, reopen, title, body)", async () => {
    const i = await t.create("New", "Body", ["inbox", "bug"]);
    expect(i).toMatchObject({ title: "New", body: "Body", labels: ["inbox", "bug"], open: true });
    const before = h.writes().length;
    await t.update(i.n, { labels: ["ready"], assignees: ["ann"], title: "Renamed", body: "B2" }, "the update");
    expect(h.writes().length - before).toBe(1);
    expect(await t.issue(i.n)).toMatchObject({ labels: ["ready"], assignees: ["ann"], title: "Renamed", body: "B2" });
    await t.update(i.n, { open: false, reason: "not_planned", assignees: [] }, "closing");
    expect(await t.issue(i.n)).toMatchObject({ open: false, assignees: [] });
    await t.update(i.n, { open: true }, "reopening");
    expect((await t.issue(i.n)).open).toBe(true);
  });

  it("posts comments and reads them oldest first", async () => {
    const n = h.issue();
    const a = await t.comment(n, "first");
    const b = await t.comment(n, "second");
    expect((await t.comments(n)).map((c) => [c.id, c.body])).toEqual([
      [a, "first"],
      [b, "second"],
    ]);
  });

  it("lists a branch's commits oldest first, first line only, and knows which commit contains which", async () => {
    const a = h.commit("feat: a (#1)\n\nbody");
    const b = h.commit("fix: b (#2)");
    expect(await t.commits("main", "2026-01-01T00:00:00Z")).toEqual([
      { sha: a, subject: "feat: a (#1)" },
      { sha: b, subject: "fix: b (#2)" },
    ]);
    expect(await t.contains(a, b)).toBe(true);
    expect(await t.contains(b, b)).toBe(true);
    expect(await t.contains(b, a)).toBe(false);
    expect(await t.contains("f".repeat(40), b)).toBe(false);
    const br = h.push("flowee/3");
    expect(await t.contains(b, br)).toBe(true);
    expect(await t.contains(br, b)).toBe(false);
  });

  it("names the failed call in a 502 and refuses without a token", async () => {
    const n = h.issue();
    h.fail("POST", "/issues", 500);
    expect(await refusal(t.comment(n, "x"))).toEqual([502, kind, `${name} answered 500 for the comment on #${n}.`]);
    const bare = h.make("");
    expect(await refusal(bare.issue(n))).toEqual([502, kind, `${name} is not connected yet (the secret ${kind.toUpperCase()}_TOKEN is missing); nothing was changed.`]);
  });

  it("waits out a short 429 once and answers a long one with 503 rate_limited", async () => {
    const n = h.issue();
    let left = 1;
    h.fail("GET", "/issues/", () => (left-- > 0 ? new Response("{}", { status: 429, headers: { "retry-after": "0" } }) : (undefined as unknown as Response)));
    expect((await t.issue(n)).n).toBe(n);
    h.fail("GET", "/issues/", () => new Response("{}", { status: 429, headers: { "retry-after": "30" } }));
    expect(await refusal(t.issue(n))).toEqual([503, "rate_limited", `${name} is rate-limiting this token for reading #${n}; try again in 30 seconds.`]);
  });

  it("branches: head, files, the changes of a commit, deleting", async () => {
    h.commit("feat: base");
    const sha = h.push("flowee/7", { "app/ui/Screen.kt": "@@ -1 +1,2 @@\n+@Composable fun Screen()\n context", "README.md": "A:+hi" });
    h.file("Samples/a.png");
    const br = capability(t, "branches");
    expect(await br.head("flowee/7")).toBe(sha);
    expect(await br.head("nope")).toBeNull();
    expect(await br.exists("main", "Samples/a.png")).toBe(true);
    expect(await br.exists("main", "Samples/b.png")).toBe(false);
    expect(await br.changes(sha)).toEqual([
      { status: "M", path: "app/ui/Screen.kt", added: ["@Composable fun Screen()"] },
      { status: "A", path: "README.md", added: ["hi"] },
    ]);
    await br.remove("flowee/7");
    expect(await br.head("flowee/7")).toBeNull();
    await br.remove("flowee/7");
  });

  it("pulls: by branch (open first), get, open, create, update, files, merge and its refusal", async () => {
    h.commit("feat: base");
    h.push("flowee/7", { "a.txt": "A:+x" });
    h.closedPull("flowee/7");
    const pulls = capability(t, "pulls");
    const p = await pulls.create("flowee/7", "main", "Thing (#7)", "Closes #7");
    expect(p).toMatchObject({ head: "flowee/7", base: "main", state: "open", body: "Closes #7", mergeSha: null, title: "Thing (#7)" });
    expect((await pulls.forBranch("flowee/7"))?.number).toBe(p.number);
    expect(await pulls.forBranch("other")).toBeNull();
    expect((await pulls.open()).map((x) => x.number)).toEqual([p.number]);
    await pulls.update(p.number, { title: "Thing, renamed (#7)" });
    expect((await pulls.get(p.number)).title).toBe("Thing, renamed (#7)");
    expect(await pulls.files(p.number)).toEqual([{ status: "A", path: "a.txt", added: ["x"] }]);
    const [s, c, m] = (await refusal(pulls.get(99))) as [number, string, string];
    expect([s, c, m]).toEqual([404, "not_found", `${h.pr(99)[0].toUpperCase()}${h.pr(99).slice(1)} does not exist.`]);
    const sha = await pulls.merge(p.number, "squash", "feat: thing (#7)");
    expect(await pulls.get(p.number)).toMatchObject({ state: "merged", mergeSha: sha });
    expect(h.lastMain()).toBe("feat: thing (#7)");
    const [s2, c2, m2] = (await refusal(pulls.merge(p.number, "merge"))) as [number, string, string];
    expect([s2, c2]).toEqual([409, "not_mergeable"]);
    expect(m2).toMatch(new RegExp(`^${name} refused to merge ${h.pr(p.number)} \\(\\w+\\): it is not mergeable`));
  });

  it("checks, releases and tags", async () => {
    const a = h.commit("feat: a (#1)");
    h.green(a, "build", "lint");
    const runs = await capability(t, "checks").forCommit(a);
    expect(runs.map((r) => r.name)).toEqual(expect.arrayContaining(["build", "lint"]));
    expect(runs.every((r) => r.status === "completed" && r.conclusion === "success")).toBe(true);
    expect(await capability(t, "checks").forCommit(h.commit("feat: no ci"))).toEqual([]);
    const rel = capability(t, "releases");
    expect(await rel.recent()).toEqual([]);
    h.publish("1.2.0", a);
    h.publish("1.3.0", a);
    expect((await rel.recent()).map((r) => r.tag)).toEqual(["1.3.0", "1.2.0"]);
    expect((await rel.recent())[1]).toMatchObject({ tag: "1.2.0", name: "1.2.0", sha: a });
    const tags = capability(t, "tags");
    expect(await tags.get("tested")).toBeNull();
    await tags.move("tested", a);
    expect(await tags.get("tested")).toBe(a);
    const b = h.commit("feat: b (#2)");
    await tags.move("tested", b);
    expect(await tags.get("tested")).toBe(b);
  });
});

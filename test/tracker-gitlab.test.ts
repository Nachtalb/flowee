// What only GitLab has: nested group paths, iid vs id, system notes, issue types, draft titles, pipeline states,
// merges a protected branch refuses, tags moved by delete + create, self-managed hosts and pasted references.
import { beforeEach, describe, expect, it } from "vitest";
import { GitLab, gitlabRepo, run } from "../src/adapters/tracker-gitlab";
import { Fail } from "../src/core/errors";
import type { FakeGitLab } from "./fake-gitlab";
import { setup } from "./helpers";

let gl: FakeGitLab;
let glself: FakeGitLab;
let t: GitLab;
beforeEach(() => {
  ({ gl, glself } = setup());
  t = new GitLab({ repo: gl.repo, token: "glpat-test", tokenName: "GITLAB_TOKEN" });
});

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof Fail ? [e.status, e.code, e.message] : String(e);
  }
  return "no refusal";
};

describe("GitLab adapter", () => {
  it("addresses a nested project by its URL-encoded path with a bearer token; a ticket is the iid, ref the global id", async () => {
    const i = gl.add({ iid: 3 });
    const got = await t.issue(3);
    expect(got).toMatchObject({ n: 3, ref: String(i.id), url: `https://gitlab.com/grp/sub/shop/-/issues/3` });
    expect(gl.auth.at(-1)).toBe("Bearer glpat-test");
    expect(t.p).toBe("/projects/grp%2Fsub%2Fshop");
  });

  it("reaches a self-managed instance at its own API URL", async () => {
    glself.add({ iid: 1, title: "On prem" });
    const s = new GitLab({ repo: glself.repo, api: "https://gitlab.example.com/api/v4", token: "x", tokenName: "T" });
    expect((await s.issue(1)).title).toBe("On prem");
  });

  it("treats tasks, incidents and test cases as no tickets", async () => {
    gl.add({ iid: 1 });
    gl.add({ iid: 2, issue_type: "task" });
    expect((await t.openIssues()).map((i) => i.n)).toEqual([1]);
    expect(await refusal(t.issue(2))).toEqual([404, "not_found", "#2 does not exist or is not an issue."]);
  });

  it("reads human comments only: system notes (label changes, closing) are skipped", async () => {
    gl.add({ iid: 1 });
    gl.issues.get(1)?.notes.push({ id: 5, body: "added ~ready label", system: true, created_at: "2026-11-02T00:00:00Z" });
    await t.comment(1, "Owner: yes");
    await t.update(1, { open: false, reason: "not_planned" }, "closing");
    expect((await t.comments(1)).map((c) => c.body)).toEqual(["Owner: yes"]);
    expect(gl.issues.get(1)?.state).toBe("closed");
  });

  it("closing as not planned adds the not-planned label (GitLab stores no reason); reopening takes it off; it is configurable", async () => {
    gl.add({ iid: 2, labels: ["ready"] });
    await t.update(2, { open: false, reason: "completed" }, "closing");
    expect(gl.issues.get(2)?.labels).toEqual(["ready"]);
    await t.update(2, { open: true }, "reopening");
    await t.update(2, { labels: [], open: false, reason: "not_planned" }, "dropping");
    expect(gl.issues.get(2)).toMatchObject({ state: "closed", labels: ["not planned"] });
    await t.update(2, { labels: ["not planned", "needs triage"], open: true }, "reopening");
    expect(gl.issues.get(2)).toMatchObject({ state: "opened", labels: ["needs triage"] });
    const own = new GitLab({ repo: gl.repo, token: "glpat-test", tokenName: "GITLAB_TOKEN", notPlannedLabel: "wontfix" });
    await own.update(2, { open: false, reason: "not_planned" }, "dropping");
    expect(gl.issues.get(2)?.labels).toEqual(["needs triage", "wontfix"]);
    await own.update(2, { open: true }, "reopening");
    expect(gl.issues.get(2)?.labels).toEqual(["needs triage"]);
  });

  it("assigns by user id and says so when a login does not exist", async () => {
    gl.add({ iid: 1 });
    await t.update(1, { assignees: ["ann"] }, "assigning #1");
    expect(gl.issues.get(1)?.assignees).toEqual([{ id: 7, username: "ann" }]);
    expect(await refusal(t.update(1, { assignees: ["nobody"] }, "assigning #1"))).toEqual([502, "gitlab", "GitLab has no user 'nobody' for assigning #1."]);
  });

  it("knows a directory from its tree", async () => {
    gl.files.add("Samples/x/a.png");
    expect(await t.branches.exists("main", "Samples/x")).toBe(true);
    expect(await t.branches.exists("main", "Samples/y")).toBe(false);
  });

  it("maps pipeline and job states: manual, skipped, canceled, allowed failures", async () => {
    const a = gl.commit("feat: a");
    gl.pipeline(a, "manual", ["build", "success"], ["deploy", "manual", false], ["review", "manual", true], ["docs", "skipped"], ["lint", "failed", true], ["e2e", "canceled"], ["slow", "running"]);
    expect(await t.checks.forCommit(a)).toEqual([
      { name: "pipeline", status: "completed", conclusion: "action_required" },
      { name: "slow", status: "in_progress", conclusion: null },
      { name: "e2e", status: "completed", conclusion: "cancelled" },
      { name: "lint", status: "completed", conclusion: "neutral" },
      { name: "docs", status: "completed", conclusion: "skipped" },
      { name: "review", status: "completed", conclusion: "skipped" },
      { name: "deploy", status: "completed", conclusion: "action_required" },
      { name: "build", status: "completed", conclusion: "success" },
    ]);
    expect(["created", "pending", "scheduled", "waiting_for_resource"].map((s) => run("x", s).status)).toEqual(["queued", "queued", "queued", "queued"]);
    expect(run("x", "skipped")).toEqual({ name: "x", status: "completed", conclusion: "skipped" });
  });

  it("the newest pipeline and the newest status per name count", async () => {
    const a = gl.commit("feat: a");
    gl.pipeline(a, "failed", ["build", "failed"]);
    gl.pipeline(a, "success", ["build", "success"]);
    expect(await t.checks.forCommit(a)).toEqual([
      { name: "pipeline", status: "completed", conclusion: "success" },
      { name: "build", status: "completed", conclusion: "success" },
    ]);
  });

  it("merges pinned to the head it read; squash sends the subject; a protected branch's refusal is 409 not_mergeable", async () => {
    gl.commit("feat: base");
    gl.push("flowee/4");
    const m = gl.mr("flowee/4", "Four (#4)");
    const sha = await t.pulls.merge(m.iid, "squash", "feat: four (#4)");
    expect(gl.merged.at(-1)?.body).toEqual({ sha: m.sha, squash: true, squash_commit_message: "feat: four (#4)" });
    expect(sha).toBe(gl.main.at(-1)?.sha);
    gl.push("flowee/5");
    const p = gl.mr("flowee/5", "Five (#5)");
    p.refuse = 403;
    expect(await refusal(t.pulls.merge(p.iid, "merge", "feat: five (#5)"))).toEqual([
      409,
      "not_mergeable",
      `GitLab refused to merge merge request !${p.iid} (403): it is not mergeable, its head moved or the branch is protected.`,
    ]);
    p.refuse = undefined;
    const merged = await t.pulls.merge(p.iid, "merge", "feat: five (#5)");
    expect(gl.merged.at(-1)?.body).toEqual({ sha: p.sha, merge_commit_message: "feat: five (#5)" });
    expect(merged).toBe(gl.main.at(-1)?.sha);
  });

  it("a fast-forward merge (no merge commit) answers the head; a draft cannot merge and stays a draft when renamed", async () => {
    gl.push("flowee/6");
    const m = gl.mr("flowee/6", "Draft: Six (#6)");
    expect((await t.pulls.get(m.iid)).title).toBe("Six (#6)");
    await t.pulls.update(m.iid, { title: "Six, renamed (#6)" });
    expect(m.title).toBe("Draft: Six, renamed (#6)");
    expect(((await refusal(t.pulls.merge(m.iid, "merge"))) as unknown[])[1]).toBe("not_mergeable");
    m.state = "merged";
    m.merge_commit_sha = null;
    expect((await t.pulls.get(m.iid)).mergeSha).toBe(m.sha);
  });

  it("moves a tag by deleting and creating it, and leaves it alone when it is already there", async () => {
    const a = gl.commit("feat: a");
    const b = gl.commit("feat: b");
    await t.tags.move("tested", a);
    await t.tags.move("tested", b);
    await t.tags.move("tested", b);
    expect(gl.tags.get("tested")).toBe(b);
    expect(gl.writes.filter((w) => w.includes("/repository/tags"))).toEqual([
      "POST /api/v4/projects/grp%2Fsub%2Fshop/repository/tags",
      "DELETE /api/v4/projects/grp%2Fsub%2Fshop/repository/tags/tested",
      "POST /api/v4/projects/grp%2Fsub%2Fshop/repository/tags",
    ]);
  });

  it("skips an upcoming release", async () => {
    const a = gl.commit("feat: a");
    gl.publish("1.0.0", a);
    gl.publish("2.0.0", a);
    gl.releases[0].upcoming_release = true;
    expect((await t.releases.recent()).map((r) => r.tag)).toEqual(["1.0.0"]);
  });
});

describe("repository references (GitLab)", () => {
  const parse = gitlabRepo();
  it.each([
    ["grp/app", "grp/app"],
    ["grp/sub/deeper/app", "grp/sub/deeper/app"],
    ["https://gitlab.com/grp/sub/app", "grp/sub/app"],
    ["https://gitlab.com/grp/app/-/issues/3", "grp/app"],
    ["https://gitlab.com/grp/sub/app/-/merge_requests/9#note_1", "grp/sub/app"],
    ["https://gitlab.com/grp/app.git", "grp/app"],
    ["https://gitlab.com/grp/app/", "grp/app"],
    ["gitlab.com/grp/app", "grp/app"],
    ["git@gitlab.com:grp/sub/app.git", "grp/sub/app"],
    ["ssh://git@gitlab.com/grp/app.git", "grp/app"],
    ["<https://gitlab.com/grp/app>", "grp/app"],
  ])("%s", (ref, want) => expect(parse(ref)).toBe(want));

  it("takes a self-managed host from the API URL and refuses other hosts and non-paths", () => {
    const self = gitlabRepo("https://gitlab.example.com/api/v4");
    expect(self("https://gitlab.example.com/team/tools/lib/-/tree/main")).toBe("team/tools/lib");
    expect(self("ssh://git@gitlab.example.com:2222/team/lib.git")).toBe("team/lib");
    expect(parse("https://gitlab.example.com/team/lib")).toBeUndefined();
    expect(parse("https://github.com/acme/app")).toBeUndefined();
    expect(parse("app")).toBeUndefined();
    expect(parse("grp/../app")).toBeUndefined();
    expect(parse("grp/app name")).toBeUndefined();
  });
});

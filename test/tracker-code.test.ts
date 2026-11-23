// The GitHub adapter's optional capabilities against the fake GitHub; a tracker without one answers 501.
import { beforeEach, describe, expect, it } from "vitest";
import { GitHub } from "../src/adapters/tracker-github";
import { Fail } from "../src/core/errors";
import { capability, type Tracker } from "../src/ports/tracker";
import type { FakeGitHub } from "./fake";
import { FakeCode } from "./fake-code";
import { setup } from "./helpers";

let gh: FakeGitHub;
let code: FakeCode;
let t: GitHub;
beforeEach(() => {
  ({ gh } = setup());
  code = new FakeCode(gh);
  t = new GitHub({ repo: "Nachtalb/livedu", token: "x", tokenName: "GITHUB_TOKEN" });
});

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof Fail ? [e.status, e.code, e.message] : String(e);
  }
  return "no refusal";
};

describe("GitHub capabilities", () => {
  it("branches: heads, files, the changes of a commit, deleting", async () => {
    gh.commit("feat: base");
    const sha = code.push("flowee/7", { "app/ui/Screen.kt": "@@ -1 +1,2 @@\n+@Composable fun Screen()\n context", "README.md": "A:+hi" });
    code.files.add("Samples/a.png");
    expect(await t.branches.head("flowee/7")).toBe(sha);
    expect(await t.branches.head("nope")).toBeNull();
    expect(await t.branches.exists("main", "Samples/a.png")).toBe(true);
    expect(await t.branches.exists("main", "Samples/b.png")).toBe(false);
    expect(await t.branches.changes(sha)).toEqual([
      { status: "M", path: "app/ui/Screen.kt", added: ["@Composable fun Screen()"] },
      { status: "A", path: "README.md", added: ["hi"] },
    ]);
    await t.branches.remove("flowee/7");
    expect(code.branches.has("flowee/7")).toBe(false);
  });

  it("pull requests: by branch (open first), get, open, create, update, merge and its refusal", async () => {
    gh.commit("feat: base");
    code.push("flowee/7");
    const old = code.pr("flowee/7", "old");
    old.state = "closed";
    const p = await t.pulls.create("flowee/7", "main", "Thing (#7)", "Closes #7");
    expect(p).toMatchObject({ head: "flowee/7", base: "main", state: "open", body: "Closes #7", mergeSha: null });
    expect((await t.pulls.forBranch("flowee/7"))?.number).toBe(p.number);
    expect(await t.pulls.forBranch("other")).toBeNull();
    expect((await t.pulls.open()).map((x) => x.number)).toEqual([p.number]);
    await t.pulls.update(p.number, { title: "Thing, renamed (#7)" });
    expect((await t.pulls.get(p.number)).title).toBe("Thing, renamed (#7)");
    expect(await refusal(t.pulls.get(9))).toEqual([404, "not_found", "Pull request #9 does not exist."]);
    const sha = await t.pulls.merge(p.number, "squash", "feat: thing (#7)");
    expect(await t.pulls.get(p.number)).toMatchObject({ state: "merged", mergeSha: sha });
    expect(gh.main.at(-1)?.message).toBe("feat: thing (#7)");
    expect(await refusal(t.pulls.merge(p.number, "merge"))).toEqual([
      409,
      "not_mergeable",
      `GitHub refused to merge pull request #${p.number} (405): it is not mergeable or its head moved.`,
    ]);
  });

  it("checks, releases and tags", async () => {
    const a = gh.commit("feat: a (#1)");
    code.green(a, "build", "lint");
    expect(await t.checks.forCommit(a)).toEqual([
      { name: "build", status: "completed", conclusion: "success" },
      { name: "lint", status: "completed", conclusion: "success" },
    ]);
    expect(await t.releases.latest()).toBeNull();
    code.publish("1.2.0", a);
    expect(await t.releases.latest()).toMatchObject({ tag: "1.2.0", name: "1.2.0", sha: a });
    expect(await t.tags.get("tested")).toBeNull();
    await t.tags.move("tested", a);
    const b = gh.commit("feat: b (#2)");
    await t.tags.move("tested", b);
    expect(await t.tags.get("tested")).toBe(b);
    expect(gh.writes.filter((w) => w.includes("/git/refs"))).toEqual(["POST /repos/Nachtalb/livedu/git/refs", "PATCH /repos/Nachtalb/livedu/git/refs/tags/tested"]);
  });

  it("a tracker without a capability answers 501 unsupported", async () => {
    const bare = { ...t, pulls: undefined } as unknown as Tracker;
    expect(await refusal(Promise.resolve().then(() => capability(bare, "pulls")))).toEqual([501, "unsupported", "The tracker does not support pull requests."]);
    expect(capability(t, "tags")).toBe(t.tags);
  });
});

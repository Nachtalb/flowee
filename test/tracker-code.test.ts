// What only the GitHub adapter does with its optional capabilities; a tracker without one answers 501.
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
  t = new GitHub({ repo: "acme/shop", token: "x", tokenName: "GITHUB_TOKEN" });
});

const refusal = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e instanceof Fail ? [e.status, e.code, e.message] : String(e);
  }
  return "no refusal";
};

describe("GitHub capabilities (the shared cases are in tracker-contract.test.ts)", () => {
  it("a merge GitHub refuses names its status; a tag moves by PATCHing its ref", async () => {
    gh.commit("feat: base");
    code.push("flowee/7");
    const p = await t.pulls.create("flowee/7", "main", "Thing (#7)", "Closes #7");
    await t.pulls.merge(p.number, "squash", "feat: thing (#7)");
    expect(await refusal(t.pulls.merge(p.number, "merge"))).toEqual([
      409,
      "not_mergeable",
      `GitHub refused to merge pull request #${p.number} (405): it is not mergeable or its head moved.`,
    ]);
    const a = gh.commit("feat: a (#1)");
    await t.tags.move("tested", a);
    await t.tags.move("tested", gh.commit("feat: b (#2)"));
    expect(gh.writes.filter((w) => w.includes("/git/refs"))).toEqual(["POST /repos/acme/shop/git/refs", "PATCH /repos/acme/shop/git/refs/tags/tested"]);
  });

  it("a tracker without a capability answers 501 unsupported", async () => {
    const bare = { ...t, pulls: undefined } as unknown as Tracker;
    expect(await refusal(Promise.resolve().then(() => capability(bare, "pulls")))).toEqual([501, "unsupported", "The tracker does not support pull requests."]);
    expect(capability(t, "tags")).toBe(t.tags);
  });
});

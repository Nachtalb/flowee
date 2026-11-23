// The one chart's independent switches: every combination of branching (single branch or feature branches),
// versioning and the other options loads with the right guards, the starting points `trunk` and `pr-release` keep
// the documents written before, and two walks against the Worker: single branch with versioning, feature branches
// without it.
import { beforeEach, describe, expect, it } from "vitest";
import { validate } from "../src/config/schema";
import { FLOW, flowOf, PRESETS } from "../src/config/presets";
import { ACTIONS } from "../src/core/actions";
import { loadFlow } from "../src/core/chart";
import { type FeaturesDoc, prune, resolve } from "../src/core/features";
import { GUARDS } from "../src/core/guards";
import type { FakeGitHub, FakeTelegram } from "./fake";
import { FakeCode } from "./fake-code";
import { call, inFlow, setup, wipe } from "./helpers";
import workspaces from "./workspaces.json";

const load = (f: FeaturesDoc) => {
  const x = prune(FLOW.chart, FLOW.options, resolve(f));
  return loadFlow(x.chart, x.options, Object.keys(GUARDS), Object.keys(ACTIONS));
};
const OTHERS: FeaturesDoc = { samples: true, uiReview: { paths: ["**/ui/**"] }, dependencyTickets: true, untrustedReports: true };
const guards = (f: ReturnType<typeof load>, s: string, ev: string) => JSON.stringify(f.transitions(s, ev).map((t) => t.guard));
const targets = (f: ReturnType<typeof load>, s: string, ev: string) => f.transitions(s, ev).map((t) => t.target);

describe("branching x versioning x the other options", () => {
  const others = Object.keys(OTHERS);
  const combos: FeaturesDoc[] = [];
  for (const branching of [undefined, { merger: "flow" }, { merger: "developer" }] as const)
    for (const versioning of [false, true])
      for (let mask = 0; mask < 2 ** others.length; mask++)
        combos.push({
          ...(branching ? { pullRequests: branching } : {}),
          ...(versioning ? { releases: true } : {}),
          ...Object.fromEntries(others.filter((_, i) => mask & (1 << i)).map((k) => [k, (OTHERS as Record<string, unknown>)[k]])),
        } as FeaturesDoc);

  it(`every one of the ${combos.length} combinations loads and hands off, tests and escalates the way its switches say`, () => {
    expect(combos.length).toBe(3 * 2 * 16);
    for (const f of combos) {
      const why = JSON.stringify(f);
      const flow = load(f);
      const handoff = guards(flow, "in development", "handoff");
      if (f.pullRequests) {
        expect(handoff, why).not.toContain('"commitsOnMain"');
        expect(handoff, why).toContain((f.pullRequests as { merger: string }).merger === "flow" ? '"pullRequestOpen"' : '"merged"');
      } else {
        expect(handoff, why).toContain('"commitsOnMain"');
        expect(handoff, why).not.toContain('"pullRequestOpen"');
      }
      expect(Object.keys(flow.options.commands).includes("pr"), why).toBe(!!f.pullRequests);
      expect(flow.states.includes("awaiting release"), why).toBe(!!f.releases);
      expect(targets(flow, "board review", "escalate").includes("awaiting release"), why).toBe(!!f.releases);
      expect((flow.options.ticks ?? []).map((t) => t.event), why).toEqual(f.releases ? ["released"] : []);
      expect(flow.states.includes("needs samples"), why).toBe(!!f.samples);
      expect(guards(flow, "testing", "pass").includes('"uiChanged"'), why).toBe(!!f.uiReview);
      expect(Object.keys(flow.options.commands).includes("merge"), why).toBe(!!f.dependencyTickets || (f.pullRequests as { merger?: string } | undefined)?.merger === "developer");
      expect(Object.keys(flow.options.commands).includes("checked"), why).toBe(!!f.untrustedReports);
    }
  });

  it("each combination is a valid workspace document under either name", () => {
    const base = JSON.parse(JSON.stringify(workspaces.workspaces[1]));
    for (const f of combos) for (const preset of ["trunk", "pr-release"]) expect(validate({ ...base, flow: { preset }, features: f }), JSON.stringify(f)).toEqual([]);
  });
});

describe("the starting points trunk and pr-release", () => {
  it("load the one chart; the document's features are the switches, so documents written before keep their meaning", () => {
    for (const d of workspaces.workspaces as { flow: { preset: string }; features?: FeaturesDoc }[]) {
      expect(validate(d)).toEqual([]);
      const other = d.flow.preset === "trunk" ? "pr-release" : "trunk";
      expect(flowOf({ ...d, flow: { preset: other } })).toEqual(flowOf(d));
    }
    expect(flowOf({ flow: { preset: "pr-release" } })).toEqual(flowOf({ flow: { preset: "trunk" } }));
  });

  it("preset the switches a new document starts with: trunk none, pr-release feature branches and versioning", () => {
    expect(PRESETS.trunk.start).toEqual({});
    expect(PRESETS["pr-release"].start).toEqual({ pullRequests: true, releases: true });
    const base = JSON.parse(JSON.stringify(workspaces.workspaces[1]));
    for (const [preset, p] of Object.entries(PRESETS)) expect(validate({ ...base, flow: { preset }, features: p.start })).toEqual([]);
  });

  it("an invalid combination is refused in one sentence with its JSON path", () => {
    const base = JSON.parse(JSON.stringify(workspaces.workspaces[1]));
    expect(validate({ ...base, features: { releases: { source: "tag" } } })).toEqual(["$.features.releases.tag: is required when source is 'tag'."]);
    expect(validate({ ...base, features: { uiReview: true } })).toEqual(["$.features.uiReview: name at least one of paths, addedFiles or addedLines."]);
  });
});

const CARD = "Works.\n\n### For the owner\nKind: test\nChanged: Lessons load faster\nCheck:\n- open a lesson";
let relmain: FakeGitHub;
let branchy: FakeGitHub;
let tg: FakeTelegram;
beforeEach(async () => {
  ({ relmain, branchy, tg } = setup());
  await wipe("relmain");
  await wipe("branchy");
});
const r = (who: string, cmd: string, body?: unknown) => call(who, cmd, body, undefined, "r");
const b = (who: string, cmd: string, body?: unknown) => call(who, cmd, body, undefined, "b");

describe("single branch with versioning", () => {
  it("walks: commit on main, hand-off, the tester's pass, the card held, a release, the card with its version, the answer, closed", async () => {
    const code = new FakeCode(relmain);
    relmain.commit("feat: base");
    const n = (await r("board", "file", { title: "Faster lessons", body: "## Acceptance\n- a lesson opens at once" })).body.n;
    expect((await r("board", "triage", { n, comment: "Clear." })).body.state).toBe("ready");
    expect((await r("dev1", "next", {})).body.ticket).toMatchObject({ n, state: "in development" });
    expect((await r("dev1", "pr", { n })).status).toBe(404);
    expect((await r("dev1", "handoff", { n, comment: "Done." })).body.error).toBe("no_commits");
    const c = relmain.commit("feat: faster lessons (#1)");
    expect((await r("dev1", "handoff", { n, comment: "Done." })).body.state).toBe("ready for testing");
    expect((await r("tester", "next", {})).body.ticket).toMatchObject({ n, state: "testing" });
    expect((await r("tester", "pass", { n, comment: CARD, build: c, gates: { sha: c, ok: true }, owner_check: true })).body.state).toBe("board review");
    const sent = tg.of("sendRichMessage").length;
    expect((await r("board", "escalate", { n, comment: CARD })).body.state).toBe("awaiting release");
    await inFlow((f) => f.cron(), "relmain");
    expect(relmain.label(n)).toEqual(["awaiting release"]);
    expect(tg.of("sendRichMessage").length).toBe(sent);
    code.publish("1.4.0", c);
    await inFlow((f) => f.cron(), "relmain");
    expect(relmain.label(n)).toEqual(["human review"]);
    expect(JSON.stringify(tg.of("sendRichMessage").slice(sent))).toContain("📦 In 1.4.0 or later");
    expect((await r("owner", "answer", { n, text: "Fast now." })).body.state).toBe("needs triage");
    expect((await r("board", "approve", { n })).body.state).toBe("closed");
    expect(relmain.issues.get(n)!.state).toBe("closed");
  });
});

describe("feature branches without versioning", () => {
  it("walks: branch and pull request, green checks, hand-off, the pass merges, the card goes straight to the owner", async () => {
    const code = new FakeCode(branchy);
    branchy.commit("feat: base");
    const n = (await b("board", "file", { title: "Dark mode", body: "## Acceptance\n- dark" })).body.n;
    await b("board", "triage", { n, comment: "Clear." });
    await b("dev1", "next", {});
    const head = code.push("flowee/1", { "src/theme.ts": "@@ -0,0 +1 @@\n+export const dark = true" });
    expect((await b("dev1", "pr", { n })).body.pull).toMatchObject({ branch: "flowee/1" });
    code.green(head);
    expect((await b("dev1", "handoff", { n, comment: "Done." })).body.state).toBe("ready for testing");
    await b("tester", "next", {});
    const passed = (await b("tester", "pass", { n, comment: CARD, build: head, gates: { sha: head, ok: true }, owner_check: true })).body;
    expect(passed).toMatchObject({ state: "board review", merged: branchy.main.at(-1)!.sha });
    const sent = tg.of("sendRichMessage").length;
    expect((await b("board", "escalate", { n, comment: CARD })).body.state).toBe("human review");
    const shown = JSON.stringify(tg.of("sendRichMessage").slice(sent));
    expect(shown).toContain("Dark mode");
    expect(shown).not.toContain("📦");
  });
});

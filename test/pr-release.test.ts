// The pr-release preset: AnyFile's flow with every feature a switch. XState runs the file, the feature matrix, a
// full ticket walk with pull requests, checks, UI review, a held card, the release and the tested tag, and the
// sampler, untrusted-text, dependency-ticket and developer-merges variants against the Worker.
import { beforeEach, describe, expect, it } from "vitest";
import { createMachine, initialTransition, transition } from "xstate";
import chart from "../flows/pr-release.json";
import options from "../flows/pr-release.options.json";
import { ACTIONS } from "../src/core/actions";
import { type Chart, type FlowOptions, loadFlow } from "../src/core/chart";
import { uiReasons } from "../src/core/code";
import { type FeaturesDoc, prune, resolve } from "../src/core/features";
import { GUARDS } from "../src/core/guards";
import type { FakeGitHub, FakeTelegram } from "./fake";
import { FakeCode } from "./fake-code";
import { call, claim, inFlow, setup, wipe } from "./helpers";

const C = chart as unknown as Chart;
const O = options as unknown as FlowOptions;
const load = (f: FeaturesDoc) => {
  const x = prune(C, O, resolve(f));
  return loadFlow(x.chart, x.options, Object.keys(GUARDS), Object.keys(ACTIONS));
};
const p = (who: string, cmd: string, body?: unknown) => call(who, cmd, body, undefined, "p");
const q = (who: string, cmd: string, body?: unknown) => call(who, cmd, body, undefined, "q");
const CARD = "Works.\n\n### For Nick\nKind: test\nChanged: .qoi files open as images\nSamples: a.qoi\nCheck:\n- open a.qoi";
const ALL = { pullRequests: true, releases: { testedTag: "tested" }, samples: true, uiReview: { paths: ["**/ui/**"] }, dependencyTickets: true, untrustedReports: true };

describe("the pr-release statechart", () => {
  it("is a statechart XState itself accepts and runs, tagged parts included", () => {
    const off = new Set(["originIs", "refuse", "flag", "answered", "untrusted", "isDependencyTicket", "awaitsRelease", "uiChanged", "cardKind"]);
    const one = (g: unknown): boolean =>
      typeof g === "string" ? !off.has(g) : (g as { type: string }).type === "all" ? every(g) : !off.has((g as { type: string }).type);
    const every = (g: unknown) => ((g as { params: { guards: unknown[] } }).params.guards ?? []).every(one);
    const names = (o: Record<string, unknown>) => Object.fromEntries(Object.keys(o).map((k) => [k, () => !off.has(k)]));
    const m = createMachine(C as never).provide({ guards: { ...names(GUARDS), all: (_: unknown, x: unknown) => every({ params: x }) }, actions: names(ACTIONS) as never });
    expect(Object.keys(m.states)).toEqual(Object.keys(C.states));
    let [s] = initialTransition(m);
    for (const [ev, to] of [
      ["triage", "ready"],
      ["next", "in development"],
      ["handoff", "ready for testing"],
      ["next", "testing"],
      ["pass", "closed"],
      ["answer", "needs triage"],
      ["triage", "ready"],
      ["escalate", "human review"],
      ["postpone", "postponed"],
    ]) {
      [s] = transition(m, s, { type: ev });
      expect(s.value, ev).toBe(to);
    }
  });

  it("loads with every combination of the six switches and both mergers", () => {
    const names = Object.keys(ALL);
    for (let mask = 0; mask < 2 ** names.length; mask++)
      for (const merger of ["flow", "developer"]) {
        const f = Object.fromEntries(names.filter((_, i) => mask & (1 << i)).map((k) => [k, k === "pullRequests" ? { merger } : (ALL as Record<string, unknown>)[k]]));
        expect(() => load(f as FeaturesDoc), JSON.stringify(f)).not.toThrow();
      }
  });

  it("with every switch off is the trunk flow's states and commands", () => {
    const f = load({});
    expect(f.states.sort()).toEqual(["back to development", "board review", "closed", "human review", "in development", "needs triage", "postponed", "ready", "ready for testing", "testing"]);
    expect(Object.keys(f.options.roles)).toEqual(["board", "developer", "tester", "owner"]);
    expect(f.options.ticks).toEqual([]);
  });
});

describe("the feature matrix", () => {
  const MATRIX: { feature: FeaturesDoc; states: string[]; commands: string[]; roles?: string[]; events?: [string, string, string][] }[] = [
    { feature: { samples: true }, states: ["needs samples", "in procurement", "samples unobtainable"], commands: ["found", "unobtainable", "needsamples"], roles: ["sampler"] },
    { feature: { releases: true }, states: ["awaiting release"], commands: [], events: [["awaiting release", "released", "inRelease"]] },
    { feature: { pullRequests: true }, states: [], commands: ["pr"], events: [["in development", "handoff", "pullRequestOpen"]] },
    { feature: { pullRequests: { merger: "developer" } }, states: [], commands: ["pr", "merge"], events: [["in development", "handoff", "merged"]] },
    { feature: { uiReview: { paths: ["ui/**"] } }, states: [], commands: [], events: [["testing", "pass", "uiChanged"]] },
    { feature: { dependencyTickets: true }, states: [], commands: ["merge"], events: [["in development", "handoff", "isDependencyTicket"]] },
    { feature: { untrustedReports: true }, states: [], commands: ["checked"], events: [["ready", "next", "untrusted"]] },
  ];
  const guards = (f: ReturnType<typeof load>, s: string, ev: string) => JSON.stringify(f.transitions(s, ev).map((t) => t.guard));

  for (const row of MATRIX)
    it(`${JSON.stringify(row.feature)}: on, its states and commands exist; off, they are refused`, () => {
      const on = load(row.feature);
      const off = load({});
      for (const s of row.states) {
        expect(on.states).toContain(s);
        expect(off.states).not.toContain(s);
      }
      for (const c of row.commands) {
        expect(Object.keys(on.options.commands)).toContain(c);
        expect(Object.keys(off.options.commands)).not.toContain(c);
      }
      for (const r of row.roles ?? []) {
        expect(Object.keys(on.options.roles)).toContain(r);
        expect(Object.keys(off.options.roles)).not.toContain(r);
      }
      for (const [s, ev, g] of row.events ?? []) {
        expect(guards(on, s, ev)).toContain(`"${g}"`);
        if (off.states.includes(s)) expect(guards(off, s, ev)).not.toContain(`"${g}"`);
      }
    });

  it("a command of a switched-off feature is no endpoint (404), a role of it no role", async () => {
    setup();
    expect(await call("board", "found", { n: 1 })).toEqual({ status: 404, body: { ok: false, error: "not_found", message: "There is no POST /v1/found." } });
    expect((await q("board", "found", { n: 1 })).status).toBe(404);
    expect((await q("board", "checked", { n: 1 })).status).toBe(404);
  });
});

describe("UI detection", () => {
  it("names UI files, new files and added UI lines, minus the ignored ones", () => {
    const u = { paths: ["**/ui/**", "**/src/main/res/**"], addedFiles: ["**/renderer/**"], addedLines: ["@Composable|Toast\\."], ignore: ["formats/**"] };
    expect(
      uiReasons(
        [
          { status: "M", path: "app/core/ui/Screen.kt", added: [] },
          { status: "A", path: "app/core/engine/renderer/Qoi.kt", added: [] },
          { status: "M", path: "app/Main.kt", added: ["val x = 1", "  @Composable fun Card()"] },
          { status: "M", path: "formats/qoi/src/main/ui/Parser.kt", added: ["@Composable"] },
          { status: "M", path: "app/Other.kt", added: ["val y = 2"] },
        ],
        u,
      ),
    ).toEqual(["UI file: app/core/ui/Screen.kt", "new file: app/core/engine/renderer/Qoi.kt", "new UI element in app/Main.kt: @Composable fun Card()"]);
  });
});

let any: FakeGitHub;
let dev: FakeGitHub;
let code: FakeCode;
let devCode: FakeCode;
let tg: FakeTelegram;
beforeEach(async () => {
  let x: ReturnType<typeof setup>;
  ({ anyfile: any, anydev: dev, tg } = x = setup());
  void x;
  code = new FakeCode(any);
  devCode = new FakeCode(dev);
  await wipe("anyfile");
  await wipe("anydev");
});
const cron = (ws = "anyfile") => inFlow((f) => f.cron(), ws);
const state = async (n: number, who = "board") => (await p(who, "show", undefined).catch(() => null), (await call(who, `show?n=${n}`, undefined, undefined, "p")).body.state);
const labels = (n: number) => any.label(n);

describe("a pr-release ticket from filing to the owner's release", () => {
  it("walks: file, triage, sample, branch + pull request, checks, hand-off, UI pass, held card, release, answer, closed, tested tag", async () => {
    const n = (await p("board", "file", { title: "QOI images", body: "## Acceptance\n- .qoi opens" })).body.n;
    expect(n).toBe(1);
    expect((await p("board", "next", {})).body.ticket).toMatchObject({ n: 1, state: "needs triage" });
    expect((await p("board", "triage", { n, comment: "Needs a real .qoi.", samples: true })).body.state).toBe("needs samples");

    expect((await p("sampler", "next", {})).body.ticket).toMatchObject({ n, state: "in procurement" });
    expect((await p("sampler", "found", { n, paths: ["Samples/Images/a.qoi"] })).body).toMatchObject({ error: "no_samples", message: "Not on main yet: Samples/Images/a.qoi." });
    expect((await p("sampler", "found", { n, paths: ["Images/a.qoi"] })).body).toMatchObject({ error: "bad_request", message: "Sample paths start with Samples/: Images/a.qoi." });
    code.files.add("Samples/Images/a.qoi");
    expect((await p("sampler", "found", { n, paths: ["Samples/Images/a.qoi"] })).body.state).toBe("ready");
    expect(any.last(n)).toBe("Sampler: Samples:\n- `Samples/Images/a.qoi`");

    expect((await p("dev1", "next", {})).body.ticket).toMatchObject({ n, state: "in development" });
    expect((await p("dev1", "pr", { n })).body).toMatchObject({ error: "no_branch", message: "Push flowee/1 first; it does not exist on the tracker." });
    const head = code.push("flowee/1", { "app/src/main/ui/QoiView.kt": "@@ -0,0 +1 @@\n+@Composable fun QoiView()" });
    const pr = (await p("dev1", "pr", { n })).body;
    expect(pr).toEqual({ ok: true, pull: { number: 1001, url: "https://github.com/acme/anyfile/pull/1001", branch: "flowee/1" } });
    expect(code.pulls[0]).toMatchObject({ title: "QOI images (#1)", body: "Closes #1" });
    expect((await p("dev1", "handoff", { n, comment: "Done." })).body).toMatchObject({ error: "checks_pending", message: `Checks of ${head.slice(0, 7)} are not done yet: build (queued); wait and try again.` });
    code.checks.set(head, [{ name: "build", status: "completed", conclusion: "failure" }]);
    expect((await p("dev1", "handoff", { n, comment: "Done." })).body).toMatchObject({ error: "checks_failed", message: `Checks failed on ${head.slice(0, 7)}: build (failure); fix them first.` });
    code.green(head);
    expect((await p("dev1", "handoff", { n, comment: "Done." })).body.state).toBe("ready for testing");
    expect(any.last(n)).toBe(`Developer: Done.\n\nPull request: #1001 at ${head.slice(0, 7)}`);
    expect((await call("dev1", `show?n=${n}`, undefined, undefined, "p")).body).toMatchObject({ branch: "flowee/1", pull: { number: 1001, state: "open", checks: "green", head } });

    expect((await p("tester", "next", {})).body.ticket).toMatchObject({ n, state: "testing" });
    const gates = { sha: head, ok: true };
    expect((await p("tester", "pass", { n, comment: "Opens.", build: "0".repeat(40), gates: { sha: "0".repeat(40), ok: true } })).body).toMatchObject({ error: "not_in_build" });
    expect((await p("tester", "pass", { n, comment: "Opens.", build: head, gates })).body).toMatchObject({ error: "bad_card", message: "The comment has no ### For Nick card." });
    const passed = (await p("tester", "pass", { n, comment: CARD, build: head, gates })).body;
    expect(passed).toMatchObject({ state: "board review" });
    const merge = any.main.at(-1)!;
    expect(passed.merged).toBe(merge.sha);
    expect(merge.message).toBe("QOI images (#1)");
    expect(code.merged).toEqual([{ number: 1001, method: "squash", title: "QOI images (#1)" }]);
    expect(code.branches.has("flowee/1")).toBe(false);
    expect(any.last(n)).toContain(`Tested build: ${head}, gates green at ${head}\n\nNeeds the owner's review (the board passes it on):\n- UI file: app/src/main/ui/QoiView.kt`);
    expect(code.tags.get("tested")).toBeUndefined(); // the merge commit's build is not green yet

    code.green(merge.sha);
    await cron();
    expect(code.tags.get("tested")).toBe(merge.sha);

    expect((await p("board", "next", {})).body.ticket).toMatchObject({ n, state: "board review", origin: { from: "passed" } });
    const sentBefore = tg.of("sendRichMessage").length;
    expect((await p("board", "escalate", { n, comment: CARD.replace("Works.", "Board: checked") })).body.state).toBe("awaiting release");
    expect(labels(n)).toContain("awaiting release");
    expect(tg.of("sendRichMessage").length).toBe(sentBefore);
    await cron();
    expect(labels(n)).toContain("awaiting release");
    code.publish("1.4.0", merge.sha);
    await cron();
    expect(labels(n)).toContain("human review");
    const card = await inFlow((f) => JSON.parse(f.rows<{ card: string }>("SELECT card FROM inbox WHERE n = ?", n)[0].card), "anyfile");
    expect(card).toMatchObject({ kind: "test", samples: "a.qoi", version: "1.4.0" });
    expect(JSON.stringify(tg.of("sendRichMessage").slice(sentBefore))).toContain("📦 In 1.4.0 or later");

    expect((await p("owner", "answer", { n, text: "Works on my phone." })).body.state).toBe("needs triage");
    expect((await p("board", "approve", { n })).body.state).toBe("closed");
    expect(any.issues.get(n)!.state).toBe("closed");
  });

  it("a test card whose code is already released goes straight to the owner, with the version", async () => {
    any.add({ number: 3, state_label: "board review" });
    const sha = any.commit("feat: thing (#3)");
    code.publish("2.0.0", sha);
    expect((await p("board", "escalate", { n: 3, comment: CARD })).body.state).toBe("human review");
    const card = await inFlow((f) => JSON.parse(f.rows<{ card: string }>("SELECT card FROM inbox WHERE n = 3")[0].card), "anyfile");
    expect(card.version).toBe("2.0.0");
  });

  it("the tested tag stops before the first commit of an untested ticket and skips docs commits", async () => {
    any.add({ number: 1, state: "closed" });
    any.add({ number: 2, state_label: "in development" });
    const a = any.commit("feat: a (#1)");
    const d = any.commit("docs: notes");
    const b = any.commit("feat: b (#2)");
    for (const s of [a, d, b]) code.green(s);
    await cron();
    expect(code.tags.get("tested")).toBe(a);
    any.issues.get(2)!.labels = [{ name: "ready for testing" }];
    await cron();
    expect(code.tags.get("tested")).toBe(a);
    any.issues.get(2)!.state = "closed";
    await cron();
    expect(code.tags.get("tested")).toBe(b);
  });
});

describe("samples", () => {
  it("unobtainable goes to the board; it reaches the owner only with a Kind: sample card; sendback asks the sampler again", async () => {
    any.add({ number: 1, state_label: "in procurement" });
    await claim(1, "sampler" as never, "sampler", Date.now(), "anyfile");
    const draft = "Looked everywhere.\n\n### For Nick\nKind: sample\nSamples: a.qoi\nCheck:\n- export one from the QOI tool, drop it in Samples/Images";
    expect((await p("sampler", "unobtainable", { n: 1, comment: draft })).body.state).toBe("board review");
    expect((await p("board", "escalate", { n: 1, comment: "### For Nick\nKind: question\nQuestion: Can you make one?" })).body).toMatchObject({
      error: "bad_card",
      message: "#1 could not get its sample: escalate it only with a complete Kind: sample card.",
    });
    expect((await p("board", "escalate", { n: 1, comment: draft.replace("Samples: a.qoi", "Samples: Samples/a.qoi") })).body).toMatchObject({ error: "bad_card" });
    expect((await p("board", "escalate", { n: 1, comment: draft })).body.state).toBe("samples unobtainable");
    expect(any.issues.get(1)!.assignees.map((a) => a.login)).toEqual(["Nachtalb"]);
    expect((await p("board", "needsamples", { n: 1, comment: "Nick dropped one in." })).body.state).toBe("needs samples");

    any.add({ number: 2, state_label: "in procurement" });
    await claim(2, "sampler" as never, "sampler", Date.now(), "anyfile");
    await p("sampler", "unobtainable", { n: 2, comment: draft });
    expect((await p("board", "sendback", { n: 2, comment: "Try the QOI test images repository." })).body.state).toBe("needs samples");
  });

  it("triage to ready needs sample paths on main or the not-file-related label", async () => {
    any.add({ number: 1 });
    any.add({ number: 2, labels: [{ name: "not file related" }] });
    expect((await p("board", "triage", { n: 1, comment: "Spec done." })).body).toMatchObject({ error: "no_samples", message: "#1 needs sample paths (or the 'not file related' label)." });
    expect((await p("board", "triage", { n: 2, comment: "Spec done." })).body.state).toBe("ready");
    code.files.add("Samples/x.7z");
    expect((await p("board", "triage", { n: 1, comment: "Spec done.", paths: ["Samples/x.7z/inner/a.qoi"] })).body.state).toBe("ready");
  });
});

describe("untrusted reports", () => {
  it("only the board gets a ticket with untrusted text, in any state, until it checked it", async () => {
    any.add({ number: 1, state_label: "ready", labels: [{ name: "feedback" }] });
    expect((await p("dev1", "next", {})).body.ticket).toBeNull();
    expect((await call("board", "queue", undefined, undefined, "p")).body.queue).toEqual([1]);
    expect((await p("board", "next", {})).body.ticket).toMatchObject({ n: 1, state: "ready" });
    expect((await p("board", "checked", { n: 1, comment: "Adds nothing actionable." })).body.state).toBe("ready");
    expect(labels(1)).toEqual(["ready"]);
    expect((await p("board", "checked", { n: 1, comment: "again" })).body).toMatchObject({ error: "not_untrusted", message: "#1 has no 'feedback' label." });
    expect((await p("dev1", "next", {})).body.ticket).toMatchObject({ n: 1, state: "in development" });
  });
});

describe("dependency tickets and a developer who merges", () => {
  it("files one ticket per dependency pull request; the developer merges it green and hands it off", async () => {
    dev.commit("feat: base");
    devCode.push("dependabot/npm/x-2");
    const pr = devCode.pr("dependabot/npm/x-2", "Bump x from 1 to 2", "dependabot[bot]");
    devCode.pr("someone/else", "Not a bump", "ann");
    await cron("anydev");
    await cron("anydev");
    expect([...dev.issues.values()].map((i) => [i.title, i.labels.map((l) => l.name)])).toEqual([["deps: Bump x from 1 to 2 (PR #1001)", ["needs triage"]]]);
    const n = 1;
    expect(dev.issues.get(n)!.body).toContain("Pull request: #1001");
    expect((await q("board", "triage", { n, comment: "Merge it." })).body.state).toBe("ready");
    expect((await q("dev1", "next", {})).body.ticket).toMatchObject({ n, state: "in development" });
    expect((await q("dev1", "handoff", { n, comment: "Done." })).body).toMatchObject({ error: "not_merged", message: "Pull request #1001 of #1 is not merged yet; merge it first." });
    expect((await q("dev1", "merge", { n })).body).toMatchObject({ error: "checks_pending", message: `No checks reported on ${pr.head.sha.slice(0, 7)} yet; wait and try again.` });
    devCode.green(pr.head.sha);
    const merged = (await q("dev1", "merge", { n })).body;
    expect(merged.state).toBe("in development");
    expect(dev.main.at(-1)!.message).toBe("Bump x from 1 to 2 (#1)");
    expect((await q("dev1", "handoff", { n, comment: "Done." })).body.state).toBe("ready for testing");
    expect(dev.last(n)).toBe(`Developer: Done.\n\nPull request: #1001, merged as ${merged.merged.slice(0, 7)}`);
  });

  it("with merger developer: pr, merge with green checks, hand-off, the tester tests the main branch", async () => {
    dev.commit("feat: base");
    dev.add({ number: 1, state_label: "in development", title: "Dark mode" });
    await claim(1, "dev1", "developer", Date.now(), "anydev");
    const head = devCode.push("flowee/1");
    expect((await q("dev1", "pr", { n: 1 })).body.pull.number).toBe(1001);
    expect((await q("dev1", "handoff", { n: 1, comment: "Done." })).body).toMatchObject({ error: "not_merged" });
    devCode.green(head);
    const sha = (await q("dev1", "merge", { n: 1 })).body.merged;
    expect(devCode.merged[0]).toMatchObject({ method: "merge", title: "Dark mode (#1)" });
    expect((await q("dev1", "handoff", { n: 1, comment: "Done." })).body.state).toBe("ready for testing");
    await q("tester", "next", {});
    expect((await q("tester", "pass", { n: 1, comment: "ok", build: sha, gates: { sha, ok: true } })).body.state).toBe("closed");
  });
});

describe("the remaining feature transitions", () => {
  it("the sampler releases, gets stuck, expires; the board sends a stuck sampler ticket back and asks for samples on the owner's word", async () => {
    any.add({ number: 1, state_label: "in procurement" });
    await claim(1, "sampler" as never, "sampler", Date.now(), "anyfile");
    expect((await p("sampler", "release", { n: 1 })).body).toMatchObject({ error: "comment_required" });
    expect((await p("sampler", "release", { n: 1, comment: "Out of time." })).body.state).toBe("needs samples");
    any.issues.get(1)!.labels = [{ name: "in procurement" }];
    await claim(1, "sampler" as never, "sampler", Date.now(), "anyfile");
    expect((await p("sampler", "stuck", { n: 1, comment: "Which variant?" })).body.state).toBe("board review");
    expect((await p("board", "sendback", { n: 1, comment: "The 2019 one." })).body.state).toBe("needs samples");
    any.issues.get(1)!.labels = [{ name: "in procurement" }];
    await claim(1, "sampler" as never, "sampler", Date.now() - 4 * 3600e3, "anyfile");
    await cron();
    expect(labels(1)).toEqual(["needs samples"]);
    expect(any.last(1)).toContain("The claim of sampler expired after 3 h");

    any.add({ number: 2 });
    expect((await p("board", "needsamples", { n: 2 })).body).toMatchObject({ error: "wrong_state" });
    await inFlow((f) => {
      f.sql.exec("INSERT INTO answers (n, ts, text, via) VALUES (2, ?, 'needs a sample', 'api')", Date.now());
    }, "anyfile");
    expect((await p("board", "needsamples", { n: 2 })).body.state).toBe("needs samples");
  });

  it("a held card can still be reworked; a merge the tracker refuses is 409 not_mergeable and changes nothing", async () => {
    any.add({ number: 1, state_label: "awaiting release" });
    expect((await p("board", "rework", { n: 1, comment: "Red CI on main." })).body.state).toBe("back to development");

    any.commit("feat: base");
    any.add({ number: 2, state_label: "testing" });
    await claim(2, "tester", "tester", Date.now(), "anyfile");
    const head = code.push("flowee/2");
    code.green(head);
    code.pr("flowee/2", "Thing (#2)").mergeable = false;
    const r = await p("tester", "pass", { n: 2, comment: "ok", build: head, gates: { sha: head, ok: true } });
    expect(r.body).toMatchObject({ error: "not_mergeable", message: "GitHub refused to merge pull request #1001 (405): it is not mergeable or its head moved." });
    expect(labels(2)).toEqual(["testing"]);
  });

  it("UI review reads every file of the pull request, not only its head commit", async () => {
    any.commit("feat: base");
    any.add({ number: 2, state_label: "testing", title: "Viewer" });
    await claim(2, "tester", "tester", Date.now(), "anyfile");
    code.push("flowee/2", { "app/src/main/ui/Viewer.kt": "@@ -0,0 +1 @@\n+fun Viewer()" });
    const head = code.push("flowee/2", { "app/src/main/Engine.kt": "@@ -1 +1 @@\n+val x = 2" });
    code.green(head);
    code.pr("flowee/2", "Viewer (#2)");
    const r = await p("tester", "pass", { n: 2, comment: CARD, build: head, gates: { sha: head, ok: true } });
    expect(r.body.state).toBe("board review");
    expect(any.last(2)).toContain("- UI file: app/src/main/ui/Viewer.kt");
  });

  it("show names the branch, the pull request and its checks", async () => {
    any.add({ number: 1, state_label: "in development" });
    expect((await call("board", "show?n=1", undefined, undefined, "p")).body).toMatchObject({ branch: "flowee/1", pull: null });
    const head = code.push("flowee/1");
    code.pr("flowee/1", "x (#1)");
    code.checks.set(head, [{ name: "build", status: "in_progress", conclusion: null }]);
    expect((await call("board", "show?n=1", undefined, undefined, "p")).body.pull).toEqual({
      number: 1001,
      url: "https://github.com/acme/anyfile/pull/1001",
      state: "open",
      head,
      checks: "pending",
      waiting: "build (in progress)",
    });
  });
});

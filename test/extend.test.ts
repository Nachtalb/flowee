// Flow extensions: merged into the one chart, validated as a whole with one sentence per problem naming the
// extension and its JSON path, still an XState chart; the samples example extension and the former samples switch.
import { describe, expect, it } from "vitest";
import { createMachine, initialTransition, transition } from "xstate";
import { merged } from "../scripts/flow";
import type { WorkspaceDoc } from "../src/config/document";
import { BUILTIN, flowOf, samplesWith } from "../src/config/presets";
import { validate } from "../src/config/schema";
import { ACTIONS } from "../src/core/actions";
import { type Extension, extend } from "../src/core/extend";
import { GUARDS } from "../src/core/guards";
import { aliasesOf } from "../src/wizard/wizard";
import { FLOW } from "../src/config/presets";
import security from "./fixtures/security-review.json";

const SEC = security as unknown as Extension;
const doc = (extensions: unknown[], features: object = {}): WorkspaceDoc =>
  ({
    flowee: 1,
    id: "shop",
    flow: { preset: "trunk" },
    extensions,
    features,
    tracker: { repos: ["acme/shop"], token: "T" },
    roles: [
      { instance: "board", role: "board", secret: "T_BOARD" },
      { instance: "owner", role: "owner", secret: "T_OWNER" },
    ],
    owners: [{ name: "Ann" }],
  }) as unknown as WorkspaceDoc;
const ext = (e: object[]) => extend(FLOW.chart, FLOW.options, e as Extension[], Object.keys(GUARDS), Object.keys(ACTIONS)).problems;

describe("flow extensions", () => {
  it("a security review: new states, a role, commands and a grant merge into a chart XState runs", () => {
    expect(validate(doc([SEC]))).toEqual([]);
    const chart = merged(doc([SEC]));
    const options = merged(doc([SEC]), true) as typeof FLOW.options;
    expect(options.roles.security).toEqual({ sign: "Security", who: "the security reviewer" });
    expect(options.commands.next.roles).toContain("security");
    const m = createMachine(chart as never).provide({ guards: Object.fromEntries([...Object.keys(GUARDS)].map((g) => [g, () => true])) as never, actions: Object.fromEntries(Object.keys(ACTIONS).map((a) => [a, () => {}])) as never });
    let [s] = initialTransition(m);
    for (const [ev, to] of [["triage", "ready"], ["next", "in development"], ["stuck", "board review"], ["securityreview", "awaiting security"], ["next", "security review"], ["secure", "closed"]]) {
      [s] = transition(m, s, { type: ev });
      expect(s.value, ev).toBe(to);
    }
  });

  it("every problem is one sentence with the extension's name and JSON path", () => {
    expect(ext([{ name: "a", states: { ready: { meta: { label: "x" } } } }])).toEqual([
      "$.extensions[0].states.ready: extension 'a' adds the state 'ready', which the flow has already; change a state with on, replace or remove.",
    ]);
    expect(ext([{ name: "a", replace: { ready: { drop: [] } } }, { name: "b", replace: { ready: { drop: [] } } }])).toEqual([
      "$.extensions[1].replace.ready.drop: extension 'b' and extension 'a' both replace 'drop' on 'ready'; only one extension may.",
    ]);
    expect(ext([{ name: "a", on: { ready: { poke: { target: "ready", guard: "isTuesday", actions: ["dance"] } } } }])).toEqual([
      "$.extensions[0].on.ready.poke[0].guard: extension 'a' names the unknown guard 'isTuesday'; the guards are listed in docs/flows.md.",
      "$.extensions[0].on.ready.poke[0].actions: extension 'a' names the unknown action 'dance'; the actions are listed in docs/flows.md.",
    ]);
    expect(ext([{ name: "a", replace: { ready: { poke: [] } } }])).toEqual(["$.extensions[0].replace.ready.poke: extension 'a' replaces 'poke' on 'ready', which the base flow does not have; add it with on instead."]);
    expect(ext([{ name: "a", on: { nowhere: { go: "ready" } } }])).toEqual(["$.extensions[0].on.nowhere: extension 'a' changes the state 'nowhere', which the flow does not have."]);
    expect(ext([{ name: "a", roles: { board: { sign: "B", who: "b" } } }, { name: "a" }])).toEqual([
      "$.extensions[1].name: the extension 'a' is listed twice.",
      "$.extensions[0].roles.board: extension 'a' adds the role 'board', which the flow has already.",
    ]);
    expect(ext([{ name: "a", cards: ["poem"] }])).toEqual(["$.extensions[0].cards: extension 'a' names the card kind 'poem'; the kinds an extension may add are sample."]);
    // the whole merged flow is loaded too: a missing target and an unreachable state of an extension
    expect(validate(doc([{ name: "lost", states: { limbo: { meta: { label: "limbo" }, on: { go: "nowhere" } } } }]))).toEqual([
      "$.extensions[0].states['limbo']: State 'limbo', event 'go': the target 'nowhere' does not exist.",
      "$.extensions[0].states['limbo']: State 'limbo' is unreachable: no transition leads to it.",
      "$.extensions[0].states['limbo']: Event 'go' has no entry in options.commands.".replace("$.extensions[0].states['limbo']: ", "$.flow: "),
    ].sort((a, b) => (a.startsWith("$.flow") ? -1 : b.startsWith("$.flow") ? 1 : 0)));
    expect(validate(doc(["builtin:nothing"]))).toEqual(["$.extensions[0]: Flowee ships no extension 'builtin:nothing'; it ships builtin:samples."]);
  });

  it("samples is the shipped example extension; the former features.samples maps to it with its options", () => {
    const viaExt = flowOf(doc(["builtin:samples"]));
    const viaSwitch = flowOf(doc([], { samples: true }));
    expect(viaSwitch).toEqual(viaExt);
    expect(viaExt.chart.states["needs samples"]).toBeDefined();
    expect(Object.keys(viaExt.options.roles)).toContain("sampler");
    expect(viaExt.options.cards).toEqual(["sample"]);
    expect(flowOf(doc([])).chart.states["needs samples"]).toBeUndefined();
    const rooted = JSON.stringify(flowOf(doc([], { samples: { root: "Samples/", notNeededLabel: "no sample" } })).chart);
    expect(rooted).toContain('"root":"Samples/","unlessLabel":"no sample"');
    expect(JSON.stringify(samplesWith({}))).toBe(JSON.stringify(BUILTIN.samples));
    expect(validate({ ...doc(["builtin:samples"]), roles: [...(doc([]).roles ?? []), { instance: "sampler", role: "sampler", secret: "T_S" }] })).toEqual([]);
    // the base chart knows no sampler at all
    expect(JSON.stringify(FLOW)).not.toMatch(/sampl/);
  });
});

describe("the wizard's repository aliases", () => {
  it("two repositories of the same name are told apart by their owner instead of refused", () => {
    expect(aliasesOf(["acme/app", "octo/app", "acme/lib"])).toEqual(["acme-app", "octo-app", "lib"]);
  });
});

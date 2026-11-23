// The statechart engine: the trunk preset loads, XState itself interprets the same file, load-time validation.
import { createMachine, initialTransition, transition } from "xstate";
import { describe, expect, it } from "vitest";
import chart from "../flows/trunk.json";
import options from "../flows/trunk.options.json";
import { ACTIONS } from "../src/core/actions";
import { type Chart, type FlowOptions, loadFlow } from "../src/core/chart";
import { from } from "../src/core/engine";
import { GUARDS } from "../src/core/guards";

const C = chart as unknown as Chart;
const O = options as unknown as FlowOptions;
const load = (c: unknown, o: unknown = O) => loadFlow(c as Chart, o as FlowOptions, Object.keys(GUARDS), Object.keys(ACTIONS));
const problems = (c: unknown, o: unknown = O) => {
  try {
    load(c, o);
    return "";
  } catch (e) {
    return (e as Error).message;
  }
};
const copy = () => JSON.parse(JSON.stringify(chart));

describe("the trunk preset", () => {
  it("loads", () => {
    const f = load(C);
    expect(f.states).toContain("needs triage");
    expect(f.closed).toBe("closed");
  });

  it("is a statechart XState itself accepts and runs (so Stately's editor can load it)", () => {
    const names = (o: Record<string, unknown>) => Object.fromEntries(Object.keys(o).map((k) => [k, () => true]));
    const value: Record<string, boolean> = { originIs: false, refuse: false, flag: false, answered: false };
    const one = (g: unknown): boolean =>
      typeof g === "string" ? (value[g] ?? true) : (g as { type: string }).type === "all" ? all(g) : (value[(g as { type: string }).type] ?? true);
    const all = (g: unknown) => ((g as { params: { guards: unknown[] } }).params.guards ?? []).every(one);
    const m = createMachine(C as never).provide({
      guards: { ...names(GUARDS), ...Object.fromEntries(Object.entries(value).map(([k, v]) => [k, () => v])), all: (_: unknown, p: unknown) => all({ params: p }) },
      actions: names(ACTIONS) as never,
    });
    expect(Object.keys(m.states)).toEqual(Object.keys(C.states));
    let [s] = initialTransition(m);
    expect(s.value).toBe("needs triage");
    for (const [ev, to] of [
      ["next", "needs triage"],
      ["triage", "ready"],
      ["next", "in development"],
      ["handoff", "ready for testing"],
      ["next", "testing"],
      ["pass", "closed"],
      ["answer", "needs triage"],
    ]) {
      [s] = transition(m, s, { type: ev });
      expect(s.value, ev).toBe(to);
    }
  });

  it("names the states a role may use an event in, as the contract's From column (answered ones last)", () => {
    const f = load(C);
    expect(from(f, "rework", "board")).toEqual(["'board review'", "'human review'", "'ready for testing'", "'needs triage (answered)'"]);
    expect(from(f, "heartbeat", "developer")).toEqual(["'needs triage'", "'board review'", "'in development'", "'testing'"]);
    expect(from(f, "release", "developer")).toEqual(["'in development'"]);
    expect(from(f, "release", "board")).toEqual(["'needs triage'", "'board review'"]);
    expect(from(f, "approve", "board")).toEqual(["'board review'", "'human review'", "'needs triage (answered)'"]);
  });
});

describe("validation at load", () => {
  it("reports every problem in one sentence naming the state or event", () => {
    const c = copy();
    c.states.ready.on.spec.guard = "isFriday";
    c.states.ready.on.next.actions = ["setStatus", "dance"];
    c.states.testing.on.fail.target = "limbo";
    c.states.orphan = { meta: { label: "orphan" } };
    const m = problems(c);
    expect(m).toContain("State 'ready', event 'spec': unknown guard 'isFriday'.");
    expect(m).toContain("State 'ready', event 'next': unknown action 'dance'.");
    expect(m).toContain("State 'testing', event 'fail': the target 'limbo' does not exist.");
    expect(m).toContain("State 'orphan' is unreachable: no transition leads to it.");
  });

  it("checks guards nested in all, roles, labels, the initial state and the options", () => {
    const c = copy();
    c.initial = "nowhere";
    c.states.ready.on.next.guard = { type: "all", params: { guards: ["holdsClaim", "nope"] } };
    c.states.testing.meta.label = "ready";
    c.states.testing.meta.holder = "sampler";
    c.states.ready.on.dance = { target: "testing" };
    const o = JSON.parse(JSON.stringify(options));
    o.commands.pass.roles = ["tester", "qa"];
    o.commands.pass.input.build = "hash";
    o.leaseHours = 0;
    const m = problems(c, o);
    for (const s of [
      "The initial state 'nowhere' does not exist.",
      "State 'ready', event 'next': unknown guard 'nope'.",
      "State 'testing' reuses the label 'ready' of 'ready'.",
      "State 'testing' names the unknown role 'sampler'.",
      "Event 'dance' has no entry in options.commands.",
      "Command 'pass' names the unknown role 'qa'.",
      'Command \'pass\', field \'build\': unknown input rule "hash".',
      "options.leaseHours must be a positive number.",
    ])
      expect(m).toContain(s);
  });
});

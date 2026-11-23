// Feature switches: terms, pruning a tagged chart, and the workspace document's feature rules.
import { describe, expect, it } from "vitest";
import { flowOf } from "../src/config/presets";
import { featureProblems } from "../src/config/features";
import { validate } from "../src/config/schema";
import type { Chart, FlowOptions } from "../src/core/chart";
import { featuresOf, glob, holds, prune, resolve } from "../src/core/features";
import workspaces from "./workspaces.json";

const { chart: trunk, options: trunkOptions } = flowOf({ flow: { preset: "trunk" } });

const base = JSON.parse(JSON.stringify(workspaces.workspaces[1]));

/** trunk plus a `parked` state, its `park` command and a `sampler` role, all tagged `samples`. */
function tagged() {
  const chart = JSON.parse(JSON.stringify(trunk)) as Chart;
  const options = JSON.parse(JSON.stringify(trunkOptions)) as FlowOptions;
  chart.states.parked = { meta: { label: "parked", features: ["samples"] } as never, on: { resume: "needs triage" } };
  chart.states.ready.on!.park = { target: "parked", meta: { features: ["samples"] } };
  chart.states.ready.on!.drop = [{ target: "closed", meta: { features: ["!samples"] } }, chart.states.ready.on!.drop as never];
  options.roles.sampler = { sign: "Sampler", who: "the sampler", features: ["samples"] };
  options.commands.park = { roles: ["board", "sampler"], features: "samples" };
  options.ticks = [{ event: "resume", role: "board", features: ["samples"] }];
  return { chart, options };
}

describe("terms", () => {
  it("hold for on, off, an option value and a true option", () => {
    const f = resolve({ pullRequests: { merger: "developer" }, releases: true });
    expect(holds("pullRequests", f)).toBe(true);
    expect(holds("!samples", f)).toBe(true);
    expect(holds("pullRequests.merger=developer", f)).toBe(true);
    expect(holds("pullRequests.merger=flow", f)).toBe(false);
    expect(holds("releases.hold", f)).toBe(true);
    expect(holds("releases.testedTag", f)).toBe(false);
    expect(resolve({ samples: false, releases: { hold: false } })).toEqual({
      releases: { source: "release", checks: [], skip: ["docs", "chore", "test"], hold: false, versionLine: true },
    });
  });

  it("globs: * within a folder, ** across folders, ? one character", () => {
    expect(glob("**/ui/**").test("app/src/ui/Screen.kt")).toBe(true);
    expect(glob("**/ui/**").test("ui/a.kt")).toBe(true);
    expect(glob("src/*.ts").test("src/a/b.ts")).toBe(false);
    expect(glob("src/?.ts").test("src/a.ts")).toBe(true);
    expect(glob("formats/**").test("formats/x/src/main/A.kt")).toBe(true);
  });
});

describe("pruning", () => {
  it("removes the states, transitions, roles, commands and ticks of a switched-off feature", () => {
    const { chart, options } = tagged();
    expect([...featuresOf(chart, options)]).toEqual(["samples", "pullRequests"]);
    const off = prune(chart, options, resolve({}));
    expect(off.chart.states.parked).toBeUndefined();
    expect(off.chart.states.ready.on?.park).toBeUndefined();
    expect((off.chart.states.ready.on?.drop as unknown[]).length).toBe(2);
    expect(off.options.roles.sampler).toBeUndefined();
    expect(off.options.commands.park).toBeUndefined();
    expect(off.options.ticks).toEqual([]);
    const on = prune(chart, options, resolve({ samples: true }));
    expect(on.chart.states.parked).toBeDefined();
    expect((on.chart.states.ready.on?.drop as unknown[]).length).toBe(1);
    expect(on.options.commands.park.roles).toEqual(["board", "sampler"]);
    expect(on.options.ticks).toHaveLength(1);
  });
});

describe("the workspace document's features", () => {
  const doc = (features: unknown, flow: unknown = tagged()) => ({ ...base, flow, ...(features === undefined ? {} : { features }) });

  it("are off by default and validated per field", () => {
    expect(validate(doc(undefined))).toEqual([]);
    expect(validate(doc({ samples: { root: "Samples/" } }))).toEqual([]);
    expect(validate(doc({ samples: { rot: "x" } }))).toEqual(["$.features.samples.rot: is not a known field."]);
    expect(validate(doc({ colour: true }))).toEqual(["$.features.colour: is not a known field."]);
    expect(validate(doc({ pullRequests: { branch: "work" } }))).toEqual(["$.features.pullRequests.branch: must match \\{n\\}."]);
    expect(validate(doc({ pullRequests: { method: "octopus" } }))).toEqual(['$.features.pullRequests.method: must be one of "merge", "squash", "rebase".']);
  });

  it("refuse a feature the flow does not have, and contradicting options, in one sentence with the path", () => {
    const t = tagged();
    const f = (features: unknown) => featureProblems(doc(features) as never, t);
    expect(f({ releases: { source: "tag" } })).toEqual(["$.features.releases: the inline flow has no feature 'releases'.", "$.features.releases.tag: is required when source is 'tag'."]);
    expect(f({ releases: { source: "tag", tag: "x", testedTag: "x" } })[1]).toBe("$.features.releases.testedTag: must differ from releases.tag, which marks the published build.");
    expect(f({ uiReview: true })[1]).toBe("$.features.uiReview: name at least one of paths, addedFiles or addedLines.");
    expect(f({ uiReview: { addedLines: ["(oops"] } })[1]).toBe("$.features.uiReview.addedLines[0]: '(oops' is no regular expression.");
    expect(f({ untrustedReports: { role: "qa" } })[1]).toBe("$.features.untrustedReports.role: 'qa' is no role of the flow.");
  });

  it("refuse a feature the tracker cannot do", () => {
    const t = tagged();
    expect(featureProblems(doc({ dependencyTickets: true }) as never, t, { github: ["branches"] })).toEqual(["$.features.dependencyTickets: the flow tags no 'dependencyTickets'.".replace("the flow tags no 'dependencyTickets'.", "the inline flow has no feature 'dependencyTickets'."), "$.features.dependencyTickets: the tracker 'github' cannot do pull requests."]);
    expect(featureProblems(doc({ uiReview: { paths: ["ui/**"] } }) as never, t, { github: ["pulls"] })).toEqual(["$.features.uiReview: the inline flow has no feature 'uiReview'.", "$.features.uiReview: the tracker 'github' cannot do branches."]);
  });

  it("drop a switched-off feature's role from the flow, so an instance of it is refused", () => {
    const d = doc(undefined);
    d.roles = [...d.roles, { instance: "sampler", role: "sampler", secret: "OTHER_SAMPLER" }];
    expect(validate(d)).toEqual(["$.roles[5].role: 'sampler' is no role of the flow (board, developer, tester, owner)."]);
    expect(validate({ ...d, features: { samples: true } })).toEqual([]);
  });
});

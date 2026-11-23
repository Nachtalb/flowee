// The `features` part of a workspace document: its JSON Schema and the rules across fields (a feature the flow does
// not have, a capability the tracker lacks, options that contradict each other).
import { type Chart, type FlowOptions } from "../core/chart";
import { FEATURES, type FeatureName, featuresOf, NEEDS, resolve } from "../core/features";
import type { Capability } from "../ports/tracker";
import type { WorkspaceDoc } from "./document";
import { TRACKER_KINDS } from "./trackers";

type S = Record<string, unknown>;
const str = (description: string, extra: S = {}): S => ({ type: "string", minLength: 1, description, ...extra });
const strs = (description: string, extra: S = {}): S => ({ type: "array", items: str("One entry."), description, ...extra });
const bool = (description: string, d: boolean): S => ({ type: "boolean", default: d, description });
const feature = (description: string, properties: S): S => ({
  description,
  oneOf: [
    { type: "object", additionalProperties: false, required: [], properties, description: "On, with these options." },
    { type: "boolean", description: "true: on with the defaults; false: off." },
  ],
});

export const FEATURES_SCHEMA: S = {
  type: "object",
  additionalProperties: false,
  description: "Feature switches of the flow; each is off unless given (docs/configuration.md, Features).",
  properties: {
    pullRequests: feature("A branch and a pull request per ticket, its checks green before hand-off or merge.", {
      branch: str("The ticket's branch; {n} is the ticket.", { default: "flowee/{n}", pattern: "\\{n\\}" }),
      checks: strs("Check names that must be green; empty: every check of the head.", { default: [] }),
      method: { enum: ["merge", "squash", "rebase"], default: "merge", description: "How a pull request is merged." },
      merger: { enum: ["flow", "developer"], default: "flow", description: "flow: the tester's pass merges; developer: the developer merges before the hand-off." },
      deleteBranch: bool("Delete the branch after the merge.", true),
    }),
    releases: feature("Releases: test cards wait for the release with their code, the version line, the tested tag.", {
      source: { enum: ["release", "tag"], default: "release", description: "release: the latest published release; tag: the commit `tag` points at." },
      tag: str("The tag that marks the published build (source tag)."),
      testedTag: str("A tag moved forward over main as far as no commit belongs to an untested ticket."),
      checks: strs("Checks a commit needs green before testedTag moves onto it.", { default: [] }),
      skip: strs("Commit types never tagged (their builds are skipped).", { default: ["docs", "chore", "test"] }),
      hold: bool("Test cards wait in `awaiting release` until the release has the ticket's code.", true),
      versionLine: bool("Test cards say `📦 In <version> or later`.", true),
    }),
    samples: feature("The sampler role: tickets need a real sample on the main branch before development.", {
      root: str("Sample paths must start with this.", { default: "" }),
      notNeededLabel: str("Tickets with this label need no sample.", { default: "not file related" }),
    }),
    uiReview: feature("A pass whose diff changes the UI goes to board review with an owner card.", {
      paths: strs("Globs: a change under one of them is a UI change."),
      addedFiles: strs("Globs: a file added under one of them is a UI change."),
      addedLines: strs("Regular expressions: an added line matching one is a UI change."),
      ignore: strs("Globs never counted."),
    }),
    dependencyTickets: feature("One ticket per open dependency pull request (e.g. Dependabot); the developer merges it green.", {
      authors: strs("Pull request authors whose pull requests become tickets.", { default: ["dependabot[bot]"], minItems: 1 }),
      labels: strs("Labels the filed ticket gets.", { default: [] }),
    }),
    untrustedReports: feature("Tickets with untrusted user text go to one role only until it checked them.", {
      label: str("The label marking untrusted text.", { default: "feedback" }),
      role: str("The role that reviews it.", { default: "board" }),
    }),
  },
};

/** Capabilities per tracker type. */
export const TRACKER_CAPABILITIES: Record<string, Capability[]> = Object.fromEntries(Object.entries(TRACKER_KINDS).map(([k, v]) => [k, v.capabilities]));

const NAMES: Record<Capability, string> = { board: "a project board", branches: "branches", pulls: "pull requests", checks: "check runs", releases: "releases", tags: "tags" };

/** Problems of `$.features` against the (unpruned) flow and the tracker. */
export function featureProblems(d: WorkspaceDoc, raw: { chart: Chart; options: FlowOptions }, caps = TRACKER_CAPABILITIES): string[] {
  const errs: string[] = [];
  const f = resolve(d.features);
  const known = featuresOf(raw.chart, raw.options);
  // every repository's tracker must do what a feature needs (a mixed workspace: each kind once)
  const kinds = [...new Set(d.tracker.repos.map((r) => (typeof r === "object" && r.type) || d.tracker.type || "github"))];
  const flowName = "preset" in d.flow ? `'${d.flow.preset}'` : "inline";
  for (const k of FEATURES) {
    if (!f[k]) continue;
    if (!known.has(k)) errs.push(`$.features.${k}: the ${flowName} flow has no feature '${k}'.`);
    const need = [...NEEDS[k as FeatureName], ...(k === "releases" && f.releases?.checks.length ? (["checks"] as Capability[]) : [])];
    for (const kind of kinds) {
      const lacks = [...new Set(need.filter((c) => !(caps[kind] ?? []).includes(c)))];
      if (lacks.length) errs.push(`$.features.${k}: the tracker '${kind}' cannot do ${lacks.map((c) => NAMES[c]).join(" or ")}.`);
    }
  }
  const r = f.releases;
  if (r?.source === "tag" && !r.tag) errs.push("$.features.releases.tag: is required when source is 'tag'.");
  if (r?.testedTag && r.testedTag === r.tag) errs.push("$.features.releases.testedTag: must differ from releases.tag, which marks the published build.");
  const u = f.uiReview;
  if (u && !u.paths.length && !u.addedFiles.length && !u.addedLines.length) errs.push("$.features.uiReview: name at least one of paths, addedFiles or addedLines.");
  u?.addedLines.forEach((x, i) => {
    try {
      new RegExp(x);
    } catch {
      errs.push(`$.features.uiReview.addedLines[${i}]: '${x}' is no regular expression.`);
    }
  });
  const t = f.untrustedReports;
  if (t && !(t.role in raw.options.roles)) errs.push(`$.features.untrustedReports.role: '${t.role}' is no role of the flow.`);
  return errs;
}

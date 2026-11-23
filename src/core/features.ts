// Feature switches of a flow. A preset tags the states, transitions, roles and commands that belong to a feature
// (`meta.features` / `features`: terms that must all hold); loading a workspace prunes what its switched-off
// features tag, so one statechart file (openable in Stately) serves every combination.
import type { Capability } from "../ports/tracker";
import type { Chart, FlowOptions, StateNode, Transition } from "./chart";
import { BUILTIN, list } from "./chart";

export interface PullRequestsFeature {
  /** The ticket's branch; `{n}` is the ticket number. */
  branch: string;
  /** Check names that must be green; empty: every check of the head. */
  checks: string[];
  method: "merge" | "squash" | "rebase";
  /** `flow`: the tester's pass merges; `developer`: the developer merges before the hand-off. */
  merger: "flow" | "developer";
  deleteBranch: boolean;
}

export interface ReleasesFeature {
  /** `release`: the latest published release; `tag`: the commit `tag` points at. */
  source: "release" | "tag";
  tag?: string;
  /** A tag moved forward over main as far as no commit belongs to an untested ticket. */
  testedTag?: string;
  /** Checks a commit needs green before `testedTag` moves onto it. */
  checks: string[];
  /** Commit types never tagged (CI skips their builds). */
  skip: string[];
  /** Test cards wait in `awaiting release` until the release has the ticket's code. */
  hold: boolean;
  /** Test cards say `📦 In <version> or later`. */
  versionLine: boolean;
}

export interface SamplesFeature {
  /** Sample paths must start with this. */
  root: string;
  /** Tickets with this label need no sample. */
  notNeededLabel: string;
}

export interface UiReviewFeature {
  /** Globs: a change under one of them is a UI change. */
  paths: string[];
  /** Globs: an added file under one of them is a UI change. */
  addedFiles: string[];
  /** Regular expressions: an added line matching one is a UI change. */
  addedLines: string[];
  /** Globs never counted. */
  ignore: string[];
}

export interface DependencyTicketsFeature {
  /** Pull request authors whose open pull requests become tickets. */
  authors: string[];
  /** Labels the filed ticket gets besides the initial state's. */
  labels: string[];
}

export interface UntrustedReportsFeature {
  /** The label an outside service puts on untrusted user text. */
  label: string;
  /** The only role that gets such a ticket, in any state, until it is checked. */
  role: string;
}

/** Resolved switches: a feature is on when present. */
export interface Features {
  pullRequests?: PullRequestsFeature;
  releases?: ReleasesFeature;
  samples?: SamplesFeature;
  uiReview?: UiReviewFeature;
  dependencyTickets?: DependencyTicketsFeature;
  untrustedReports?: UntrustedReportsFeature;
}

export type FeatureName = keyof Features;

/** As written in a workspace document: false/absent off, true on with defaults, an object on with options. */
export type FeaturesDoc = { [K in FeatureName]?: boolean | Partial<NonNullable<Features[K]>> };

export const DEFAULTS: { [K in FeatureName]-?: NonNullable<Features[K]> } = {
  pullRequests: { branch: "flowee/{n}", checks: [], method: "merge", merger: "flow", deleteBranch: true },
  releases: { source: "release", checks: [], skip: ["docs", "chore", "test"], hold: true, versionLine: true },
  samples: { root: "", notNeededLabel: "not file related" },
  uiReview: { paths: [], addedFiles: [], addedLines: [], ignore: [] },
  dependencyTickets: { authors: ["dependabot[bot]"], labels: [] },
  untrustedReports: { label: "feedback", role: "board" },
};

export const FEATURES = Object.keys(DEFAULTS) as FeatureName[];

/** The tracker capabilities each feature uses. */
export const NEEDS: Record<FeatureName, Capability[]> = {
  pullRequests: ["branches", "pulls", "checks"],
  releases: ["releases", "tags"],
  samples: ["branches"],
  uiReview: ["branches"],
  dependencyTickets: ["pulls"],
  untrustedReports: [],
};

export function resolve(doc: FeaturesDoc = {}): Features {
  const out: Record<string, unknown> = {};
  for (const k of FEATURES) {
    const v = doc[k];
    if (v) out[k] = { ...DEFAULTS[k], ...(v === true ? {} : v) };
  }
  return out as Features;
}

/** A term: `samples` (on), `!samples` (off), `pullRequests.merger=flow` (on with that option), `releases.hold` (on, option true). */
export function holds(term: string, f: Features): boolean {
  if (term.startsWith("!")) return !holds(term.slice(1), f);
  const [path, want] = term.split("=");
  const [name, key] = path.split(".");
  const on = f[name as FeatureName] as Record<string, unknown> | undefined;
  if (!on) return false;
  if (!key) return true;
  return want === undefined ? !!on[key] : String(on[key]) === want;
}

const all = (terms: unknown, f: Features) => list(terms as string | string[] | undefined).every((t) => holds(t, f));
const metaOf = (x: { meta?: unknown }) => (x.meta ?? {}) as { features?: string | string[] };

/** Feature names a chart and its options tag. */
export function featuresOf(chart: Chart, options: FlowOptions): Set<string> {
  const out = new Set<string>();
  const add = (terms: unknown) => list(terms as string | string[] | undefined).forEach((t) => out.add(t.replace(/^!/, "").split(/[.=]/)[0]));
  for (const s of Object.values(chart.states ?? {})) {
    add(metaOf(s).features);
    for (const raw of Object.values(s.on ?? {})) for (const t of list(raw)) if (typeof t !== "string") add(metaOf(t).features);
  }
  for (const x of [...Object.values(options.roles ?? {}), ...Object.values(options.commands ?? {}), ...(options.ticks ?? [])]) add((x as { features?: unknown }).features);
  return out;
}

/** The chart and options with everything a switched-off feature tags removed. */
export function prune(chart: Chart, options: FlowOptions, f: Features): { chart: Chart; options: FlowOptions } {
  const states: Record<string, StateNode> = {};
  const events = new Set<string>();
  for (const [name, s] of Object.entries(chart.states ?? {})) {
    if (!all(metaOf(s).features, f)) continue;
    const on: Record<string, Transition[]> = {};
    for (const [ev, raw] of Object.entries(s.on ?? {})) {
      const ts = list(raw)
        .map((t) => (typeof t === "string" ? { target: t } : t))
        .filter((t) => all(metaOf(t).features, f));
      if (ts.length) {
        on[ev] = ts;
        events.add(ev);
      }
    }
    states[name] = { ...s, on };
  }
  const roles = Object.fromEntries(Object.entries(options.roles ?? {}).filter(([, r]) => all(r.features, f)));
  const keep = (rs: string[]) => rs.filter((r) => r in roles);
  const commands = Object.fromEntries(
    Object.entries(options.commands ?? {})
      .filter(([c, o]) => all(o.features, f) && (o.read || (BUILTIN as readonly string[]).includes(c) || events.has(c)))
      .map(([c, o]) => [c, { ...o, roles: keep(o.roles ?? []) }]),
  );
  return {
    chart: { ...chart, states },
    options: {
      ...options,
      roles,
      commands,
      inboxRoles: keep(options.inboxRoles ?? []),
      ticks: (options.ticks ?? []).filter((t) => all(t.features, f) && events.has(t.event)),
    },
  };
}

/** `*` any characters but `/`, `**` any path (also empty), `?` one character. */
export function glob(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "*" && pattern[i + 1] === "*") {
      re += pattern[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += pattern[i + 2] === "/" ? 2 : 1;
    } else if (ch === "*") re += "[^/]*";
    else if (ch === "?") re += "[^/]";
    else re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

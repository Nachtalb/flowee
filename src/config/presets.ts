import flowChart from "../../flows/flow.json";
import flowOptions from "../../flows/flow.options.json";
import samples from "../../flows/extensions/samples.json";
import { ACTIONS } from "../core/actions";
import type { Chart, FlowOptions } from "../core/chart";
import { type Extension, extend } from "../core/extend";
import { type FeaturesDoc, prune, resolve, type SamplesOptions } from "../core/features";
import { GUARDS } from "../core/guards";

/** The one statechart: every part beyond the base is tagged with the switch that keeps it (docs/flows.md). */
export const FLOW = { chart: flowChart as unknown as Chart, options: flowOptions as unknown as FlowOptions };

/** Extensions shipped with Flowee, named `builtin:<name>` in a document (flows/extensions/). */
export const BUILTIN: Record<string, Extension> = { samples: samples as unknown as Extension };

/** An extension in a workspace document: inline, or a shipped one by name. */
export type ExtensionRef = Extension | `builtin:${string}`;

/**
 * Named starting points. Both load the one chart; `start` is the switches a new document starts with (the wizard,
 * the configure skill). A document's own `features` are always its switches, so a document written before keeps
 * its meaning: a preset name never switches anything on by itself.
 */
export const PRESETS: Record<string, { chart: Chart; options: FlowOptions; start: FeaturesDoc }> = {
  trunk: { ...FLOW, start: {} },
  "pr-release": { ...FLOW, start: { pullRequests: true, releases: true } },
};

type FlowDoc = { flow: { preset: string } | { chart: Chart; options: FlowOptions }; features?: FeaturesDoc; extensions?: ExtensionRef[] };

/**
 * The extensions a document names, shipped ones resolved, with the compatibility mapping: the former
 * `features.samples` is `builtin:samples` with its `root` and `notNeededLabel` (docs/flows.md, "Extending the flow").
 */
export function extensionsOf(d: FlowDoc): Extension[] {
  // an unknown shipped name is the validator's to report; it adds nothing
  const out = (d.extensions ?? []).flatMap((e) => (typeof e === "string" ? (BUILTIN[e.replace(/^builtin:/, "")] ?? []) : [e]));
  const s = d.features?.samples;
  // an inline chart reads `samples` as a switch of its own tags; a preset gets the extension
  if (s && "preset" in d.flow && !out.some((e) => e.name === "samples")) out.push(samplesWith(s === true ? {} : s));
  return out;
}

/** The shipped samples extension with the options of the former switch in its pathsExist guards. */
export function samplesWith(o: Partial<SamplesOptions>): Extension {
  const json = JSON.stringify(BUILTIN.samples, (k, v) => {
    if (v && typeof v === "object" && (v as { type?: string }).type === "pathsExist")
      return { ...v, params: { ...v.params, ...(o.root !== undefined ? { root: o.root } : {}), ...(o.notNeededLabel !== undefined ? { unlessLabel: o.notNeededLabel } : {}) } };
    return v;
  });
  return JSON.parse(json) as Extension;
}

/** The workspace's flow as written: a preset or its inline chart, with its extensions merged, before pruning. */
export function rawFlow(d: FlowDoc): { chart: Chart; options: FlowOptions; problems: string[] } {
  const f = "preset" in d.flow ? PRESETS[d.flow.preset] : d.flow;
  const exts = extensionsOf(d);
  if (!exts.length) return { chart: f.chart, options: f.options, problems: [] };
  const { chart, options, problems } = extend(f.chart, f.options, exts, Object.keys(GUARDS), Object.keys(ACTIONS));
  return { chart, options, problems };
}

/** The workspace's flow: the merged chart with the states, transitions, roles and commands of switched-off features removed. */
export const flowOf = (d: FlowDoc) => {
  const f = rawFlow(d);
  return prune(f.chart, f.options, resolve(d.features));
};

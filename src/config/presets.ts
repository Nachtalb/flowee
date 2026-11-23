import flowChart from "../../flows/flow.json";
import flowOptions from "../../flows/flow.options.json";
import type { Chart, FlowOptions } from "../core/chart";
import { type FeaturesDoc, prune, resolve } from "../core/features";

/** The one statechart: every part beyond the base is tagged with the switch that keeps it (docs/flows.md). */
export const FLOW = { chart: flowChart as unknown as Chart, options: flowOptions as unknown as FlowOptions };

/**
 * Named starting points. Both load the one chart; `start` is the switches a new document starts with (the wizard,
 * the configure skill). A document's own `features` are always its switches, so a document written before keeps
 * its meaning: a preset name never switches anything on by itself.
 */
export const PRESETS: Record<string, { chart: Chart; options: FlowOptions; start: FeaturesDoc }> = {
  trunk: { ...FLOW, start: {} },
  "pr-release": { ...FLOW, start: { pullRequests: true, releases: true } },
};

type FlowDoc = { flow: { preset: string } | { chart: Chart; options: FlowOptions }; features?: FeaturesDoc };

/** The workspace's flow as written: a preset or its inline chart, before pruning. */
export const rawFlow = (d: FlowDoc) => ("preset" in d.flow ? PRESETS[d.flow.preset] : d.flow);

/** The workspace's flow: the chart with the states, transitions, roles and commands of switched-off features removed. */
export const flowOf = (d: FlowDoc) => {
  const f = rawFlow(d);
  return prune(f.chart, f.options, resolve(d.features));
};

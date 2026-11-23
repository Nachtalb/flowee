import trunkChart from "../../flows/trunk.json";
import trunkOptions from "../../flows/trunk.options.json";
import prChart from "../../flows/pr-release.json";
import prOptions from "../../flows/pr-release.options.json";
import type { Chart, FlowOptions } from "../core/chart";
import { type FeaturesDoc, prune, resolve } from "../core/features";

/** Flow presets by name: a statechart plus its options. */
export const PRESETS: Record<string, { chart: Chart; options: FlowOptions }> = {
  trunk: { chart: trunkChart as unknown as Chart, options: trunkOptions as unknown as FlowOptions },
  "pr-release": { chart: prChart as unknown as Chart, options: prOptions as unknown as FlowOptions },
};

type FlowDoc = { flow: { preset: string } | { chart: Chart; options: FlowOptions }; features?: FeaturesDoc };

/** The workspace's flow as written: a preset or its inline chart, before pruning. */
export const rawFlow = (d: FlowDoc) => ("preset" in d.flow ? PRESETS[d.flow.preset] : d.flow);

/** The workspace's flow: the chart with the states, transitions, roles and commands of switched-off features removed. */
export const flowOf = (d: FlowDoc) => {
  const f = rawFlow(d);
  return prune(f.chart, f.options, resolve(d.features));
};

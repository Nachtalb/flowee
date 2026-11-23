import trunkChart from "../../flows/trunk.json";
import trunkOptions from "../../flows/trunk.options.json";
import type { Chart, FlowOptions } from "../core/chart";

/** Flow presets by name: a statechart plus its options. */
export const PRESETS: Record<string, { chart: Chart; options: FlowOptions }> = {
  trunk: { chart: trunkChart as unknown as Chart, options: trunkOptions as unknown as FlowOptions },
};

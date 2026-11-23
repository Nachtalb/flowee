// The setup wizard's statechart (setup.json, XState v5 JSON like flows/flow.json) and the few functions that run it:
// the transitions of an event in a state, the first one whose guard holds, and the path ahead of a screen. The
// wizard (wizard.ts) reads the input into the draft, then asks the chart where to go; no screen decides that itself.
import { list, type Ref, type Transition } from "../core/chart";
import chart from "./setup.json";

export interface SetupNode {
  description?: string;
  type?: "final";
  entry?: Ref | Ref[];
  /** `step`: counted in "Step n of N"; `typed` / `files`: the event a typed message / a sent file raises here. */
  meta?: { step?: boolean; typed?: string; files?: string };
  on?: Record<string, Transition | Transition[]>;
}

export const SETUP = chart as unknown as { id: string; initial: string; description: string; on: Record<string, Transition | Transition[]>; states: Record<string, SetupNode> };
export type State = keyof typeof chart.states;
export const STATES = Object.keys(SETUP.states) as State[];
/** The guards the chart may name (wizard.ts implements them). */
export const GUARDS = ["editing", "hasHistory", "ownBot", "inGroup", "tooWide", "is"] as const;
/** The actions the chart may name. */
export const ACTIONS = ["back", "restore", "commit"] as const;

/** The transitions of `event` in `state`: the state's own, else the chart's root ones (Back, Cancel, expiry). */
export function transitions(state: string, event: string): Transition[] {
  return list(SETUP.states[state]?.on?.[event] ?? SETUP.on[event]).map((t) => (typeof t === "string" ? { target: t } : t));
}

/** The first transition of `event` whose guard holds, or none. */
export function pick(state: string, event: string, holds: (g: Ref) => boolean): Transition | undefined {
  return transitions(state, event).find((t) => !t.guard || holds(t.guard));
}

/** A transition's target as a state name (`.cancelled` on the root is the state `cancelled`). */
export const targetOf = (t: Transition | undefined) => t?.target?.replace(/^\./, "") as State | undefined;

export const counted = (state: string) => !!SETUP.states[state]?.meta?.step;

/** The screen `next` leads to from `state` for this draft, past the skipped screens; none at the end. */
export function ahead(state: string, holds: (g: Ref) => boolean, skip: readonly string[] = []): State | undefined {
  let x: State | undefined = targetOf(pick(state, "next", holds));
  for (let i = 0; x && skip.includes(x) && i < STATES.length; i++) x = targetOf(pick(x, "next", holds));
  return x;
}

/** The counted screens of the path: the ones behind (history), this one, and those `next` leads to from here. */
export function pathOf(state: string, history: readonly string[], holds: (g: Ref) => boolean, skip: readonly string[] = []): string[] {
  const path = [...history.filter(counted), state];
  for (let x = ahead(state, holds, skip); x && counted(x) && path.length < STATES.length; x = ahead(x, holds, skip)) path.push(x);
  return path;
}

/** The chart as a mermaid state diagram (docs/managed.md; `bun scripts/setup-chart.ts` writes it there). */
export function mermaid(): string {
  const guard = (g: Ref) => (typeof g === "string" ? g : `${g.type}(${Object.values(g.params ?? {}).join(", ")})`);
  const lines = ["stateDiagram-v2", `  [*] --> ${SETUP.initial}`];
  for (const [s, node] of Object.entries(SETUP.states)) {
    if (node.type === "final") lines.push(`  ${s} --> [*]`);
    for (const [ev, raw] of Object.entries(node.on ?? {}))
      for (const t of list(raw)) {
        const to = targetOf(t);
        const acts = list(t.actions).map((a) => (typeof a === "string" ? a : a.type));
        if (to) lines.push(`  ${s} --> ${to}: ${ev}${t.guard ? ` [${guard(t.guard)}]` : ""}`);
        else if (acts.length) lines.push(`  ${s} --> ${s}: ${ev} / ${acts.join(", ")}`);
      }
  }
  return `${lines.join("\n")}\n`;
}

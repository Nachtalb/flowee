// The flow file: an XState v5 statechart (JSON) plus options. Loading validates both and reports every problem
// as one sentence naming the state, event or option.
import { Fail } from "./errors";

export type Ref = string | { type: string; params?: Record<string, unknown> };

export interface Transition {
  target?: string;
  guard?: Ref;
  actions?: Ref | Ref[];
  description?: string;
  meta?: Record<string, unknown>;
}

export interface Claimable {
  role: string;
  /** Queue position of this state among the role's states (lower first). */
  rank: number;
  /** `number`: lowest ticket first; `handover`: oldest recorded origin (else last update) first. */
  sort?: "number" | "handover";
  /** A selector guard a ticket must pass to be handed out (e.g. dependenciesClosed). */
  when?: Ref;
}

export interface StateMeta {
  /** The tracker label of the state; none for the closed state. */
  label?: string;
  /** The project board column. */
  status?: string;
  /** The role whose claim holds a ticket here (`next` resumes it). */
  holder?: string;
  claimable?: Claimable;
  /** The owner is assigned while a ticket is here. */
  assignOwner?: boolean;
  /** The ticket is closed in the tracker. */
  closed?: boolean;
  /** The owner's inbox: tickets here are cards in the chat. */
  inbox?: boolean;
  /** Parked tickets the owner can list and answer. */
  parked?: boolean;
  /** The recorded origin (who handed it over, from where) is shown here. */
  review?: boolean;
  /** A ticket here is not tested yet: the tested tag stops before its commits (feature releases). */
  untested?: boolean;
  /** Feature terms that must hold for the state to exist (docs/flows.md, "Features"). */
  features?: string | string[];
}

export interface StateNode {
  description?: string;
  meta?: StateMeta;
  on?: Record<string, string | Transition | Transition[]>;
  entry?: Ref | Ref[];
  exit?: Ref | Ref[];
}

export interface Chart {
  id: string;
  initial: string;
  description?: string;
  states: Record<string, StateNode>;
}

export type InputRule =
  | "required"
  | "optional"
  | "card"
  | "sha"
  | "gates"
  | "flag"
  | "text"
  | "body"
  | "title"
  | "paths"
  | { required: string[] };

export interface CommandOptions {
  roles: string[];
  /** GET endpoint without a body (whoami, queue, show). */
  read?: boolean;
  /** Fields of the JSON body, checked in this order after `n`. */
  input?: Record<string, InputRule>;
  /** The response carries the ticket's state (default true). */
  state?: boolean;
  /** Feature terms that must hold for the command to exist (docs/flows.md, "Features"). */
  features?: string | string[];
}

export interface FlowOptions {
  roles: Record<string, { sign: string; who: string; features?: string | string[] }>;
  /** Every API command: who may call it and what its body holds. Commands that are chart events need `n`. */
  commands: Record<string, CommandOptions>;
  /** Hours a claim lives without a heartbeat. */
  leaseHours: number;
  /** The event the lease reaper fires on an expired claim, as `reaperRole`. */
  reaper: { event: string; role: string };
  /** Roles whose `queue` also lists the inbox. */
  inboxRoles: string[];
  /** A ticket's commits: their subject ends with this (`{n}` = the ticket). */
  commitSuffix: string;
  /** The role that files tickets from the chat and answers there. */
  ownerRole: string;
  /** Events the cron fires as `role` on every open ticket whose state has them (e.g. `released`). */
  ticks?: { event: string; role: string; features?: string | string[] }[];
}

/** Commands handled by the service itself rather than a chart event. */
export const BUILTIN = ["whoami", "queue", "show", "next", "file"] as const;

export interface Flow {
  chart: Chart;
  options: FlowOptions;
  states: string[];
  /** The state a ticket with no state label is in. */
  initial: string;
  closed: string;
  meta(state: string): StateMeta;
  transitions(state: string, event: string): Transition[];
}

export const list = <X>(x: X | X[] | undefined): X[] => (x === undefined ? [] : Array.isArray(x) ? x : [x]);
export const refName = (r: Ref) => (typeof r === "string" ? r : r.type);
export const refParams = (r: Ref) => (typeof r === "string" ? {} : (r.params ?? {}));

/** Every guard name used in a guard tree (the `all` combinator nests). */
export function guardNames(g: Ref | undefined): string[] {
  if (!g) return [];
  const p = refParams(g) as { guards?: Ref[] };
  return [refName(g), ...(refName(g) === "all" ? (p.guards ?? []).flatMap(guardNames) : [])];
}

const INPUTS = ["required", "optional", "card", "sha", "gates", "flag", "text", "body", "title", "paths"];

/**
 * Loads and validates a flow. `guards`/`actions` are the names the registries know. Throws a Fail(400,
 * "bad_flow") whose message lists every problem, one sentence each.
 */
export function loadFlow(chart: Chart, options: FlowOptions, guards: string[], actions: string[]): Flow {
  const errs: string[] = [];
  const states = Object.keys(chart.states ?? {});
  if (!chart.id) errs.push("The chart has no id.");
  if (!states.includes(chart.initial)) errs.push(`The initial state '${chart.initial}' does not exist.`);
  const closed = states.filter((s) => chart.states[s].meta?.closed);
  if (closed.length !== 1) errs.push(`Exactly one state must have meta.closed (found ${closed.length}).`);
  const roles = Object.keys(options.roles ?? {});
  const events = new Set<string>();
  const labels = new Map<string, string>();
  const reach = new Set<string>([chart.initial]);
  for (const s of states) {
    const node = chart.states[s];
    const m = node.meta ?? {};
    if (m.label) {
      if (labels.has(m.label)) errs.push(`State '${s}' reuses the label '${m.label}' of '${labels.get(m.label)}'.`);
      labels.set(m.label, s);
    } else if (!m.closed) errs.push(`State '${s}' has no meta.label.`);
    for (const r of [m.holder, m.claimable?.role]) if (r && !roles.includes(r)) errs.push(`State '${s}' names the unknown role '${r}'.`);
    if (m.claimable?.when) for (const g of guardNames(m.claimable.when)) if (!guards.includes(g)) errs.push(`State '${s}': unknown guard '${g}' in meta.claimable.when.`);
    for (const a of [...list(node.entry), ...list(node.exit)])
      if (!actions.includes(refName(a))) errs.push(`State '${s}': unknown action '${refName(a)}'.`);
    for (const [ev, raw] of Object.entries(node.on ?? {})) {
      events.add(ev);
      for (const t of list(raw)) {
        const tr: Transition = typeof t === "string" ? { target: t } : t;
        if (tr.target !== undefined) {
          if (!states.includes(tr.target)) errs.push(`State '${s}', event '${ev}': the target '${tr.target}' does not exist.`);
          else reach.add(tr.target);
        }
        for (const g of guardNames(tr.guard)) if (!guards.includes(g)) errs.push(`State '${s}', event '${ev}': unknown guard '${g}'.`);
        for (const a of list(tr.actions)) if (!actions.includes(refName(a))) errs.push(`State '${s}', event '${ev}': unknown action '${refName(a)}'.`);
        const rp = (tr.guard ? collectRoles(tr.guard) : []).filter((r) => !roles.includes(r));
        for (const r of rp) errs.push(`State '${s}', event '${ev}': roleIs names the unknown role '${r}'.`);
      }
    }
  }
  for (const s of states) if (!reach.has(s)) errs.push(`State '${s}' is unreachable: no transition leads to it.`);
  const cmds = options.commands ?? {};
  for (const ev of events)
    if (ev !== options.reaper?.event && !(options.ticks ?? []).some((t) => t.event === ev) && !cmds[ev]) errs.push(`Event '${ev}' has no entry in options.commands.`);
  for (const [c, o] of Object.entries(cmds)) {
    for (const r of o.roles ?? []) if (!roles.includes(r)) errs.push(`Command '${c}' names the unknown role '${r}'.`);
    if (!o.read && !(BUILTIN as readonly string[]).includes(c) && !events.has(c)) errs.push(`Command '${c}' is no event of the chart.`);
    for (const [f, rule] of Object.entries(o.input ?? {}))
      if (typeof rule === "string" ? !INPUTS.includes(rule) : !Array.isArray(rule.required))
        errs.push(`Command '${c}', field '${f}': unknown input rule ${JSON.stringify(rule)}.`);
  }
  for (const r of [options.reaper?.role, options.ownerRole, ...(options.inboxRoles ?? []), ...(options.ticks ?? []).map((t) => t.role)])
    if (r && !roles.includes(r)) errs.push(`The options name the unknown role '${r}'.`);
  if (!(options.leaseHours > 0)) errs.push("options.leaseHours must be a positive number.");
  if (!options.commitSuffix?.includes("{n}")) errs.push("options.commitSuffix must contain {n}.");
  if (errs.length) throw new Fail(400, "bad_flow", errs.join(" "));
  return {
    chart,
    options,
    states,
    initial: chart.initial,
    closed: closed[0],
    meta: (s) => chart.states[s]?.meta ?? {},
    transitions: (s, ev) => list(chart.states[s]?.on?.[ev]).map((t) => (typeof t === "string" ? { target: t } : t)),
  };
}

/** Roles a guard tree is limited to by `roleIs` (empty: any role). */
export function collectRoles(g: Ref): string[] {
  if (refName(g) === "roleIs") return (refParams(g).roles as string[]) ?? [];
  if (refName(g) === "all") return ((refParams(g).guards as Ref[]) ?? []).flatMap(collectRoles);
  return [];
}

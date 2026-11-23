// Flow extensions: small documents in the chart's own vocabulary that add to the one chart (new states, transitions,
// roles, commands, ticks, card kinds) or replace or remove a named base transition, never silently. Merged at load
// into one chart, each problem one sentence starting with the extension's JSON path (docs/flows.md, "Extending").
import { type Chart, type CommandOptions, type FlowOptions, guardNames, type InputRule, list, refName, type StateNode, type Transition } from "./chart";

type Ts = Transition | string | (Transition | string)[];

export interface Extension {
  /** Lower-case letters, digits and dashes; unique in a workspace. */
  name: string;
  description?: string;
  /** New states (with their `meta`: label, status, holder, claimable). */
  states?: Record<string, StateNode>;
  /** Transitions added after the base's, per state and event. */
  on?: Record<string, Record<string, Ts>>;
  /** Transitions that replace all of the base's for that state and event. */
  replace?: Record<string, Record<string, Ts>>;
  /** Events taken off a state. */
  remove?: Record<string, string[]>;
  /** New roles: their comment signature and how the texts name them. */
  roles?: FlowOptions["roles"];
  /** Existing commands opened to more roles. */
  grant?: Record<string, string[]>;
  /** Body fields of existing commands, added or replaced. */
  inputs?: Record<string, Record<string, InputRule>>;
  /** New commands (a new event needs one, unless a tick fires it). */
  commands?: Record<string, CommandOptions>;
  /** Events the cron fires on every open ticket whose state has them. */
  ticks?: NonNullable<FlowOptions["ticks"]>;
  /** Owner card kinds beyond test, question and decision. */
  cards?: string[];
}

/** Card kinds an extension may switch on: the envoy renders these (docs/envoy.md). */
export const CARD_KINDS = ["sample"];

const KEYS = ["name", "description", "states", "on", "replace", "remove", "roles", "grant", "inputs", "commands", "ticks", "cards"];
const q = (k: string) => (/^[A-Za-z_][\w]*$/.test(k) ? `.${k}` : `['${k}']`);

/**
 * The chart and options with the extensions merged in order. `path(i)` is the JSON path of extension i (in a workspace
 * document `$.extensions[i]`). Problems name the extension and the path; the merged flow still needs `loadFlow`.
 */
export function extend(chart: Chart, options: FlowOptions, exts: Extension[], guards: string[], actions: string[], path = (i: number) => `$.extensions[${i}]`) {
  const out: string[] = [];
  const c: Chart = structuredClone(chart);
  const o: FlowOptions = structuredClone(options);
  const base = new Set(Object.keys(c.states));
  const added = new Map<string, number>();
  const replaced = new Map<string, number>();
  const by = (i: number) => `extension '${exts[i]?.name}'`;
  const known = (p: string, i: number, t: Transition | string) => {
    if (typeof t === "string") return;
    for (const g of guardNames(t.guard)) if (!guards.includes(g)) out.push(`${p}.guard: ${by(i)} names the unknown guard '${g}'; the guards are listed in docs/flows.md.`);
    for (const a of list(t.actions)) if (!actions.includes(refName(a))) out.push(`${p}.actions: ${by(i)} names the unknown action '${refName(a)}'; the actions are listed in docs/flows.md.`);
  };
  const walk = (p: string, i: number, ts: Ts) => list(ts as Transition | Transition[]).forEach((t, k) => known(`${p}[${k}]`, i, t));
  // first every extension's states, so transitions may lead into another extension's
  exts.forEach((e, i) => {
    const p = path(i);
    if (!e || typeof e !== "object" || typeof e.name !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(e.name)) {
      out.push(`${p}.name: an extension needs a name of lower-case letters, digits and dashes.`);
      return;
    }
    if (exts.findIndex((x) => x?.name === e.name) < i) out.push(`${p}.name: the extension '${e.name}' is listed twice.`);
    for (const k of Object.keys(e)) if (!KEYS.includes(k)) out.push(`${p}.${k}: ${by(i)} has the unknown part '${k}'; an extension has ${KEYS.join(", ")}.`);
    for (const [s, node] of Object.entries(e.states ?? {})) {
      const sp = `${p}.states${q(s)}`;
      if (base.has(s)) out.push(`${sp}: ${by(i)} adds the state '${s}', which the flow has already; change a state with on, replace or remove.`);
      else if (added.has(s)) out.push(`${sp}: ${by(i)} adds the state '${s}', which ${by(added.get(s) as number)} adds too.`);
      else {
        added.set(s, i);
        c.states[s] = structuredClone(node);
        for (const a of [...list(node.entry), ...list(node.exit)]) if (!actions.includes(refName(a))) out.push(`${sp}: ${by(i)} names the unknown action '${refName(a)}'.`);
        for (const [ev, ts] of Object.entries(node.on ?? {})) walk(`${sp}.on${q(ev)}`, i, ts);
      }
    }
  });
  exts.forEach((e, i) => {
    if (!e || typeof e.name !== "string") return;
    const p = path(i);
    const state = (sp: string, s: string) => {
      if (c.states[s]) return c.states[s];
      out.push(`${sp}: ${by(i)} changes the state '${s}', which the flow does not have.`);
      return undefined;
    };
    for (const [s, evs] of Object.entries(e.replace ?? {}))
      for (const [ev, ts] of Object.entries(evs)) {
        const sp = `${p}.replace${q(s)}${q(ev)}`;
        const node = state(`${p}.replace${q(s)}`, s);
        if (!node) continue;
        if (!(base.has(s) && chart.states[s].on?.[ev])) {
          out.push(`${sp}: ${by(i)} replaces '${ev}' on '${s}', which the base flow does not have; add it with on instead.`);
          continue;
        }
        const key = `${s}\u0000${ev}`;
        if (replaced.has(key)) {
          out.push(`${sp}: ${by(i)} and ${by(replaced.get(key) as number)} both replace '${ev}' on '${s}'; only one extension may.`);
          continue;
        }
        replaced.set(key, i);
        walk(sp, i, ts);
        node.on = { ...(node.on ?? {}), [ev]: structuredClone(ts) as Transition[] };
      }
    for (const [s, evs] of Object.entries(e.remove ?? {})) {
      const node = state(`${p}.remove${q(s)}`, s);
      for (const ev of node ? evs : []) {
        const key = `${s}\u0000${ev}`;
        if (!node?.on?.[ev]) out.push(`${p}.remove${q(s)}: ${by(i)} removes '${ev}' from '${s}', which has no such event.`);
        else if (replaced.has(key) && replaced.get(key) !== i) out.push(`${p}.remove${q(s)}: ${by(i)} removes '${ev}' from '${s}', which ${by(replaced.get(key) as number)} replaces.`);
        else {
          replaced.set(key, i);
          delete node.on[ev];
        }
      }
    }
    for (const [s, evs] of Object.entries(e.on ?? {}))
      for (const [ev, ts] of Object.entries(evs)) {
        const node = state(`${p}.on${q(s)}`, s);
        if (!node) continue;
        walk(`${p}.on${q(s)}${q(ev)}`, i, ts);
        node.on = { ...(node.on ?? {}), [ev]: [...list(node.on?.[ev] as Transition[] | undefined), ...(structuredClone(list(ts as Transition[])) as Transition[])] };
      }
    for (const [r, v] of Object.entries(e.roles ?? {})) {
      if (o.roles[r]) out.push(`${p}.roles${q(r)}: ${by(i)} adds the role '${r}', which the flow has already.`);
      else o.roles[r] = structuredClone(v);
    }
    for (const [k, v] of Object.entries(e.commands ?? {})) {
      if (o.commands[k]) out.push(`${p}.commands${q(k)}: ${by(i)} adds the command '${k}', which the flow has already; open it to a role with grant.`);
      else o.commands[k] = structuredClone(v);
    }
    o.ticks = [...(o.ticks ?? []), ...structuredClone(e.ticks ?? [])];
    for (const k of e.cards ?? []) if (!CARD_KINDS.includes(k)) out.push(`${p}.cards: ${by(i)} names the card kind '${k}'; the kinds an extension may add are ${CARD_KINDS.join(", ")}.`);
    o.cards = [...new Set([...(o.cards ?? []), ...(e.cards ?? [])])];
  });
  // grants and inputs once every extension's roles and commands are in
  exts.forEach((e, i) => {
    if (!e || typeof e.name !== "string") return;
    const p = path(i);
    for (const [k, roles] of Object.entries(e.grant ?? {})) {
      const cmd = o.commands[k];
      if (!cmd) out.push(`${p}.grant${q(k)}: ${by(i)} opens the command '${k}', which the flow does not have.`);
      for (const r of roles) if (!o.roles[r]) out.push(`${p}.grant${q(k)}: ${by(i)} names the unknown role '${r}'.`);
      if (cmd) cmd.roles = [...new Set([...cmd.roles, ...roles])];
    }
    for (const [k, fields] of Object.entries(e.inputs ?? {})) {
      const cmd = o.commands[k];
      if (!cmd) out.push(`${p}.inputs${q(k)}: ${by(i)} gives fields to the command '${k}', which the flow does not have.`);
      else cmd.input = { ...(cmd.input ?? {}), ...structuredClone(fields) };
    }
  });
  return { chart: c, options: o, problems: out, origin: added };
}

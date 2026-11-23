// Interprets a chart: picks the first enabled transition of an event in the ticket's state and runs its actions.
// Guards are selectors (false: try the next transition) or checks (throw a Fail: the command is refused).
import { ACTIONS } from "./actions";
import { type Flow, guardNames, list, refName, refParams, type Ref, type Transition } from "./chart";
import { Fail } from "./errors";
import { GUARDS } from "./guards";
import type { Flowee, Ticket } from "./service";
import { or } from "./text";

export interface Caller {
  instance: string;
  role: string;
}

export interface Ctx {
  f: Flowee;
  t: Ticket;
  caller: Caller;
  event: string;
  /** The checked body fields. */
  input: Record<string, unknown>;
  from: string;
  to: string;
  /** Scratch space guards fill for actions (fresh commits, the card …). */
  data: Record<string, unknown>;
  /** Extra response fields. */
  out: Record<string, unknown>;
  /** Open ticket numbers, when known (queue). */
  open?: Set<number>;
}

export type Params = Record<string, unknown>;

export interface Guard {
  kind: "selector" | "check";
  /** Appended to the state's name in a wrong_state message when this guard limits the state. */
  note?: string;
  run(c: Ctx, p: Params): boolean | Promise<boolean>;
}

export type Action = (c: Ctx, p: Params) => unknown;

export async function check(g: Ref, c: Ctx): Promise<boolean> {
  const guard = GUARDS[refName(g)];
  if (!guard) throw new Fail(500, "bad_flow", `Unknown guard '${refName(g)}'.`);
  return guard.run(c, refParams(g));
}

export async function act(a: Ref, c: Ctx) {
  const action = ACTIONS[refName(a)];
  if (!action) throw new Fail(500, "bad_flow", `Unknown action '${refName(a)}'.`);
  await action(c, refParams(a));
}

/** The transition `event` takes for this context, or null when none is enabled. */
export async function pick(flow: Flow, c: Ctx): Promise<Transition | null> {
  for (const tr of flow.transitions(c.from, c.event)) if (!tr.guard || (await check(tr.guard, c))) return tr;
  return null;
}

/**
 * Runs `event` on the ticket. Order: guards, transition actions, then (on a state change) the source's exit and
 * the target's entry actions and the record of when the ticket entered its state. Unlike XState, exit actions run
 * after the transition's, so a tracker write that fails leaves the stored state as it was.
 */
export async function fire(c: Ctx): Promise<void> {
  const flow = c.f.flow;
  // taken before the actions: an answer recorded by this very transition counts as given after the entry
  const at = c.f.clock.now();
  const tr = await pick(flow, c);
  if (!tr) throw wrongState(flow, c);
  c.to = tr.target ?? c.from;
  for (const a of list(tr.actions)) await act(a, c);
  if (c.to !== c.from) {
    for (const a of list(flow.chart.states[c.from].exit)) await act(a, c);
    c.f.entered(c.t.n, c.to, at);
    for (const a of list(flow.chart.states[c.to].entry)) await act(a, c);
  }
  c.t.state = c.to;
}

/** 409 wrong_state naming the states the caller's role could use the event in. */
export function wrongState(flow: Flow, c: Ctx): Fail {
  return new Fail(409, "wrong_state", `${c.f.label(c.t.n)} is '${c.from}'; ${c.event} needs ${or(from(flow, c.event, c.caller.role))}.`);
}

export function from(flow: Flow, event: string, role: string): string[] {
  const plain: string[] = [];
  const noted: string[] = [];
  for (const s of flow.states) {
    const trs = flow.transitions(s, event).filter((t) => {
      const roles = t.guard ? rolesOf(t.guard) : null;
      return !roles || roles.includes(role);
    });
    if (!trs.length) continue;
    const notes = trs.map((t) => guardNames(t.guard).map((g) => GUARDS[g]?.note).find(Boolean));
    const note = notes.every(Boolean) ? notes[0] : undefined;
    if (note) noted.push(`'${s}${note}'`);
    else plain.push(`'${s}'`);
  }
  return [...plain, ...noted];
}

function rolesOf(g: Ref): string[] | null {
  if (refName(g) === "roleIs") return refParams(g).roles as string[];
  if (refName(g) === "all") {
    for (const x of (refParams(g).guards as Ref[]) ?? []) {
      const r = rolesOf(x);
      if (r) return r;
    }
  }
  return null;
}

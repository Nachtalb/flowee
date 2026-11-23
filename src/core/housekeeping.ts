// What the scheduled work does for the flow's features besides the reaper: dependency tickets, the tested tag, the
// chart's ticks (docs/flows.md, "Features"), for the repositories whose listing was due (all of them when polled).
import type { Issue } from "../ports/tracker";
import { fileDependencyTickets, moveTestedTag } from "./code";
import { fire, pick } from "./engine";
import { type Repo, SLOT } from "./repos";
import type { Flowee } from "./service";

export async function housekeeping(f: Flowee, repos: Repo[] = f.tracker.list) {
  await fileDependencyTickets(f, repos).catch((e) => console.error("dependency tickets", e));
  await moveTestedTag(f, repos).catch((e) => console.error("tested tag", e));
  if (!f.flow.options.ticks?.length) return;
  const slots = new Set(repos.map((r) => r.slot));
  for (const i of await f.events.openIssues()) if (slots.has(Math.floor(i.n / SLOT))) await tickTicket(f, i);
}

/** The chart's ticks on one open ticket whose state has them. */
export async function tickTicket(f: Flowee, i: Issue) {
  for (const t of f.flow.options.ticks ?? []) {
    const state = f.stateOrNull(i);
    if (!state || !f.flow.transitions(state, t.event).length) continue;
    try {
      const x = f.ctx({ instance: t.role, role: t.role }, { n: i.n, issue: i, state }, t.event);
      if (!(await pick(f.flow, x))) continue;
      await fire(x);
      await f.events.reread(i.n);
      return;
    } catch (e) {
      console.error("tick", t.event, i.n, e);
    }
  }
}

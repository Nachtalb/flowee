// What the cron does for the flow's features besides the reaper: the chart's ticks (docs/flows.md, "Features").
import { fire, pick } from "./engine";
import type { Flowee } from "./service";

export async function housekeeping(f: Flowee) {
  const ticks = f.flow.options.ticks ?? [];
  if (!ticks.length) return;
  const issues = await f.tracker.openIssues();
  for (const t of ticks)
    for (const i of issues) {
      const state = f.stateOrNull(i);
      if (!state || !f.flow.transitions(state, t.event).length) continue;
      try {
        const x = f.ctx({ instance: t.role, role: t.role }, { n: i.n, issue: i, state }, t.event);
        if (await pick(f.flow, x)) await fire(x);
      } catch (e) {
        console.error("tick", t.event, i.n, e);
      }
    }
}

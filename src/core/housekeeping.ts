// What the cron does for the flow's features besides the reaper: dependency tickets, the tested tag, the chart's
// ticks (docs/flows.md, "Features").
import { fileDependencyTickets, moveTestedTag } from "./code";
import { fire, pick } from "./engine";
import type { Flowee } from "./service";

export async function housekeeping(f: Flowee) {
  await fileDependencyTickets(f).catch((e) => console.error("dependency tickets", e));
  await moveTestedTag(f).catch((e) => console.error("tested tag", e));
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

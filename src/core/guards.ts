// Named guards a chart may use. docs/flows.md describes each one, its refusal and its error code.
import { parseCard } from "./card";
import type { Ref } from "./chart";
import type { Ctx, Guard, Params } from "./engine";
import { check } from "./engine";
import { CODE_GUARDS } from "./code";
import { Fail } from "./errors";
import { fill } from "./text";

const s7 = (s: string) => s.slice(0, 7);
const build = (c: Ctx) => String(c.input.build);

export const GUARDS: Record<string, Guard> = {
  ...CODE_GUARDS,
  all: {
    kind: "selector",
    async run(c, p) {
      for (const g of (p.guards as Ref[]) ?? []) if (!(await check(g, c))) return false;
      return true;
    },
  },
  roleIs: { kind: "selector", run: (c, p) => ((p.roles as string[]) ?? []).includes(c.caller.role) },
  flag: { kind: "selector", run: (c, p) => c.input[String(p.name)] === true },
  answered: { kind: "selector", note: " (answered)", run: (c) => c.f.answered(c.t.n, c.from) },
  hasCommits: { kind: "selector", run: async (c) => (await c.f.commitsOf(c.t)).length > 0 },
  originIs: { kind: "selector", run: (c, p) => c.f.origin(c.t.n)?.from === p.from },
  dependenciesClosed: {
    kind: "selector",
    run: async (c) => {
      const open = c.open ?? new Set((await c.f.tracker.openIssues()).map((i) => i.n));
      return c.f.tracker.dependsOn(c.t.n, c.t.issue.body).every((d) => !open.has(d));
    },
  },
  holdsClaim: {
    kind: "check",
    run(c) {
      if (c.f.claim(c.t.n)?.instance !== c.caller.instance)
        throw new Fail(409, "not_claimed", `${c.f.label(c.t.n)} is not claimed by ${c.caller.instance}.`);
      return true;
    },
  },
  notClaimedBy: {
    kind: "check",
    run(c, p) {
      const cl = c.f.claim(c.t.n);
      if (cl && ((p.roles as string[]) ?? []).includes(cl.role)) throw new Fail(409, "claimed", `${c.f.label(c.t.n)} is claimed by ${cl.instance}.`);
      return true;
    },
  },
  hasAcceptance: {
    kind: "check",
    run(c, p) {
      const h = String(p.heading ?? "Acceptance");
      if (!new RegExp(`^#{2,4}\\s*${h}\\b`, "m").test(c.t.issue.body ?? ""))
        throw new Fail(400, "bad_request", `${c.f.label(c.t.n)} has no ## ${h} section; add one with spec first.`);
      return true;
    },
  },
  commitsOnMain: {
    kind: "check",
    async run(c) {
      const listed = new Set(c.f.db.rows<{ sha: string }>("SELECT sha FROM handed WHERE n = ?", c.t.n).map((r) => r.sha));
      const fresh = (await c.f.commitsOf(c.t)).filter((s) => !listed.has(s));
      if (!fresh.length) {
        const tag = c.f.tracker.commitTags(c.t.n, c.f.flow.options.commitSuffix).map((x) => x.trim()).join(" or ");
        throw new Fail(422, "no_commits", `No new commit on ${c.f.branch(c.t.n)} ends with ${tag}; push first.`);
      }
      c.data.commits = fresh;
      return true;
    },
  },
  gatesMatchBuild: {
    kind: "check",
    run(c) {
      const g = c.input.gates as { sha: string; ok: boolean };
      if (g.sha !== build(c)) throw new Fail(422, "gates_mismatch", `The gates ran on ${s7(g.sha)}, not on the build ${s7(build(c))}.`);
      if (!g.ok) throw new Fail(422, "gates_mismatch", `The gates failed on ${s7(build(c))}; pass needs them green.`);
      return true;
    },
  },
  buildOnMain: {
    kind: "check",
    async run(c) {
      const main = c.f.branch(c.t.n);
      if (!(await c.f.tracker.at(c.t.n).repo.tracker.contains(build(c), main)))
        throw new Fail(422, "not_in_build", `Build ${s7(build(c))} is not on ${main}; push it and test again.`);
      return true;
    },
  },
  buildContainsCommits: {
    kind: "check",
    async run(c) {
      const t = c.f.tracker.at(c.t.n).repo.tracker;
      for (const x of await c.f.commitsOf(c.t))
        if (!(await t.contains(x, build(c))))
          throw new Fail(422, "not_in_build", `Build ${s7(build(c))} lacks ${s7(x)} (${c.f.label(c.t.n)}); pull and test again.`);
      return true;
    },
  },
  cardValid: {
    kind: "check",
    run(c, p) {
      c.data.card = parseCard(String(c.input[String(p.field ?? "comment")] ?? ""), c.f.s.texts.cardHeading, !!c.f.s.features.samples);
      return true;
    },
  },
  refuse: {
    kind: "check",
    run(c, p: Params) {
      throw new Fail(Number(p.status ?? 409), String(p.code ?? "wrong_state"), fill(c.f.tracker.say(String(p.message), c.t.n), { state: c.from }));
    },
  },
};

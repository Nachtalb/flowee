// Guards, actions and housekeeping of the code features (docs/configuration.md, "Features"): branches and pull
// requests, CI checks, releases and the tested tag, samples, UI review, dependency tickets, untrusted reports.
// Each reaches the tracker of the ticket's repository through its optional capabilities.
import { capability, type Change, type Issue, type PullRequest, type Tracker } from "../ports/tracker";
import { type Card, parseCard } from "./card";
import type { Action, Caller, Ctx, Guard } from "./engine";
import { Fail } from "./errors";
import { glob } from "./features";
import { type Repo, SLOT } from "./repos";
import type { Flowee, Ticket } from "./service";
import { fill } from "./text";

const s7 = (s: string) => s.slice(0, 7);
const DEP = /^Pull request: #(\d+)\s*$/m;
const vars = (c: Ctx) => (c.data.vars ??= {}) as Record<string, string>;
const local = (f: Flowee, id: number) => f.tracker.at(id);
const suffixOf = (f: Flowee, n: number) => fill(f.flow.options.commitSuffix, { n });

/** The ticket's branch (feature pullRequests). */
export const branchOf = (f: Flowee, id: number) => fill(f.s.features.pullRequests?.branch ?? "flowee/{n}", { n: local(f, id).n });

const isDependency = (i: Issue) => DEP.test(i.body ?? "");

/** The ticket's pull request: the one its body names (a dependency ticket), else the one from its branch. */
async function pullOf(c: Ctx): Promise<PullRequest | null> {
  if (c.data.pull !== undefined) return c.data.pull as PullRequest | null;
  const { repo } = local(c.f, c.t.n);
  const dep = DEP.exec(c.t.issue.body ?? "");
  let p: PullRequest | null = null;
  if (dep) p = await capability(repo.tracker, "pulls").get(Number(dep[1]));
  else if (c.f.s.features.pullRequests) p = await capability(repo.tracker, "pulls").forBranch(branchOf(c.f, c.t.n));
  c.data.pull = p;
  return p;
}

type Verdict = { state: "green" | "pending" | "failed" | "none"; detail: string };

async function checksOf(t: Tracker, sha: string, names: string[]): Promise<Verdict> {
  const runs = await capability(t, "checks").forCommit(sha);
  const want = names.length ? names.map((n) => runs.find((r) => r.name === n) ?? { name: n, status: "queued" as const, conclusion: null }) : runs;
  if (!want.length) return { state: "none", detail: "" };
  const say = (xs: typeof want) => xs.map((r) => `${r.name} (${r.conclusion ?? r.status.replace("_", " ")})`).join(", ");
  const failed = want.filter((r) => r.status === "completed" && !["success", "neutral", "skipped"].includes(String(r.conclusion)));
  if (failed.length) return { state: "failed", detail: say(failed) };
  const pending = want.filter((r) => r.status !== "completed");
  if (pending.length) return { state: "pending", detail: say(pending) };
  return { state: "green", detail: "" };
}

function requireGreen(v: Verdict, sha: string) {
  if (v.state === "failed") throw new Fail(422, "checks_failed", `Checks failed on ${s7(sha)}: ${v.detail}; fix them first.`);
  if (v.state === "pending") throw new Fail(422, "checks_pending", `Checks of ${s7(sha)} are not done yet: ${v.detail}; wait and try again.`);
  if (v.state === "none") throw new Fail(422, "checks_pending", `No checks reported on ${s7(sha)} yet; wait and try again.`);
}

/** The ticket's commits: those ending with its suffix, plus merge commits recorded for it. */
async function ticketShas(f: Flowee, t: Ticket): Promise<string[]> {
  const handed = f.db.rows<{ sha: string }>("SELECT sha FROM handed WHERE n = ?", t.n).map((r) => r.sha);
  return [...new Set([...(await f.commitsOf(t)), ...handed])];
}

/** The published build of a repository: its version and the commit it was built from. */
export async function published(f: Flowee, repo: Repo): Promise<{ version: string; sha: string } | null> {
  const r = f.s.features.releases;
  if (!r) return null;
  if (r.source === "tag") {
    const sha = await capability(repo.tracker, "tags").get(String(r.tag));
    return sha ? { version: `${r.tag} ${s7(sha)}`, sha } : null;
  }
  const rel = await capability(repo.tracker, "releases").latest();
  if (!rel) return null;
  const sha = rel.sha ?? (await capability(repo.tracker, "tags").get(rel.tag));
  return sha ? { version: rel.name, sha } : null;
}

/** Commits of the ticket the published build lacks (all of them when nothing is published). */
async function unreleased(c: Ctx): Promise<string[]> {
  const { repo } = local(c.f, c.t.n);
  const shas = await ticketShas(c.f, c.t);
  if (!shas.length) return [];
  const rel = await published(c.f, repo);
  if (rel) c.data.release = rel;
  const out: string[] = [];
  for (const s of shas) if (!rel || !(await repo.tracker.contains(s, rel.sha))) out.push(s);
  return out;
}

/** Why a ticket's changes need the owner's eyes (feature uiReview). */
export function uiReasons(changes: Change[], u: NonNullable<Flowee["s"]["features"]["uiReview"]>): string[] {
  const any = (gs: string[], p: string) => gs.some((g) => glob(g).test(p));
  const lines = u.addedLines.map((x) => new RegExp(x));
  const why: string[] = [];
  for (const ch of changes) {
    if (any(u.ignore, ch.path)) continue;
    if (any(u.paths, ch.path)) why.push(`UI file: ${ch.path}`);
    else if (ch.status === "A" && any(u.addedFiles, ch.path)) why.push(`new file: ${ch.path}`);
    else {
      const l = ch.added.find((x) => lines.some((re) => re.test(x)));
      if (l !== undefined) why.push(`new UI element in ${ch.path}: ${l.trim().slice(0, 80)}`);
    }
  }
  return [...new Set(why)];
}

function untrustedLabel(f: Flowee) {
  return f.s.features.untrustedReports?.label;
}

export const CODE_GUARDS: Record<string, Guard> = {
  pullRequestOpen: {
    kind: "check",
    async run(c) {
      const p = await pullOf(c);
      if (!p || p.state !== "open")
        throw new Fail(422, "no_pull_request", `No open pull request for ${c.f.label(c.t.n)}${isDependency(c.t.issue) ? "" : ` from ${branchOf(c.f, c.t.n)}`}; push the branch and run pr first.`);
      vars(c).pull = `#${p.number} at ${s7(p.headSha)}`;
      return true;
    },
  },
  checksGreen: {
    kind: "check",
    async run(c) {
      const p = await pullOf(c);
      if (!p) throw new Fail(422, "no_pull_request", `${c.f.label(c.t.n)} has no pull request to check.`);
      requireGreen(await checksOf(local(c.f, c.t.n).repo.tracker, p.headSha, c.f.s.features.pullRequests?.checks ?? []), p.headSha);
      return true;
    },
  },
  merged: {
    kind: "check",
    async run(c) {
      const p = await pullOf(c);
      if (!p || p.state !== "merged" || !p.mergeSha)
        throw new Fail(422, "not_merged", `${p ? `Pull request #${p.number}` : "The pull request"} of ${c.f.label(c.t.n)} is not merged yet; merge it first.`);
      c.f.db.exec("INSERT OR IGNORE INTO handed VALUES (?, ?)", c.t.n, p.mergeSha);
      c.data.commits = [p.mergeSha];
      vars(c).pull = `#${p.number}, merged as ${s7(p.mergeSha)}`;
      return true;
    },
  },
  isDependencyTicket: { kind: "selector", run: (c) => isDependency(c.t.issue) },
  buildTested: {
    kind: "check",
    async run(c, p) {
      const build = String(c.input.build);
      const pr = c.f.s.features.pullRequests?.merger === "flow" && !isDependency(c.t.issue) ? await pullOf(c) : null;
      if (pr?.state === "open") {
        const t = local(c.f, c.t.n).repo.tracker;
        if (p.contains !== false && !(await t.contains(pr.headSha, build)))
          throw new Fail(422, "not_in_build", `Build ${s7(build)} lacks the head ${s7(pr.headSha)} of pull request #${pr.number}; pull and test again.`);
        if (p.contains === false && !(await t.contains(build, pr.headSha)) && !(await t.contains(build, c.f.branch(c.t.n))))
          throw new Fail(422, "not_in_build", `Build ${s7(build)} is neither on pull request #${pr.number} nor on ${c.f.branch(c.t.n)}.`);
        vars(c).pull = `#${pr.number} at ${s7(pr.headSha)}`;
        return true;
      }
      const t = local(c.f, c.t.n).repo.tracker;
      const main = c.f.branch(c.t.n);
      if (!(await t.contains(build, main))) throw new Fail(422, "not_in_build", `Build ${s7(build)} is not on ${main}; push it and test again.`);
      if (p.contains !== false)
        for (const x of await ticketShas(c.f, c.t))
          if (!(await t.contains(x, build))) throw new Fail(422, "not_in_build", `Build ${s7(build)} lacks ${s7(x)} (${c.f.label(c.t.n)}); pull and test again.`);
      return true;
    },
  },
  uiChanged: {
    kind: "selector",
    async run(c) {
      const u = c.f.s.features.uiReview;
      if (!u) return false;
      const { repo } = local(c.f, c.t.n);
      const pr = c.f.s.features.pullRequests ? await pullOf(c) : null;
      let changes: Change[];
      if (pr?.state === "open") changes = await capability(repo.tracker, "branches").changes(pr.headSha);
      else {
        changes = [];
        for (const s of await ticketShas(c.f, c.t)) changes.push(...(await capability(repo.tracker, "branches").changes(s)));
      }
      const why = uiReasons(changes, u);
      if (why.length) vars(c).ui = `\n\nNeeds the owner's review (the board passes it on):\n${why.slice(0, 15).map((w) => `- ${w}`).join("\n")}`;
      return why.length > 0;
    },
  },
  inRelease: { kind: "selector", run: async (c) => (await unreleased(c)).length === 0 },
  awaitsRelease: {
    kind: "selector",
    run: async (c) => !!c.f.s.features.releases?.hold && (c.data.card as Card | undefined)?.kind === "test" && (await unreleased(c)).length > 0,
  },
  cardKind: { kind: "selector", run: (c, p) => ((p.kinds as string[]) ?? []).includes(String((c.data.card as Card | undefined)?.kind)) },
  hasCard: {
    kind: "selector",
    async run(c) {
      for (const cm of [...(await c.f.tracker.comments(c.t.n))].reverse()) {
        try {
          c.data.card = parseCard(cm.body, c.f.s.texts.cardHeading, !!c.f.s.features.samples);
          c.data.commentId = cm.id;
          return true;
        } catch {}
      }
      return false;
    },
  },
  samplesGiven: {
    kind: "check",
    async run(c) {
      const s = c.f.s.features.samples;
      if (!s) return true;
      const paths = (c.input.paths as string[] | undefined) ?? [];
      if (!paths.length) {
        if (c.t.issue.labels.includes(s.notNeededLabel)) return true;
        throw new Fail(422, "no_samples", `${c.f.label(c.t.n)} needs sample paths (or the '${s.notNeededLabel}' label).`);
      }
      const outside = paths.filter((x) => !x.startsWith(s.root));
      if (outside.length) throw new Fail(400, "bad_request", `Sample paths start with ${s.root}: ${outside.join(", ")}.`);
      const { repo } = local(c.f, c.t.n);
      const br = capability(repo.tracker, "branches");
      const missing: string[] = [];
      for (const x of paths) {
        const parts = x.replace(/^\/+|\/+$/g, "").split("/");
        let found = false;
        // a path may point into a container (x.7z/inner/file): the container itself must exist
        for (let i = parts.length; i > 0 && !found; i--) {
          const prefix = parts.slice(0, i).join("/");
          if (prefix.length >= s.root.replace(/\/$/, "").length) found = await br.exists(repo.branch, prefix);
        }
        if (!found) missing.push(x);
      }
      if (missing.length) throw new Fail(422, "no_samples", `Not on ${repo.branch} yet: ${missing.join(", ")}.`);
      vars(c).paths = `\n\nSamples:\n${paths.map((x) => `- \`${x}\``).join("\n")}`;
      return true;
    },
  },
  untrusted: { kind: "selector", run: (c) => !!untrustedLabel(c.f) && c.t.issue.labels.includes(String(untrustedLabel(c.f))) },
  isUntrusted: {
    kind: "check",
    run(c) {
      const l = untrustedLabel(c.f);
      if (!l || !c.t.issue.labels.includes(l)) throw new Fail(409, "not_untrusted", `${c.f.label(c.t.n)} has no '${l ?? "untrusted"}' label.`);
      return true;
    },
  },
  trusted: {
    kind: "selector",
    run: (c) => {
      const u = c.f.s.features.untrustedReports;
      return !u || !c.t.issue.labels.includes(u.label) || c.caller.role === u.role;
    },
  },
};

export const CODE_ACTIONS: Record<string, Action> = {
  /** Opens the ticket's pull request from its branch, or updates its title; answers `pull`. */
  async openPull(c) {
    const { repo, n } = local(c.f, c.t.n);
    const branch = branchOf(c.f, c.t.n);
    if (!(await capability(repo.tracker, "branches").head(branch))) throw new Fail(422, "no_branch", `Push ${branch} first; it does not exist on the tracker.`);
    const pulls = capability(repo.tracker, "pulls");
    const title = `${c.t.issue.title}${suffixOf(c.f, n)}`;
    let p = await pulls.forBranch(branch);
    if (p?.state === "open") {
      if (p.title !== title) await pulls.update(p.number, { title });
    } else p = await pulls.create(branch, repo.branch, title, `Closes #${n}`);
    c.data.pull = p;
    c.out.pull = { number: p.number, url: p.url, branch };
  },

  /** Merges the ticket's open pull request (subject ending with the ticket suffix); no-op without one. */
  async mergePull(c) {
    const p = await pullOf(c);
    if (!p || p.state !== "open") return;
    const { repo, n } = local(c.f, c.t.n);
    const pr = c.f.s.features.pullRequests;
    const sfx = suffixOf(c.f, n);
    const subject = p.title.trimEnd().endsWith(sfx.trim()) ? p.title : `${p.title}${sfx}`;
    const sha = await capability(repo.tracker, "pulls").merge(p.number, pr?.method ?? "merge", subject);
    if (pr?.deleteBranch ?? true) await capability(repo.tracker, "branches").remove(p.head);
    c.f.db.exec("INSERT OR IGNORE INTO handed VALUES (?, ?)", c.t.n, sha);
    c.data.pull = { ...p, state: "merged", mergeSha: sha };
    vars(c).merge = s7(sha);
    c.out.merged = sha;
  },

  /** Moves the tested tag (feature releases, testedTag); answers `tested`. */
  async moveTag(c) {
    const moved = await moveTestedTag(c.f);
    if (moved.length) c.out.tested = moved[0];
  },

  /** The untrusted label goes: the reviewing role checked the text. */
  async markChecked(c) {
    const l = untrustedLabel(c.f);
    if (!l) return;
    const fresh = await c.f.tracker.issue(c.t.n);
    if (fresh.labels.includes(l)) await c.f.tracker.update(c.t.n, { labels: fresh.labels.filter((x) => x !== l) }, `removing '${l}' from ${c.f.label(c.t.n)}`);
  },
};

/** What `show` adds for the code features: the branch, the pull request and its checks. */
export async function codeView(f: Flowee, t: Ticket): Promise<Record<string, unknown>> {
  const dep = isDependency(t.issue);
  if (!f.s.features.pullRequests && !(dep && f.s.features.dependencyTickets)) return {};
  const c = f.ctx({ instance: "", role: "" }, t, "show");
  const p = await pullOf(c);
  const out: Record<string, unknown> = dep ? {} : { branch: branchOf(f, t.n) };
  if (p) {
    const v = p.state === "open" ? await checksOf(local(f, t.n).repo.tracker, p.headSha, f.s.features.pullRequests?.checks ?? []) : null;
    out.pull = { number: p.number, url: p.url, state: p.state, head: p.headSha, ...(v ? { checks: v.state, ...(v.detail ? { waiting: v.detail } : {}) } : {}) };
  } else out.pull = null;
  return out;
}

/** The reviewing role also gets every free ticket with untrusted text, in any state, after its own queue. */
export function untrustedQueue(f: Flowee, c: Caller, issues: Issue[], out: Issue[]): Issue[] {
  const u = f.s.features.untrustedReports;
  if (!u || c.role !== u.role) return out;
  const mine = new Set(out.map((i) => i.n));
  const claims = new Map(f.rows<{ n: number; instance: string }>("SELECT n, instance FROM claims").map((r) => [r.n, r.instance]));
  const extra = issues.filter((i) => i.labels.includes(u.label) && !mine.has(i.n) && (claims.get(i.n) ?? c.instance) === c.instance && f.stateOrNull(i) !== null);
  return [...out, ...extra.sort((a, b) => (a.n % SLOT) - (b.n % SLOT) || a.n - b.n)];
}

/**
 * Moves the tested tag of every repository forward over its main branch, commit by commit, up to the first commit
 * that belongs to a ticket still in an untested state; it lands on the newest such commit that is not of a skipped
 * type and (with `releases.checks`) has those checks green. The shas it moved to.
 */
export async function moveTestedTag(f: Flowee): Promise<string[]> {
  const r = f.s.features.releases;
  if (!r?.testedTag) return [];
  const moved: string[] = [];
  const tagRe = new RegExp(
    `${f.flow.options.commitSuffix
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace("\\{n\\}", "(\\d+)")}\\s*$`,
  );
  const skip = new RegExp(`^(${r.skip.map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") || "(?!)"})(\\([^)]*\\))?!?:`);
  for (const repo of f.tracker.list) {
    const tags = capability(repo.tracker, "tags");
    const base = await tags.get(r.testedTag);
    const all = await repo.tracker.commits(repo.branch, new Date(f.clock.now() - 365 * 864e5).toISOString());
    const from = base ? all.findIndex((x) => x.sha === base) + 1 : Math.max(0, all.length - 20);
    const states = new Map<number, string>();
    const stateOf = async (n: number) => {
      if (!states.has(n)) {
        let st = f.flow.closed;
        try {
          st = f.stateOf(await f.tracker.issue(f.tracker.id(repo, n)));
        } catch {}
        states.set(n, st);
      }
      return states.get(n) as string;
    };
    const handedBy = new Map(f.rows<{ n: number; sha: string }>("SELECT n, sha FROM handed").map((x) => [x.sha, x.n % SLOT]));
    const allowed: string[] = [];
    for (const cm of all.slice(from)) {
      const refs = [Number(tagRe.exec(cm.subject)?.[1]), handedBy.get(cm.sha)].filter((x): x is number => !!x);
      let untested = false;
      for (const n of refs) if (f.flow.meta(await stateOf(n)).untested) untested = true;
      if (untested) break;
      if (!skip.test(cm.subject)) allowed.push(cm.sha);
    }
    let target: string | undefined;
    for (const sha of allowed.reverse()) {
      if (!r.checks.length || (await checksOf(repo.tracker, sha, r.checks)).state === "green") {
        target = sha;
        break;
      }
    }
    if (target && target !== base) {
      await tags.move(r.testedTag, target);
      moved.push(target);
    }
  }
  return moved;
}

/** One ticket per open pull request of the configured authors (feature dependencyTickets), filed once. */
export async function fileDependencyTickets(f: Flowee) {
  const d = f.s.features.dependencyTickets;
  if (!d) return;
  const m = f.flow.meta(f.flow.initial);
  for (const repo of f.tracker.list) {
    const pulls = repo.tracker.pulls;
    if (!pulls) continue;
    for (const p of await pulls.open()) {
      const key = `deps:${repo.repo}#${p.number}`;
      if (!d.authors.includes(p.author) || f.rows("SELECT 1 FROM meta WHERE k = ?", key).length) continue;
      const title = `deps: ${p.title}`.slice(0, 100) + ` (PR #${p.number})`;
      const body = `Pull request: #${p.number}\n\n${p.url}\n\n## Acceptance\n- the pull request is merged with its checks green\n- the app still works with the new version`;
      const i = await f.tracker.createIn(repo, title, body, [...(m.label ? [m.label] : []), ...d.labels]);
      f.entered(i.n, f.flow.initial);
      if (m.status && f.tracker.board) await f.tracker.board.setStatus(i, m.status);
      f.db.exec("INSERT OR REPLACE INTO meta VALUES (?, ?)", key, String(i.n));
    }
  }
}

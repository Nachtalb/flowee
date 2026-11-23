// One workspace's ticket flow: the commands of the HTTP API, the queues, the lease reaper. Tracker, chat, storage
// and time come in through ports; the chart decides every transition.
import type { Clock } from "../ports/clock";
import type { Issue, Tracker } from "../ports/tracker";
import type { Secrets } from "../ports/secrets";
import type { Store } from "../ports/store";
import { parseCard } from "./card";
import { BUILTIN, type Flow, type InputRule } from "./chart";
import { type Caller, type Ctx, check, fire, pick } from "./engine";
import { Fail } from "./errors";
import type { Settings } from "./settings";
import { dependsOn, fill, iso, or, stripper } from "./text";

export interface Ticket {
  n: number;
  issue: Issue;
  state: string;
}

/** The owner's side (the envoy) as the flow sees it. */
export interface Inbox {
  sendCard(n: number): Promise<"sent" | "queued">;
  /** Marks an open item answered; whether it was open. */
  markAnswered(n: number): boolean;
  closeCards(n: number): Promise<void>;
  tick(): Promise<void>;
  setup(): Promise<Record<string, string>>;
}

export type Body = Record<string, unknown>;
const SHA = /^[0-9a-f]{40}$/;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export class Flowee {
  envoy?: Inbox;
  readonly flow: Flow;
  readonly strip: (text: string) => string;

  constructor(
    public s: Settings,
    public tracker: Tracker,
    public db: Store,
    public clock: Clock,
    public secrets: Secrets,
  ) {
    this.flow = s.flow;
    const signs = Object.keys(this.flow.options.roles).map((r) => this.signWord(r));
    this.strip = stripper([...new Set([...signs, "Owner"])]);
  }

  signWord(role: string) {
    return fill(this.flow.options.roles[role]?.sign ?? role, { owner: this.s.texts.owner });
  }

  /** The caller's text with any signature it wrote itself removed, signed with its role. */
  sign(role: string, text: string) {
    return `${this.signWord(role)}: ${this.strip(text)}`;
  }

  rows = <R extends Record<string, unknown>>(q: string, ...a: (string | number | null)[]) => this.db.rows(q, ...a) as unknown as R[];

  // ---- tickets ----

  stateOf(i: Issue): string {
    if (!i.open) return this.flow.closed;
    const s = this.flow.states.filter((x) => {
      const l = this.flow.meta(x).label;
      return l && i.labels.includes(l);
    });
    if (s.length > 1)
      throw new Fail(409, "two_states", `#${i.n} has two state labels (${s.map((x) => this.flow.meta(x).label).join(", ")}); fix it by hand.`);
    return s[0] ?? this.flow.initial;
  }

  stateOrNull(i: Issue): string | null {
    try {
      return this.stateOf(i);
    } catch {
      return null;
    }
  }

  async ticket(n: number): Promise<Ticket> {
    const issue = await this.tracker.issue(n);
    return { n, issue, state: this.stateOf(issue) };
  }

  claim(n: number) {
    return this.rows<{ n: number; instance: string; role: string; since: number; touched: number }>("SELECT * FROM claims WHERE n = ?", n)[0];
  }

  claimView(n: number) {
    const c = this.claim(n);
    return c ? { n, instance: c.instance, since: iso(c.since), touched: iso(c.touched) } : null;
  }

  entered(n: number, state: string, at = this.clock.now()) {
    this.db.exec("INSERT OR REPLACE INTO entered VALUES (?, ?, ?)", n, state, at);
  }

  /** An owner answer was recorded after the ticket last entered `state`. */
  answered(n: number, state: string): boolean {
    const e = this.rows<{ state: string; ts: number }>("SELECT state, ts FROM entered WHERE n = ?", n)[0];
    const since = e?.state === state ? e.ts : 0;
    return this.rows("SELECT 1 FROM answers WHERE n = ? AND ts >= ?", n, since).length > 0;
  }

  answers(n: number) {
    return this.rows<{ ts: number; text: string }>("SELECT ts, text FROM answers WHERE n = ? ORDER BY id", n).map((a) => ({ ts: iso(a.ts), text: a.text }));
  }

  origin(n: number) {
    const o = this.rows<{ origin: string; instance: string; ts: number }>("SELECT * FROM origins WHERE n = ?", n)[0];
    return o ? { from: o.origin, instance: o.instance, ts: iso(o.ts) } : undefined;
  }

  /** Shas of the ticket's commits on the main branch, oldest first. */
  async commitsOf(t: Ticket): Promise<string[]> {
    const tag = fill(this.flow.options.commitSuffix, { n: t.n });
    return (await this.tracker.commits(this.s.mainBranch, t.issue.createdAt)).filter((c) => c.subject.trimEnd().endsWith(tag)).map((c) => c.sha);
  }

  ctx(caller: Caller, t: Ticket, event: string, input: Body = {}): Ctx {
    return { f: this, t, caller, event, input, from: t.state, to: t.state, data: {}, out: {} };
  }

  // ---- queues ----

  /** What `next` would hand out to the caller, in order. */
  async queueOf(c: Caller, issues: Issue[]): Promise<Issue[]> {
    const open = new Set(issues.map((i) => i.n));
    const claims = new Map(this.rows<{ n: number; instance: string }>("SELECT n, instance FROM claims").map((r) => [r.n, r.instance]));
    const free = (i: Issue) => (claims.get(i.n) ?? c.instance) === c.instance;
    const states = this.flow.states
      .filter((s) => this.flow.meta(s).claimable?.role === c.role)
      .sort((a, b) => (this.flow.meta(a).claimable?.rank ?? 0) - (this.flow.meta(b).claimable?.rank ?? 0));
    const out: Issue[] = [];
    for (const s of states) {
      const cl = this.flow.meta(s).claimable;
      let xs = issues.filter((i) => this.stateOrNull(i) === s && free(i)).sort((a, b) => a.n - b.n);
      if (cl?.sort === "handover") {
        const at = (i: Issue) => this.rows<{ ts: number }>("SELECT ts FROM origins WHERE n = ?", i.n)[0]?.ts ?? Date.parse(i.updatedAt);
        xs = xs.sort((a, b) => at(a) - at(b) || a.n - b.n);
      }
      for (const i of xs) {
        if (cl?.when && !(await check(cl.when, { ...this.ctx(c, { n: i.n, issue: i, state: s }, "next"), open }))) continue;
        out.push(i);
      }
    }
    return out;
  }

  view(t: Ticket, resumed: boolean) {
    const answers = this.answers(t.n);
    const o = this.flow.meta(t.state).review ? this.origin(t.n) : undefined;
    return { n: t.n, title: t.issue.title, state: t.state, resumed, ...(o ? { origin: o } : {}), ...(answers.length ? { answers } : {}) };
  }

  // ---- commands ----

  need(c: Caller, cmd: string) {
    const roles = this.flow.options.commands[cmd]?.roles ?? [];
    if (!roles.includes(c.role))
      throw new Fail(403, "wrong_role", `Only ${or(roles.map((r) => this.flow.options.roles[r]?.who ?? r))} may use ${cmd}.`);
  }

  isRead = (cmd: string) => !!this.flow.options.commands[cmd]?.read;
  isCommand = (cmd: string) => Object.hasOwn(this.flow.options.commands, cmd);

  /** The body's fields checked against the command's input rules, in order (`n` first). */
  input(c: Caller, cmd: string, b: Body, data: Body): Body {
    const out: Body = {};
    for (const [field, rule] of Object.entries(this.flow.options.commands[cmd]?.input ?? {})) out[field] = this.field(c, field, rule, b[field], data);
    return out;
  }

  private field(c: Caller, name: string, rule: InputRule, v: unknown, data: Body): unknown {
    const t = str(v);
    switch (typeof rule === "string" ? rule : "for-roles") {
      case "optional":
        return t;
      case "for-roles":
        if (!(rule as { required: string[] }).required.includes(c.role)) return t;
      // falls through
      case "required":
      case "card":
        if (!t) throw new Fail(422, "comment_required", "This step needs a comment.");
        if (rule === "card") data.card = parseCard(t, this.s.texts.cardHeading);
        return t;
      case "text":
        if (!t) throw new Fail(422, "comment_required", "The answer needs text.");
        return t;
      case "body":
        if (!t) throw new Fail(400, "bad_request", `${name} must not be empty.`);
        return t;
      case "title":
        if (v === undefined) return undefined;
        if (t.length < 1 || t.length > 120) throw new Fail(400, "bad_request", `${name} must be 1 to 120 characters.`);
        return t;
      case "sha":
        if (!SHA.test(t)) throw new Fail(400, "bad_request", `${name} must be a 40-character commit sha.`);
        return t;
      case "gates": {
        const g = v as { sha?: unknown; ok?: unknown } | undefined;
        if (!g || typeof g !== "object" || typeof g.sha !== "string" || typeof g.ok !== "boolean")
          throw new Fail(400, "bad_request", `${name} must be {sha, ok} from the client's gates command.`);
        return { sha: g.sha, ok: g.ok };
      }
      case "flag":
        if (v !== undefined && typeof v !== "boolean") throw new Fail(400, "bad_request", `${name} must be true or false.`);
        return v === true;
    }
    return t;
  }

  /** One API command for an authenticated caller; the response fields besides `ok`. */
  async run(c: Caller, cmd: string, b: Body): Promise<Record<string, unknown>> {
    this.need(c, cmd);
    switch (cmd) {
      case "whoami":
        return { instance: c.instance, role: c.role };
      case "queue":
        return this.queue(c);
      case "show":
        return this.show(num(b));
      case "next":
        return this.next(c);
      case "file":
        return this.file(str(b.title), str(b.body));
    }
    const n = num(b);
    const data: Body = {};
    const input = this.input(c, cmd, b, data);
    const t = await this.ticket(n);
    const x = this.ctx(c, t, cmd, input);
    Object.assign(x.data, data);
    await fire(x);
    const withState = this.flow.options.commands[cmd]?.state !== false;
    return { ...(withState ? { state: t.state } : {}), ...x.out };
  }

  async queue(c: Caller) {
    const issues = await this.tracker.openIssues();
    const mine = this.rows<{ n: number; since: number; touched: number }>("SELECT n, since, touched FROM claims WHERE instance = ? ORDER BY since", c.instance)[0];
    const out: Record<string, unknown> = {
      role: c.role,
      queue: (await this.queueOf(c, issues)).map((i) => i.n),
      claim: mine ? { n: mine.n, since: iso(mine.since), touched: iso(mine.touched) } : null,
    };
    if (this.flow.options.inboxRoles.includes(c.role)) out.inbox = this.inbox(issues).map((i) => i.n).sort((a, b) => a - b);
    return out;
  }

  inbox(issues: Issue[]) {
    return issues.filter((i) => {
      const s = this.stateOrNull(i);
      return s !== null && this.flow.meta(s).inbox;
    });
  }

  async show(n: number) {
    const t = await this.ticket(n);
    const open = new Set<number>();
    const deps = dependsOn(t.issue.body);
    for (const d of deps) {
      try {
        if ((await this.tracker.issue(d)).open) open.add(d);
      } catch (e) {
        if (!(e instanceof Fail) || e.code !== "not_found") throw e;
      }
    }
    return {
      n: t.n,
      title: t.issue.title,
      state: t.state,
      claim: this.claimView(t.n),
      depends_on: deps,
      blocked_by: [...open],
      commits: await this.commitsOf(t),
      ...(this.flow.meta(t.state).review ? { origin: this.origin(t.n) ?? null } : {}),
      answers: this.answers(t.n),
    };
  }

  async next(c: Caller) {
    const own = this.rows<{ n: number }>("SELECT n FROM claims WHERE instance = ? ORDER BY since", c.instance)[0];
    if (own) {
      try {
        const t = await this.ticket(own.n);
        if (this.flow.meta(t.state).holder === c.role) return { ticket: this.view(t, true) };
      } catch (e) {
        if (!(e instanceof Fail) || !["not_found", "two_states"].includes(e.code)) throw e;
      }
      this.db.exec("DELETE FROM claims WHERE n = ?", own.n);
    }
    const [i] = await this.queueOf(c, await this.tracker.openIssues());
    if (!i) return { ticket: null };
    const t: Ticket = { n: i.n, issue: i, state: this.stateOf(i) };
    await fire(this.ctx(c, t, "next"));
    return { ticket: this.view(t, false) };
  }

  async file(title: string, body: string) {
    if (title.length < 1 || title.length > 120) throw new Fail(400, "bad_request", "title must be 1 to 120 characters.");
    if (!body) throw new Fail(400, "bad_request", "body must not be empty.");
    const m = this.flow.meta(this.flow.initial);
    const i = await this.tracker.create(title, body, m.label ? [m.label] : []);
    this.entered(i.n, this.flow.initial);
    if (m.status && this.tracker.board) await this.tracker.board.setStatus(i, m.status);
    return { n: i.n, url: i.url };
  }

  /** The owner's words on a ticket (API or chat): the `answer` event as the owner. */
  async answer(n: number, words: string, via: string) {
    const role = this.flow.options.ownerRole;
    const t = await this.ticket(n);
    const x = this.ctx({ instance: role, role }, t, "answer", { text: words });
    x.data.via = via;
    await fire(x);
    return { state: t.state };
  }

  // ---- cron: lease reaper, the envoy's poll, pruning, the chat profile ----

  async reap() {
    const o = this.flow.options;
    const now = this.clock.now();
    for (const cl of this.rows<{ n: number; instance: string; role: string }>("SELECT n, instance, role FROM claims WHERE touched < ?", now - o.leaseHours * 3600e3)) {
      try {
        if (cl.role !== o.reaper.role) {
          const t = await this.ticket(cl.n);
          const x = this.ctx({ instance: o.reaper.role, role: o.reaper.role }, t, o.reaper.event);
          x.data.claim = cl.instance;
          if (this.flow.meta(t.state).holder === cl.role && (await pick(this.flow, x))) await fire(x);
        }
        this.db.exec("DELETE FROM claims WHERE n = ? AND instance = ?", cl.n, cl.instance);
      } catch (e) {
        console.error("reaper", cl.n, e);
      }
    }
  }

  async cron() {
    const now = this.clock.now();
    await this.reap();
    if (this.envoy) await this.envoy.tick().catch((e) => console.error("envoy tick", e));
    this.db.exec("DELETE FROM idem WHERE ts < ?", now - 24 * 3600e3);
    this.db.exec("DELETE FROM updates WHERE ts < ?", now - 7 * 24 * 3600e3);
    if (this.envoy) await this.envoy.setup().catch((e) => console.error("setup", e));
  }
}

export function num(b: Body): number {
  const n = b.n;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 1) throw new Fail(400, "bad_request", "n must be a ticket number.");
  return n;
}

export { BUILTIN };

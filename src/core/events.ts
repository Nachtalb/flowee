// Webhooks in the core (docs/webhooks.md): verified deliveries become events queued in the workspace's store; the
// alarm turns them into targeted work on the one ticket or repository they name, and keeps a mirror of the open
// tickets that answers the agents' `queue` and the envoy's sync without a tracker call. A slow reconcile lists
// everything to catch missed deliveries; a repository without healthy webhooks is polled as before. Events are
// hints: every command still re-reads the ticket from the tracker.
import type { Delivery, TrackerEvent } from "../ports/hooks";
import type { Issue } from "../ports/tracker";
import { fileDependencyTicket, moveTestedTag } from "./code";
import { Fail } from "./errors";
import { tickTicket } from "./housekeeping";
import { type Repo, SLOT } from "./repos";
import type { Flowee } from "./service";
import { hex, sha256 } from "./text";

/** Seals the per-repository webhook secrets for storage (the adapter's vault). */
export interface Sealer {
  seal(plain: string): Promise<string>;
  unseal(sealed: string): Promise<string>;
}

export type Mode = "webhook" | "poll";

export interface HookState {
  /** How the repository's changes reach Flowee now. */
  mode: Mode;
  /** Why it polls. */
  reason?: string;
  /** Who set the hook up: Flowee through the tracker's API, or the owner by hand. */
  via?: "api" | "manual";
  /** The permission the token lacks to register the hook. */
  missing?: string;
  /** The last verified delivery (a ping included). */
  seen?: number;
  /** The last full listing. */
  listed?: number;
  /** When the mode last changed. */
  since?: number;
  /** When registering is tried again. */
  retry?: number;
  /** The mode the owner was last told about. */
  said?: Mode;
}

export interface SyncStatus {
  webhooks: "auto" | "off" | "required";
  repos: {
    alias: string;
    repo: string;
    mode: Mode;
    reason?: string;
    via?: "api" | "manual";
    missing?: string;
    url?: string;
    lastDelivery?: string;
    lastListing?: string;
  }[];
}

const MIN = 60e3;
/** A difference younger than this may still be on its way as a delivery. */
const IN_FLIGHT = 2 * MIN;
/** A repository that fell back stays polled at least this long before a delivery turns webhooks back on. */
const SETTLE = 10 * MIN;
const iso = (ms?: number) => (ms ? new Date(ms).toISOString() : undefined);
const DAY = 24 * 3600e3;

export class Webhooks {
  /** Set by the adapter that wires the workspace: without it webhooks are off (polling). */
  vault?: Sealer;
  /** The Worker's public base URL: the hook of repository `alias` is `<base>/hooks/<workspace>/<alias>`. */
  base?: string;
  private secrets = new Map<string, string>();

  constructor(private f: Flowee) {}

  get option() {
    return this.f.s.sync.webhooks;
  }

  url(r: Repo) {
    return this.base ? `${this.base.replace(/\/+$/, "")}/hooks/${this.f.s.id}/${r.alias}` : undefined;
  }

  private meta = (k: string) => this.f.rows<{ v: string }>("SELECT v FROM meta WHERE k = ?", k)[0]?.v;
  private setMeta = (k: string, v: string) => void this.f.db.exec("INSERT OR REPLACE INTO meta VALUES (?, ?)", k, v);

  state(r: Repo): HookState {
    const v = this.meta(`hook:${r.repo}`);
    return v ? (JSON.parse(v) as HookState) : { mode: "poll" };
  }

  private save(r: Repo, st: HookState) {
    this.setMeta(`hook:${r.repo}`, JSON.stringify(st));
  }

  /** The repository's changes arrive as deliveries and its mirror is current. */
  healthy(r: Repo) {
    return this.option !== "off" && this.state(r).mode === "webhook";
  }

  // ---- the mirror of open tickets ----

  private range = (r: Repo) => [r.slot * SLOT, (r.slot + 1) * SLOT] as const;

  mirrored(r: Repo): Issue[] {
    return this.f
      .rows<{ issue: string }>("SELECT issue FROM mirror WHERE n >= ? AND n < ? ORDER BY n", ...this.range(r))
      .map((x) => JSON.parse(x.issue) as Issue);
  }

  private put(i: Issue) {
    if (i.open) this.f.db.exec("INSERT OR REPLACE INTO mirror VALUES (?, ?)", i.n, JSON.stringify(i));
    else this.f.db.exec("DELETE FROM mirror WHERE n = ?", i.n);
  }

  /** A full listing of one repository from the tracker; the mirror becomes it. */
  async fetch(r: Repo): Promise<Issue[]> {
    const issues = (await r.tracker.openIssues()).map((i) => ({ ...i, n: this.f.tracker.id(r, i.n) }));
    this.f.db.exec("DELETE FROM mirror WHERE n >= ? AND n < ?", ...this.range(r));
    for (const i of issues) this.put(i);
    const st = this.state(r);
    st.listed = this.f.clock.now();
    this.save(r, st);
    return issues;
  }

  /** The open tickets as last known: the mirror, listed first where it never was. */
  async openIssues(): Promise<Issue[]> {
    const all = await Promise.all(this.f.tracker.list.map(async (r) => (this.state(r).listed ? this.mirrored(r) : await this.fetch(r))));
    return all.flat();
  }

  /** What `queue` reads: the mirror where webhooks keep it current, the tracker elsewhere. */
  async forQueue(): Promise<{ issues: Issue[]; source: "mirror" | "tracker" }> {
    let tracker = false;
    const all = await Promise.all(
      this.f.tracker.list.map(async (r) => {
        if (this.healthy(r) && this.state(r).listed) return this.mirrored(r);
        tracker = true;
        return (await r.tracker.openIssues()).map((i) => ({ ...i, n: this.f.tracker.id(r, i.n) }));
      }),
    );
    return { issues: all.flat(), source: tracker ? "tracker" : "mirror" };
  }

  // ---- deliveries ----

  /** The repository's webhook secret; a new one with `create`. */
  async secret(r: Repo, create = false): Promise<string | undefined> {
    const cached = this.secrets.get(r.repo);
    if (cached) return cached;
    if (!this.vault) return undefined;
    const sealed = this.meta(`hooksecret:${r.repo}`);
    let plain = sealed ? await this.vault.unseal(sealed) : undefined;
    if (!plain && create) {
      plain = hex(crypto.getRandomValues(new Uint8Array(32)));
      this.setMeta(`hooksecret:${r.repo}`, await this.vault.seal(plain));
    }
    if (plain) this.secrets.set(r.repo, plain);
    return plain;
  }

  /**
   * One inbound delivery for repository `alias`: 401 unless the tracker's proof matches the repository's secret;
   * a delivery id seen before does nothing; otherwise its events are queued for the alarm. Returns the status.
   */
  async receive(alias: string, d: Delivery): Promise<number> {
    const r = this.f.tracker.list.find((x) => x.alias === alias);
    const hooks = r?.tracker.hooks;
    const secret = r && hooks && this.option !== "off" ? await this.secret(r) : undefined;
    if (!r || !hooks || !secret || !(await hooks.verify(d, secret))) return 401;
    const id = hooks.id(d) ?? hex(await sha256(d.body));
    const now = this.f.clock.now();
    if (this.f.rows("SELECT 1 FROM deliveries WHERE id = ?", id).length) return 200;
    this.f.db.exec("INSERT INTO deliveries VALUES (?, ?)", id, now);
    const mine = hooks.parse(d).filter((e) => e.repo.toLowerCase() === r.repo.toLowerCase());
    for (const e of mine) this.f.db.exec("INSERT INTO hook_events (slot, event) VALUES (?, ?)", r.slot, JSON.stringify(e));
    const st = this.state(r);
    st.seen = now;
    st.via ??= "manual";
    if (st.mode === "poll" && now - (st.since ?? 0) >= SETTLE) Object.assign(st, { mode: "webhook", reason: undefined, missing: undefined, since: now, listed: 0 });
    this.save(r, st);
    await this.f.clock.wake(0);
    return 200;
  }

  /** The queued events as targeted work: re-read the tickets they name, the work that concerns them. */
  async drain() {
    const rows = this.f.rows<{ id: number; slot: number; event: string }>("SELECT id, slot, event FROM hook_events ORDER BY id");
    if (!rows.length) return;
    this.f.db.exec("DELETE FROM hook_events WHERE id <= ?", rows[rows.length - 1].id);
    for (const r of this.f.tracker.list) {
      const evs = rows.filter((x) => x.slot === r.slot).map((x) => JSON.parse(x.event) as TrackerEvent);
      if (!evs.length) continue;
      try {
        await this.work(r, evs);
      } catch (e) {
        // a failed re-read loses nothing: the next pass lists the repository
        console.error("hook events", r.repo, e);
        const st = this.state(r);
        st.listed = 0;
        this.save(r, st);
      }
    }
    if (this.f.envoy) await this.f.envoy.tick().catch((e) => console.error("envoy tick", e));
  }

  private async work(r: Repo, evs: TrackerEvent[]) {
    const f = this.f;
    const tickets = new Set<number>();
    let tested = false;
    let released = false;
    for (const e of evs) {
      if (e.kind === "ticket" || e.kind === "comment") tickets.add(e.n);
      else if (e.kind === "push") tested ||= e.branch === r.branch;
      else if (e.kind === "checks") tested ||= !!f.s.features.releases?.checks.length;
      else if (e.kind === "release" || e.kind === "tag") released = tested = true;
      else if (e.kind === "pull" && e.action === "opened" && f.s.features.dependencyTickets?.authors.includes(e.author) && r.tracker.pulls)
        await fileDependencyTicket(f, r, await r.tracker.pulls.get(e.number));
    }
    for (const n of tickets) if (await this.refresh(r, n)) tested = true;
    if (released) for (const i of this.mirrored(r)) if (!tickets.has(i.n % SLOT)) await tickTicket(f, i);
    if (tested && f.s.features.releases?.testedTag) await moveTestedTag(f, [r]).catch((e) => console.error("tested tag", e));
  }

  /** Re-reads one ticket into the mirror (after Flowee changed it outside a command, e.g. a tick). */
  async reread(id: number) {
    const { repo, n } = this.f.tracker.at(id);
    await this.refresh(repo, n, false);
  }

  /** Re-reads one ticket into the mirror and runs its ticks; true when it left an untested state. */
  private async refresh(r: Repo, n: number, ticks = true): Promise<boolean> {
    const f = this.f;
    const id = f.tracker.id(r, n);
    const old = f.rows<{ issue: string }>("SELECT issue FROM mirror WHERE n = ?", id)[0];
    const before = old ? f.stateOrNull(JSON.parse(old.issue) as Issue) : null;
    let i: Issue | null = null;
    try {
      i = await f.tracker.issue(id);
    } catch (e) {
      if (!(e instanceof Fail) || e.code !== "not_found") throw e;
    }
    if (i) this.put(i);
    else f.db.exec("DELETE FROM mirror WHERE n = ?", id);
    if (i?.open && ticks) await tickTicket(f, i);
    const after = i ? f.stateOrNull(i) : null;
    return !!before && !!f.flow.meta(before).untested && !(after && f.flow.meta(after).untested);
  }

  // ---- registration, health, schedule ----

  /** Tells the owner once when a repository falls back to polling and once when webhooks are back. */
  private async note(r: Repo, st: HookState) {
    if (st.said === st.mode || this.option === "off") return;
    if (st.said === undefined) {
      // the first state is no change: the management view shows it
      st.said = st.mode;
      return this.save(r, st);
    }
    const name = this.f.tracker.multi ? `${r.alias} (${r.repo})` : r.repo;
    const text =
      st.mode === "webhook"
        ? `⚡ Instant updates for ${name} are on again.`
        : `Instant updates for ${name} are off: ${st.reason}. ${this.option === "required" ? "Nothing is polled (sync.webhooks is required)." : "Flowee checks the tracker every few minutes instead."}`;
    st.said = st.mode;
    this.save(r, st);
    await this.f.envoy?.notice?.(text).catch((e) => console.warn("sync notice", e));
  }

  private fallBack(r: Repo, st: HookState, reason: string, missing?: string) {
    const now = this.f.clock.now();
    if (st.mode !== "poll") st.since = now;
    Object.assign(st, { mode: "poll", reason, missing });
  }

  /** Registers (or, with `off`, removes) the repository's hook through the tracker's API when the token allows. */
  async enable(r: Repo) {
    const st = this.state(r);
    const hooks = r.tracker.hooks;
    const url = this.url(r);
    const now = this.f.clock.now();
    st.retry = now + this.f.s.sync.reconcileMinutes * MIN;
    if (this.option === "off") {
      if (st.via === "api" && hooks && url) await hooks.unregister(url).catch((e) => console.warn("unregister", e));
      this.save(r, { mode: "poll", reason: "sync.webhooks is off", listed: st.listed, said: st.said });
      return;
    }
    if (!hooks) this.fallBack(r, st, "this tracker has no webhooks in Flowee");
    else if (!this.vault) this.fallBack(r, st, "webhooks need the Worker secret FLOWEE_KEY");
    else if (!url) this.fallBack(r, st, "no public URL is configured (chat.publicUrl or instance.publicUrl)");
    else if (st.via !== "manual" || st.mode !== "webhook") {
      try {
        const h = await hooks.register(url, (await this.secret(r, true)) as string);
        Object.assign(st, { via: "api", missing: undefined, retry: undefined });
        if (h.ok) {
          if (st.mode !== "webhook") Object.assign(st, { mode: "webhook", reason: undefined, since: now, listed: 0 });
        } else this.fallBack(r, st, `the tracker reports the webhook failing (${h.detail})`);
      } catch (e) {
        if (e instanceof Fail && e.code === "forbidden") this.fallBack(r, st, `the token lacks ${hooks.permission}`, hooks.permission);
        else this.fallBack(r, st, `registering the webhook failed (${e instanceof Error ? e.message : String(e)})`);
      }
    }
    this.save(r, st);
    await this.note(r, st);
  }

  /** Removes the repository's hook (workspace deleted, repository removed); best effort. */
  async disable(r: Repo) {
    const st = this.state(r);
    const url = this.url(r);
    if (st.via && url && r.tracker.hooks) await r.tracker.hooks.unregister(url).catch((e) => console.warn("unregister", r.repo, e));
    this.f.db.exec("DELETE FROM meta WHERE k IN (?, ?)", `hook:${r.repo}`, `hooksecret:${r.repo}`);
    this.secrets.delete(r.repo);
  }

  /**
   * The owner sets the hook up by hand: a new secret (shown once), the URL, where to paste them and the
   * permission that would let Flowee do it itself. Webhooks count as on from the first delivery (the ping).
   */
  async manual(alias: string): Promise<{ url: string; secret: string; where: string; permission: string }> {
    const r = this.f.tracker.repo(alias);
    const hooks = r.tracker.hooks;
    const url = this.url(r);
    if (!hooks || !this.vault || !url) throw new Fail(501, "unsupported", `Webhooks are not available here: ${this.state(r).reason ?? "no public URL"}.`);
    this.f.db.exec("DELETE FROM meta WHERE k = ?", `hooksecret:${r.repo}`);
    this.secrets.delete(r.repo);
    const secret = (await this.secret(r, true)) as string;
    const st = this.state(r);
    st.via = "manual";
    // the old secret no longer verifies: poll until the new hook's first delivery
    if (st.mode === "webhook") this.fallBack(r, st, "waiting for the first delivery of the hook set up by hand");
    st.since = 0;
    // the owner is setting it up and sees the result in the menu: no note when it turns on
    st.said = undefined;
    this.save(r, st);
    return { url, secret, where: hooks.manual, permission: hooks.permission };
  }

  /** Registration follows the option, the URL and the repositories: once per change, and retried while refused. */
  private async configure() {
    const want = JSON.stringify({ o: this.option, r: this.f.tracker.list.map((r) => [r.repo, this.url(r)]) });
    const changed = this.meta("hooks:config") !== want;
    const now = this.f.clock.now();
    for (const r of this.f.tracker.list) {
      const st = this.state(r);
      const retry = this.option !== "off" && st.mode === "poll" && !st.via && (st.retry ?? 0) <= now;
      if (changed || retry) await this.enable(r);
    }
    this.setMeta("hooks:config", want);
  }

  /** Checks a webhook repository against a full listing and the tracker's report; falls back when deliveries are missing. */
  private async reconcile(r: Repo) {
    const st0 = this.state(r);
    const was = st0.mode === "webhook" && st0.listed ? new Map(this.mirrored(r).map((i) => [i.n, i.updatedAt])) : null;
    const now = this.f.clock.now();
    const fresh = await this.fetch(r);
    const st = this.state(r);
    if (this.option === "off" || !st.via) return;
    let why: string | undefined;
    // a change older than a delivery takes that the mirror never heard of: deliveries stopped or were lost
    if (was && fresh.some((i) => was.get(i.n) !== i.updatedAt && Date.parse(i.updatedAt) < now - IN_FLIGHT)) why = "changes on the tracker arrived without a delivery";
    const url = this.url(r);
    if (was && url && r.tracker.hooks)
      try {
        const h = await r.tracker.hooks.status(url);
        if (!h) why = "the webhook is gone from the tracker";
        else if (!h.ok) why = `the tracker reports the webhook failing (${h.detail})`;
      } catch (e) {
        // a hand-made hook with a token that may not read hooks: only deliveries tell
        if (!(e instanceof Fail && e.code === "forbidden")) throw e;
      }
    if (why && st.mode === "webhook") {
      this.fallBack(r, st, why);
      if (why === "the webhook is gone from the tracker") st.via = undefined;
    }
    this.save(r, st);
    await this.note(r, st);
  }

  /**
   * The listings that are due, made now: a webhook repository at its reconcile time (or at once after a gap), a
   * polled one at its poll time; `force` (the cron) polls every polled repository whose pollMinutes is 1.
   * The repositories listed.
   */
  async scheduled(force: boolean): Promise<Repo[]> {
    await this.configure();
    const now = this.f.clock.now();
    const { reconcileMinutes, pollMinutes } = this.f.s.sync;
    const due: Repo[] = [];
    for (const r of this.f.tracker.list) {
      const st = this.state(r);
      const watched = this.option !== "off" && (st.mode === "webhook" || this.option === "required");
      const last = st.listed ?? 0;
      if (watched ? now - last >= reconcileMinutes * MIN : (force && pollMinutes <= 1) || now - last >= pollMinutes * MIN - 30e3) due.push(r);
    }
    for (const r of due) await this.reconcile(r).catch((e) => console.error("listing", r.repo, e));
    // a delivery that turned webhooks back on is said here, not in its (fast) response
    for (const r of this.f.tracker.list) await this.note(r, this.state(r));
    this.f.db.exec("DELETE FROM deliveries WHERE ts < ?", now - 7 * DAY);
    return due;
  }

  /** When the next reconcile is due; undefined when the cron is enough (every repository polls). */
  next(): number | undefined {
    const at = this.f.tracker.list
      .filter((r) => this.option !== "off" && (this.state(r).mode === "webhook" || this.option === "required"))
      .map((r) => (this.state(r).listed ?? 0) + this.f.s.sync.reconcileMinutes * MIN);
    return at.length ? Math.min(...at) : undefined;
  }

  status(): SyncStatus {
    return {
      webhooks: this.option,
      repos: this.f.tracker.list.map((r) => {
        const st = this.state(r);
        const url = this.url(r);
        return {
          alias: r.alias,
          repo: r.repo,
          mode: this.option === "off" ? "poll" : st.mode,
          ...(st.mode === "poll" || this.option === "off" ? { reason: this.option === "off" ? "sync.webhooks is off" : (st.reason ?? "not set up yet") } : {}),
          ...(st.via ? { via: st.via } : {}),
          ...(st.missing ? { missing: st.missing } : {}),
          ...(url ? { url } : {}),
          ...(st.seen ? { lastDelivery: iso(st.seen) } : {}),
          ...(st.listed ? { lastListing: iso(st.listed) } : {}),
        };
      }),
    };
  }
}

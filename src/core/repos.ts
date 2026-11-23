// The repositories of a workspace behind one Tracker. A ticket's id is global: its repository's slot × 10⁹ plus its
// number there. The first repository a workspace ever had holds slot 0, so a one-repository workspace keeps plain
// issue numbers (in storage, the API and the chat) exactly as before; slots are kept per repository (owner/name) in
// the store, so renaming an alias or reordering repositories never moves a ticket. With several repositories a
// ticket is written `alias#n` everywhere it is shown or accepted.
import type { Store } from "../ports/store";
import type { Comment, Commit, Issue, IssuePatch, Tracker } from "../ports/tracker";
import { Fail } from "./errors";
import { or } from "./text";

export const SLOT = 1_000_000_000;

export interface RepoConfig {
  alias: string;
  /** owner/name */
  repo: string;
  branch: string;
  tracker: Tracker;
}

export interface Repo extends RepoConfig {
  slot: number;
}

/** A ticket written in text: `12`, `#12`, `app#12`. */
const REF = /^(?:([a-z0-9][a-z0-9-]*)?#)?(\d{1,9})$/;

export class Repos implements Tracker {
  readonly list: Repo[];

  constructor(repos: RepoConfig[], db: Store) {
    const stored = new Map(db.rows<{ k: string; v: string }>("SELECT k, v FROM meta WHERE k LIKE 'slot:%'").map((r) => [r.k.slice(5), Number(r.v)]));
    let next = stored.size ? Math.max(...stored.values()) + 1 : 0;
    this.list = repos.map((r) => {
      let slot = stored.get(r.repo);
      if (slot === undefined) {
        slot = next++;
        db.exec("INSERT OR REPLACE INTO meta VALUES (?, ?)", `slot:${r.repo}`, String(slot));
      }
      return { ...r, slot };
    });
  }

  get multi() {
    return this.list.length > 1;
  }

  private bySlot(id: number) {
    return this.list.find((r) => r.slot === Math.floor(id / SLOT));
  }

  /** The repository of a ticket id and the ticket's number there. */
  at(id: number): { repo: Repo; n: number } {
    const repo = this.bySlot(id);
    if (!repo) throw new Fail(404, "not_found", `Ticket ${id} belongs to no repository of this workspace.`);
    return { repo, n: id % SLOT };
  }

  id(repo: Repo, n: number) {
    return repo.slot * SLOT + n;
  }

  /** `#12` with one repository, `app#12` with several. */
  label(id: number) {
    const r = this.bySlot(id);
    return this.multi && r ? `${r.alias}#${id % SLOT}` : `#${id % SLOT}`;
  }

  /** The ticket as the API writes it: the number with one repository, `alias#n` with several. */
  ref(id: number): number | string {
    return this.multi ? this.label(id) : id % SLOT;
  }

  /** A ticket written in text or JSON, relative to `base`'s repository; undefined when it is no ticket reference. */
  parse(v: unknown, base?: number): number | undefined {
    if (typeof v === "number") return Number.isInteger(v) && v > 0 && v < SLOT && (!this.multi || base !== undefined) ? this.id(this.home(base), v) : undefined;
    const m = typeof v === "string" ? REF.exec(v.trim()) : null;
    if (!m || Number(m[2]) < 1) return undefined;
    if (m[1] === undefined) return !this.multi || base !== undefined ? this.id(this.home(base), Number(m[2])) : undefined;
    const r = this.list.find((x) => x.alias === m[1]);
    return r ? this.id(r, Number(m[2])) : undefined;
  }

  private home(base?: number) {
    return base === undefined ? this.list[0] : this.at(base).repo;
  }

  /** The `n` of a request body; refuses anything that names no ticket of this workspace. */
  need(v: unknown): number {
    const id = this.parse(v);
    if (id !== undefined) return id;
    if (!this.multi) throw new Fail(400, "bad_request", "n must be a ticket number.");
    throw new Fail(400, "bad_request", `n must be alias#number with an alias of ${or(this.list.map((r) => r.alias))}.`);
  }

  /** The repository an alias names (the first one when none is given). */
  repo(alias?: unknown): Repo {
    if (alias === undefined || alias === "") return this.list[0];
    const r = this.list.find((x) => x.alias === alias);
    if (!r) throw new Fail(400, "bad_request", `repo must be one of ${or(this.list.map((x) => x.alias))}.`);
    return r;
  }

  /** Ticket ids of a `Depends on: #3, lib#4` line; a bare number is in the ticket's own repository. */
  dependsOn(id: number, body: string | null): number[] {
    const m = /^Depends on:(.*)$/im.exec(body ?? "");
    if (!m) return [];
    return [...m[1].matchAll(/([a-z0-9][a-z0-9-]*)?#(\d+)/g)].map((x) => this.parse(`${x[1] ?? ""}#${x[2]}`, id)).filter((x): x is number => x !== undefined);
  }

  /** Commit-message endings that name the ticket: ` (#12)` in its own repository and, with several, ` (app#12)`. */
  commitTags(id: number, suffix: string): string[] {
    const n = id % SLOT;
    const plain = suffix.replace("{n}", String(n));
    return this.multi ? [plain, suffix.replace("#{n}", this.label(id)).replace("{n}", this.label(id))] : [plain];
  }

  /** A text template's `#{n}` / `{n}` as this ticket's label. */
  say(template: string, id: number) {
    return template.replace(/#\{n\}/g, this.label(id)).replace(/\{n\}/g, String(this.ref(id)));
  }

  private global(r: Repo, i: Issue): Issue {
    return { ...i, n: this.id(r, i.n) };
  }

  private async on<R>(id: number, fn: (t: Tracker, n: number) => Promise<R>): Promise<R> {
    const { repo, n } = this.at(id);
    try {
      return await fn(repo.tracker, n);
    } catch (e) {
      // the adapter names the local number; with several repositories say which one
      if (this.multi && e instanceof Fail) throw new Fail(e.status, e.code, e.message.replace(`#${n}`, this.label(id)));
      throw e;
    }
  }

  // ---- Tracker over global ids ----

  issue(id: number) {
    return this.on(id, async (t, n) => this.global(this.at(id).repo, await t.issue(n)));
  }

  async openIssues(): Promise<Issue[]> {
    const all = await Promise.all(this.list.map(async (r) => (await r.tracker.openIssues()).map((i) => this.global(r, i))));
    return all.flat();
  }

  /** Files in the first repository; `createIn` names another. */
  create(title: string, body: string, labels: string[]) {
    return this.createIn(this.list[0], title, body, labels);
  }

  async createIn(r: Repo, title: string, body: string, labels: string[]) {
    return this.global(r, await r.tracker.create(title, body, labels));
  }

  update(id: number, patch: IssuePatch, what: string) {
    return this.on(id, (t, n) => t.update(n, patch, what));
  }

  comment(id: number, body: string) {
    return this.on(id, (t, n) => t.comment(n, body));
  }

  comments(id: number): Promise<Comment[]> {
    return this.on(id, (t, n) => t.comments(n));
  }

  /** The first repository's commits; per ticket use `at(id).repo.tracker`. */
  commits(branch: string, since: string): Promise<Commit[]> {
    return this.list[0].tracker.commits(branch, since);
  }

  contains(base: string, head: string) {
    return this.list[0].tracker.contains(base, head);
  }

  /** The project board is the workspace's: any repository's issue goes on it by its tracker ref. */
  get board() {
    return this.list[0].tracker.board;
  }

  // Repository-level capabilities answer for the one repository; with several, reach them per ticket through
  // `at(id).repo.tracker` with the local number `at(id).n`.
  get branches() {
    return this.multi ? undefined : this.list[0].tracker.branches;
  }
  get pulls() {
    return this.multi ? undefined : this.list[0].tracker.pulls;
  }
  get checks() {
    return this.multi ? undefined : this.list[0].tracker.checks;
  }
  get releases() {
    return this.multi ? undefined : this.list[0].tracker.releases;
  }
  get tags() {
    return this.multi ? undefined : this.list[0].tracker.tags;
  }
}

// Workspaces of an instance. Every API token, chat update and stored key is resolved to a workspace through here.
import { ACTIONS } from "../core/actions";
import { loadFlow } from "../core/chart";
import { Fail } from "../core/errors";
import { GUARDS } from "../core/guards";
import type { Settings, Texts } from "../core/settings";
import { hex, sha256 } from "../core/text";
import type { ChatRef } from "../ports/chat";
import type { Secrets } from "../ports/secrets";
import type { Store } from "../ports/store";
import { type InstanceDoc, VERSION, type WorkspaceDoc } from "./document";
import { resolve } from "../core/features";
import { flowOf } from "./presets";
import { secretNames, validate, validateInstance } from "./schema";

export interface WorkspaceRegistry {
  list(): WorkspaceDoc[];
  get(id: string): WorkspaceDoc | undefined;
  /** The workspace and instance whose secret has this SHA-256 hex digest. */
  byDigest(digest: string): { doc: WorkspaceDoc; instance: string; role: string } | undefined;
  /** The workspace bound to a chat (and topic). */
  byChat(at: ChatRef): WorkspaceDoc | undefined;
  export(id: string): WorkspaceDoc;
  exportAll(): InstanceDoc;
  /** Creates or replaces a workspace; validated first, nothing changes when it is invalid. */
  import(doc: unknown): WorkspaceDoc;
  /** Replaces every workspace at once; validated first. */
  importAll(doc: unknown): void;
}

const clone = <X>(x: X): X => JSON.parse(JSON.stringify(x));

export function invalid(errs: string[]): Fail {
  return new Fail(400, "bad_config", errs.join(" "));
}

/** Workspaces held in memory: the standalone instance's configuration, fixed at deploy. */
export class StaticRegistry implements WorkspaceRegistry {
  protected docs = new Map<string, WorkspaceDoc>();
  private digests = new Map<string, { id: string; instance: string; role: string }>();

  constructor(
    protected secrets: Secrets,
    config?: unknown,
  ) {
    if (config !== undefined) this.importAll(config);
  }

  list() {
    return [...this.docs.values()].map(clone);
  }
  get(id: string) {
    const d = this.docs.get(id);
    return d && clone(d);
  }
  byDigest(digest: string) {
    const x = this.digests.get(digest.toLowerCase());
    const doc = x && this.docs.get(x.id);
    return doc && x ? { doc: clone(doc), instance: x.instance, role: x.role } : undefined;
  }
  byChat(at: ChatRef) {
    const d = [...this.docs.values()].find((w) => w.chat?.chatId === at.chat && (w.chat.topicId === undefined || w.chat.topicId === at.topic));
    return d && clone(d);
  }
  export(id: string) {
    const d = this.docs.get(id);
    if (!d) throw new Fail(404, "not_found", `There is no workspace '${id}'.`);
    return clone(d);
  }
  exportAll(): InstanceDoc {
    return { flowee: VERSION, workspaces: this.list() };
  }
  import(doc: unknown) {
    const errs = validate(doc);
    if (errs.length) throw invalid(errs);
    const d = clone(doc as WorkspaceDoc);
    const others = [...this.docs.values()].filter((w) => w.id !== d.id);
    const all = validateInstance({ flowee: VERSION, workspaces: [...others, d] });
    if (all.length) throw invalid(all);
    this.docs.set(d.id, d);
    this.index();
    return clone(d);
  }
  importAll(doc: unknown) {
    const d = (doc as { workspaces?: unknown }).workspaces === undefined ? { flowee: VERSION, workspaces: [doc] } : doc;
    const errs = validateInstance(d);
    if (errs.length) throw invalid(errs);
    this.docs = new Map((d as InstanceDoc).workspaces.map((w) => [w.id, clone(w)]));
    this.index();
  }
  protected index() {
    this.digests = new Map();
    for (const w of this.docs.values())
      for (const r of w.roles) {
        const h = this.secrets.get(r.secret)?.trim().toLowerCase();
        if (h) this.digests.set(h, { id: w.id, instance: r.instance, role: r.role });
      }
  }
}

/**
 * Workspaces kept in a store (the managed mode: the instance's Durable Object), each with the chat user who owns
 * it and whether it is paused. Same validation as the static registry; every change is written through.
 */
export class StoredRegistry extends StaticRegistry {
  constructor(
    secrets: Secrets,
    private db: Store,
  ) {
    super(secrets);
    db.exec("CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, doc TEXT NOT NULL, owner TEXT NOT NULL, paused INTEGER NOT NULL DEFAULT 0)");
    for (const r of db.rows<{ id: string; doc: string }>("SELECT id, doc FROM workspaces")) this.docs.set(r.id, JSON.parse(r.doc));
    this.index();
  }

  /** Re-reads the role digests (after a secret changed). */
  reindex() {
    this.index();
  }

  import(doc: unknown, owner = "") {
    const d = super.import(doc);
    const had = this.db.rows<{ owner: string }>("SELECT owner FROM workspaces WHERE id = ?", d.id)[0];
    this.db.exec("INSERT OR REPLACE INTO workspaces (id, doc, owner, paused) VALUES (?, ?, ?, ?)", d.id, JSON.stringify(d), had?.owner || owner, this.paused(d.id) ? 1 : 0);
    return d;
  }

  importAll(doc: unknown) {
    super.importAll(doc);
    const keep = new Set(this.docs.keys());
    for (const r of this.db.rows<{ id: string }>("SELECT id FROM workspaces")) if (!keep.has(r.id)) this.db.exec("DELETE FROM workspaces WHERE id = ?", r.id);
    for (const d of this.docs.values())
      this.db.exec("INSERT INTO workspaces (id, doc, owner) VALUES (?, ?, '') ON CONFLICT (id) DO UPDATE SET doc = excluded.doc", d.id, JSON.stringify(d));
  }

  remove(id: string) {
    this.docs.delete(id);
    this.db.exec("DELETE FROM workspaces WHERE id = ?", id);
    this.index();
  }

  owner(id: string) {
    return this.db.rows<{ owner: string }>("SELECT owner FROM workspaces WHERE id = ?", id)[0]?.owner;
  }

  ownedBy(user: string) {
    return this.db.rows<{ id: string }>("SELECT id FROM workspaces WHERE owner = ? ORDER BY id", user).map((r) => r.id);
  }

  paused(id: string) {
    return !!this.db.rows<{ paused: number }>("SELECT paused FROM workspaces WHERE id = ?", id)[0]?.paused;
  }

  setPaused(id: string, paused: boolean) {
    this.db.exec("UPDATE workspaces SET paused = ? WHERE id = ?", paused ? 1 : 0, id);
  }
}

/** Secret names the document references that the instance does not have. */
export const missingSecrets = (d: WorkspaceDoc, secrets: Secrets) => secretNames(d).filter((n) => !secrets.get(n));

export const digestOf = async (secret: string) => hex(await sha256(secret.trim()));

export function texts(d: WorkspaceDoc): Texts {
  const t = d.texts ?? {};
  const botName = t.botName ?? "Flowee Envoy";
  const project = t.project ?? d.id;
  const owner = t.owner ?? "Owner";
  return {
    owner,
    cardHeading: t.cardHeading ?? "For the owner",
    botName,
    project,
    welcome:
      t.welcome ??
      `👋 <b>${botName}</b> brings the ${project} inbox to your phone.

• Every ticket waiting for you arrives as a card; <i>Details</i> opens the hand-over.
• Reply to any card (or the bar under it) to answer that ticket: text, screenshots and files go to its issue.
• The buttons at the bottom walk through the open items: ◀ Prev goes back (also to a skipped one), ⏭ Skip puts the current one last, ▶ Next moves on, 📋 List shows them all.
• Type a number like <code>7</code> to open that item directly, answered ones too.
• 🔎 Search in the list finds open items by words: all must match, the start of a word is enough, <code>#7</code> finds a number, "quotes" a phrase.`,
    about: t.about ?? `Your ${project} review inbox as a todo list: tests, questions and decisions waiting for you, answered by replying.`,
    shortAbout: t.shortAbout ?? `The ${project} review inbox as a todo list.`,
    filedBody: t.filedBody ?? "Filed by the owner through Envoy; the Board writes the spec from their words.",
    untitled: t.untitled ?? "Request from the owner",
  };
}

/** The runtime settings of a document. */
export function settings(d: WorkspaceDoc): Settings {
  const f = flowOf(d);
  const flow = loadFlow(f.chart, f.options, Object.keys(GUARDS), Object.keys(ACTIONS));
  const s = d.schedule ?? {};
  return {
    id: d.id,
    flow,
    features: resolve(d.features),
    mainBranch: d.tracker.mainBranch ?? "main",
    ownerLogin: d.owners.find((o) => o.tracker)?.tracker,
    owners: d.owners.map((o) => o.chat).filter((x): x is string => !!x),
    instances: d.roles.map((r) => ({ ...r })),
    texts: texts(d),
    chat: d.chat && { chat: d.chat.chatId, ...(d.chat.topicId ? { topic: d.chat.topicId } : {}), username: d.chat.username },
    timezone: s.timezone ?? "UTC",
    digest: { from: s.digestFrom ?? 9, to: s.digestTo ?? 12 },
    // an own bot of the managed mode has its own path; the standalone bot is the instance's /telegram
    polling: d.chat?.transport === "polling",
    webhook: d.chat?.publicUrl && d.chat.transport !== "polling" ? { url: `${d.chat.publicUrl}/telegram${d.chat.managed ? `/w/${d.id}` : ""}`, secret: d.chat.webhookSecret } : undefined,
    profile: d.profile,
    ownBot: !!d.chat?.managed,
    sync: { webhooks: d.sync?.webhooks ?? "auto", reconcileMinutes: d.sync?.reconcileMinutes ?? 30, pollMinutes: d.sync?.pollMinutes ?? 1 },
  };
}

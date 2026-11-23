// Workspaces of an instance. Every API token, chat update and stored key is resolved to a workspace through here.
import { ACTIONS } from "../core/actions";
import { loadFlow } from "../core/chart";
import { Fail } from "../core/errors";
import { GUARDS } from "../core/guards";
import type { Settings, Texts } from "../core/settings";
import { hex, sha256 } from "../core/text";
import type { ChatRef } from "../ports/chat";
import type { Secrets } from "../ports/secrets";
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
  private docs = new Map<string, WorkspaceDoc>();
  private digests = new Map<string, { id: string; instance: string; role: string }>();

  constructor(
    private secrets: Secrets,
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
  private index() {
    this.digests = new Map();
    for (const w of this.docs.values())
      for (const r of w.roles) {
        const h = this.secrets.get(r.secret)?.trim().toLowerCase();
        if (h) this.digests.set(h, { id: w.id, instance: r.instance, role: r.role });
      }
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
    webhook: d.chat?.publicUrl ? { url: d.chat.publicUrl, secret: d.chat.webhookSecret } : undefined,
    profile: d.profile,
  };
}

// The setup and management conversation, chat-agnostic: steps, prompts, choices and validation. It talks to the
// user through the Chat port (views as HTML text with button rows, a reply-keyboard request where the chat has
// one) and to the instance through `WizardHost`. docs/wizard.md walks through it; docs/adapters.md says what a
// chat adapter must offer for it.
import type { RepoDoc, WorkspaceDoc } from "../config/document";
import { esc } from "../envoy/render";
import type { Button, Chat, ChatRef, ChatRequest } from "../ports/chat";

export const TTL = 24 * 3600e3;

export type Step = "bot" | "repos" | "botCreate" | "flow" | "bind" | "credential" | "roles" | "summary";
export const STEPS: Step[] = ["bot", "repos", "botCreate", "flow", "bind", "credential", "roles", "summary"];

export interface Draft {
  id?: string;
  /** Editing or importing over this existing workspace. */
  replaces?: string;
  /** The imported document the draft starts from (fields the wizard does not ask for are kept). */
  base?: WorkspaceDoc;
  bot?: "shared" | "own";
  botId?: string;
  botUsername?: string;
  /** The name the user gave the own bot when creating it (its profile keeps it). */
  botName?: string;
  repos: string[];
  preset?: string;
  features: Record<string, boolean>;
  bind?: { chat: string; topic?: number; label: string };
  bindCode?: string;
  /** The sealed tracker token, when it was given in this conversation. */
  token?: string;
  /** The tracker token is already stored for the workspace. */
  tokenStored?: boolean;
  /** The own bot's sealed token and webhook secret, until the workspace is created. */
  botToken?: string;
  hook?: string;
  /** A workspace without a chat (imported that way): the bind step is skipped. */
  noChat?: boolean;
  roles: Record<string, number>;
}

export interface Session {
  user: string;
  at: ChatRef;
  step: Step;
  back: Step[];
  draft: Draft;
  ts: number;
  /** The message showing the step. */
  msg?: number;
  /** Edit one part: the summary follows that step. */
  single?: boolean;
  /** Further imported workspaces, set up one after the other. */
  queue?: WorkspaceDoc[];
}

export type Input =
  | { kind: "press"; data: string; message?: number }
  | { kind: "text"; text: string; message: number }
  | { kind: "managed"; botId: string; username?: string; name?: string }
  | { kind: "bound"; chat: string; topic?: number; label: string };

export interface Preset {
  name: string;
  roles: string[];
  ownerRole: string;
  features: string[];
}

export interface WizardHost {
  presets(): Preset[];
  /** Why the user may not create another workspace, or null. */
  refusal(user: string, replacing?: string): string | null;
  freeId(base: string): string;
  /** Does the shared bot / own bots exist in this chat (managed-bot support)? */
  ownBots: boolean;
  botUsername?: string;
  seal(value: string): Promise<string>;
  /** Problems of the sealed token with the repositories, one sentence each (none: usable). */
  checkRepos(sealed: string, repos: string[]): Promise<string[]>;
  /** The workspace other than `except` that already has this repository. */
  repoTaken(repo: string, except?: string): string | undefined;
  /** The managed bot just created: its token stored for the draft, its webhook set. */
  adoptBot(s: Session, botId: string): Promise<void>;
  /** Creates or replaces the workspace; returns the role secrets to hand over once. */
  /** `warning`: the workspace was made, but its bot's profile was not (one sentence). */
  commit(s: Session): Promise<{ id: string; secrets: Record<string, string>; doc: WorkspaceDoc; warning?: string }>;
  load(user: string): Session | undefined;
  /** A draft over an imported document, with what the instance already holds for it filled in. */
  draftOf(doc: WorkspaceDoc): Draft;
  save(s: Session): void;
  drop(user: string): void;
  /** Where a /bind code is waiting. */
  publicUrl: string;
}

const b = (label: string, data: string): Button => ({ label, data: `w:${data}` });
const nav = (s: Session): Button[] => [...(s.back.length ? [b("◀ Back", "back")] : []), b("✖ Cancel", "cancel")];
export const aliasOf = (repo: string) => repo.split("/")[1].toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+/, "").slice(0, 32) || "repo";
const REPO = /^[\w.-]+\/[\w.-]+$/;

export interface View {
  html: string;
  buttons?: Button[][];
  request?: ChatRequest;
}

export function fresh(user: string, at: ChatRef, now: number): Session {
  return { user, at, step: "bot", back: [], draft: { repos: [], features: {}, roles: {} }, ts: now };
}

/** A draft from an existing or imported document. */
export function fromDoc(d: WorkspaceDoc, presets: Preset[]): Draft {
  const preset = "preset" in d.flow ? d.flow.preset : undefined;
  const p = presets.find((x) => x.name === preset);
  const roles: Record<string, number> = {};
  for (const r of d.roles) if (r.role !== p?.ownerRole) roles[r.role] = (roles[r.role] ?? 0) + 1;
  return {
    id: d.id,
    base: d,
    bot: d.chat?.managed ? "own" : "shared",
    repos: d.tracker.repos.map((r) => (typeof r === "string" ? r : r.repo)),
    preset,
    features: Object.fromEntries(Object.entries(d.features ?? {}).map(([k, v]) => [k, v !== false])),
    bind: d.chat ? { chat: d.chat.chatId, topic: d.chat.topicId, label: d.chat.topicId ? `chat ${d.chat.chatId}, topic ${d.chat.topicId}` : `chat ${d.chat.chatId}` } : undefined,
    roles,
  };
}

/** Secret names of a workspace made here: one prefix per workspace keeps them apart. */
export const slot = (id: string, what: string) => `W_${id.toUpperCase().replace(/-/g, "_")}_${what.toUpperCase().replace(/-/g, "_")}`;

/** Role instance names for the chosen counts: board, dev1…, tester or tester1…, and the owner. */
export function instances(roles: Record<string, number>, preset: Preset): { instance: string; role: string }[] {
  const out: { instance: string; role: string }[] = [];
  for (const role of preset.roles.filter((r) => r !== preset.ownerRole)) {
    const n = roles[role] ?? 0;
    const short = role === "developer" ? "dev" : role;
    for (let i = 1; i <= n; i++) out.push({ instance: n === 1 && role !== "developer" ? short : `${short}${i}`, role });
  }
  out.push({ instance: preset.ownerRole, role: preset.ownerRole });
  return out;
}

/** The workspace document of a finished draft; fields of an imported or existing document are kept. */
export function toDoc(d: Draft, user: string, preset: Preset, shared: { token: string; webhookSecret: string; username?: string }, publicUrl: string, api?: string): WorkspaceDoc {
  const id = d.id as string;
  const base: Partial<WorkspaceDoc> = d.base ? JSON.parse(JSON.stringify(d.base)) : {};
  // every secret a workspace made here names is its own slot: a document cannot borrow another workspace's token
  const old = new Map((base.tracker?.repos ?? []).map((r) => (typeof r === "string" ? [r, r] : [r.repo, { repo: r.repo, ...(r.alias ? { alias: r.alias } : {}), ...(r.mainBranch ? { mainBranch: r.mainBranch } : {}) }]) as [string, RepoDoc]));
  const repos: RepoDoc[] = d.repos.map((r) => old.get(r) ?? (d.repos.length > 1 ? { repo: r, alias: aliasOf(r) } : r));
  const owners = base.owners?.length ? base.owners : [{ chat: user }];
  if (!owners.some((o) => o.chat === user)) owners.push({ chat: user });
  const own = d.bot === "own";
  const doc: WorkspaceDoc = {
    ...base,
    flowee: 1,
    id,
    flow: d.preset ? { preset: d.preset } : (base.flow as WorkspaceDoc["flow"]),
    // a feature switched on keeps the options the document gave it
    ...(Object.keys(d.features).length
      ? { features: Object.fromEntries(Object.entries(d.features).map(([k, on]) => [k, on && typeof base.features?.[k as keyof typeof base.features] === "object" ? base.features?.[k as keyof typeof base.features] : on])) }
      : {}),
    tracker: { ...(base.tracker ?? {}), type: "github", repos, token: slot(id, "tracker"), ...(api && !base.tracker?.api ? { api } : {}) },
    roles: instances(d.roles, preset).map((r) => ({ ...r, secret: slot(id, r.instance) })),
    owners,
  };
  if (!Object.keys(d.features).length) delete doc.features;
  if (own && d.botName && !doc.texts?.botName) doc.texts = { ...(doc.texts ?? {}), botName: d.botName };
  if (d.bind)
    doc.chat = {
      ...(base.chat ?? {}),
      type: "telegram",
      token: own ? slot(id, "bot") : shared.token,
      webhookSecret: own ? slot(id, "hook") : shared.webhookSecret,
      chatId: d.bind.chat,
      ...(d.bind.topic ? { topicId: d.bind.topic } : {}),
      ...(own ? { managed: true, publicUrl, ...(d.botUsername ? { username: d.botUsername } : {}) } : shared.username ? { username: shared.username } : {}),
    };
  if (doc.chat && !d.bind?.topic) delete doc.chat.topicId;
  if (doc.chat && !own) {
    delete doc.chat.managed;
    delete doc.chat.publicUrl;
    delete doc.profile;
  }
  return doc;
}

export class Wizard {
  constructor(
    private chat: Chat,
    private host: WizardHost,
    private now: () => number,
  ) {}

  private preset(d: Draft) {
    const all = this.host.presets();
    return all.find((p) => p.name === d.preset) ?? all[0];
  }

  /** Whether a step still needs an answer for this draft (import and edits skip the answered ones). */
  private needed(s: Session, step: Step): boolean {
    const d = s.draft;
    switch (step) {
      case "bot":
        return !d.bot;
      case "repos":
        return !d.repos.length;
      case "botCreate":
        return d.bot === "own" && !d.botId;
      case "flow":
        return !d.preset;
      case "bind":
        return !d.bind && !d.noChat;
      case "credential":
        return !d.token && !d.tokenStored;
      case "roles":
        return !Object.keys(d.roles).length;
      case "summary":
        return true;
    }
  }

  /** Starts a new setup, or offers to resume the unfinished one. */
  async start(user: string, at: ChatRef) {
    const old = this.host.load(user);
    if (old && this.now() - old.ts < TTL)
      return this.say(at, "<b>Unfinished setup</b>\nYou started a workspace setup earlier.", [[b("▶ Resume", "resume"), b("🆕 Start over", "restart")]]);
    const why = this.host.refusal(user);
    if (why) return this.say(at, esc(why));
    const s = fresh(user, at, this.now());
    if (!this.host.ownBots) s.draft.bot = "shared";
    await this.go(s, this.first(s), false);
  }

  /** Opens the wizard over an existing or imported workspace: only the steps still missing are asked. */
  async over(user: string, at: ChatRef, draft: Draft, only?: Step, queue?: WorkspaceDoc[]) {
    const s: Session = { user, at, step: "summary", back: [], draft, ts: this.now(), ...(queue?.length ? { queue } : {}) };
    if (only) {
      s.single = true;
      if (only === "bind") delete draft.bind;
      if (only === "credential") delete draft.tokenStored;
      return this.go(s, only, false);
    }
    await this.go(s, this.first(s), false);
  }

  private first(s: Session): Step {
    return STEPS.find((x) => this.needed(s, x)) as Step;
  }

  private nextStep(s: Session): Step {
    if (s.single) return "summary";
    const i = STEPS.indexOf(s.step);
    return STEPS.slice(i + 1).find((x) => this.needed(s, x)) as Step;
  }

  private async go(s: Session, step: Step, push = true) {
    if (push && s.step !== step) s.back.push(s.step);
    s.step = step;
    s.ts = this.now();
    await this.show(s);
  }

  private async advance(s: Session) {
    await this.go(s, this.nextStep(s));
  }

  private async say(at: ChatRef, html: string, buttons?: Button[][]) {
    return this.chat.text(at, html, { html: true, ...(buttons ? { buttons } : {}) });
  }

  /** Shows the session's step (a new message; the previous step message loses its buttons). */
  async show(s: Session, note?: string) {
    const v = this.view(s);
    const html = note ? `${v.html}\n\n⚠️ ${esc(note)}` : v.html;
    if (s.msg !== undefined) await this.chat.dropButtons(s.at, s.msg).catch(() => {});
    if (v.request && this.chat.request) {
      s.msg = await this.chat.request(s.at, html, v.request);
      if (v.buttons) await this.say(s.at, "Or:", v.buttons);
    } else s.msg = await this.say(s.at, html, v.buttons);
    this.host.save(s);
  }

  view(s: Session): View {
    const d = s.draft;
    const n = nav(s);
    switch (s.step) {
      case "bot":
        return {
          html: "<b>New workspace · 1 Bot</b>\nWhich bot talks to you about this workspace?\n\n• <b>Own bot</b>: a new bot just for it, created by you and managed here (its own name, picture and commands).\n• <b>This bot</b>: I serve it myself, next to other workspaces.",
          buttons: [[b("🤖 Own bot", "bot:own"), b("💬 This bot", "bot:shared")], n],
        };
      case "repos":
        return {
          html: `<b>New workspace · 2 Repositories</b>\nSend the repository as <code>owner/name</code>; several, one per line or separated by spaces. With several, tickets are written <code>alias#12</code> (the alias is the repository's name).${d.repos.length ? `\n\nNow: ${d.repos.map((r) => `<code>${esc(r)}</code>`).join(", ")}` : ""}`,
          buttons: [...(d.repos.length ? [[b("✅ Keep these", "repos:keep")]] : []), n],
        };
      case "botCreate": {
        const name = `${(d.id ?? "flowee").replace(/-/g, " ")} envoy`.replace(/^\w/, (c) => c.toUpperCase());
        const username = `${(d.id ?? "flowee").replace(/-/g, "_").slice(0, 20)}_envoy_bot`;
        return {
          html: "<b>New workspace · Own bot</b>\nTap <b>Create the bot</b> below: Telegram asks you for its name and username (suggested from the repository) and hands it to me. I set its picture, texts, commands and settings.",
          request: { kind: "managedBot", label: "🤖 Create the bot", name, username },
          buttons: [n],
        };
      }
      case "flow": {
        const p = this.preset(d);
        const presets = this.host.presets();
        const rows: Button[][] = [presets.map((x) => b(`${x.name === d.preset ? "● " : ""}${x.name}`, `flow:${x.name}`))];
        if (d.preset) for (const f of p.features) rows.push([b(`${d.features[f] ? "✅" : "⬜"} ${f}`, `feat:${f}`)]);
        if (d.preset) rows.push([b("Next ▶", "flow:done")]);
        return {
          html: `<b>New workspace · 3 Flow</b>\nPick the flow preset${d.preset && p.features.length ? ", then switch the features you want" : ""}.\n\n• <b>trunk</b>: developers commit straight to the main branch.\n${presets.some((x) => x.name === "pr-release") ? "• <b>pr-release</b>: branches, pull requests and releases.\n" : ""}`,
          buttons: [...rows, n],
        };
      }
      case "bind": {
        const bot = d.bot === "own" ? (d.botUsername ? `@${d.botUsername}` : "your new bot") : this.host.botUsername ? `@${this.host.botUsername}` : "this bot";
        return {
          html: `<b>New workspace · 4 Where</b>\nWhere should ${esc(bot)} bring the cards?\n\n• <b>This private chat</b>${d.bot === "own" ? " (open the new bot and press Start first)" : ""}.\n• <b>A group</b>, or <b>one topic</b> of a forum group: add ${esc(bot)} to the group, then send\n<code>/bind ${d.bindCode}</code>\nin the group, inside the topic to bind only that topic.`,
          ...(d.bot !== "own" ? { request: { kind: "chat", label: "👥 Pick a group" } as ChatRequest } : {}),
          buttons: [[b("💬 This private chat", "bind:here")], n],
        };
      }
      case "credential":
        return {
          html: `<b>New workspace · 5 GitHub token</b>\nSend a GitHub token for ${d.repos.map((r) => `<code>${esc(r)}</code>`).join(", ")}. <b>I delete your message right after reading it</b>; the token is stored encrypted and never shown again or exported.\n\nA fine-grained token limited to these repositories, with:\n• Issues: read and write\n• Metadata: read\n• Contents: read${d.features.pullRequests ? "\n• Pull requests: read and write, Checks: read, Commit statuses: read, Contents: read and write" : ""}${d.features.releases ? "\n• Contents: read and write (the tested tag)" : ""}`,
          buttons: [n],
        };
      case "roles": {
        const p = this.preset(d);
        const rows = p.roles
          .filter((r) => r !== p.ownerRole)
          .map((r) => [b("−", `role:${r}:-1`), { label: `${r}: ${d.roles[r] ?? 0}` }, b("+", `role:${r}:1`)]);
        return {
          html: "<b>New workspace · 6 Agents</b>\nHow many agents of each role? Each gets its own secret; you get them once at the end, with a ready <code>.flowee.toml</code>.",
          buttons: [...rows, [b("Next ▶", "roles:done")], n],
        };
      }
      case "summary":
        return { html: this.summary(s), buttons: [[b("✅ Create", "confirm")], n] };
    }
  }

  private summary(s: Session) {
    const d = s.draft;
    const p = this.preset(d);
    const on = Object.entries(d.features).filter(([, v]) => v).map(([k]) => k);
    const agents = instances(d.roles, p).filter((r) => r.role !== p.ownerRole).map((r) => r.instance);
    return [
      `<b>${d.replaces ? "Replace" : "Create"} workspace <code>${esc(d.id ?? "")}</code></b>`,
      `Bot: ${d.bot === "own" ? `own${d.botUsername ? ` (@${esc(d.botUsername)})` : ""}` : "this bot"}`,
      `Repositories: ${d.repos.map((r) => `<code>${esc(r)}</code>`).join(", ")}`,
      `Flow: ${esc(d.preset ?? "inline")}${on.length ? ` (${on.map(esc).join(", ")})` : ""}`,
      `Cards go to: ${esc(d.bind?.label ?? "nowhere (API only)")}`,
      `GitHub token: ${d.token ? "given, checked" : d.tokenStored ? "kept" : "missing"}`,
      `Agents: ${agents.map(esc).join(", ") || "none"}; new secrets for all of them`,
    ].join("\n");
  }

  /** One input for the user's open session; false when there is none (the input is not the wizard's). */
  async input(user: string, at: ChatRef, i: Input): Promise<boolean> {
    const s = this.host.load(user);
    if (i.kind === "press" && i.data === "w:restart") {
      this.host.drop(user);
      await this.start(user, at);
      return true;
    }
    if (!s) {
      if (i.kind === "press" && i.data.startsWith("w:")) await this.say(at, "This setup expired or was finished. /setup starts a new one.");
      return i.kind === "press" && i.data.startsWith("w:");
    }
    if (this.now() - s.ts > TTL) {
      this.host.drop(user);
      await this.say(at, "That setup expired after a day without an answer; nothing was created. /setup starts a new one.");
      return true;
    }
    if (i.kind === "bound") {
      s.draft.bind = { chat: i.chat, topic: i.topic, label: i.label };
      await this.say(s.at, `Bound to ${esc(i.label)}.`);
      await this.advance(s);
      return true;
    }
    if (i.kind === "managed") {
      if (s.step !== "botCreate") return false;
      await this.host.adoptBot(s, i.botId);
      s.draft.botId = i.botId;
      s.draft.botUsername = i.username;
      s.draft.botName = i.name;
      if (this.chat.dropKeyboard) await this.chat.dropKeyboard(s.at, `🤖 @${i.username ?? i.botId} is yours; I manage it from here.`).catch(() => {});
      await this.advance(s);
      return true;
    }
    if (i.kind === "text") return this.text(s, i.text, i.message);
    if (!i.data.startsWith("w:")) return false;
    await this.press(s, i.data.slice(2));
    return true;
  }

  private async press(s: Session, data: string) {
    const d = s.draft;
    const [k, v, w] = data.split(":");
    switch (k) {
      case "resume":
        return this.show(s);
      case "cancel":
        this.host.drop(s.user);
        if (s.msg !== undefined) await this.chat.dropButtons(s.at, s.msg).catch(() => {});
        if (this.chat.dropKeyboard) await this.chat.dropKeyboard(s.at, "✖ Cancelled; nothing was changed.").catch(() => {});
        else await this.say(s.at, "✖ Cancelled; nothing was changed.");
        return;
      case "back": {
        const prev = s.back.pop();
        if (!prev) return this.show(s);
        if (s.single) s.single = false;
        return this.go(s, prev, false);
      }
      case "bot":
        if (v === "own" && !this.host.ownBots) return this.show(s, "Own bots are not available on this instance.");
        d.bot = v === "own" ? "own" : "shared";
        return this.advance(s);
      case "repos":
        return this.advance(s);
      case "flow":
        if (v === "done") return this.advance(s);
        if (d.preset !== v) d.features = {};
        d.preset = v;
        return this.show(s);
      case "feat":
        d.features[v] = !d.features[v];
        return this.show(s);
      case "bind":
        d.bind = { chat: s.at.chat, label: "this private chat" };
        return this.advance(s);
      case "role": {
        const n = Math.max(0, Math.min(9, (d.roles[v] ?? 0) + Number(w)));
        d.roles[v] = n;
        return this.show(s);
      }
      case "roles":
        if (!Object.values(d.roles).some((x) => x > 0)) return this.show(s, "At least one agent is needed.");
        return this.advance(s);
      case "confirm":
        return this.confirm(s);
    }
  }

  private async text(s: Session, text: string, message: number): Promise<boolean> {
    const d = s.draft;
    if (s.step === "credential") {
      // the token never stays in the chat: deleted before anything else happens
      const gone = await this.chat.remove(s.at, message).then(
        () => "Your message was deleted.",
        (e) => `I could not delete your message (${e instanceof Error ? e.message : e}); delete it yourself.`,
      );
      const token = text.trim();
      if (!/^[\w-]{20,255}$/.test(token)) {
        await this.show(s, `${gone} That does not look like a GitHub token; send just the token.`);
        return true;
      }
      const sealed = await this.host.seal(token);
      const problems = await this.host.checkRepos(sealed, d.repos);
      if (problems.length) {
        await this.show(s, `${gone} ${problems.join(" ")}`);
        return true;
      }
      d.token = sealed;
      await this.say(s.at, `🔒 Token checked and stored. ${esc(gone)}`);
      await this.advance(s);
      return true;
    }
    if (s.step === "repos") {
      const repos = [...new Set(text.split(/[\s,]+/).filter(Boolean))];
      const bad = repos.filter((r) => !REPO.test(r));
      if (!repos.length || bad.length) {
        await this.show(s, `${bad.map((x) => `'${x}'`).join(", ") || "That"} ${bad.length > 1 ? "are" : "is"} not owner/name.`);
        return true;
      }
      const taken = repos.find((r) => this.host.repoTaken(r, d.replaces));
      if (taken) {
        await this.show(s, `'${taken}' is already in workspace '${this.host.repoTaken(taken, d.replaces)}'; a repository belongs to one workspace only.`);
        return true;
      }
      const aliases = repos.map(aliasOf);
      const dup = aliases.find((a, i) => aliases.indexOf(a) !== i);
      if (dup) {
        await this.show(s, `Two repositories would both be '${dup}'; import a document with your own aliases instead.`);
        return true;
      }
      d.repos = repos;
      if (!d.id) d.id = this.host.freeId(aliasOf(repos[0]));
      if (!d.bindCode) d.bindCode = d.id;
      await this.advance(s);
      return true;
    }
    return false;
  }

  private async confirm(s: Session) {
    const why = this.host.refusal(s.user, s.draft.replaces);
    if (why) return this.show(s, why);
    let r: Awaited<ReturnType<WizardHost["commit"]>>;
    try {
      r = await this.host.commit(s);
    } catch (e) {
      return this.show(s, e instanceof Error ? e.message : String(e));
    }
    this.host.drop(s.user);
    if (s.msg !== undefined) await this.chat.dropButtons(s.at, s.msg).catch(() => {});
    const names = Object.keys(r.secrets);
    await this.say(
      s.at,
      `✅ Workspace <code>${esc(r.id)}</code> is ${s.draft.replaces ? "updated" : "ready"}.${r.warning ? ` ⚠️ ${esc(r.warning)}` : ""}${names.length ? " The file below holds each agent's secret: <b>shown this once</b>, only their digests are stored. Put each next to its agent and delete the file." : ""}\n/workspaces manages it.`,
    );
    if (names.length) await this.handOver(s.at, r.id, r.secrets);
    const [next, ...rest] = s.queue ?? [];
    if (next) await this.over(s.user, s.at, this.host.draftOf(next), undefined, rest);
  }

  /** The agents' secrets with a ready .flowee.toml, once, as a file (or a message without file support). */
  async handOver(at: ChatRef, id: string, secrets: Record<string, string>) {
    const toml = [
      `url = "${this.host.publicUrl}"`,
      `workspace = "${id}"`,
      `instance = "${Object.keys(secrets)[0]}"            # each agent its own, or FLOWEE_AS`,
      `secret_file = "~/.secrets/flowee/{workspace}/{instance}"   # or FLOWEE_TOKEN`,
    ].join("\n");
    const body = `# Flowee workspace ${id}: agent secrets (shown once; only digests are stored)\n${Object.entries(secrets)
      .map(([k, v]) => `${k} = ${v}`)
      .join("\n")}\n\n# .flowee.toml\n${toml}\n`;
    // shown once: a refused file must not lose them, so they come as a message instead
    if (this.chat.sendFile && (await this.chat.sendFile(at, `flowee-${id}-secrets.txt`, body, "Agent secrets: shown once.").then(() => true, () => false))) return;
    await this.say(at, `<pre>${esc(body)}</pre>`);
  }
}

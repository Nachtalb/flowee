// The setup conversation, chat-agnostic: steps, screens, choices and validation. Every screen is a view built from
// the envoy's blocks (docs/chat-style.md) shown in one living message that each step edits; typed answers are
// deleted after reading. It reaches the instance through `WizardHost`; docs/managed.md walks through it.
import type { RepoDoc, WorkspaceDoc } from "../config/document";
import type { ExtensionRef } from "../config/presets";
import type { TrackerKind } from "../config/trackers";
import { btn, copyBtn, esc, facts, heading, linkBtn, option, options, question, row, text, warning } from "../envoy/render";
import { type Block, type Chat, type ChatRef, type ChatRequest, live, type View } from "../ports/chat";
import { TOKEN_DAYS, type TokenHelp } from "../ports/tracker";
import { fromFile, INPUTS, type OptionSpec, parse, problem, shown, type Values, valuesOf, written } from "./inputs";

/** A workspace's tracker: its kind and, when not the default one, its API (GitHub Enterprise, a self-managed GitLab). */
export interface TrackerRef {
  kind: TrackerKind;
  api?: string;
}

/** A pasted repository link as the host recognised it. */
export interface PastedRepo extends TrackerRef {
  repo: string;
}

export const TTL = 24 * 3600e3;

export type Step = "repos" | "bot" | "botCreate" | "flow" | "bind" | "credential" | "roles" | "summary";
export const STEPS: Step[] = ["repos", "bot", "botCreate", "flow", "bind", "credential", "roles", "summary"];
/** The steps counted in "Step k of n"; creating the bot belongs to the bot step. */
const COUNTED: Step[] = ["repos", "bot", "flow", "bind", "credential", "roles"];

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
  /** The tracker the repositories are on (default GitHub). */
  tracker?: TrackerRef;
  /** Single branch or feature branches (`features.pullRequests`); chosen in the flow step. */
  branching?: "single" | "feature";
  /** The other switches: versioning (`releases`) and the more options. */
  features: Record<string, boolean>;
  /** Flow extensions of the workspace (inline or `builtin:<name>`), in order. */
  extensions?: ExtensionRef[];
  /** The values an option asked for (its follow-up screen), by option; kept when it is switched off. */
  inputs?: Record<string, Record<string, unknown>>;
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
  /** The steps this setup asks, for "Step k of n". */
  plan?: Step[];
  /** A second screen of the step: the group instructions of the bind step, the options after the branching, a token wider than needed. */
  sub?: "group" | "options" | "wide" | "input" | "ext";
  /** Sub `ext`: the problems of the extension file just sent, one sentence each. */
  extProblems?: string[];
  /** The repositories a pasted token reaches besides the workspace's (sub `wide`). */
  wide?: string[];
  /** Sub `input`: the option whose values are asked, and the one value the next typed message is for. */
  input?: string;
  typing?: string;
  /** The message carrying the reply keyboard of the bot step, removed when the step is left. */
  helper?: number;
  /** Edit one part: the summary follows that step. */
  single?: boolean;
  /** Further imported workspaces, set up one after the other. */
  queue?: WorkspaceDoc[];
}

export type Input =
  | { kind: "press"; data: string; message?: number }
  | { kind: "text"; text: string; message: number }
  | { kind: "file"; name: string; text: string; message: number }
  | { kind: "managed"; botId: string; username?: string; name?: string }
  | { kind: "bound"; chat: string; topic?: number; label: string };

/** The flow the wizard sets up: its roles and the switches its chart has. */
export interface FlowInfo {
  roles: string[];
  ownerRole: string;
  features: string[];
  /** How the texts name each role (`the tester`); an extension's role is described by it. */
  who?: Record<string, string>;
  /** Roles that exist only with some features: `uiReview`, `!uiReview`, `pullRequests.merger=flow`. */
  roleFeatures?: Record<string, string[]>;
}

export interface WizardHost {
  /** The flow's roles and switches; for a draft, with its extensions merged. */
  flow(d?: Draft): FlowInfo;
  /** Why the user may not create another workspace, or null. */
  refusal(user: string, replacing?: string): string | null;
  freeId(base: string): string;
  /** The repository and its tracker of a pasted link or path (the tracker adapters know the shapes). */
  parseRepo(ref: string): PastedRepo | undefined;
  /** The token's permissions on this tracker and a link to the filled-in token form. */
  tokenHelp(t: TrackerRef): TokenHelp;
  /** The tracker's name for the screens (`GitHub`, `GitLab`). */
  trackerName(kind?: TrackerKind): string;
  /** Does the shared bot / own bots exist in this chat (managed-bot support)? */
  ownBots: boolean;
  /** The setup runs in the terminal: the workspace's inbox is the terminal too, so no chat is chosen. */
  terminal?: boolean;
  botUsername?: string;
  seal(value: string): Promise<string>;
  /** Problems of the sealed token with the repositories on that tracker, one sentence each (none: usable). */
  checkRepos(sealed: string, repos: string[], t: TrackerRef): Promise<string[]>;
  /** Repositories besides `repos` the sealed token reaches (none, or unknown: empty). */
  wider?(sealed: string, repos: string[], t: TrackerRef): Promise<string[]>;
  /** Problems of these extensions merged into the flow, one sentence each with its JSON path (none: usable). */
  extensionProblems?(exts: ExtensionRef[], features: Record<string, unknown>): string[];
  /** Days a new tracker token lives when the document names none (`tracker.tokenDays`). */
  tokenDays?: number | "none";
  /** The workspace other than `except` that already has this repository. */
  repoTaken(repo: string, except: string | undefined, t: TrackerRef): string | undefined;
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
  /** The user's living message (docs/chat-style.md). */
  live(user: string): number | undefined;
  setLive(user: string, id: number): void;
}

const b = (label: string, data: string) => btn(label, `w:${data}`);
/** An extension's name on the screens. */
export const extName = (e: ExtensionRef | undefined) => (typeof e === "string" ? e.replace(/^builtin:/, "") : String((e as { name?: unknown } | undefined)?.name ?? "unnamed"));
export const aliasOf = (repo: string) => (repo.split("/").at(-1) ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+/, "").slice(0, 32) || "repo";
const code = (s: string) => `<code>${esc(s)}</code>`;

const BRANCHING: Record<"single" | "feature", [string, string, string]> = {
  single: ["🌿", "Single branch", "The agents commit straight to the main branch; the tester tests the main branch."],
  feature: ["🔀", "Feature branches", "One branch and one pull request per ticket; its checks must be green, and it is merged when the tester passes it."],
};
/** Versioning first, then the more options; each works with either branching. A third text: the row when off. */
const OPTIONS: Record<string, [string, string, string?]> = {
  releases: ["Versioning", "You get a test card only once a published version has the ticket's code; the card says “In 1.4 or later”."],
  uiReview: ["UI review", "A pass that changes the screens comes to you first; it needs the paths that count as UI."],
  dependencyTickets: ["Dependency updates", "Each update pull request (e.g. Dependabot) becomes a ticket the developers merge."],
  userFeedback: ["User feedback", "Tickets carrying the feedback label are triaged by the board automatically.", "Tickets carrying the feedback label wait for a human first."],
};
export const ROLES: Record<string, [string, string]> = {
  board: ["🧭 Board", "Plans and sorts the tickets, and asks you."],
  developer: ["🛠 Developers", "Build what the tickets ask for."],
  tester: ["🧪 Testers", "Test each ticket before it closes."],
};
/** The way of working in words: the branching, then every option switched on. */
export const wayOf = (features: Record<string, unknown> = {}) =>
  [BRANCHING[features.pullRequests ? "feature" : "single"][1], ...Object.keys(OPTIONS).filter((f) => features[f] && (features[f] as { autoTriage?: boolean }).autoTriage !== false).map((f) => OPTIONS[f][0])].join(", ");
/** A role's name on the screens; an extension's role by its own name. */
export const roleName = (r: string) => ROLES[r]?.[0] ?? `🧩 ${esc(r)}`;

/** The parts of a screen: text blocks, then button rows; a warning goes between them. */
interface Screen {
  body: Block[];
  rows: Block[];
  keyboard?: ChatRequest;
}

/** The user's living message: every screen edits it; a typed command shows the screen anew at the bottom. */
export class Living {
  constructor(
    private chat: Chat,
    private host: Pick<WizardHost, "live" | "setLive">,
  ) {}

  async show(user: string, at: ChatRef, view: View, bottom = false): Promise<number> {
    const old = this.host.live(user);
    const id = await live(this.chat, at, bottom ? undefined : old, view);
    if (old !== undefined && old !== id) await this.chat.remove(at, old).catch(() => {});
    this.host.setLive(user, id);
    return id;
  }

  /** A button was pressed on `message`: that message lives on; an older living one goes. */
  async adopt(user: string, at: ChatRef, message?: number) {
    if (message === undefined) return;
    const old = this.host.live(user);
    if (old !== undefined && old !== message) await this.chat.remove(at, old).catch(() => {});
    this.host.setLive(user, message);
  }
}

/** Shown in a group (or topic) the moment it is chosen for a workspace's tickets. */
export const boundView = (id: string): View => [
  heading("✅", `Tickets of ${code(id)} appear here`),
  text("Your team works the tickets together: reply to a card to answer it, and the ticket records who answered."),
];

/** Something failed: one sentence, and the way back. */
export const failedView = (why: string, setup: boolean): View => [
  heading("⚠️", "That did not work"),
  text(esc(why)),
  row(setup ? b("▶ Continue the setup", "resume") : b("🚀 Set up a workspace", "new")),
];

export function fresh(user: string, at: ChatRef, now: number): Session {
  // user feedback is a choice either way: off, a ticket with the label waits for a human first
  return { user, at, step: "bot", back: [], draft: { repos: [], features: { userFeedback: false }, roles: {} }, ts: now };
}

/** A chat as its owner knows it, without its title. */
export const chatLabel = (chat: string, topic?: number) => (!chat.startsWith("-") ? "a private chat" : topic ? "one topic of your group" : "your group");

/** A draft from an existing or imported document. */
export function fromDoc(d: WorkspaceDoc, flow: FlowInfo): Draft {
  const roles: Record<string, number> = {};
  for (const r of d.roles) if (r.role !== flow.ownerRole) roles[r.role] = (roles[r.role] ?? 0) + 1;
  const { pullRequests, untrustedReports, ...features } = d.features ?? {};
  // the former name: automatic triage of user feedback
  if (untrustedReports && features.userFeedback === undefined) features.userFeedback = true;
  return {
    id: d.id,
    base: d,
    bot: d.chat?.managed ? "own" : "shared",
    repos: d.tracker.repos.map((r) => (typeof r === "string" ? r : r.repo)),
    tracker: { kind: d.tracker.type ?? "github", ...(d.tracker.api ? { api: d.tracker.api } : {}) },
    branching: pullRequests ? "feature" : "single",
    features: Object.fromEntries(Object.entries(features).map(([k, v]) => [k, v !== false && !(k === "userFeedback" && typeof v === "object" && (v as { autoTriage?: boolean }).autoTriage === false)])),
    ...(d.extensions?.length ? { extensions: structuredClone(d.extensions) } : {}),
    bind: d.chat ? { chat: d.chat.chatId, topic: d.chat.topicId, label: chatLabel(d.chat.chatId, d.chat.topicId) } : undefined,
    roles,
  };
}

/** Secret names of a workspace made here: one prefix per workspace keeps them apart. */
export const slot = (id: string, what: string) => `W_${id.toUpperCase().replace(/-/g, "_")}_${what.toUpperCase().replace(/-/g, "_")}`;

/** Role instance names for the chosen counts: board, dev1…, tester or tester1…, and the owner. */
export function instances(roles: Record<string, number>, preset: FlowInfo): { instance: string; role: string }[] {
  const out: { instance: string; role: string }[] = [];
  for (const role of preset.roles.filter((r) => r !== preset.ownerRole)) {
    const n = roles[role] ?? 0;
    const short = role === "developer" ? "dev" : role;
    for (let i = 1; i <= n; i++) out.push({ instance: n === 1 && role !== "developer" ? short : `${short}${i}`, role });
  }
  out.push({ instance: preset.ownerRole, role: preset.ownerRole });
  return out;
}

/** User feedback as written: its options (also from the former `untrustedReports`) with the switch as `autoTriage`. */
function feedbackDoc(f: WorkspaceDoc["features"], on: boolean, asked?: Values) {
  const old = f?.userFeedback ?? f?.untrustedReports;
  const { autoTriage: _, ...opts } = written("userFeedback", { ...((typeof old === "object" ? old : {}) as Values), ...(asked ?? {}) });
  return Object.keys(opts).length || !on ? { ...opts, autoTriage: on } : true;
}

/** A switched-on feature as written: the document's options with what the wizard asked over them. */
function withInputs(k: string, old: unknown, asked: Values | undefined, on: boolean): unknown {
  const opts = written(k, { ...((typeof old === "object" ? old : {}) as Values), ...(asked ?? {}) });
  return Object.keys(opts).length ? opts : on;
}

/** The workspace document of a finished draft; fields of an imported or existing document are kept. */
export function toDoc(d: Draft, user: string, preset: FlowInfo, shared: { token: string; webhookSecret: string; username?: string }, publicUrl: string, api?: string): WorkspaceDoc {
  const id = d.id as string;
  const base: Partial<WorkspaceDoc> = d.base ? JSON.parse(JSON.stringify(d.base)) : {};
  // every secret a workspace made here names is its own slot: a document cannot borrow another workspace's token
  const old = new Map((base.tracker?.repos ?? []).map((r) => (typeof r === "string" ? [r, r] : [r.repo, { repo: r.repo, ...(r.alias ? { alias: r.alias } : {}), ...(r.mainBranch ? { mainBranch: r.mainBranch } : {}) }]) as [string, RepoDoc]));
  const repos: RepoDoc[] = d.repos.map((r) => old.get(r) ?? (d.repos.length > 1 ? { repo: r, alias: aliasOf(r) } : r));
  const owners = base.owners?.length ? base.owners : [{ chat: user }];
  // a manager changing the workspace does not become one of its owners
  if (!owners.some((o) => o.chat === user) && !base.managers?.includes(user)) owners.push({ chat: user });
  const own = d.bot === "own";
  const doc: WorkspaceDoc = {
    ...base,
    flowee: 1,
    id,
    // the starting point that matches the branching; an inline chart stays
    flow: base.flow && "chart" in base.flow ? base.flow : { preset: d.branching === "feature" ? "pr-release" : "trunk" },
    // a feature switched on keeps the options the document gave it
    features: Object.fromEntries(
      Object.entries({ ...d.features, pullRequests: d.branching === "feature" })
        .filter(([k, on]) => on || k === "userFeedback")
        .map(([k, on]) => [k, k === "userFeedback" ? feedbackDoc(base.features, on, d.inputs?.[k]) : withInputs(k, base.features?.[k as keyof typeof base.features], d.inputs?.[k], on)]),
    ),
    tracker: {
      ...(base.tracker ?? {}),
      type: d.tracker?.kind ?? "github",
      repos,
      token: slot(id, "tracker"),
      // a self-managed or Enterprise tracker names its API; the instance's GitHub API applies to GitHub only
      ...(d.tracker?.api ? { api: d.tracker.api } : api && (d.tracker?.kind ?? "github") === "github" && !base.tracker?.api ? { api } : {}),
    },
    roles: instances(d.roles, preset).map((r) => ({ ...r, secret: slot(id, r.instance) })),
    owners,
  };
  if (!Object.keys(doc.features ?? {}).length) delete doc.features;
  if (d.extensions?.length) doc.extensions = structuredClone(d.extensions);
  else delete doc.extensions;
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
  readonly living: Living;

  constructor(
    private chat: Chat,
    private host: WizardHost,
    private now: () => number,
  ) {
    this.living = new Living(chat, host);
  }

  /** The lifetime a new token is asked for: the document's, else the instance's, else the longest GitHub allows. */
  private tokenDays(d: Draft): number | "none" {
    return d.base?.tracker?.tokenDays ?? this.host.tokenDays ?? TOKEN_DAYS;
  }

  /** Every switch of the draft, the branching included. */
  private switches(d: Draft): Record<string, boolean> {
    return { ...d.features, pullRequests: d.branching === "feature" };
  }

  /** Whether a step still needs an answer for this draft (import and edits skip the answered ones). */
  private needed(s: Session, step: Step): boolean {
    const d = s.draft;
    switch (step) {
      case "repos":
        return !d.repos.length;
      case "bot":
        return !d.bot;
      case "botCreate":
        return d.bot === "own" && !d.botId;
      case "flow":
        return !d.branching;
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

  /** Starts a new setup, or offers to resume the unfinished one; `bottom`: asked by a typed command. */
  async start(user: string, at: ChatRef, bottom = false) {
    const old = this.host.load(user);
    if (old && this.now() - old.ts < TTL)
      return this.living.show(
        user,
        at,
        [heading("🆕", "New workspace"), question("Continue the setup you started?"), text("You began setting up a workspace earlier and did not finish it."), row(b("▶ Continue", "resume"), b("🆕 Start over", "restart"))],
        bottom,
      );
    const why = this.host.refusal(user);
    if (why) return this.living.show(user, at, [heading("⚠️", "You cannot set up a workspace"), text(esc(why)), row(btn("📂 My workspaces", "m:list"))], bottom);
    const s = fresh(user, at, this.now());
    if (!this.host.ownBots) s.draft.bot = "shared";
    if (this.host.terminal) s.draft.noChat = true;
    s.plan = COUNTED.filter((x) => this.needed(s, x));
    await this.go(s, this.first(s), false, { bottom });
  }

  /** Opens the wizard over an existing or imported workspace: only the steps still missing are asked. */
  async over(user: string, at: ChatRef, draft: Draft, only?: Step, queue?: WorkspaceDoc[], o: { lead?: Block[]; bottom?: boolean } = {}) {
    const s: Session = { user, at, step: "summary", back: [], draft, ts: this.now(), ...(queue?.length ? { queue } : {}) };
    if (only) {
      s.single = true;
      if (only === "bind") delete draft.bind;
      if (only === "credential") delete draft.tokenStored;
      if (only === ("ext" as Step)) {
        s.step = "flow";
        s.sub = "ext";
        return this.show(s, o);
      }
      return this.go(s, only, false, o);
    }
    s.plan = COUNTED.filter((x) => this.needed(s, x) || (x === "bot" && this.needed(s, "botCreate")));
    await this.go(s, this.first(s), false, o);
  }

  private first(s: Session): Step {
    return STEPS.find((x) => this.needed(s, x)) as Step;
  }

  private nextStep(s: Session): Step {
    if (s.single) return "summary";
    const i = STEPS.indexOf(s.step);
    return STEPS.slice(i + 1).find((x) => this.needed(s, x)) as Step;
  }

  private async go(s: Session, step: Step, push = true, o: { note?: string; lead?: Block[]; bottom?: boolean } = {}) {
    if (push && s.step !== step) s.back.push(s.step);
    s.step = step;
    delete s.sub;
    s.ts = this.now();
    const roles = this.agentRoles(s.draft);
    for (const r of Object.keys(s.draft.roles)) if (!roles.includes(r)) delete s.draft.roles[r];
    if (step === "roles" && !Object.keys(s.draft.roles).length) for (const r of roles) s.draft.roles[r] = 1;
    await this.show(s, o);
  }

  private async advance(s: Session, o: { note?: string } = {}) {
    await this.go(s, this.nextStep(s), true, o);
  }

  /** The roles agents can have with the draft's features. */
  agentRoles(d: Draft) {
    const p = this.host.flow(d);
    const on = this.switches(d);
    const holds = (t: string) => !!on[t.replace(/^!/, "").split(/[.=]/)[0]] !== t.startsWith("!");
    return p.roles.filter((r) => r !== p.ownerRole && (p.roleFeatures?.[r] ?? []).every(holds));
  }

  /** Shows the session's step in the living message; `note` is one sentence under the prompt. */
  async show(s: Session, o: { note?: string; lead?: Block[]; bottom?: boolean } = {}) {
    const v = this.screen(s);
    const [top, ...body] = v.body;
    if (!v.keyboard) await this.dropHelper(s);
    await this.living.show(s.user, s.at, [top, ...(o.lead ?? []), ...body, ...(o.note ? [warning(o.note)] : []), ...v.rows], o.bottom);
    // the one reply keyboard: the bot can be created only from a keyboard button (docs/telegram.md)
    if (v.keyboard && s.helper === undefined) s.helper = await this.chat.view(s.at, [text("👇 Tap <b>🤖 Create the bot</b> on the keyboard below.")], { keyboard: v.keyboard });
    this.host.save(s);
  }

  /** Takes the reply keyboard away and deletes the message that carried it. */
  private async dropHelper(s: Session) {
    if (s.helper === undefined) return;
    const gone = await this.chat.view(s.at, [text("👌")], { removeKeyboard: true }).catch(() => undefined);
    for (const id of [gone, s.helper]) if (id !== undefined) await this.chat.remove(s.at, id).catch(() => {});
    delete s.helper;
  }

  /** The bottom row: Back (when there is a way back), Next (`next`: its data), Cancel. */
  private nav(s: Session, next?: string): Block {
    return row(...(s.back.length || s.sub ? [b("◀ Back", "back")] : []), ...(next ? [b("▶ Next", next)] : []), b("✖ Cancel", "cancel"));
  }

  private top(s: Session, last = false): Block {
    const d = s.draft;
    if (s.single || d.replaces) return heading("✏️", `Change ${code(d.replaces ?? d.id ?? "")}`);
    const plan = s.plan ?? COUNTED;
    const k = plan.indexOf(s.step === "botCreate" ? "bot" : s.step) + 1;
    return heading("🆕", "New workspace", ...(last ? ["Last check"] : k ? [`Step ${k} of ${plan.length}`] : []));
  }

  private botOf(d: Draft) {
    return d.bot === "own" ? d.botUsername : this.host.botUsername;
  }

  /** Where the tickets go, in the words of the person setting it up. */
  private where(s: Session) {
    const d = s.draft;
    if (!d.bind) return this.host.terminal ? "in the terminal (flowee-tui): you first, more people in the menu" : "nowhere: the workspace is used through its API only";
    if (d.bind.chat !== s.user) return esc(d.bind.label);
    return d.bot === "own" ? `your private chat with ${d.botUsername ? `@${esc(d.botUsername)}` : "its bot"}` : "here, in this chat";
  }

  private screen(s: Session): Screen {
    const d = s.draft;
    const nav = this.nav(s);
    const top = this.top(s);
    switch (s.step) {
      case "repos":
        return {
          body: [
            top,
            question("Which repository is this workspace for?"),
            text(`Paste the repository's link from GitHub or GitLab, for example ${code("https://github.com/octo/app")}. Several: one per line.`),
            ...(d.repos.length ? [text(`Now: ${d.repos.map(code).join(", ")} on ${this.host.trackerName(d.tracker?.kind)}`)] : []),
          ],
          rows: [...(d.repos.length ? [row(b(`✅ Keep ${d.repos.length > 1 ? "these" : esc(d.repos[0])}`, "repos:keep"))] : []), nav],
        };
      case "bot": {
        const me = this.host.botUsername ? ` (@${esc(this.host.botUsername)})` : "";
        return {
          body: [
            top,
            question("Which bot should bring you the tickets?"),
          ],
          rows: [
            options(
              option(`💬 This bot${me}`, "I bring them myself, next to your other workspaces.", b(d.bot === "shared" ? "● Chosen" : "💬 Choose", "bot:shared")),
              option("🤖 A new bot", "Its own name and picture; you create it with two taps, I set it up.", b(d.bot === "own" ? "● Chosen" : "🤖 Choose", "bot:own")),
            ),
            nav,
          ],
        };
      }
      case "botCreate": {
        const base = d.id ?? "flowee";
        const name = `${base.replace(/-/g, " ")} envoy`.replace(/^\w/, (c) => c.toUpperCase());
        const username = `${base.replace(/-/g, "_").slice(0, 20)}_envoy_bot`;
        return {
          body: [
            top,
            question("Create the new bot"),
            text(`Tap <b>🤖 Create the bot</b> on the keyboard below. Telegram suggests the name <b>${esc(name)}</b> and the username ${code(`@${username}`)}; keep them or change them, then confirm.`),
          ],
          rows: [nav],
          keyboard: { kind: "managedBot", label: "🤖 Create the bot", name, username },
        };
      }
      case "flow": {
        if (s.sub !== "options" && s.sub !== "input" && s.sub !== "ext")
          return {
            body: [top, question("How should the agents bring in their code?"), text("Choose one. Versioning and the other options come next; each works with either.")],
            rows: [
              options(
                ...(["single", "feature"] as const).map((k) => option(`${BRANCHING[k][0]} ${BRANCHING[k][1]}`, BRANCHING[k][2], b(d.branching === k ? "● Chosen" : `${BRANCHING[k][0]} Choose`, `branch:${k}`))),
              ),
              nav,
            ],
          };
        if (s.sub === "input") return this.inputScreen(s);
        if (s.sub === "ext") return this.extScreen(s);
        const offered = Object.keys(OPTIONS).filter((f) => this.host.flow().features.includes(f));
        const toggle = (f: string) =>
          option(
            `${d.features[f] ? "✅" : "⬜"} ${OPTIONS[f][0]}`,
            `${(!d.features[f] && OPTIONS[f][2]) || OPTIONS[f][1]}${d.features[f] && INPUTS[f as keyof typeof INPUTS] ? ` ${this.inputLine(d, f)}` : ""}`,
            b(d.features[f] ? "Switch off" : "Switch on", `feat:${f}`),
            ...(d.features[f] && INPUTS[f as keyof typeof INPUTS] ? [b("⚙️ Change", `in:open:${f}`)] : []),
          );
        const more = offered.filter((f) => f !== "releases");
        const feature = d.branching === "feature" && INPUTS.pullRequests;
        return {
          body: [
            top,
            question("What else should the flow do?"),
            text(`With <b>${BRANCHING[d.branching ?? "single"][1]}</b>. Each switch works on its own; one that needs details asks for them next. You can change them later.`),
          ],
          rows: [
            ...(feature ? [options(option(`⚙️ ${BRANCHING.feature[1]}`, this.inputLine(d, "pullRequests"), b("⚙️ Change", "in:open:pullRequests")))] : []),
            ...(offered.includes("releases") ? [options(toggle("releases"))] : []),
            ...(more.length ? [text("<b>More options</b>"), options(...more.map(toggle))] : []),
            options(option("🧩 Custom steps", `Add your own states and rules with an extension file${d.extensions?.length ? `: ${d.extensions.map((e) => code(extName(e))).join(", ")}` : ""}.`, b(d.extensions?.length ? "🧩 Change" : "🧩 Add", "ext:open"))),
            this.nav(s, "flow:done"),
          ],
        };
      }
      case "bind": {
        const bot = this.botOf(d);
        const who = bot ? `@${esc(bot)}` : d.bot === "own" ? "the new bot" : "this bot";
        if (s.sub === "group")
          return {
            body: [
              top,
              question("Add the bot to a group"),
            ],
            rows: [
              options(
                ...(bot ? [option("👥 A whole group", `Pick one: Telegram adds ${who} there, and the group is set.`, linkBtn("👥 Choose a group", `https://t.me/${bot}?startgroup=${d.bindCode}`))] : []),
                option("🧵 One topic of a forum group", `Add ${who} to the group, then send ${code(`/bind ${d.bindCode}`)} inside that topic.`, copyBtn("📋 Copy", `/bind ${d.bindCode}`)),
              ),
              nav,
            ],
          };
        const own = d.bot === "own";
        return {
          body: [
            top,
            question("Where should the tickets appear?"),
          ],
          rows: [
            options(
              own
                ? option(`💬 In my private chat with ${who}`, "Open it and press <b>Start</b> once, so it may write to you.", ...(bot ? [linkBtn("↗ Open", `https://t.me/${bot}`)] : []), b("💬 Choose", "bind:here"))
                : option("💬 Here", "In this chat with me.", b("💬 Choose", "bind:here")),
              option("👥 In a group", "Your team works the tickets together; each answer is recorded with the name of who gave it.", b("👥 Choose", "bind:group")),
            ),
            nav,
          ],
        };
      }
      case "credential": {
        const name = this.host.trackerName(d.tracker?.kind);
        const what = d.repos.length > 1 ? "these repositories" : code(d.repos[0] ?? "");
        if (s.sub === "wide") {
          const more = s.wide ?? [];
          return {
            body: [
              top,
              question("This token reaches more than it needs"),
              text(`Besides ${what} it can also reach ${more.slice(0, 3).map(code).join(", ")}${more.length > 3 ? ` and ${more.length - 3} more` : ""}; a narrower token limits what a leak could do.`),
            ],
            rows: [
              options(
                option("✅ Use it anyway", "Keep this token; you can replace it later in the workspace's menu.", b("✅ Use it", "wide:keep")),
                option("🔑 Make a narrower one", `A token for ${what} only: paste it here when you have it.`, b("🔑 Narrower", "wide:new")),
              ),
              nav,
            ],
          };
        }
        const on = Object.entries(this.switches(d)).filter(([, v]) => v).map(([k]) => k);
        const help = this.host.tokenHelp(d.tracker ?? { kind: "github" })(d.repos, `Flowee ${d.id ?? ""}`.trim(), on, this.tokenDays(d));
        const step = (x: string) => esc(x).replace(/`([^`]+)`/g, "<code>$1</code>");
        const create = help.url ? [linkBtn("🔑 Create a token", help.url)] : [];
        return {
          body: [
            top,
            question(`Send me a ${name} token for ${what}`),
            text(`${help.url ? `Tap <b>🔑 Create a token</b>: ${esc(help.filled ?? `${name} opens the form.`)} ` : ""}Create the token and paste it here.`),
            ...(help.steps?.length ? [facts(help.steps.map((x) => [`👉 ${step(x)}`]))] : []),
            text("🔒 I delete your message right away and keep the token encrypted; it is never shown again."),
            text("<b>Permissions it needs</b>"),
            facts(help.permissions.map((x) => [esc(x)])),
          ],
          rows: help.alt
            ? [options(option("🔑 Project token", "Reaches this project only.", ...create), option(help.alt.label, esc(help.alt.why), linkBtn("↗ Open", help.alt.url))), nav]
            : [...(create.length ? [row(...create)] : []), nav],
        };
      }
      case "roles": {
        const roles = this.agentRoles(d);
        return {
          body: [
            top,
            question("Agent identities"),
            text("Each agent signs in with its own secret, so Flowee knows who holds which ticket. Start with these; you can add or remove agents any time."),
          ],
          rows: [options(...roles.map((r) => option(roleName(r), ROLES[r]?.[1] ?? `Works as ${esc(this.host.flow(d).who?.[r] ?? r)}.`, b("−", `role:${r}:-1`), { label: String(d.roles[r] ?? 0) }, b("+", `role:${r}:1`)))), this.nav(s, "roles:done")],
        };
      }
      case "summary": {
        const edit = !!(s.single || d.replaces);
        return {
          body: [this.top(s, true), question(edit ? `Save the changes to ${code(d.id ?? "")}?` : `Create the workspace ${code(d.id ?? "")}?`), facts(this.facts(s))],
          rows: [row(b(edit ? "✅ Save the changes" : "✅ Create the workspace", "confirm")), nav],
        };
      }
    }
  }

  /** The custom steps screen: what an extension is, the ones added (each removable), and a file to send. */
  private extScreen(s: Session): Screen {
    const d = s.draft;
    const exts = d.extensions ?? [];
    return {
      body: [
        this.top(s),
        question("Custom steps"),
        text(`An extension adds your own states, roles and rules to the flow, written as a small chart file (${code(`${this.host.publicUrl}/docs/flows.md`)}, “Extending the flow”). Send its ${code(".json")} file here; an agent can write one from the base chart at ${code(`${this.host.publicUrl}/flows/flow.json`)}.`),
        ...(s.extProblems?.length ? [warning(`The file was not added: ${s.extProblems.length > 1 ? `${s.extProblems.length} problems` : "one problem"}.`), facts(s.extProblems.map((x) => [esc(x)]))] : []),
        ...(exts.length ? [] : [text("None added yet.")]),
      ],
      rows: [
        ...(exts.length ? [options(...exts.map((e, i) => option(`🧩 ${esc(extName(e))}`, esc((typeof e === "object" && e.description) || "A shipped extension."), b("✖ Remove", `ext:rm:${i}`))))] : []),
        row(b("◀ Back", "ext:back"), b("✖ Cancel", "cancel")),
      ],
    };
  }

  /** A press on the custom steps screen. */
  private async extPress(s: Session, what: string, i: string | undefined) {
    const d = s.draft;
    delete s.extProblems;
    if (what === "open") s.sub = "ext";
    else if (what === "back") s.sub = "options";
    else if (what === "rm") {
      d.extensions = (d.extensions ?? []).filter((_, k) => k !== Number(i));
      for (const r of Object.keys(d.roles)) if (!this.agentRoles(d).includes(r)) delete d.roles[r];
    }
    return this.show(s);
  }

  /** A sent extension file: validated with the draft's other extensions; problems in the living message. */
  private async extFile(s: Session, text: string) {
    const d = s.draft;
    let e: unknown;
    try {
      e = JSON.parse(text);
    } catch (err) {
      s.extProblems = [`The file is not JSON (${err instanceof Error ? err.message : String(err)}).`];
      return this.show(s);
    }
    const name = extName(e as ExtensionRef);
    const others = (d.extensions ?? []).filter((x) => extName(x) !== name);
    const next = [...others, e as ExtensionRef];
    const problems = this.host.extensionProblems?.(next, this.switches(d)) ?? [];
    if (problems.length) {
      s.extProblems = problems;
      return this.show(s);
    }
    delete s.extProblems;
    d.extensions = next;
    return this.show(s, { note: `🧩 ${name} is added; its roles appear in the agents step.` });
  }

  /** An option's values now: defaults, the document's, then what was asked here. */
  private values(d: Draft, f: string): Values {
    return valuesOf(f, d.base?.features?.[f as keyof NonNullable<WorkspaceDoc["features"]>], d.inputs?.[f]);
  }

  /** The asked values in one line, for the option's row. */
  private inputLine(d: Draft, f: string): string {
    const spec = INPUTS[f as keyof typeof INPUTS] as OptionSpec;
    const v = this.values(d, f);
    const say = (x: unknown, i: OptionSpec["inputs"][number]) =>
      i.type === "flag" ? (x ? "on" : "off") : i.type === "choice" ? (i.choices?.find(([c]) => c === x)?.[1] ?? String(x)) : Array.isArray(x) ? (x.length ? x.map((y) => code(String(y))).join(", ") : "none") : x === undefined || x === "" ? "none" : code(String(x));
    return shown(spec, v).map((i) => `${esc(i.name)}: ${say(v[i.key], i)}`).join("; ");
  }

  /** The follow-up screen of an option: one row per value with its suggestions, Type, and a sent file. */
  private inputScreen(s: Session): Screen {
    const d = s.draft;
    const f = s.input as string;
    const spec = INPUTS[f as keyof typeof INPUTS] as OptionSpec;
    const v = this.values(d, f);
    const rows = shown(spec, v).flatMap((i) => {
      const x = v[i.key];
      const type = b(s.typing === i.key ? "✏️ Typing…" : "✏️ Type", `in:type:${i.key}`);
      if (i.type === "choice") return [option(esc(i.name), esc(i.ask), ...(i.choices ?? []).map(([c, l]) => b(x === c ? `● ${l}` : l, `in:set:${i.key}:${c}`)))];
      if (i.type === "flag") return [option(`${x ? "✅" : "⬜"} ${esc(i.name)}`, esc(i.ask), b(x ? "Switch off" : "Switch on", `in:flag:${i.key}`))];
      if (i.type === "list") {
        const now = (x as string[]) ?? [];
        const offer = [...new Set([...(i.suggest ?? []), ...now])];
        return [
          option(esc(i.name), `${esc(i.ask)} Now: ${now.length ? now.map((y) => code(y)).join(", ") : "none"}.`, type, ...(now.length ? [b("✖ Clear", `in:clear:${i.key}`)] : [])),
          ...offer.map((y, k) => option(`${now.includes(y) ? "✅" : "⬜"} ${code(y)}`, now.includes(y) ? "chosen" : "suggested", b(now.includes(y) ? "Remove" : "Add", `in:tog:${i.key}:${k}`))),
        ];
      }
      return [option(esc(i.name), `${esc(i.ask)} Now: ${x === undefined || x === "" ? "none" : code(String(x))}.`, ...(i.suggest ?? []).filter((y) => y !== x).map((y) => b(y, `in:set:${i.key}:${y}`)), type, ...(x && !i.required ? [b("✖ None", `in:clear:${i.key}`)] : []))];
    });
    const typing = spec.inputs.find((i) => i.key === s.typing);
    return {
      body: [
        this.top(s),
        question(esc(spec.question)),
        text(
          typing
            ? `Type ${esc(typing.name.toLowerCase())} as your next message${typing.type === "list" ? ", one per line" : ""}.`
            : "Tap a value, ✏️ Type your own, or send a <code>.json</code> or text file with the values (an agent can prepare it). ▶ Done keeps what is shown.",
        ),
      ],
      rows: [options(...rows), row(b("◀ Back", "in:back"), b("▶ Done", "in:done"), b("✖ Cancel", "cancel"))],
    };
  }

  /** A press on an option's follow-up screen. */
  private async inputPress(s: Session, what: string, key: string, value: string | undefined) {
    const d = s.draft;
    if (what === "open") {
      if (!INPUTS[key as keyof typeof INPUTS]) return this.show(s);
      s.sub = "input";
      s.input = key;
      delete s.typing;
      return this.show(s);
    }
    const f = s.input;
    const spec = f && INPUTS[f as keyof typeof INPUTS];
    if (!f || !spec || s.sub !== "input") return this.show(s);
    const v = this.values(d, f);
    const set = (x: unknown) => {
      d.inputs = { ...(d.inputs ?? {}), [f]: { ...(d.inputs?.[f] ?? {}), [key]: x } };
    };
    const i = spec.inputs.find((x) => x.key === key);
    switch (what) {
      case "back":
        delete s.typing;
        s.sub = "options";
        return this.show(s);
      case "done": {
        const why = problem(spec, v);
        if (why) return this.show(s, { note: why });
        delete s.typing;
        if (f !== "pullRequests") d.features[f] = true;
        s.sub = "options";
        return this.show(s);
      }
      case "type":
        if (i) s.typing = key;
        return this.show(s);
      case "set":
        if (i && value !== undefined) set(i.type === "number" ? Number(value) : value);
        delete s.typing;
        return this.show(s);
      case "flag":
        if (i) set(!v[key]);
        return this.show(s);
      case "clear":
        if (i) set(i.type === "list" ? [] : "");
        return this.show(s);
      case "tog": {
        if (!i) return this.show(s);
        const now = (v[key] as string[]) ?? [];
        const y = [...new Set([...(i.suggest ?? []), ...now])][Number(value)];
        if (y !== undefined) set(now.includes(y) ? now.filter((z) => z !== y) : [...now, y]);
        return this.show(s);
      }
    }
    return this.show(s);
  }

  /** A typed value or a sent file on an option's follow-up screen; the message is deleted after reading. */
  private async inputText(s: Session, text: string, file: boolean) {
    const d = s.draft;
    const f = s.input as string;
    const spec = INPUTS[f as keyof typeof INPUTS] as OptionSpec;
    const v = this.values(d, f);
    const put = (values: Values) => {
      d.inputs = { ...(d.inputs ?? {}), [f]: { ...(d.inputs?.[f] ?? {}), ...values } };
    };
    if (file) {
      const r = fromFile(spec, text, s.typing, v);
      if ("error" in r) return this.show(s, { note: r.error });
      put(r.values);
    } else {
      const i = spec.inputs.find((x) => x.key === s.typing) ?? spec.inputs.find((x) => x.type === "list" || x.type === "label");
      if (!i) return this.show(s, { note: "Tap ✏️ Type beside the value you want to type first." });
      const r = parse(i, text, v[i.key]);
      if ("error" in r) return this.show(s, { note: r.error });
      put({ [i.key]: r.value });
    }
    delete s.typing;
    return this.show(s);
  }

  /** What it will be, as rows of a two-column table. */
  private facts(s: Session): string[][] {
    const d = s.draft;
    const p = this.host.flow();
    const agents = instances(d.roles, p).filter((r) => r.role !== p.ownerRole).map((r) => esc(r.instance));
    return [
      ["📦 Repositories", `${d.repos.map(code).join(", ")} on ${this.host.trackerName(d.tracker?.kind)}`],
      ...(this.host.terminal ? [] : [["🤖 Bot", d.bot === "own" ? `its own${d.botUsername ? `, @${esc(d.botUsername)}` : ""}` : "this bot"]]),
      ["🔀 Way of working", wayOf(this.switches(d))],
      ["💬 Tickets appear", this.where(s)],
      [`🔑 ${this.host.trackerName(d.tracker?.kind)} token`, d.token ? "checked" : d.tokenStored ? "kept from before" : "missing"],
      ["👥 Agents", `${agents.join(", ") || "none"}${agents.length ? " (each gets a new secret)" : ""}`],
    ];
  }

  /** One input for the user's open session; false when there is none (the input is not the wizard's). */
  async input(user: string, at: ChatRef, i: Input): Promise<boolean> {
    if (i.kind === "press" && (i.data === "w:restart" || i.data === "w:new")) {
      if (i.data === "w:restart") this.host.drop(user);
      await this.start(user, at);
      return true;
    }
    const s = this.host.load(user);
    if (!s) {
      if (i.kind === "press" && i.data.startsWith("w:"))
        await this.living.show(user, at, [heading("⌛", "This setup is over"), text("It was finished or cancelled."), row(b("🚀 Set up a workspace", "new"))]);
      return i.kind === "press" && i.data.startsWith("w:");
    }
    if (this.now() - s.ts > TTL) {
      this.host.drop(user);
      await this.dropHelper(s);
      await this.living.show(user, at, [heading("⌛", "This setup expired"), text("A day passed without an answer, so nothing was created."), row(b("🚀 Start again", "new"))]);
      return true;
    }
    if (i.kind === "bound") {
      s.draft.bind = { chat: i.chat, topic: i.topic, label: i.label };
      await this.advance(s);
      return true;
    }
    if (i.kind === "managed") {
      if (s.step !== "botCreate") return false;
      await this.host.adoptBot(s, i.botId);
      s.draft.botId = i.botId;
      s.draft.botUsername = i.username;
      s.draft.botName = i.name;
      await this.advance(s);
      return true;
    }
    if (i.kind === "text") return this.text(s, i.text, i.message);
    if (i.kind === "file") {
      // a file is the wizard's only while an option asks for its values or custom steps are open; otherwise an import
      if (s.step !== "flow" || (s.sub !== "input" && s.sub !== "ext")) return false;
      await this.chat.remove(s.at, i.message).catch(() => {});
      if (s.sub === "ext") await this.extFile(s, i.text);
      else await this.inputText(s, i.text, true);
      return true;
    }
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
      case "cancel": {
        this.host.drop(s.user);
        await this.dropHelper(s);
        const edit = !!(s.single || d.replaces);
        await this.living.show(s.user, s.at, [
          heading("✖", edit ? "Nothing changed" : "Setup cancelled"),
          text(edit ? "The workspace stays as it was." : "Nothing was created."),
          row(...(edit ? [] : [b("🚀 Start again", "new")]), btn("📂 My workspaces", "m:list")),
        ]);
        return;
      }
      case "back": {
        if (s.sub === "wide") delete d.token;
        if (s.sub) {
          delete s.sub;
          return this.show(s);
        }
        const prev = s.back.pop();
        if (!prev) return this.show(s);
        if (s.single) s.single = false;
        return this.go(s, prev, false);
      }
      case "bot":
        if (v === "own" && !this.host.ownBots) return this.show(s, { note: "This Flowee cannot make bots of their own; choose this bot." });
        d.bot = v === "own" ? "own" : "shared";
        return this.advance(s);
      case "repos":
        return this.advance(s);
      case "flow":
        return this.advance(s);
      case "branch":
        d.branching = v === "feature" ? "feature" : "single";
        if (!Object.keys(OPTIONS).some((f) => this.host.flow().features.includes(f))) return this.advance(s);
        s.sub = "options";
        return this.show(s);
      case "feat":
        // an option that needs details asks for them next; it is on once they are usable (off keeps them)
        if (!d.features[v] && INPUTS[v as keyof typeof INPUTS]) return this.inputPress(s, "open", v, undefined);
        d.features[v] = !d.features[v];
        return this.show(s);
      case "in":
        return this.inputPress(s, v, w, data.split(":").slice(3).join(":") || undefined);
      case "ext":
        return this.extPress(s, v, w);
      case "bind":
        if (v === "group") {
          s.sub = "group";
          return this.show(s);
        }
        d.bind = { chat: s.at.chat, label: "a private chat" };
        return this.advance(s);
      case "role": {
        d.roles[v] = Math.max(0, Math.min(9, (d.roles[v] ?? 0) + Number(w)));
        return this.show(s);
      }
      case "roles":
        if (!Object.values(d.roles).some((x) => x > 0)) return this.show(s, { note: "At least one agent is needed." });
        return this.advance(s);
      case "wide":
        if (v === "keep" && d.token) return this.advance(s);
        delete d.token;
        delete s.sub;
        return this.show(s);
      case "confirm":
        return this.confirm(s);
    }
  }

  /** A typed answer: deleted after reading (always for the token), the result shown in the living message. */
  private async text(s: Session, text: string, message: number): Promise<boolean> {
    const d = s.draft;
    if (s.step === "flow" && s.sub === "input") {
      await this.chat.remove(s.at, message).catch(() => {});
      await this.inputText(s, text, false);
      return true;
    }
    if (s.step !== "credential" && s.step !== "repos") return false;
    // the token never stays in the chat: deleted before anything else happens
    const kept = await this.chat.remove(s.at, message).then(
      () => undefined,
      (e) => `I could not delete your message (${e instanceof Error ? e.message : e}); please delete it yourself.`,
    );
    if (s.step === "credential") {
      const token = text.trim();
      if (!/^[\w-]{20,255}$/.test(token)) {
        await this.show(s, { note: [kept, `That does not look like a ${this.host.trackerName(d.tracker?.kind)} token; paste just the token.`].filter(Boolean).join(" ") });
        return true;
      }
      const sealed = await this.host.seal(token);
      const problems = await this.host.checkRepos(sealed, d.repos, d.tracker ?? { kind: "github" });
      if (problems.length) {
        delete s.sub;
        await this.show(s, { note: [kept, ...problems].filter(Boolean).join(" ") });
        return true;
      }
      d.token = sealed;
      const wide = (await this.host.wider?.(sealed, d.repos, d.tracker ?? { kind: "github" }).catch(() => [])) ?? [];
      if (wide.length) {
        s.sub = "wide";
        s.wide = wide;
        await this.show(s, { note: kept });
        return true;
      }
      await this.advance(s, { note: kept });
      return true;
    }
    const refs = text.split(/[\s,]+/).filter(Boolean);
    const found = refs.map((r) => this.host.parseRepo(r));
    const bad = refs.filter((_, i) => !found[i]);
    const no = (why: string) => this.show(s, { note: why }).then(() => true);
    if (!refs.length || bad.length)
      return no(`${bad.map((x) => `'${x}'`).join(", ") || "That"} ${bad.length > 1 ? "are not repository links" : "is not a repository link"} of GitHub or GitLab; send its link, for example https://github.com/octo/app.`);
    const ok = found as PastedRepo[];
    if (new Set(ok.map((r) => `${r.kind} ${r.api ?? ""}`)).size > 1)
      return no("Paste the repositories of one tracker here; a workspace on several trackers is written as a configuration and imported (📥 Import).");
    const repos = [...new Set(ok.map((r) => r.repo))];
    const where: TrackerRef = { kind: ok[0].kind, ...(ok[0].api ? { api: ok[0].api } : {}) };
    const taken = repos.find((r) => this.host.repoTaken(r, d.replaces, where));
    if (taken) return no(`'${taken}' is already in your workspace '${this.host.repoTaken(taken, d.replaces, where)}'; a repository belongs to one workspace only.`);
    const aliases = repos.map(aliasOf);
    const dup = aliases.find((a, i) => aliases.indexOf(a) !== i);
    if (dup) return no(`Two repositories are both called '${dup}'; import a configuration that names them apart instead.`);
    d.repos = repos;
    d.tracker = { kind: ok[0].kind, ...(ok[0].api ? { api: ok[0].api } : {}) };
    if (!d.id) d.id = this.host.freeId(aliasOf(repos[0]));
    if (!d.bindCode) d.bindCode = d.id;
    await this.advance(s);
    return true;
  }

  private async confirm(s: Session) {
    const why = this.host.refusal(s.user, s.draft.replaces);
    if (why) return this.show(s, { note: why });
    let r: Awaited<ReturnType<WizardHost["commit"]>>;
    try {
      r = await this.host.commit(s);
    } catch (e) {
      return this.show(s, { note: e instanceof Error ? e.message : String(e) });
    }
    this.host.drop(s.user);
    await this.dropHelper(s);
    const names = Object.keys(r.secrets);
    await this.living.show(s.user, s.at, [
      heading("✅", s.draft.replaces ? "Changes saved" : "Workspace ready", code(r.id)),
      ...(r.warning ? [warning(r.warning)] : []),
      ...(names.length ? [text(`These are your agents' sign-in secrets for ${code("flowee.py")}, <b>shown only this once</b>. Save each one on the machine where that agent runs (the file shows where), put the ${code(".flowee.toml")} part into the repository, then delete the file.`)] : []),
      row(btn("📂 My workspaces", "m:list")),
    ]);
    if (names.length) await this.handOver(s.at, r.id, r.secrets);
    const [next, ...rest] = s.queue ?? [];
    // the secrets file now stands under the living message: the next workspace starts anew below it
    if (next) await this.over(s.user, s.at, this.host.draftOf(next), undefined, rest, { bottom: names.length > 0 });
  }

  /** The agents' secrets as a file that explains itself, once (or a message where files are refused). */
  async handOver(at: ChatRef, id: string, secrets: Record<string, string>) {
    const body = secretsFile(this.host.publicUrl, id, secrets);
    const buttons = [[btn("🗑 Delete this file from the chat", "m:rmfile")], [linkBtn("❓ How do I use these?", `${this.host.publicUrl}/docs/agents/`)]];
    // shown once: a refused file must not lose them, so they come as a message instead
    if (this.chat.sendFile && (await this.chat.sendFile(at, `flowee-${id}-secrets.txt`, body, "🔑 Agent secrets: shown only this once.", buttons).then(() => true, () => false))) return;
    await this.chat.view(at, [heading("🔑", "Agent secrets", code(id)), { html: `<pre>${esc(body)}</pre>` }, row(...buttons[0]), row(...buttons[1])]);
  }
}


/**
 * The secrets file: each agent's secret as a ready block that stores it with mode 600 where flowee.py reads it (the
 * secret on stdin, never in an argument), then the `.flowee.toml` for the repository. An agent handed this file and
 * the instance URL can set up the project side by itself.
 */
export function secretsFile(url: string, id: string, secrets: Record<string, string>): string {
  const names = Object.keys(secrets);
  const dir = `~/.secrets/flowee/${id}`;
  return [
    `# Flowee workspace ${id}: the agents' sign-in secrets for flowee.py, shown only this once.`,
    "# Flowee keeps only a fingerprint of each; a lost secret is replaced in /workspaces (New agent secret).",
    `# Hand this file to an agent with the address ${url} and say "set this up", or do the two steps below.`,
    `# Then delete this file and the message it came in. More: ${url}/docs/agents/`,
    "",
    "# 1. Each agent's secret: run its block on the machine where that agent runs. It stores the secret with",
    `#    mode 600 in ${dir}/<agent>, where .flowee.toml points flowee.py.`,
    ...names.flatMap((n) => ["", `# ${n}`, `mkdir -p ${dir} && install -m 600 /dev/stdin ${dir}/${n} <<'EOF'`, secrets[n], "EOF"]),
    "",
    "# 2. .flowee.toml: commit it to the repository's root (no secret in it). Each agent runs as its own",
    `#    instance: set FLOWEE_AS=<agent> in that agent's environment, or edit 'instance' in its clone.`,
    `url = "${url}"`,
    `workspace = "${id}"`,
    `instance = "${names[0]}"`,
    `secret_file = "~/.secrets/flowee/{workspace}/{instance}"`,
    "",
  ].join("\n");
}
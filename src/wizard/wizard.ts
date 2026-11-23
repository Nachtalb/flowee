// The setup conversation, chat-agnostic: steps, screens, choices and validation. Every screen is a view built from
// the envoy's blocks (docs/chat-style.md) shown in one living message that each step edits; typed answers are
// deleted after reading. It reaches the instance through `WizardHost`; docs/managed.md walks through it.
import type { RepoDoc, WorkspaceDoc } from "../config/document";
import type { ExtensionRef } from "../config/presets";
import type { TrackerKind } from "../config/trackers";
import { btn, copyBtn, esc, facts, heading, linkBtn, option, options, question, row, text, warning } from "../envoy/render";
import { type Block, type Chat, type ChatRef, type ChatRequest, live, type View } from "../ports/chat";
import { TOKEN_DAYS, type TokenHelp } from "../ports/tracker";
import { list, type Ref, refName, refParams } from "../core/chart";
import { pathOf, pick, SETUP, type State, STATES, targetOf, transitions } from "./chart";
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

/** The screen the menu's ✏️ Change opens, by the part of the workspace. */
export const PARTS = { repos: "repos", flow: "branching", bind: "where", credential: "token", ext: "ext" } as const satisfies Record<string, State>;
export type Part = keyof typeof PARTS;
/** The screens of the steps a session stored before the chart was at. */
const OLD_STEPS: Record<string, State> = { repos: "repos", bot: "bot", botCreate: "botCreate", flow: "branching", bind: "where", credential: "token", summary: "summary" };

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
  /** Tickets go to a group (or one topic of it): its screen comes after where the tickets appear. */
  inGroup?: boolean;
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
}

export interface Session {
  user: string;
  at: ChatRef;
  /** The screen shown: a state of the setup chart (setup.json). */
  state: State;
  /** The screens shown before it, the newest last: Back goes to the newest. */
  history: State[];
  draft: Draft;
  ts: number;
  /** Screens not asked: those an imported document answers, the bot where there are no own bots, the chat in the terminal. */
  skip?: State[];
  /** One part changed from the menu: saved or cancelled, the workspace's screen comes back. */
  edit?: boolean;
  /** What a values or custom-steps screen had when it opened, for its Back. */
  before?: unknown;
  /** Custom steps: the problems of the extension file just sent, one sentence each. */
  extProblems?: string[];
  /** The repositories a pasted token reaches besides the workspace's. */
  wide?: string[];
  /** The value the next typed message is for, on a values screen. */
  typing?: string;
  /** The message carrying the reply keyboard of the bot step, removed when the step is left. */
  helper?: number;
  /** Further imported workspaces, set up one after the other. */
  queue?: WorkspaceDoc[];
  /** One sentence for the next screen: a refusal, or what was just done. */
  note?: string;
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
  /**
   * Creates or replaces the workspace; returns what to hand over once: the project key when it is new, and the
   * secrets of agents an imported document names without one. `warning`: the workspace was made, but its bot's
   * profile was not (one sentence).
   */
  commit(s: Session): Promise<{ id: string; key?: string; secrets: Record<string, string>; doc: WorkspaceDoc; warning?: string }>;
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
/** The aliases of several repositories: each its name, two with the same name told apart by their owner. */
export function aliasesOf(repos: string[]): string[] {
  const plain = repos.map(aliasOf);
  return repos.map((r, i) => (plain.filter((a) => a === plain[i]).length > 1 ? aliasOf(r.split("/").slice(-2).join("-")) : plain[i]));
}
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
const ROLES: Record<string, string> = { board: "🧭 Board", developer: "🛠 Developer", tester: "🧪 Tester", owner: "👤 Owner" };
/** The way of working in words: the branching, then every option switched on. */
export const wayOf = (features: Record<string, unknown> = {}) =>
  [BRANCHING[features.pullRequests ? "feature" : "single"][1], ...Object.keys(OPTIONS).filter((f) => features[f] && (features[f] as { autoTriage?: boolean }).autoTriage !== false).map((f) => OPTIONS[f][0])].join(", ");
/** A role's name on the screens; an extension's role by its own name. */
export const roleName = (r: string) => ROLES[r] ?? `🧩 ${esc(r)}`;

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
  return { user, at, state: "repos", history: [], draft: { repos: [], features: { userFeedback: false } }, ts: now };
}

/** A chat as its owner knows it, without its title. */
export const chatLabel = (chat: string, topic?: number) => (!chat.startsWith("-") ? "a private chat" : topic ? "one topic of your group" : "your group");

/** A draft from an existing or imported document. */
export function fromDoc(d: WorkspaceDoc): Draft {
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
    ...(d.chat?.chatId.startsWith("-") ? { inGroup: true } : {}),
  };
}

/** Secret names of a workspace made here: one prefix per workspace keeps them apart. */
export const slot = (id: string, what: string) => `W_${id.toUpperCase().replace(/-/g, "_")}_${what.toUpperCase().replace(/-/g, "_")}`;

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
export function toDoc(d: Draft, user: string, shared: { token: string; webhookSecret: string; username?: string }, publicUrl: string, api?: string): WorkspaceDoc {
  const id = d.id as string;
  const base: Partial<WorkspaceDoc> = d.base ? JSON.parse(JSON.stringify(d.base)) : {};
  // every secret a workspace made here names is its own slot: a document cannot borrow another workspace's token
  const old = new Map((base.tracker?.repos ?? []).map((r) => (typeof r === "string" ? [r, r] : [r.repo, { repo: r.repo, ...(r.alias ? { alias: r.alias } : {}), ...(r.mainBranch ? { mainBranch: r.mainBranch } : {}) }]) as [string, RepoDoc]));
  const named = aliasesOf(d.repos);
  const repos: RepoDoc[] = d.repos.map((r, i) => old.get(r) ?? (d.repos.length > 1 ? { repo: r, alias: named[i] } : r));
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
    owners,
  };
  // agents with their own secrets in an imported or older document keep them, in this workspace's own slots;
  // a new workspace gets one project key, and its agents create themselves with it
  if (base.roles?.length) doc.roles = base.roles.map((r) => ({ ...r, secret: slot(id, r.instance) }));
  else delete doc.roles;
  if (base.agents || !base.roles?.length) doc.agents = { ...(base.agents ?? {}), key: slot(id, "key") };
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
  /** Where a change made from the menu returns: the workspace's screen with one sentence (set by the menu). */
  returnTo?: (user: string, at: ChatRef, id: string, note: string) => Promise<unknown>;

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

  /** The chart's guards over the session and its draft; `value`: the pressed button's (`is`). */
  private holds(s: Session, value?: string) {
    const d = s.draft;
    return (g: Ref): boolean => {
      switch (refName(g)) {
        case "editing":
          return !!s.edit;
        case "hasHistory":
          return s.history.length > 0;
        case "ownBot":
          return d.bot === "own";
        case "inGroup":
          return !!d.inGroup;
        case "tooWide":
          return !!s.wide?.length;
        case "is":
          return refParams(g).value === value;
      }
      return false;
    };
  }

  /** The screens a draft over a document does not ask again: those the document answers. */
  private answered(d: Draft): State[] {
    const skip: State[] = [];
    if (d.repos.length) skip.push("repos");
    if (d.bot) skip.push("bot");
    if (d.bot === "shared" || d.botId) skip.push("botCreate");
    if (d.branching) skip.push("branching", "options");
    if (d.bind || d.noChat) skip.push("where", "group");
    if (d.token || d.tokenStored) skip.push("token", "wide");
    return skip;
  }

  /** `x`, or past it while it is skipped: where `next` leads from it for this draft. */
  private resolve(s: Session, x: State | undefined): State | undefined {
    for (let i = 0; x && s.skip?.includes(x) && i < STATES.length; i++) x = targetOf(pick(x, "next", this.holds(s)));
    return x;
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
    if (!this.host.ownBots) {
      s.draft.bot = "shared";
      s.skip = ["bot", "botCreate"];
    }
    if (this.host.terminal) {
      s.draft.noChat = true;
      s.skip = [...(s.skip ?? []), "where", "group"];
    }
    await this.begin(s, { bottom });
  }

  /**
   * Opens the wizard over an existing or imported workspace: only the screens the document does not answer are
   * asked. `only`: one part changed from the menu, which returns there when done.
   */
  async over(user: string, at: ChatRef, draft: Draft, only?: string, queue?: WorkspaceDoc[], o: { lead?: Block[]; bottom?: boolean } = {}) {
    const s: Session = { user, at, state: "summary", history: [], draft, ts: this.now(), ...(queue?.length ? { queue } : {}) };
    if (!only) {
      s.skip = this.answered(draft);
      return this.begin(s, o);
    }
    s.edit = true;
    if (only === "bind") {
      delete draft.bind;
      delete draft.inGroup;
    }
    if (only === "credential") delete draft.tokenStored;
    s.state = PARTS[only as Part] ?? "summary";
    this.opened(s);
    await this.show(s, o);
  }

  private async begin(s: Session, o: { lead?: Block[]; bottom?: boolean }) {
    s.state = this.resolve(s, SETUP.initial as State) ?? "summary";
    await this.show(s, o);
  }

  /** A session stored before the chart (a step, a sub-screen and a stack of steps) resumes at its screen. */
  private migrate(s: Session): Session {
    if (STATES.includes(s.state) && Array.isArray(s.history)) return s;
    const o = s as Session & { step?: string; sub?: string; input?: string; single?: boolean; back?: unknown; plan?: unknown };
    const sub: Record<string, State> = { options: "options", ext: "ext", group: "group", wide: "wide" };
    const state = (o.sub === "input" ? `${o.input}Values` : (sub[o.sub ?? ""] ?? OLD_STEPS[o.step ?? ""] ?? "summary")) as State;
    s.state = STATES.includes(state) ? state : "summary";
    if (o.single) s.edit = true;
    for (const k of ["step", "sub", "input", "single", "back", "plan"] as const) delete o[k];
    // the screens before it are those the chart leads through to it for this draft
    const to = SETUP.states[s.state].meta?.step ? s.state : "options";
    const before: State[] = [];
    for (let x = this.resolve(s, SETUP.initial as State); x && x !== to && before.length < STATES.length; x = this.resolve(s, targetOf(pick(x, "next", this.holds(s))))) before.push(x);
    s.history = s.edit ? [] : [...(before.length < STATES.length ? before : []), ...(to !== s.state ? [to] : [])];
    return s;
  }

  /** Shows the session's screen in the living message; `s.note` is one sentence under it, shown once. */
  async show(s: Session, o: { lead?: Block[]; bottom?: boolean } = {}) {
    const note = s.note;
    delete s.note;
    s.ts = this.now();
    const v = this.screen(s);
    const [top, ...body] = v.body;
    if (!v.keyboard) await this.dropHelper(s);
    await this.living.show(s.user, s.at, [top, ...(o.lead ?? []), ...body, ...(note ? [warning(note)] : []), ...v.rows], o.bottom);
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

  /**
   * One event on the session's screen: the input is read into the draft (a refusal stays on the screen with one
   * sentence), then the chart's first transition whose guard holds runs its actions and enters its target.
   */
  private async fire(s: Session, event: string, value?: string, raw?: Input): Promise<void> {
    if (!transitions(s.state, event).length) return this.show(s);
    const why = await this.read(s, event, value, raw);
    if (why !== undefined) {
      if (why) s.note = [s.note, why].filter(Boolean).join(" ");
      return this.show(s);
    }
    const t = pick(s.state, event, this.holds(s, value));
    for (const a of list(t?.actions)) {
      if (refName(a) === "restore") this.restore(s);
      if (refName(a) === "back") s.state = s.history.pop() ?? s.state;
    }
    const to = this.resolve(s, targetOf(t));
    if (to === "done") return this.done(s);
    if (to === "cancelled") return this.cancelled(s);
    if (to === "expired") return this.expired(s);
    if (to) {
      s.history.push(s.state);
      s.state = to;
      this.opened(s);
    }
    return this.show(s);
  }

  /** The option a values screen is for. */
  private optionOf(state: string) {
    return state.endsWith("Values") ? state.slice(0, -"Values".length) : undefined;
  }

  /** A values or custom-steps screen opens: what it had is kept for its Back. */
  private opened(s: Session) {
    const f = this.optionOf(s.state);
    delete s.typing;
    delete s.extProblems;
    if (f) s.before = structuredClone(s.draft.inputs?.[f]);
    else if (s.state === "ext") s.before = structuredClone(s.draft.extensions);
  }

  /** Back on a values or custom-steps screen: what it had when it opened. */
  private restore(s: Session) {
    const d = s.draft;
    const f = this.optionOf(s.state);
    const was = s.before;
    delete s.before;
    if (f) {
      const { [f]: _, ...rest } = d.inputs ?? {};
      d.inputs = was === undefined ? rest : { ...rest, [f]: was as Record<string, unknown> };
    } else if (s.state === "ext") {
      if (was === undefined) delete d.extensions;
      else d.extensions = was as ExtensionRef[];
    }
  }

  /** Reads an event's input into the draft; a sentence (or null: no sentence) when it is refused. */
  private async read(s: Session, event: string, value: string | undefined, raw: Input | undefined): Promise<string | null | undefined> {
    const d = s.draft;
    const f = this.optionOf(s.state);
    if (f) return event === "apply" ? this.apply(s, f) : event === "text" || event === "file" ? this.inputText(s, f, value ?? "", event === "file") : event === "back" ? undefined : this.editValue(s, f, event, value);
    switch (`${s.state}.${event}`) {
      case "repos.next":
        return value === undefined ? (d.repos.length ? undefined : null) : this.readRepos(s, value);
      case "bot.next":
        if (value === undefined) return d.bot ? undefined : null;
        if (value === "own" && !this.host.ownBots) return "This Flowee cannot make bots of their own; choose this bot.";
        d.bot = value === "own" ? "own" : "shared";
        return;
      case "botCreate.next":
        if (raw?.kind !== "managed") return d.botId ? undefined : null;
        await this.host.adoptBot(s, raw.botId);
        d.botId = raw.botId;
        d.botUsername = raw.username;
        d.botName = raw.name;
        return;
      case "branching.next":
        if (value === undefined) return d.branching ? undefined : null;
        d.branching = value === "feature" ? "feature" : "single";
        return;
      case "options.switch":
        if (!value || !this.offered().includes(value) || (INPUTS[value as keyof typeof INPUTS] && !d.features[value])) return null;
        d.features[value] = !d.features[value];
        return;
      case "options.configure":
        return INPUTS[value as keyof typeof INPUTS] ? undefined : null;
      case "ext.file":
        return this.extFile(s, value ?? "");
      case "ext.remove":
        d.extensions = (d.extensions ?? []).filter((_, k) => k !== Number(value));
        if (!d.extensions.length) delete d.extensions;
        return;
      case "ext.apply":
        delete s.before;
        return;
      case "where.next":
        if (value === "here") {
          d.bind = { chat: s.at.chat, label: "a private chat" };
          d.inGroup = false;
        } else if (value === "group") d.inGroup = true;
        else return d.bind ? undefined : null;
        return;
      case "group.next":
        if (raw?.kind === "bound") {
          d.bind = { chat: raw.chat, topic: raw.topic, label: raw.label };
          d.inGroup = true;
          return;
        }
        return this.groupBound(s) ? undefined : null;
      case "token.next":
        return value === undefined ? (d.token || d.tokenStored ? undefined : null) : this.readToken(s, value);
      case "wide.next":
        return d.token ? undefined : null;
      case "wide.narrower":
        delete d.token;
        delete s.wide;
        return;
    }
    return;
  }

  /** The group chosen for the tickets is bound already (came back to its screen). */
  private groupBound(s: Session) {
    return !!s.draft.inGroup && !!s.draft.bind && s.draft.bind.chat !== s.at.chat;
  }

  /** The options this flow offers, in the order of the screen. */
  private offered() {
    return Object.keys(OPTIONS).filter((f) => this.host.flow().features.includes(f));
  }

  private nav(s: Session, next = false): Block {
    return row(...(s.history.length ? [b("◀ Back", "back")] : []), ...(next ? [b("▶ Next", "next")] : []), b("✖ Cancel", "cancel"));
  }

  /** The heading: what the screen is, and on the path's screens the step among the screens of the path. */
  private top(s: Session): Block {
    const d = s.draft;
    const path = !s.edit && SETUP.states[s.state]?.meta?.step ? pathOf(s.state, s.history, this.holds(s), s.skip) : [];
    const f = this.optionOf(s.state);
    // a values or custom-steps screen is a detour from the options, named instead of counted
    const step = path.length ? [`Step ${s.history.filter((x) => SETUP.states[x]?.meta?.step).length + 1} of ${path.length}`] : f ? [f === "pullRequests" ? BRANCHING.feature[1] : OPTIONS[f][0]] : s.state === "ext" ? ["Custom steps"] : [];
    if (s.state === "summary") step.push("Last check");
    if (s.edit || d.replaces) return heading("✏️", `Change ${code(d.replaces ?? d.id ?? "")}`, ...step);
    return heading("🆕", "New workspace", ...step);
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
    if (this.optionOf(s.state)) return this.inputScreen(s);
    switch (s.state) {
      case "repos":
        return {
          body: [
            top,
            question("Which repository is this workspace for?"),
            text(`Paste the repository's link from GitHub or GitLab, for example ${code("https://github.com/octo/app")}. Several: one per line.`),
            ...(d.repos.length ? [text(`Now: ${d.repos.map(code).join(", ")} on ${this.host.trackerName(d.tracker?.kind)}`)] : []),
          ],
          rows: [...(d.repos.length ? [row(b(`✅ Keep ${d.repos.length > 1 ? "these" : esc(d.repos[0])}`, "next"))] : []), nav],
        };
      case "bot": {
        const me = this.host.botUsername ? ` (@${esc(this.host.botUsername)})` : "";
        return {
          body: [top, question("Which bot should bring you the tickets?")],
          rows: [
            options(
              option(`💬 This bot${me}`, "I bring them myself, next to your other workspaces.", b(d.bot === "shared" ? "● Chosen" : "💬 Choose", "next:shared")),
              option("🤖 A new bot", "Its own name and picture; you create it with two taps, I set it up.", b(d.bot === "own" ? "● Chosen" : "🤖 Choose", "next:own")),
            ),
            nav,
          ],
        };
      }
      case "botCreate": {
        if (d.botId)
          return {
            body: [top, question("The new bot is ready"), text(`${d.botUsername ? `@${esc(d.botUsername)}` : "Your bot"} brings the tickets of this workspace.`)],
            rows: [this.nav(s, true)],
          };
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
      case "branching":
        return {
          body: [top, question("How should the agents bring in their code?"), text("Choose one. Versioning and the other options come next; each works with either.")],
          rows: [
            options(...(["single", "feature"] as const).map((k) => option(`${BRANCHING[k][0]} ${BRANCHING[k][1]}`, BRANCHING[k][2], b(d.branching === k ? "● Chosen" : `${BRANCHING[k][0]} Choose`, `next:${k}`)))),
            nav,
          ],
        };
      case "options": {
        const offered = this.offered();
        const toggle = (f: string) => {
          const asks = !!INPUTS[f as keyof typeof INPUTS];
          return option(
            `${d.features[f] ? "✅" : "⬜"} ${OPTIONS[f][0]}`,
            `${(!d.features[f] && OPTIONS[f][2]) || OPTIONS[f][1]}${d.features[f] && asks ? ` ${this.inputLine(d, f)}` : ""}`,
            d.features[f] ? b("Switch off", `switch:${f}`) : asks ? b("⚙️ Configure", `configure:${f}`) : b("Switch on", `switch:${f}`),
            ...(d.features[f] && asks ? [b("⚙️ Change", `configure:${f}`)] : []),
          );
        };
        const more = offered.filter((f) => f !== "releases");
        const feature = d.branching === "feature" && INPUTS.pullRequests;
        return {
          body: [top, question("What else should the flow do?"), text(`With <b>${BRANCHING[d.branching ?? "single"][1]}</b>. Each switch works on its own; one that needs details asks for them next. You can change them later.`)],
          rows: [
            ...(feature ? [options(option(`⚙️ ${BRANCHING.feature[1]}`, this.inputLine(d, "pullRequests"), b("⚙️ Change", "configure:pullRequests")))] : []),
            ...(offered.includes("releases") ? [options(toggle("releases"))] : []),
            ...(more.length ? [text("<b>More options</b>"), options(...more.map(toggle))] : []),
            options(option("🧩 Custom steps", `Add your own states and rules with an extension file${d.extensions?.length ? `: ${d.extensions.map((e) => code(extName(e))).join(", ")}` : ""}.`, b(d.extensions?.length ? "🧩 Change" : "🧩 Add", "extensions"))),
            this.nav(s, true),
          ],
        };
      }
      case "ext":
        return this.extScreen(s);
      case "group": {
        const bot = this.botOf(d);
        const who = bot ? `@${esc(bot)}` : d.bot === "own" ? "the new bot" : "this bot";
        return {
          body: [top, question("Add the bot to a group"), ...(this.groupBound(s) ? [text(`Now: ${esc(d.bind?.label ?? "")}.`)] : [])],
          rows: [
            options(
              ...(bot ? [option("👥 A whole group", `Pick one: Telegram adds ${who} there, and the group is set.`, linkBtn("👥 Choose a group", `https://t.me/${bot}?startgroup=${d.bindCode}`))] : []),
              option("🧵 One topic of a forum group", `Add ${who} to the group, then send ${code(`/bind ${d.bindCode}`)} inside that topic.`, copyBtn("📋 Copy", `/bind ${d.bindCode}`)),
            ),
            this.nav(s, this.groupBound(s)),
          ],
        };
      }
      case "where": {
        const bot = this.botOf(d);
        const who = bot ? `@${esc(bot)}` : d.bot === "own" ? "the new bot" : "this bot";
        const here = !!d.bind && !d.inGroup;
        const own = d.bot === "own";
        return {
          body: [top, question("Where should the tickets appear?")],
          rows: [
            options(
              own
                ? option(`💬 In my private chat with ${who}`, "Open it and press <b>Start</b> once, so it may write to you.", ...(bot ? [linkBtn("↗ Open", `https://t.me/${bot}`)] : []), b(here ? "● Chosen" : "💬 Choose", "next:here"))
                : option("💬 Here", "In this chat with me.", b(here ? "● Chosen" : "💬 Choose", "next:here")),
              option("👥 In a group", "Your team works the tickets together; each answer is recorded with the name of who gave it.", b(d.inGroup ? "● Chosen" : "👥 Choose", "next:group")),
            ),
            nav,
          ],
        };
      }
      case "wide": {
        const what = d.repos.length > 1 ? "these repositories" : code(d.repos[0] ?? "");
        const more = s.wide ?? [];
        return {
          body: [
            top,
            question("This token reaches more than it needs"),
            text(`Besides ${what} it can also reach ${more.slice(0, 3).map(code).join(", ")}${more.length > 3 ? ` and ${more.length - 3} more` : ""}; a narrower token limits what a leak could do.`),
          ],
          rows: [
            options(
              option("✅ Use it anyway", "Keep this token; you can replace it later in the workspace's menu.", b("✅ Use it", "next")),
              option("🔑 Make a narrower one", `A token for ${what} only: paste it here when you have it.`, b("🔑 Narrower", "narrower")),
            ),
            nav,
          ],
        };
      }
      case "token": {
        const name = this.host.trackerName(d.tracker?.kind);
        const what = d.repos.length > 1 ? "these repositories" : code(d.repos[0] ?? "");
        const on = Object.entries(this.switches(d)).filter(([, v]) => v).map(([k]) => k);
        const help = this.host.tokenHelp(d.tracker ?? { kind: "github" })(d.repos, `Flowee ${d.id ?? ""}`.trim(), on, this.tokenDays(d));
        const step = (x: string) => esc(x).replace(/`([^`]+)`/g, "<code>$1</code>");
        const create = help.url ? [linkBtn("🔑 Create a token", help.url)] : [];
        const next = this.nav(s, !!(d.token || d.tokenStored));
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
            ? [options(option("🔑 Project token", "Reaches this project only.", ...create), option(help.alt.label, esc(help.alt.why), linkBtn("↗ Open", help.alt.url))), next]
            : [...(create.length ? [row(...create)] : []), next],
        };
      }
      default: {
        const edit = !!(s.edit || d.replaces);
        return {
          body: [top, question(edit ? `Save the changes to ${code(d.id ?? "")}?` : `Create the workspace ${code(d.id ?? "")}?`), facts(this.facts(s))],
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
        ...(exts.length ? [options(...exts.map((e, i) => option(`🧩 ${esc(extName(e))}`, esc((typeof e === "object" && e.description) || "A shipped extension."), b("✖ Remove", `remove:${i}`))))] : []),
        row(...(s.history.length ? [b("◀ Back", "back")] : []), b("✅ Apply", "apply"), b("✖ Cancel", "cancel")),
      ],
    };
  }

  /** A sent extension file: validated with the draft's other extensions; problems on the screen. */
  private extFile(s: Session, text: string): undefined {
    const d = s.draft;
    let e: unknown;
    try {
      e = JSON.parse(text);
    } catch (err) {
      s.extProblems = [`The file is not JSON (${err instanceof Error ? err.message : String(err)}).`];
      return;
    }
    const name = extName(e as ExtensionRef);
    const next = [...(d.extensions ?? []).filter((x) => extName(x) !== name), e as ExtensionRef];
    const problems = this.host.extensionProblems?.(next, this.switches(d)) ?? [];
    if (problems.length) {
      s.extProblems = problems;
      return;
    }
    delete s.extProblems;
    d.extensions = next;
    s.note = `🧩 ${name} is added; agents of its roles can be created with the project key.`;
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

  /** The values screen of an option: one row per value with its suggestions, Type, and a sent file. */
  private inputScreen(s: Session): Screen {
    const d = s.draft;
    const f = this.optionOf(s.state) as string;
    const spec = INPUTS[f as keyof typeof INPUTS] as OptionSpec;
    const v = this.values(d, f);
    const rows = shown(spec, v).flatMap((i) => {
      const x = v[i.key];
      const type = b(s.typing === i.key ? "✏️ Typing…" : "✏️ Type", `type:${i.key}`);
      if (i.type === "choice") return [option(esc(i.name), esc(i.ask), ...(i.choices ?? []).map(([c, l]) => b(x === c ? `● ${l}` : l, `set:${i.key}:${c}`)))];
      if (i.type === "flag") return [option(`${x ? "✅" : "⬜"} ${esc(i.name)}`, esc(i.ask), b(x ? "Switch off" : "Switch on", `flag:${i.key}`))];
      if (i.type === "list") {
        const now = (x as string[]) ?? [];
        const offer = [...new Set([...(i.suggest ?? []), ...now])];
        return [
          option(esc(i.name), `${esc(i.ask)} Now: ${now.length ? now.map((y) => code(y)).join(", ") : "none"}.`, type, ...(now.length ? [b("✖ Clear", `clear:${i.key}`)] : [])),
          ...offer.map((y, k) => option(`${now.includes(y) ? "✅" : "⬜"} ${code(y)}`, now.includes(y) ? "chosen" : "suggested", b(now.includes(y) ? "Remove" : "Add", `tog:${i.key}:${k}`))),
        ];
      }
      return [option(esc(i.name), `${esc(i.ask)} Now: ${x === undefined || x === "" ? "none" : code(String(x))}.`, ...(i.suggest ?? []).filter((y) => y !== x).map((y) => b(y, `set:${i.key}:${y}`)), type, ...(x && !i.required ? [b("✖ None", `clear:${i.key}`)] : []))];
    });
    return {
      body: [this.top(s), question(esc(spec.question))],
      rows: [options(...rows), row(b("◀ Back", "back"), b("✅ Apply", "apply"), b("✖ Cancel", "cancel"))],
    };
  }

  /** A press on a values screen that changes one value (`set:<key>:<value>`, `flag:<key>`, `clear:<key>`, `tog:<key>:<i>`, `type:<key>`). */
  private editValue(s: Session, f: string, what: string, rest = ""): undefined {
    const d = s.draft;
    const spec = INPUTS[f as keyof typeof INPUTS] as OptionSpec;
    const [key, ...more] = rest.split(":");
    const value = more.join(":") || undefined;
    const v = this.values(d, f);
    const set = (x: unknown) => {
      d.inputs = { ...(d.inputs ?? {}), [f]: { ...(d.inputs?.[f] ?? {}), [key]: x } };
    };
    const i = spec.inputs.find((x) => x.key === key);
    if (!i) return;
    if (what === "type") s.typing = key;
    else delete s.typing;
    if (what === "set" && value !== undefined) set(i.type === "number" ? Number(value) : value);
    if (what === "flag") set(!v[key]);
    if (what === "clear") set(i.type === "list" ? [] : "");
    if (what === "tog") {
      const now = (v[key] as string[]) ?? [];
      const y = [...new Set([...(i.suggest ?? []), ...now])][Number(value)];
      if (y !== undefined) set(now.includes(y) ? now.filter((z) => z !== y) : [...now, y]);
    }
  }

  /** ✅ Apply on a values screen: the option is on once its values are usable. */
  private apply(s: Session, f: string): string | undefined {
    const why = problem(INPUTS[f as keyof typeof INPUTS] as OptionSpec, this.values(s.draft, f));
    if (why) return why;
    delete s.typing;
    delete s.before;
    if (f !== "pullRequests") s.draft.features[f] = true;
  }

  /** A typed value or a sent file on a values screen. */
  private inputText(s: Session, f: string, text: string, file: boolean): string | undefined {
    const d = s.draft;
    const spec = INPUTS[f as keyof typeof INPUTS] as OptionSpec;
    const v = this.values(d, f);
    const put = (values: Values) => {
      d.inputs = { ...(d.inputs ?? {}), [f]: { ...(d.inputs?.[f] ?? {}), ...values } };
    };
    if (file) {
      const r = fromFile(spec, text, s.typing, v);
      if ("error" in r) return r.error;
      put(r.values);
    } else {
      const i = spec.inputs.find((x) => x.key === s.typing) ?? spec.inputs.find((x) => x.type === "list" || x.type === "label");
      if (!i) return "Tap ✏️ Type beside the value you want to type first.";
      const r = parse(i, text, v[i.key]);
      if ("error" in r) return r.error;
      put({ [i.key]: r.value });
    }
    delete s.typing;
  }

  /** What it will be, as rows of a two-column table. */
  private facts(s: Session): string[][] {
    const d = s.draft;
    const named = d.base?.roles?.length && !d.base.agents;
    return [
      ["📦 Repositories", `${d.repos.map(code).join(", ")} on ${this.host.trackerName(d.tracker?.kind)}`],
      ...(this.host.terminal ? [] : [["🤖 Bot", d.bot === "own" ? `its own${d.botUsername ? `, @${esc(d.botUsername)}` : ""}` : "this bot"]]),
      ["🔀 Way of working", wayOf(this.switches(d))],
      ["💬 Tickets appear", this.where(s)],
      [`🔑 ${this.host.trackerName(d.tracker?.kind)} token`, d.token ? "checked" : d.tokenStored ? "kept from before" : "missing"],
      ["🗝 Project key", named ? "none: the agents keep their own secrets" : d.replaces && d.base?.agents ? "kept from before" : "a new one, shown once"],
    ];
  }

  /** One input for the user's open session; false when there is none (the input is not the wizard's). */
  async input(user: string, at: ChatRef, i: Input): Promise<boolean> {
    if (i.kind === "press" && (i.data === "w:restart" || i.data === "w:new")) {
      if (i.data === "w:restart") this.host.drop(user);
      await this.start(user, at);
      return true;
    }
    const stored = this.host.load(user);
    if (!stored) {
      if (i.kind === "press" && i.data.startsWith("w:"))
        await this.living.show(user, at, [heading("⌛", "This setup is over"), text("It was finished or cancelled."), row(b("🚀 Set up a workspace", "new"))]);
      return i.kind === "press" && i.data.startsWith("w:");
    }
    const s = this.migrate(stored);
    if (this.now() - s.ts > TTL) {
      await this.fire(s, "expire");
      return true;
    }
    const meta = SETUP.states[s.state]?.meta ?? {};
    switch (i.kind) {
      case "bound":
        if (s.state === "group") await this.fire(s, "next", undefined, i);
        else {
          s.draft.bind = { chat: i.chat, topic: i.topic, label: i.label };
          s.draft.inGroup = true;
          await this.show(s);
        }
        return true;
      case "managed":
        if (s.state !== "botCreate") return false;
        await this.fire(s, "next", undefined, i);
        return true;
      case "text":
      case "file": {
        // a file is the wizard's only where a screen takes one; otherwise it is an import
        const event = i.kind === "text" ? meta.typed : meta.files;
        if (!event) return false;
        // typed answers never stay in the chat: deleted before anything else happens (the token always)
        const kept = await this.chat.remove(s.at, i.message).then(
          () => undefined,
          (e) => `I could not delete your message (${e instanceof Error ? e.message : e}); please delete it yourself.`,
        );
        if (kept) s.note = kept;
        await this.fire(s, event, i.text);
        return true;
      }
    }
    if (!i.data.startsWith("w:")) return false;
    const [event, ...value] = i.data.slice(2).split(":");
    if (event === "resume") await this.show(s);
    else await this.fire(s, event, value.join(":") || undefined);
    return true;
  }

  /** A pasted repository link (or several): refused in one sentence, or the draft's repositories. */
  private readRepos(s: Session, text: string): string | undefined {
    const d = s.draft;
    const refs = text.split(/[\s,]+/).filter(Boolean);
    const found = refs.map((r) => this.host.parseRepo(r));
    const bad = refs.filter((_, i) => !found[i]);
    if (!refs.length || bad.length)
      return `${bad.map((x) => `'${x}'`).join(", ") || "That"} ${bad.length > 1 ? "are not repository links" : "is not a repository link"} of GitHub or GitLab; send its link, for example https://github.com/octo/app.`;
    const ok = found as PastedRepo[];
    if (new Set(ok.map((r) => `${r.kind} ${r.api ?? ""}`)).size > 1) return "Paste the repositories of one tracker here; a workspace on several trackers is written as a configuration and imported (📥 Import).";
    const repos = [...new Set(ok.map((r) => r.repo))];
    const where: TrackerRef = { kind: ok[0].kind, ...(ok[0].api ? { api: ok[0].api } : {}) };
    const taken = repos.find((r) => this.host.repoTaken(r, d.replaces, where));
    if (taken) return `'${taken}' is already in your workspace '${this.host.repoTaken(taken, d.replaces, where)}'; a repository belongs to one workspace only.`;
    // two repositories of the same name are told apart by their owner (`acme-app#3`, `octo-app#3`)
    const aliases = aliasesOf(repos);
    const dup = aliases.find((a, i) => aliases.indexOf(a) !== i);
    if (dup) return `Two repositories would both be called '${dup}'; paste each repository once.`;
    d.repos = repos;
    d.tracker = where;
    if (!d.id) d.id = this.host.freeId(aliasOf(repos[0]));
    if (!d.bindCode) d.bindCode = d.id;
  }

  /** A pasted tracker token: checked against every repository, sealed; its reach beyond them noted. */
  private async readToken(s: Session, text: string): Promise<string | undefined> {
    const d = s.draft;
    const token = text.trim();
    if (!/^[\w-]{20,255}$/.test(token)) return `That does not look like a ${this.host.trackerName(d.tracker?.kind)} token; paste just the token.`;
    const sealed = await this.host.seal(token);
    const problems = await this.host.checkRepos(sealed, d.repos, d.tracker ?? { kind: "github" });
    if (problems.length) return problems.join(" ");
    d.token = sealed;
    const wide = (await this.host.wider?.(sealed, d.repos, d.tracker ?? { kind: "github" }).catch(() => [])) ?? [];
    if (wide.length) s.wide = wide;
    else delete s.wide;
  }

  /** The final state `done`: the draft becomes the workspace (a refusal stays on the screen before). */
  private async done(s: Session) {
    const why = this.host.refusal(s.user, s.draft.replaces);
    if (why) {
      s.note = why;
      return this.show(s);
    }
    let r: Awaited<ReturnType<WizardHost["commit"]>>;
    try {
      r = await this.host.commit(s);
    } catch (e) {
      s.note = e instanceof Error ? e.message : String(e);
      return this.show(s);
    }
    this.host.drop(s.user);
    await this.dropHelper(s);
    const give = !!r.key || Object.keys(r.secrets).length > 0;
    if (s.edit && this.returnTo) {
      await this.returnTo(s.user, s.at, r.id, r.warning ? `⚠️ ${esc(r.warning)}` : "✅ Saved.");
      if (give) await this.handOver(s.at, r.id, { key: r.key, secrets: r.secrets });
      return;
    }
    await this.living.show(s.user, s.at, [
      heading("✅", s.draft.replaces ? "Changes saved" : "Workspace ready", code(r.id)),
      ...(r.warning ? [warning(r.warning)] : []),
      ...(r.key
        ? [text(`Below is the workspace's <b>project key</b> for ${code("flowee.py")}, <b>shown only this once</b>. Store it where your agents run (the file shows the line), put the ${code(".flowee.toml")} part into the repository, then delete the file. Your agents read the roles and create themselves with it; you see them in 📂 My workspaces.`)]
        : give
          ? [text(`These are your agents' sign-in secrets for ${code("flowee.py")}, <b>shown only this once</b>. Save each one on the machine where that agent runs (the file shows where), then delete the file.`)]
          : []),
      row(btn("📂 My workspaces", "m:list")),
    ]);
    if (give) await this.handOver(s.at, r.id, { key: r.key, secrets: r.secrets });
    const [next, ...rest] = s.queue ?? [];
    // the key file now stands under the living message: the next workspace starts anew below it
    if (next) await this.over(s.user, s.at, this.host.draftOf(next), undefined, rest, { bottom: give });
  }

  /** The final state `cancelled`: nothing was created; a change from the menu returns to the workspace. */
  private async cancelled(s: Session) {
    this.host.drop(s.user);
    await this.dropHelper(s);
    const d = s.draft;
    if (s.edit && d.replaces && this.returnTo) return void (await this.returnTo(s.user, s.at, d.replaces, "Nothing changed."));
    const edit = !!(s.edit || d.replaces);
    await this.living.show(s.user, s.at, [
      heading("✖", edit ? "Nothing changed" : "Setup cancelled"),
      text(edit ? "The workspace stays as it was." : "Nothing was created."),
      row(...(edit ? [] : [b("🚀 Start again", "new")]), btn("📂 My workspaces", "m:list")),
    ]);
  }

  /** The final state `expired`: a day passed without an answer. */
  private async expired(s: Session) {
    this.host.drop(s.user);
    await this.dropHelper(s);
    await this.living.show(s.user, s.at, [heading("⌛", "This setup expired"), text("A day passed without an answer, so nothing was created."), row(b("🚀 Start again", "new"))]);
  }

  /** The project key (and secrets of agents a document names) as a file that explains itself, once (or a message where files are refused). */
  async handOver(at: ChatRef, id: string, what: { key?: string; secrets?: Record<string, string> }) {
    const body = keyFile(this.host.publicUrl, id, what);
    const buttons = [[btn("🗑 Delete this file from the chat", "m:rmfile")], [linkBtn("❓ How do I use this?", `${this.host.publicUrl}/docs/agents/`)]];
    const title = what.key ? "🔑 Project key: shown only this once." : "🔑 Agent secrets: shown only this once.";
    // shown once: a refused file must not lose it, so it comes as a message instead
    if (this.chat.sendFile && (await this.chat.sendFile(at, `flowee-${id}-${what.key ? "key" : "secrets"}.txt`, body, title, buttons).then(() => true, () => false))) return;
    await this.chat.view(at, [heading("🔑", what.key ? "Project key" : "Agent secrets", code(id)), { html: `<pre>${esc(body)}</pre>` }, row(...buttons[0]), row(...buttons[1])]);
  }
}


/**
 * The key file: the project key as a ready block that stores it with mode 600 where flowee.py reads it (on stdin,
 * never in an argument), the `.flowee.toml` for the repository, and the three commands an agent runs to see the roles
 * and create its agents. Agents a document names with their own secrets get a block each. An agent handed this file
 * and the instance URL can set up the project side by itself.
 */
export function keyFile(url: string, id: string, what: { key?: string; secrets?: Record<string, string> }): string {
  const dir = `~/.secrets/flowee/${id}`;
  const names = Object.keys(what.secrets ?? {});
  const agents = names.flatMap((n) => ["", `# ${n}`, `mkdir -p ${dir} && install -m 600 /dev/stdin ${dir}/${n} <<'EOF'`, (what.secrets ?? {})[n], "EOF"]);
  if (!what.key)
    return [
      `# Flowee workspace ${id}: agents' sign-in secrets for flowee.py, shown only this once.`,
      "# Flowee keeps only a fingerprint of each; a lost secret is replaced in /workspaces (New agent secret).",
      `# Run each block on the machine where that agent runs, then delete this file. More: ${url}/docs/agents/`,
      ...agents,
      "",
    ].join("\n");
  return [
    `# Flowee workspace ${id}: the project key for flowee.py, shown only this once.`,
    "# With it your agents list the roles of the flow, create themselves and work the tickets. Flowee keeps only a",
    "# fingerprint; a lost key is replaced in /workspaces (New project key), and the old one stops working.",
    `# Hand this file to an agent with the address ${url} and say "set this up", or do the three steps below.`,
    `# Then delete this file and the message it came in. More: ${url}/docs/agents/`,
    "",
    "# 1. The key: run this on every machine where an agent runs. It stores the key with mode 600 where",
    "#    .flowee.toml points flowee.py.",
    `mkdir -p ${dir} && install -m 600 /dev/stdin ${dir}/key <<'EOF'`,
    what.key,
    "EOF",
    "",
    "# 2. .flowee.toml: commit it to the repository's root (no secret in it). Each agent runs under its own name:",
    "#    set FLOWEE_AS=<name> in that agent's environment, or edit 'agent' in its clone.",
    `url = "${url}"`,
    `workspace = "${id}"`,
    `key_file = "~/.secrets/flowee/{workspace}/key"`,
    `agent = "dev1"`,
    "",
    "# 3. The roles, then one agent per run you schedule (idempotent: safe in every run), then the list:",
    "#    python3 flowee.py roles",
    "#    python3 flowee.py agents add developer dev1",
    "#    python3 flowee.py agents",
    ...(names.length ? ["", "# Agents the configuration names with their own secrets: one block each, on that agent's machine.", ...agents] : []),
    "",
  ].join("\n");
}

// The setup conversation, chat-agnostic: steps, screens, choices and validation. Every screen is a view built from
// the envoy's blocks (docs/chat-style.md) shown in one living message that each step edits; typed answers are
// deleted after reading. It reaches the instance through `WizardHost`; docs/managed.md walks through it.
import type { RepoDoc, WorkspaceDoc } from "../config/document";
import { btn, copyBtn, esc, facts, heading, linkBtn, option, options, question, row, text, warning } from "../envoy/render";
import { type Block, type Chat, type ChatRef, type ChatRequest, live, type View } from "../ports/chat";
import type { RepoReference, TokenHelp } from "../ports/tracker";

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
  /** Single branch or feature branches (`features.pullRequests`); chosen in the flow step. */
  branching?: "single" | "feature";
  /** The other switches: versioning (`releases`) and the more options. */
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
  /** The steps this setup asks, for "Step k of n". */
  plan?: Step[];
  /** A second screen of the step: the group instructions of the bind step, the options after the branching. */
  sub?: "group" | "options";
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
  | { kind: "managed"; botId: string; username?: string; name?: string }
  | { kind: "bound"; chat: string; topic?: number; label: string };

/** The flow the wizard sets up: its roles and the switches its chart has. */
export interface FlowInfo {
  roles: string[];
  ownerRole: string;
  features: string[];
  /** Roles that exist only with some features: `samples`, `!samples`, `pullRequests.merger=flow`. */
  roleFeatures?: Record<string, string[]>;
}

export interface WizardHost {
  flow(): FlowInfo;
  /** Why the user may not create another workspace, or null. */
  refusal(user: string, replacing?: string): string | null;
  freeId(base: string): string;
  /** `owner/name` of a pasted repository link or name (the tracker adapter knows the shapes). */
  parseRepo: RepoReference;
  /** The token's permissions and a link to the filled-in token form. */
  tokenHelp: TokenHelp;
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
  /** The user's living message (docs/chat-style.md). */
  live(user: string): number | undefined;
  setLive(user: string, id: number): void;
}

const b = (label: string, data: string) => btn(label, `w:${data}`);
export const aliasOf = (repo: string) => repo.split("/")[1].toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+/, "").slice(0, 32) || "repo";
const code = (s: string) => `<code>${esc(s)}</code>`;

const BRANCHING: Record<"single" | "feature", [string, string, string]> = {
  single: ["🌿", "Single branch", "The agents commit straight to the main branch; the tester tests the main branch."],
  feature: ["🔀", "Feature branches", "One branch and one pull request per ticket; its checks must be green, and it is merged when the tester passes it."],
};
/** Versioning first, then the more options; each works with either branching. */
const OPTIONS: Record<string, [string, string]> = {
  releases: ["Versioning", "You get a test card only once a published version has the ticket's code; the card says “In 1.4 or later”."],
  samples: ["Samples", "A sampler finds a real sample file before development starts."],
  uiReview: ["UI review", "A pass that changes the screens comes to you first; it needs the paths that count as UI."],
  dependencyTickets: ["Dependency updates", "Each update pull request (e.g. Dependabot) becomes a ticket the developers merge."],
  untrustedReports: ["Outside reports", "Tickets with text from users go to the board first, until it has checked them."],
};
const ROLES: Record<string, [string, string]> = {
  board: ["🧭 Board", "Plans and sorts the tickets, and asks you."],
  developer: ["🛠 Developers", "Build what the tickets ask for."],
  tester: ["🧪 Testers", "Test each ticket before it closes."],
  sampler: ["📎 Samplers", "Find real sample files to test with."],
};
/** The way of working in words: the branching, then every option switched on. */
export const wayOf = (features: Record<string, unknown> = {}) =>
  [BRANCHING[features.pullRequests ? "feature" : "single"][1], ...Object.keys(OPTIONS).filter((f) => features[f]).map((f) => OPTIONS[f][0])].join(", ");
const roleName = (r: string) => ROLES[r]?.[0] ?? esc(r);

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
export const boundView = (id: string): View => [heading("✅", `Tickets of ${code(id)} appear here`), text("Everyone here can read them; only the workspace's owners answer them.")];

/** Something failed: one sentence, and the way back. */
export const failedView = (why: string, setup: boolean): View => [
  heading("⚠️", "That did not work"),
  text(esc(why)),
  row(setup ? b("▶ Continue the setup", "resume") : b("🚀 Set up a workspace", "new")),
];

export function fresh(user: string, at: ChatRef, now: number): Session {
  return { user, at, step: "bot", back: [], draft: { repos: [], features: {}, roles: {} }, ts: now };
}

/** A chat as its owner knows it, without its title. */
export const chatLabel = (chat: string, topic?: number) => (!chat.startsWith("-") ? "a private chat" : topic ? "one topic of your group" : "your group");

/** A draft from an existing or imported document. */
export function fromDoc(d: WorkspaceDoc, flow: FlowInfo): Draft {
  const roles: Record<string, number> = {};
  for (const r of d.roles) if (r.role !== flow.ownerRole) roles[r.role] = (roles[r.role] ?? 0) + 1;
  const { pullRequests, ...features } = d.features ?? {};
  return {
    id: d.id,
    base: d,
    bot: d.chat?.managed ? "own" : "shared",
    repos: d.tracker.repos.map((r) => (typeof r === "string" ? r : r.repo)),
    branching: pullRequests ? "feature" : "single",
    features: Object.fromEntries(Object.entries(features).map(([k, v]) => [k, v !== false])),
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

/** The workspace document of a finished draft; fields of an imported or existing document are kept. */
export function toDoc(d: Draft, user: string, preset: FlowInfo, shared: { token: string; webhookSecret: string; username?: string }, publicUrl: string, api?: string): WorkspaceDoc {
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
    // the starting point that matches the branching; an inline chart stays
    flow: base.flow && "chart" in base.flow ? base.flow : { preset: d.branching === "feature" ? "pr-release" : "trunk" },
    // a feature switched on keeps the options the document gave it
    features: Object.fromEntries(
      Object.entries({ ...d.features, pullRequests: d.branching === "feature" })
        .filter(([, on]) => on)
        .map(([k, on]) => [k, typeof base.features?.[k as keyof typeof base.features] === "object" ? base.features?.[k as keyof typeof base.features] : on]),
    ),
    tracker: { ...(base.tracker ?? {}), type: "github", repos, token: slot(id, "tracker"), ...(api && !base.tracker?.api ? { api } : {}) },
    roles: instances(d.roles, preset).map((r) => ({ ...r, secret: slot(id, r.instance) })),
    owners,
  };
  if (!Object.keys(doc.features ?? {}).length) delete doc.features;
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
  private agentRoles(d: Draft) {
    const p = this.host.flow();
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
    if (!d.bind) return "nowhere: the workspace is used through its API only";
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
            question("Which GitHub repository is this workspace for?"),
            text(`Paste the repository's link, for example ${code("https://github.com/octo/app")}. Several: one per line.`),
            ...(d.repos.length ? [text(`Now: ${d.repos.map(code).join(", ")}`)] : []),
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
        if (s.sub !== "options")
          return {
            body: [top, question("How should the agents bring in their code?"), text("Choose one. Versioning and the other options come next; each works with either.")],
            rows: [
              options(
                ...(["single", "feature"] as const).map((k) => option(`${BRANCHING[k][0]} ${BRANCHING[k][1]}`, BRANCHING[k][2], b(d.branching === k ? "● Chosen" : `${BRANCHING[k][0]} Choose`, `branch:${k}`))),
              ),
              nav,
            ],
          };
        const offered = Object.keys(OPTIONS).filter((f) => this.host.flow().features.includes(f));
        const toggle = (f: string) => option(`${d.features[f] ? "✅" : "⬜"} ${OPTIONS[f][0]}`, OPTIONS[f][1], b(d.features[f] ? "Switch off" : "Switch on", `feat:${f}`));
        const more = offered.filter((f) => f !== "releases");
        return {
          body: [
            top,
            question("What else should the flow do?"),
            text(`With <b>${BRANCHING[d.branching ?? "single"][1]}</b>. Each switch works on its own; you can change them later.`),
          ],
          rows: [
            ...(offered.includes("releases") ? [options(toggle("releases"))] : []),
            ...(more.length ? [text("<b>More options</b>"), options(...more.map(toggle))] : []),
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
              option("👥 In a group", "Everyone there can read them; only you answer them.", b("👥 Choose", "bind:group")),
            ),
            nav,
          ],
        };
      }
      case "credential": {
        const on = Object.entries(this.switches(d)).filter(([, v]) => v).map(([k]) => k);
        const help = this.host.tokenHelp(d.repos, `Flowee ${d.id ?? ""}`.trim(), on);
        return {
          body: [
            top,
            question(`Send me a GitHub token for ${d.repos.length > 1 ? "these repositories" : code(d.repos[0] ?? "")}`),
            text(
              `${help.url ? "Tap <b>🔑 Create a token</b>: GitHub opens the form with the permissions filled in. " : ""}Under <b>Repository access</b> choose ${d.repos.map(code).join(", ")}, create the token and paste it here.`,
            ),
            text("🔒 I delete your message right away and keep the token encrypted; it is never shown again."),
            text("<b>Permissions it needs</b>"),
            facts(help.permissions.map((x) => [esc(x)])),
          ],
          rows: [...(help.url ? [row(linkBtn("🔑 Create a token", help.url))] : []), nav],
        };
      }
      case "roles": {
        const roles = this.agentRoles(d);
        return {
          body: [
            top,
            question("How many agents do you want?"),
            text(`Each agent gets its own secret to sign in with. You get them all once at the end, with a ready ${code(".flowee.toml")}.`),
          ],
          rows: [options(...roles.map((r) => option(roleName(r), ROLES[r]?.[1] ?? "", b("−", `role:${r}:-1`), { label: String(d.roles[r] ?? 0) }, b("+", `role:${r}:1`)))), this.nav(s, "roles:done")],
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

  /** What it will be, as rows of a two-column table. */
  private facts(s: Session): string[][] {
    const d = s.draft;
    const p = this.host.flow();
    const agents = instances(d.roles, p).filter((r) => r.role !== p.ownerRole).map((r) => esc(r.instance));
    return [
      ["📦 Repositories", d.repos.map(code).join(", ")],
      ["🤖 Bot", d.bot === "own" ? `its own${d.botUsername ? `, @${esc(d.botUsername)}` : ""}` : "this bot"],
      ["🔀 Way of working", wayOf(this.switches(d))],
      ["💬 Tickets appear", this.where(s)],
      ["🔑 GitHub token", d.token ? "checked" : d.tokenStored ? "kept from before" : "missing"],
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
        // UI review means nothing without the paths that count as UI, which the configuration names
        if (v === "uiReview" && !d.features[v] && typeof d.base?.features?.uiReview !== "object")
          return this.show(s, { note: "UI review needs the paths that count as UI: export the configuration, add features.uiReview.paths, and import it." });
        d.features[v] = !d.features[v];
        return this.show(s);
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
      case "confirm":
        return this.confirm(s);
    }
  }

  /** A typed answer: deleted after reading (always for the token), the result shown in the living message. */
  private async text(s: Session, text: string, message: number): Promise<boolean> {
    const d = s.draft;
    if (s.step !== "credential" && s.step !== "repos") return false;
    // the token never stays in the chat: deleted before anything else happens
    const kept = await this.chat.remove(s.at, message).then(
      () => undefined,
      (e) => `I could not delete your message (${e instanceof Error ? e.message : e}); please delete it yourself.`,
    );
    if (s.step === "credential") {
      const token = text.trim();
      if (!/^[\w-]{20,255}$/.test(token)) {
        await this.show(s, { note: [kept, "That does not look like a GitHub token; paste just the token."].filter(Boolean).join(" ") });
        return true;
      }
      const sealed = await this.host.seal(token);
      const problems = await this.host.checkRepos(sealed, d.repos);
      if (problems.length) {
        await this.show(s, { note: [kept, ...problems].filter(Boolean).join(" ") });
        return true;
      }
      d.token = sealed;
      await this.advance(s, { note: kept });
      return true;
    }
    const refs = text.split(/[\s,]+/).filter(Boolean);
    const bad = refs.filter((r) => !this.host.parseRepo(r));
    const repos = [...new Set(refs.flatMap((r) => this.host.parseRepo(r) ?? []))];
    const no = (why: string) => this.show(s, { note: why }).then(() => true);
    if (!repos.length || bad.length)
      return no(`${bad.map((x) => `'${x}'`).join(", ") || "That"} ${bad.length > 1 ? "are not GitHub repositories" : "is not a GitHub repository"}; send its link, for example https://github.com/octo/app.`);
    const taken = repos.find((r) => this.host.repoTaken(r, d.replaces));
    if (taken) return no(`'${taken}' is already in your workspace '${this.host.repoTaken(taken, d.replaces)}'; a repository belongs to one workspace only.`);
    const aliases = repos.map(aliasOf);
    const dup = aliases.find((a, i) => aliases.indexOf(a) !== i);
    if (dup) return no(`Two repositories are both called '${dup}'; import a configuration that names them apart instead.`);
    d.repos = repos;
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
      ...(names.length ? [text("The file below holds each agent's secret, <b>shown only this once</b>: give each agent its own, then delete the file.")] : []),
      row(btn("📂 My workspaces", "m:list")),
    ]);
    if (names.length) await this.handOver(s.at, r.id, r.secrets);
    const [next, ...rest] = s.queue ?? [];
    // the secrets file now stands under the living message: the next workspace starts anew below it
    if (next) await this.over(s.user, s.at, this.host.draftOf(next), undefined, rest, { bottom: names.length > 0 });
  }

  /** The agents' secrets with a ready .flowee.toml, once, as a file (or a message where files are refused). */
  async handOver(at: ChatRef, id: string, secrets: Record<string, string>) {
    const toml = [
      `url = "${this.host.publicUrl}"`,
      `workspace = "${id}"`,
      `instance = "${Object.keys(secrets)[0]}"            # each agent its own, or FLOWEE_AS`,
      `secret_file = "~/.secrets/flowee/{workspace}/{instance}"   # or FLOWEE_TOKEN`,
    ].join("\n");
    const body = `# Flowee workspace ${id}: agent secrets (shown once; Flowee keeps only a fingerprint)\n${Object.entries(secrets)
      .map(([k, v]) => `${k} = ${v}`)
      .join("\n")}\n\n# .flowee.toml\n${toml}\n`;
    // shown once: a refused file must not lose them, so they come as a message instead
    if (this.chat.sendFile && (await this.chat.sendFile(at, `flowee-${id}-secrets.txt`, body, "🔑 Agent secrets: shown only this once.").then(() => true, () => false))) return;
    await this.chat.view(at, [heading("🔑", "Agent secrets", code(id)), { html: `<pre>${esc(body)}</pre>` }]);
  }
}

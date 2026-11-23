// The managed mode's instance: one host (a Durable Object, or one object in the process) holding the stored workspace registry, the sealed secrets, the
// wizard sessions and the bots made for workspaces. Every update of the instance bot and of the workspaces' own
// bots passes through here first: the wizard and the management menu take theirs, the rest is forwarded to the
// workspace bound to the update's bot, chat and topic.
import type { InstanceConfig, InstanceDoc, WorkspaceDoc } from "../config/document";
import { FLOW, rawFlow } from "../config/presets";
import { digestOf, StoredRegistry } from "../config/registry";
import { repoClashes, repoIdent, repoList, secretNames, validate } from "../config/schema";
import { Fail } from "../core/errors";
import { list } from "../core/chart";
import { type FeaturesDoc, featuresOf } from "../core/features";
import { hex, same, sha256 } from "../core/text";
import type { BotAccess } from "../ports/bots";
import type { Chat, ChatEvent, ChatMessage, ChatRef, Command } from "../ports/chat";
import type { Secrets } from "../ports/secrets";
import type { Store } from "../ports/store";
import type { InstanceApi, Platform, Room, Routed } from "../runtime/platform";
import { Manager, type ManageHost } from "../wizard/manage";
import { boundView, chatLabel, type Draft, failedView, fromDoc, type FlowInfo, type Session, slot, toDoc, Wizard } from "../wizard/wizard";
import { INSTANCE_UPDATES, Telegram, TelegramBots } from "./chat-telegram";
import { Terminal, type TuiFrame, tuiTables } from "./chat-tui";
import type { Env } from "./instance";
import { PHOTO } from "./photo";
import { envSecrets, PERSON_HEADER, WORKSPACE_HEADER } from "./workspace-host";
import { json } from "../api/http";
import { TRACKER_KINDS } from "../config/trackers";
import { recognise, TRACKERS } from "./trackers";
import { randomSecret, seal, unseal, vaultKey } from "./vault";

export const PRIVATE_COMMANDS: Command[] = [
  { command: "start", description: "what Flowee does" },
  { command: "setup", description: "set up a workspace" },
  { command: "workspaces", description: "your workspaces" },
  { command: "import", description: "import a configuration" },
  { command: "export", description: "export your configurations" },
];

export class InstanceHost implements InstanceApi {
  readonly store: Store;
  private plain?: Map<string, string>;
  private reg?: StoredRegistry;
  private cfg!: InstanceConfig;

  constructor(
    private room: Room,
    public env: Env,
    private platform: Pick<Platform, "workspace">,
  ) {
    this.store = room.store;
    this.store.exec("CREATE TABLE IF NOT EXISTS vault (name TEXT PRIMARY KEY, ws TEXT NOT NULL, sealed TEXT NOT NULL)");
    this.store.exec("CREATE TABLE IF NOT EXISTS sessions (user TEXT PRIMARY KEY, data TEXT NOT NULL, ts INTEGER NOT NULL)");
    this.store.exec("CREATE TABLE IF NOT EXISTS updates (bot TEXT NOT NULL, id INTEGER NOT NULL, ts INTEGER NOT NULL, PRIMARY KEY (bot, id))");
    this.store.exec("CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)");
  }

  // ---- secrets and registry ----

  private key = () => vaultKey(this.env.FLOWEE_KEY);

  private async unlock() {
    if (this.plain) return;
    const key = await this.key();
    const m = new Map<string, string>();
    for (const r of this.store.rows<{ name: string; sealed: string }>("SELECT name, sealed FROM vault")) m.set(r.name, await unseal(key, r.sealed));
    this.plain = m;
  }

  readonly secrets: Secrets = { get: (n) => this.plain?.get(n) ?? envSecrets(this.env).get(n) };

  private async put(name: string, ws: string, value: string, sealed?: string) {
    this.store.exec("INSERT OR REPLACE INTO vault VALUES (?, ?, ?)", name, ws, sealed ?? (await seal(await this.key(), value)));
    this.plain?.set(name, value);
  }

  private get registry(): StoredRegistry {
    this.reg ??= new StoredRegistry(this.secrets, this.store);
    return this.reg;
  }

  /** Every call starts here: the configuration of this request, the vault opened, preconfigured workspaces seeded. */
  private async ready(doc: InstanceDoc) {
    if (!doc.instance) throw new Fail(500, "bad_config", "The managed mode needs the instance section in FLOWEE_CONFIG.");
    this.cfg = doc.instance;
    await this.unlock();
    const mark = hex(await sha256(JSON.stringify(doc.workspaces)));
    if (this.kv("seeded") !== mark) {
      for (const w of doc.workspaces) {
        this.registry.import(w, this.registry.owner(w.id) || this.cfg.owner);
        await this.push(w.id);
      }
      this.setKv("seeded", mark);
    }
  }

  private kv = (k: string) => this.store.rows<{ v: string }>("SELECT v FROM kv WHERE k = ?", k)[0]?.v;
  private setKv = (k: string, v: string) => void this.store.exec("INSERT OR REPLACE INTO kv VALUES (?, ?)", k, v);

  private stub(id: string) {
    return this.platform.workspace(id);
  }

  /** Hands a workspace its document and its sealed secrets (it opens them with the same key). */
  private async push(id: string) {
    const doc = this.registry.get(id);
    if (!doc) return;
    const names = secretNames(doc);
    const sealed = Object.fromEntries(this.store.rows<{ name: string; sealed: string }>("SELECT name, sealed FROM vault").filter((r) => names.includes(r.name)).map((r) => [r.name, r.sealed]));
    await this.stub(id).configure(doc, sealed, this.cfg.publicUrl);
  }

  private main() {
    return new Telegram(this.secrets.get(this.cfg.bot.token), this.cfg.bot.token);
  }

  private flowInfo(d?: Draft): FlowInfo {
    const { chart, options } = d ? rawFlow({ flow: { preset: "trunk" }, extensions: d.extensions, features: d.features as FeaturesDoc }) : FLOW;
    return {
      roles: Object.keys(options.roles),
      ownerRole: options.ownerRole as string,
      features: [...featuresOf(chart, options)],
      roleFeatures: Object.fromEntries(Object.entries(options.roles).flatMap(([r, o]) => (o.features ? [[r, list(o.features)]] : []))),
    };
  }

  // ---- the wizard's host ----

  /** The wizard's and the menu's host; `person`: a terminal user (`tui:<key digest>`), whose workspaces get the terminal. */
  private host(person?: { digest: string; name: string }): ManageHost {
    const reg = this.registry;
    const cfg = this.cfg;
    const tg = this.main();
    const bots = new TelegramBots(tg);
    const key = this.key;
    const self = this;
    const flow = this.flowInfo();
    const botOf = (id: string) => this.kv(`bot:${id}`);
    const tuiOf = (user: string) => (user.startsWith("tui:") ? user.slice(4) : undefined);
    const host: ManageHost = {
      ownBots: !person,
      terminal: !!person,
      manages: (user, d) => !!tuiOf(user) && !!d.tui?.people.some((p) => p.key === tuiOf(user) && p.role === "manager"),
      async addPerson(id, role) {
        const doc = structuredClone(reg.get(id) as WorkspaceDoc);
        const people = doc.tui?.people ?? [];
        let n = people.length + 1;
        while (people.some((p) => p.id === `person-${n}`)) n++;
        const key = `fwk_${randomSecret()}`;
        const pid = `person-${n}`;
        doc.tui = { people: [...people, { id: pid, name: `Person ${n}`, role, key: await digestOf(key) }] };
        const errs = validate(doc);
        if (errs.length) throw new Error(errs.join(" "));
        reg.import(doc);
        await self.push(id);
        return { person: pid, key };
      },
      async removePerson(id, pid) {
        const doc = structuredClone(reg.get(id) as WorkspaceDoc);
        const people = (doc.tui?.people ?? []).filter((p) => p.id !== pid);
        if (!people.length) throw new Error("The last person stays: add another one first.");
        doc.tui = { people };
        reg.import(doc);
        await self.push(id);
      },
      botUsername: cfg.bot.username,
      publicUrl: cfg.publicUrl,
      flow: (d) => (d ? self.flowInfo(d) : flow),
      parseRepo: recognise(cfg.trackerApi),
      tokenHelp: (t) => TRACKERS[t.kind].tokenHelp(t.api ?? (t.kind === "github" ? cfg.trackerApi : undefined)),
      trackerName: (kind = "github") => TRACKER_KINDS[kind].name,
      live: (user) => {
        const v = self.kv(`live:${user}`);
        return v === undefined ? undefined : Number(v);
      },
      setLive: (user, id) => self.setKv(`live:${user}`, String(id)),
      expectImport: (user, on) => (on ? self.setKv(`import:${user}`, String(Date.now())) : void self.store.exec("DELETE FROM kv WHERE k = ?", `import:${user}`)),
      refusal(user, replacing) {
        const t = tuiOf(user);
        const creators = [...(cfg.creators ?? [cfg.owner]), ...(cfg.tui?.people ?? []).filter((p) => p.role === "manager").map((p) => `tui:${p.key}`)];
        if (t && !replacing && !creators.includes(user)) return "Only the people this instance allows may set up workspaces; ask its owner.";
        // a manager the creator named may change the workspace without being allowed to create any
        if (!replacing && !creators.includes(user) && user !== cfg.owner) return "Only the people this instance allows may set up workspaces; ask its owner.";
        const max = cfg.limits?.workspacesPerUser ?? 5;
        if (!replacing && reg.ownedBy(user).length >= max) return `You have ${max} workspaces, the most this instance allows; delete one first.`;
        return null;
      },
      freeId(base) {
        const b = base.replace(/[^a-z0-9-]/g, "-").replace(/^-+/, "").slice(0, 40) || "workspace";
        const taken = (x: string) => !!reg.get(x) || self.store.rows<{ data: string }>("SELECT data FROM sessions").some((r) => (JSON.parse(r.data) as Session).draft.id === x);
        let id = b;
        for (let i = 2; taken(id); i++) id = `${b}-${i}`;
        return id;
      },
      seal: async (v) => seal(await key(), v),
      async checkRepos(sealed, repos, t) {
        const token = await unseal(await key(), sealed);
        const api = t.api ?? (t.kind === "github" ? cfg.trackerApi : undefined);
        const out: string[] = [];
        for (const repo of repos) {
          const status = await TRACKERS[t.kind].make({ repo, api, token, tokenName: "the token" }).probe();
          if (status !== 200) out.push(`${TRACKER_KINDS[t.kind].name} answered ${status} for ${repo}: the repository does not exist or the token cannot reach it.`);
        }
        return out;
      },
      async wider(sealed, repos, t) {
        const token = await unseal(await key(), sealed);
        const api = t.api ?? (t.kind === "github" ? cfg.trackerApi : undefined);
        const want = new Set(repos.map((r) => r.toLowerCase()));
        const seen = await TRACKERS[t.kind].make({ repo: repos[0], api, token, tokenName: "the token" }).reach();
        return seen.filter((r) => !want.has(r.toLowerCase()));
      },
      tokenDays: cfg.tokenDays,
      repoTaken: (repo, except, t) => {
        const ident = repoIdent(t.kind, t.api ?? (t.kind === "github" ? cfg.trackerApi : undefined) ?? TRACKER_KINDS[t.kind].api, repo);
        return reg.list().find((w) => w.id !== except && repoList(w).some((r) => r.ident === ident))?.id;
      },
      async adoptBot(s, botId) {
        const token = await bots.token(botId);
        const hook = randomSecret();
        s.draft.botToken = await seal(await key(), token);
        s.draft.hook = await seal(await key(), hook);
        // polling (self-hosted): the runtime fetches the new bot's updates itself
        if (cfg.transport !== "polling") await new Telegram(token, "the new bot's token").setWebhook(`${cfg.publicUrl}/telegram/w/${s.draft.id}`, hook);
      },
      async commit(s) {
        const d = s.draft;
        const doc = toDoc(d, s.user, self.flowInfo(d), cfg.bot, cfg.publicUrl, cfg.trackerApi);
        const t = tuiOf(s.user);
        if (t) {
          // made in the terminal: the inbox is the terminal, and the one who set it up is its first manager
          doc.owners = doc.owners.filter((o) => !o.chat?.startsWith("tui:"));
          if (!doc.owners.length) doc.owners = [{ name: person?.name ?? "Owner" }];
          const people = doc.tui?.people ?? [];
          if (!people.some((p) => p.key === t)) people.unshift({ id: (person?.name ?? "owner").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "owner", name: person?.name ?? "Owner", role: "manager", key: t });
          doc.tui = { people };
        }
        if (cfg.transport === "polling" && doc.chat) doc.chat.transport = "polling";
        const before = d.replaces ? reg.get(d.replaces) : undefined;
        const errs = validate(doc);
        if (errs.length) throw new Error(errs.join(" "));
        reg.import(doc, s.user);
        const k = await key();
        const has = (n: string) => !!self.secrets.get(n);
        if (d.token) await self.put(doc.tracker.token, doc.id, await unseal(k, d.token), d.token);
        if (d.botToken && doc.chat) {
          await self.put(doc.chat.token, doc.id, await unseal(k, d.botToken), d.botToken);
          await self.put(doc.chat.webhookSecret, doc.id, await unseal(k, d.hook as string), d.hook);
          if (d.botId) self.setKv(`bot:${doc.id}`, d.botId);
        }
        const secrets: Record<string, string> = {};
        for (const r of doc.roles)
          if (!has(r.secret)) {
            secrets[r.instance] = randomSecret();
            await self.put(r.secret, doc.id, await digestOf(secrets[r.instance]));
          }
        // secrets the old version named and the new one does not
        const keep = new Set(secretNames(doc));
        for (const n of before ? secretNames(before) : []) if (!keep.has(n)) self.dropSecret(n);
        reg.reindex();
        await self.push(doc.id);
        // the workspace exists now: a refused profile must not undo it or hide the agents' secrets
        const warning = await self.stub(doc.id)
          .fetch(new Request("https://flowee/setup", { method: "POST", headers: { [WORKSPACE_HEADER]: doc.id } }))
          .then(
            () => undefined,
            (e: unknown) => `The bot's profile was not set (${e instanceof Error ? e.message : e}); the next deploy tries again.`,
          );
        return { id: doc.id, secrets, doc, warning };
      },
      load: (user) => {
        const r = self.store.rows<{ data: string }>("SELECT data FROM sessions WHERE user = ?", user)[0];
        return r && (JSON.parse(r.data) as Session);
      },
      save: (s) => void self.store.exec("INSERT OR REPLACE INTO sessions VALUES (?, ?, ?)", s.user, JSON.stringify(s), s.ts),
      drop: (user) => void self.store.exec("DELETE FROM sessions WHERE user = ?", user),
      draftOf(doc) {
        const d: Draft = fromDoc(doc, flow);
        if (reg.get(doc.id)) d.replaces = doc.id;
        // only the workspace's own slots count: an imported document never reaches another workspace's secrets
        d.tokenStored = !!d.replaces && reg.owner(doc.id) !== undefined && !!self.secrets.get(slot(doc.id, "tracker"));
        if (!doc.chat) d.noChat = true;
        if (doc.chat?.managed) {
          d.botId = botOf(doc.id);
          if (d.botId && !self.secrets.get(slot(doc.id, "bot"))) delete d.botId;
          d.botUsername = doc.chat.username;
        }
        d.bindCode = doc.id;
        return d;
      },
      // the creator's workspaces, and those whose document names the user among its managers
      owned: (user) =>
        [...new Set([...reg.ownedBy(user), ...reg.list().filter((d) => d.managers?.includes(user) || (!!tuiOf(user) && d.tui?.people.some((p) => p.key === tuiOf(user) && p.role === "manager"))).map((d) => d.id)])].flatMap((id) => reg.get(id) ?? []),
      doc: (id) => reg.get(id),
      owner: (id) => reg.owner(id),
      paused: (id) => reg.paused(id),
      setPaused: async (id, v) => reg.setPaused(id, v),
      async remove(id) {
        reg.remove(id);
        for (const r of self.store.rows<{ name: string }>("SELECT name FROM vault WHERE ws = ?", id)) self.dropSecret(r.name);
        self.store.exec("DELETE FROM kv WHERE k = ?", `bot:${id}`);
        await self.stub(id).wipe();
      },
      async rotate(id, instance) {
        const doc = reg.get(id) as WorkspaceDoc;
        const r = doc.roles.find((x) => x.instance === instance) as WorkspaceDoc["roles"][number];
        const secret = randomSecret();
        await self.put(r.secret, id, await digestOf(secret));
        reg.reindex();
        await self.push(id);
        return secret;
      },
      async addAgent(id, role) {
        const doc = structuredClone(reg.get(id) as WorkspaceDoc);
        const taken = new Set(doc.roles.map((r) => r.instance));
        const short = role === "developer" ? "dev" : role;
        let instance = role === "developer" ? "dev1" : short;
        for (let i = 2; taken.has(instance); i++) instance = `${short}${i}`;
        doc.roles.splice(doc.roles.findIndex((r) => r.role === flow.ownerRole), 0, { instance, role, secret: slot(id, instance) });
        const errs = validate(doc);
        if (errs.length) throw new Error(errs.join(" "));
        reg.import(doc);
        const secret = randomSecret();
        await self.put(slot(id, instance), id, await digestOf(secret));
        reg.reindex();
        await self.push(id);
        return { instance, secret };
      },
      async removeAgent(id, instance) {
        const doc = structuredClone(reg.get(id) as WorkspaceDoc);
        const r = doc.roles.find((x) => x.instance === instance && x.role !== flow.ownerRole);
        if (!r) throw new Error(`The workspace has no agent '${instance}'.`);
        doc.roles = doc.roles.filter((x) => x !== r);
        reg.import(doc);
        self.dropSecret(r.secret);
        reg.reindex();
        // the workspace releases the claims of an instance its document no longer names (configure)
        await self.push(id);
      },
      async replaceBotToken(id) {
        const doc = reg.get(id) as WorkspaceDoc;
        const botId = botOf(id);
        if (!botId || !doc.chat) throw new Error("This workspace has no own bot.");
        const token = await bots.replaceToken(botId);
        await self.put(doc.chat.token, id, token);
        const hook = self.secrets.get(doc.chat.webhookSecret) ?? "";
        if (cfg.transport !== "polling") await new Telegram(token, doc.chat.token).setWebhook(`${cfg.publicUrl}/telegram/w/${id}`, hook);
        await self.push(id);
      },
      access: (id) => bots.access(botOf(id) ?? ""),
      setAccess: (id, a: BotAccess) => bots.setAccess(botOf(id) ?? "", a),
      sync: (id) => self.stub(id).syncStatus(),
      manualHook: (id, alias) => self.stub(id).manualHook(alias),
      validate: (doc) => {
        const errs = validate(doc);
        return errs.length ? errs : repoClashes(reg.list(), doc as WorkspaceDoc);
      },
    };
    return host;
  }

  private dropSecret(name: string) {
    this.store.exec("DELETE FROM vault WHERE name = ?", name);
    this.plain?.delete(name);
  }

  private tools(chat: Chat, person?: { digest: string; name: string }) {
    const host = this.host(person);
    const wizard = new Wizard(chat, host, () => Date.now());
    const manager = new Manager(wizard, host, chat);
    return { host, wizard, manager };
  }

  private seen(bot: string, update: unknown) {
    const id = (update as { update_id?: unknown })?.update_id;
    if (typeof id !== "number") return true;
    if (this.store.rows("SELECT 1 FROM updates WHERE bot = ? AND id = ?", bot, id).length) return true;
    this.store.exec("INSERT INTO updates VALUES (?, ?, ?)", bot, id, Date.now());
    return false;
  }

  /** `/bind <code>` sent in a group (or a topic of it) to the bot of a waiting setup. */
  private async bind(m: ChatMessage, tg: Chat): Promise<boolean> {
    // `/start <code>` is what a group link (t.me/<bot>?startgroup=<code>) makes the user send when it adds the bot
    const c = /^\/(?:bind|start)(?:@\w+)?\s+([a-z0-9-]+)\s*$/.exec(m.text ?? "");
    if (!c || m.chatKind !== "group") return false;
    const s = this.store
      .rows<{ data: string }>("SELECT data FROM sessions")
      .map((r) => JSON.parse(r.data) as Session)
      .find((x) => x.step === "bind" && x.draft.bindCode === c[1] && x.user === m.from);
    if (!s) return false;
    const t = m.chatTitle;
    const label = t ? (m.at.topic ? `one topic of “${t}”` : `the group “${t}”`) : chatLabel(m.at.chat, m.at.topic);
    await tg.view(m.at, boundView(s.draft.id ?? "")).catch(() => {});
    await this.tools(this.main()).wizard.input(s.user, s.at, { kind: "bound", chat: m.at.chat, topic: m.at.topic, label });
    return true;
  }

  // ---- the terminal (docs/tui-protocol.md): setup and management for people with a key ----

  /** The instance's seat for a terminal key: its people, and every manager of a workspace. */
  async tuiSeat(doc: InstanceDoc, digest: string): Promise<{ name: string; role: "manager" | "member" } | null> {
    await this.ready(doc);
    const p = this.cfg.tui?.people.find((x) => x.key === digest);
    if (p) return { name: p.name ?? p.id, role: p.role ?? "member" };
    const m = this.registry.people(digest).find((x) => x.person.role === "manager");
    return m ? { name: m.person.name ?? m.person.id, role: "member" } : null;
  }

  private terminal(digest: string) {
    const ns = `p_${digest.slice(0, 16)}_`;
    this.store.exec(tuiTables(ns));
    const tag = `tui:${digest.slice(0, 16)}`;
    return { term: new Terminal(this.store, { chat: `tui:${digest}` }, (seq) => this.room.sockets?.ring(tag, JSON.stringify({ seq })), () => Date.now(), ns), tag };
  }

  /** `/tui/socket` of the instance's conversation, behind the router's key check (the doorbell needs no document). */
  async fetch(req: Request): Promise<Response> {
    const who = JSON.parse(req.headers.get(PERSON_HEADER) ?? "null") as { digest: string } | null;
    if (!who || !/^[0-9a-f]{64}$/.test(who.digest) || new URL(req.url).pathname !== "/tui/socket") return json({ ok: false, error: "not_found", message: "No such endpoint." }, 404);
    const { tag } = this.terminal(who.digest);
    return this.room.sockets ? this.room.sockets.accept(tag) : json({ ok: false, error: "unsupported", message: "This runtime has no sockets; poll sync instead." }, 501);
  }

  /** `/tui/sync` of the instance's conversation: the frames handled as the instance bot's private chat, then the events after `after`. */
  async tuiSync(doc: InstanceDoc, who: { digest: string; name: string }, raw: string): Promise<string> {
    await this.ready(doc);
    const { term } = this.terminal(who.digest);
    let body: { after?: unknown; send?: unknown } = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch {}
    const after = typeof body.after === "number" && Number.isInteger(body.after) ? body.after : 0;
    const person = { id: who.digest.slice(0, 16), name: who.name, role: "manager" as const };
    for (const f of Array.isArray(body.send) ? (body.send as TuiFrame[]).slice(0, 50) : []) {
      const u = term.frame(f, person);
      const e = u && term.parse(u);
      if (!e) continue;
      // the instance's user is the key's digest: sessions, owners and the menu stay that person's
      const ev = { ...e, from: `tui:${who.digest}`, ...("query" in e ? { query: `tui:${person.id}:${e.update}` } : {}) } as ChatEvent;
      try {
        await this.onMain(term, ev, who);
      } catch (err) {
        await this.failed(term, ev, err, who);
      }
    }
    return JSON.stringify({ ok: true, ...term.since(after) });
  }

  // ---- RPC from the Worker ----

  /** An update of the instance bot. */
  async mainUpdate(doc: InstanceDoc, update: unknown): Promise<Routed> {
    await this.ready(doc);
    if (this.seen("main", update)) return {};
    const tg = this.main();
    const e = tg.parse(update);
    if (!e) return {};
    try {
      return await this.onMain(tg, e);
    } catch (err) {
      await this.failed(tg, e, err);
      return {};
    }
  }

  /** A failed update of the wizard or the menu reaches its user as one sentence, never as silence. */
  private async failed(tg: Chat, e: ChatEvent, err: unknown, person?: { digest: string; name: string }) {
    console.error("update failed", err);
    const why = err instanceof Error ? err.message : String(err);
    const at = ("at" in e && e.at) || { chat: e.from };
    if (e.kind === "message" && e.chatKind !== "private") return void (await tg.view(at, failedView(why, false).slice(0, 2)).catch(() => {}));
    const { wizard, host } = this.tools(tg, person);
    await wizard.living.show(e.from, { chat: e.from }, failedView(why, !!host.load(e.from))).catch(() => {});
  }

  private async onMain(tg: Chat, e: ChatEvent, person?: { digest: string; name: string }): Promise<Routed> {
    const { wizard, manager, host } = this.tools(tg, person);
    const dm = (user: string): ChatRef => ({ chat: user });
    if (e.kind === "managed") {
      await wizard.input(e.from, dm(e.from), { kind: "managed", botId: e.bot.id, username: e.bot.username, name: e.bot.name });
      return {};
    }
    const bound = e.at && this.registry.byChat(e.at);
    if (e.kind === "press") {
      if (!/^[wm]:/.test(e.data)) return bound ? this.to(bound.id) : {};
      const at = e.at ?? dm(e.from);
      // every press is answered, a failure as its toast (docs/chat-style.md)
      let toast: string | undefined;
      try {
        // a secrets file's button: that message is no living one
        if (e.data !== "m:rmfile") await wizard.living.adopt(e.from, at, e.message);
        if (e.data.startsWith("w:")) await wizard.input(e.from, at, { kind: "press", data: e.data, message: e.message });
        else toast = (await manager.press(e.from, at, e.data, e.message)) ?? undefined;
      } catch (err) {
        console.error("press failed", err);
        toast = `⚠️ ${err instanceof Error ? err.message : String(err)}`.slice(0, 190);
      }
      await tg.answer(e.query, toast).catch(() => {});
      return {};
    }
    if (await this.bind(e, tg)) return {};
    if (e.chatKind !== "private") return bound ? this.to(bound.id) : {};
    // the note Telegram adds when a bot was created: the setup already shows it
    if (e.service) {
      await tg.remove(e.at, e.id).catch(() => {});
      return {};
    }
    const cmd = /^\/(\w+)(?:@\w+)?(?:\s|$)/.exec(e.text ?? "")?.[1];
    if (cmd === "setup") {
      await wizard.start(e.from, e.at, true);
      return {};
    }
    if (cmd === "workspaces") {
      await manager.list(e.from, e.at, true);
      return {};
    }
    if (cmd === "export") {
      await manager.exportAll(e.from, e.at);
      return {};
    }
    if (cmd === "import") {
      await manager.importPrompt(e.from, e.at, true);
      return {};
    }
    const c = e.content;
    // a file while an option asks for its values is those values (a .json or a text file)
    if (typeof c === "object" && "files" in c && /\.(json|txt)$/i.test(c.files[0]?.name ?? "") && host.load(e.from)) {
      const text = new TextDecoder().decode(await tg.download(c.files[0]));
      if (await wizard.input(e.from, e.at, { kind: "file", name: c.files[0].name, text, message: e.id })) return {};
      if (c.files[0].name.endsWith(".json")) {
        host.expectImport(e.from, false);
        await manager.importText(e.from, e.at, text);
        return {};
      }
    }
    if (typeof c === "object" && "files" in c && c.files[0]?.name.endsWith(".json")) {
      host.expectImport(e.from, false);
      const text = new TextDecoder().decode(await tg.download(c.files[0]));
      await manager.importText(e.from, e.at, text);
      return {};
    }
    // a reply to one of the bot's messages (a card) is never wizard input
    if (typeof e.text === "string" && !e.replyTo && (await wizard.input(e.from, e.at, { kind: "text", text: e.text, message: e.id }))) return {};
    // pasted JSON counts only as the answer to /import; a file always does
    const asked = Number(this.kv(`import:${e.from}`) ?? 0) > Date.now() - 24 * 3600e3;
    if (typeof e.text === "string" && asked) {
      await tg.remove(e.at, e.id).catch(() => {});
      await manager.importText(e.from, e.at, e.text);
      return {};
    }
    if (bound) return this.to(bound.id);
    await manager.welcome(e.from, e.at);
    return {};
  }

  private to(id: string): Routed {
    return this.registry.paused(id) ? {} : { forward: id };
  }

  /** An update of a workspace's own bot, on its own webhook path with its own secret. */
  async ownUpdate(doc: InstanceDoc, id: string, secret: string | true, update: unknown): Promise<Routed> {
    await this.ready(doc);
    const ws = this.registry.get(id);
    let want = ws?.chat ? this.secrets.get(ws.chat.webhookSecret) : undefined;
    let token = ws?.chat ? this.secrets.get(ws.chat.token) : undefined;
    if (!ws) {
      // a setup still waiting for its /bind: the bot's secrets are in the session
      const s = this.store.rows<{ data: string }>("SELECT data FROM sessions").map((r) => JSON.parse(r.data) as Session).find((x) => x.draft.id === id && x.draft.hook);
      if (s) {
        const k = await this.key();
        want = await unseal(k, s.draft.hook as string);
        token = await unseal(k, s.draft.botToken as string);
      }
    }
    if (secret !== true && (!want || !secret || !(await same(secret, want)))) return { status: 403 };
    if (this.seen(`w:${id}`, update)) return {};
    const tg = new Telegram(token, "the workspace bot's token");
    const e = tg.parse(update);
    try {
      if (e?.kind === "message" && (await this.bind(e, tg))) return {};
    } catch (err) {
      await this.failed(tg, e as ChatEvent, err);
      return {};
    }
    return ws ? this.to(id) : {};
  }

  /** The bots a polling runtime fetches updates for: the instance's, every workspace's own, setups waiting for /bind. */
  async bots(doc: InstanceDoc): Promise<{ id: string; token: string }[]> {
    await this.ready(doc);
    const out = [{ id: "main", token: this.secrets.get(this.cfg.bot.token) ?? "" }];
    for (const w of this.registry.list()) if (w.chat?.managed && this.secrets.get(w.chat.token)) out.push({ id: w.id, token: this.secrets.get(w.chat.token) as string });
    const k = await this.key();
    for (const s of this.store.rows<{ data: string }>("SELECT data FROM sessions").map((r) => JSON.parse(r.data) as Session))
      if (s.draft.id && s.draft.botToken && !out.some((b) => b.id === s.draft.id)) out.push({ id: s.draft.id, token: await unseal(k, s.draft.botToken) });
    return out.filter((b) => b.token);
  }

  /** The workspace an API token or id names (null: none). */
  async resolve(doc: InstanceDoc, q: { digest?: string; id?: string }): Promise<{ id: string; paused: boolean } | null> {
    await this.ready(doc);
    const id = q.digest ? this.registry.byDigest(q.digest)?.doc.id : q.id && this.registry.get(q.id) ? q.id : undefined;
    return id ? { id, paused: this.registry.paused(id) } : null;
  }

  async people(doc: InstanceDoc, digest: string) {
    await this.ready(doc);
    return this.registry.people(digest).map(({ doc: w, person }) => ({ id: w.id, ...(w.name ? { name: w.name } : {}), paused: this.registry.paused(w.id), person }));
  }

  /** Workspaces the cron and the deploy's /setup run (paused ones rest). */
  async active(doc: InstanceDoc): Promise<string[]> {
    await this.ready(doc);
    return this.registry
      .list()
      .map((w) => w.id)
      .filter((id) => !this.registry.paused(id));
  }

  /** Export and import for automation (docs/api.md, "Configuration"). */
  async admin(doc: InstanceDoc, method: string, path: string, body: unknown): Promise<{ status: number; json: string }> {
    const r = await this.adminCall(doc, method, path, body);
    return { status: r.status, json: JSON.stringify(r.body) };
  }

  private async adminCall(doc: InstanceDoc, method: string, path: string, body: unknown): Promise<{ status: number; body: unknown }> {
    await this.ready(doc);
    const reg = this.registry;
    const m = /^\/admin\/workspaces(?:\/([a-z0-9-]+))?(\/secrets)?$/.exec(path);
    const ok = (b: Record<string, unknown>) => ({ status: 200, body: { ok: true, ...b } });
    const bad = (status: number, error: string, message: string) => ({ status, body: { ok: false, error, message } });
    const pp = /^\/admin\/workspaces\/([a-z0-9-]+)\/people(?:\/([a-z0-9-]+))?$/.exec(path);
    if (pp) {
      // the terminal's people: a new one's key is answered once; the document keeps its digest only
      const [, wid, pid] = pp;
      const w = reg.get(wid);
      if (!w) return bad(404, "not_found", `There is no workspace '${wid}'.`);
      const host = this.host();
      if (method === "POST" && !pid) {
        const b = (body ?? {}) as { id?: unknown; name?: unknown; role?: unknown };
        const role = b.role === "manager" ? "manager" : "member";
        const r = await host.addPerson?.(wid, role);
        if (!r) return bad(500, "internal", "People cannot be added here.");
        if (typeof b.id === "string" || typeof b.name === "string") {
          const d = structuredClone(reg.get(wid) as WorkspaceDoc);
          const p = d.tui?.people.find((x) => x.id === r.person);
          if (p && typeof b.id === "string") p.id = b.id;
          if (p && typeof b.name === "string") p.name = b.name;
          const errs = validate(d);
          if (errs.length) {
            await host.removePerson?.(wid, r.person);
            return { status: 400, body: { ok: false, error: "bad_config", message: errs.join(" "), problems: errs } };
          }
          reg.import(d);
          await this.push(wid);
          r.person = p?.id ?? r.person;
        }
        return ok({ id: wid, person: r.person, key: r.key });
      }
      if (method === "DELETE" && pid) {
        if (!w.tui?.people.some((x) => x.id === pid)) return bad(404, "not_found", `The workspace '${wid}' has no person '${pid}'.`);
        try {
          await host.removePerson?.(wid, pid);
        } catch (e) {
          return bad(409, "conflict", e instanceof Error ? e.message : String(e));
        }
        return ok({ id: wid, person: pid, removed: true });
      }
      return bad(405, "bad_request", "POST adds a person, DELETE …/people/<person> removes one.");
    }
    if (!m) return bad(404, "not_found", "No such endpoint.");
    const [, id, secrets] = m;
    const missing = (w: WorkspaceDoc) => secretNames(w).filter((n) => !this.secrets.get(n));
    if (method === "GET" && !id) return ok({ flowee: 1, workspaces: reg.list() });
    if (method === "GET" && id && !secrets) {
      const w = reg.get(id);
      return w ? ok({ workspace: w, missing: missing(w), owner: reg.owner(id), paused: reg.paused(id) }) : bad(404, "not_found", `There is no workspace '${id}'.`);
    }
    if (method === "PUT" && id && !secrets) {
      const errs = validate(body);
      if (errs.length) return { status: 400, body: { ok: false, error: "bad_config", message: errs.join(" "), problems: errs } };
      if ((body as WorkspaceDoc).id !== id) return bad(400, "bad_config", `$.id: must be '${id}', the id in the path.`);
      const created = !reg.get(id);
      try {
        reg.import(body, this.cfg.owner);
      } catch (e) {
        if (e instanceof Fail) return { status: 400, body: { ok: false, error: e.code, message: e.message, problems: [e.message] } };
        throw e;
      }
      reg.reindex();
      await this.push(id);
      const w = reg.get(id) as WorkspaceDoc;
      return ok({ id, created, missing: missing(w) });
    }
    if (method === "PUT" && id && secrets) {
      const w = reg.get(id);
      if (!w) return bad(404, "not_found", `There is no workspace '${id}'.`);
      const given = (body ?? {}) as Record<string, unknown>;
      const names = secretNames(w);
      const roleSlots = new Set(w.roles.map((r) => r.secret));
      for (const [n, v] of Object.entries(given)) {
        if (!names.includes(n)) return bad(400, "bad_request", `${n}: the workspace names no such secret.`);
        if (typeof v !== "string" || !v) return bad(400, "bad_request", `${n}: must be a non-empty string.`);
      }
      // an agent's secret is kept only as its digest
      for (const [n, v] of Object.entries(given)) await this.put(n, id, roleSlots.has(n) ? await digestOf(v as string) : (v as string));
      reg.reindex();
      await this.push(id);
      return ok({ id, stored: Object.keys(given).sort(), missing: missing(w) });
    }
    if (method === "DELETE" && id && !secrets) {
      if (!reg.get(id)) return bad(404, "not_found", `There is no workspace '${id}'.`);
      await this.host().remove(id);
      return ok({ id, deleted: true });
    }
    return bad(405, "bad_request", `${method} is not allowed on ${path}.`);
  }

  /**
   * The instance bot's profile, settings, commands and webhook, each only when its value changed (hash in kv);
   * docs/telegram.md says why each setting.
   */
  async setup(doc: InstanceDoc): Promise<Record<string, string>> {
    await this.ready(doc);
    const tg = this.main();
    const secret = this.secrets.get(this.cfg.bot.webhookSecret);
    const p = this.cfg.profile ?? {};
    const done: Record<string, string> = {};
    const step = async (item: string, value: unknown, apply: () => Promise<unknown>) => {
      const h = hex(await sha256(JSON.stringify(value)));
      if (this.kv(`profile:${item}`) === h) {
        done[item] = "current";
        return;
      }
      await apply();
      this.setKv(`profile:${item}`, h);
      done[item] = "set";
    };
    const name = p.name ?? "Flowee";
    const about =
      p.description ??
      "Flowee runs a ticket flow for AI agent teams over GitHub or GitLab repositories and brings the tests, questions and decisions waiting for a human here as cards, answered by replying. Set up a workspace with /setup.";
    const short = p.shortDescription ?? "Ticket flow for AI agent teams, with your inbox as cards.";
    await step("name", name, () => tg.setName(name));
    await step("description", about, () => tg.setDescription(about));
    await step("short_description", short, () => tg.setShortDescription(short));
    await step("commands", PRIVATE_COMMANDS, () => tg.setScopedCommands(PRIVATE_COMMANDS, "private"));
    const settings = { readAllGroupMessages: false, canJoinGroups: true, topicsInPrivate: false, inline: false, manageBots: true };
    await step("settings", settings, () => tg.setSettings(settings));
    const png = p.photo ? await (await fetch(p.photo)).arrayBuffer() : Uint8Array.from(atob(PHOTO), (c) => c.charCodeAt(0)).buffer;
    await step("photo", hex(await sha256(png)), () => tg.setPhoto(png));
    if (secret && this.cfg.transport !== "polling") {
      const url = `${this.cfg.publicUrl}/telegram`;
      await step("webhook", { url, secret: hex(await sha256(secret)) }, () =>
        tg.call("setWebhook", { url, secret_token: secret, allowed_updates: INSTANCE_UPDATES }),
      );
    }
    // wizard sessions older than a day are gone; the wizard says so when one is touched again
    this.store.exec("DELETE FROM sessions WHERE ts < ?", Date.now() - 7 * 24 * 3600e3);
    this.store.exec("DELETE FROM updates WHERE ts < ?", Date.now() - 7 * 24 * 3600e3);
    return done;
  }
}

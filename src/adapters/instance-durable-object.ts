// The managed mode's instance: one Durable Object holding the stored workspace registry, the sealed secrets, the
// wizard sessions and the bots made for workspaces. Every update of the instance bot and of the workspaces' own
// bots passes through here first: the wizard and the management menu take theirs, the rest is forwarded to the
// workspace bound to the update's bot, chat and topic.
import { DurableObject } from "cloudflare:workers";
import type { InstanceConfig, InstanceDoc, WorkspaceDoc } from "../config/document";
import { PRESETS } from "../config/presets";
import { digestOf, StoredRegistry } from "../config/registry";
import { secretNames, validate } from "../config/schema";
import { Fail } from "../core/errors";
import { hex, same, sha256 } from "../core/text";
import type { BotAccess } from "../ports/bots";
import type { Button, ChatMessage, ChatRef, Command } from "../ports/chat";
import type { Secrets } from "../ports/secrets";
import { Manager, type ManageHost } from "../wizard/manage";
import { type Draft, fromDoc, type Preset, type Session, slot, toDoc, Wizard } from "../wizard/wizard";
import { Telegram, TelegramBots } from "./chat-telegram";
import type { Env } from "./instance";
import { PHOTO } from "./photo";
import { envSecrets, SqlStore, WORKSPACE_HEADER } from "./store-durable-object";
import { GitHub } from "./tracker-github";
import { randomSecret, seal, unseal, vaultKey } from "./vault";

export const PRIVATE_COMMANDS: Command[] = [
  { command: "start", description: "what Flowee does" },
  { command: "setup", description: "set up a workspace" },
  { command: "workspaces", description: "your workspaces" },
  { command: "import", description: "import a configuration" },
  { command: "export", description: "export your configurations" },
];

const INTRO =
  "<b>Flowee</b> runs a ticket flow for AI agent teams over your GitHub repositories: agents take, build and test tickets through its API, and the questions, tests and decisions waiting for you arrive here as cards you answer by replying.\n\nSet up a workspace: pick a bot, the repositories, the flow and where the cards go.";

export type Routed = { forward?: string; status?: number };

export class Instance extends DurableObject<Env> {
  declare env: Env;
  readonly store: SqlStore;
  private plain?: Map<string, string>;
  private reg?: StoredRegistry;
  private cfg!: InstanceConfig;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.store = new SqlStore(ctx.storage.sql);
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
    return this.env.WORKSPACE.get(this.env.WORKSPACE.idFromName(id));
  }

  /** Hands a workspace its document and its sealed secrets (it opens them with the same key). */
  private async push(id: string) {
    const doc = this.registry.get(id);
    if (!doc) return;
    const names = secretNames(doc);
    const sealed = Object.fromEntries(this.store.rows<{ name: string; sealed: string }>("SELECT name, sealed FROM vault").filter((r) => names.includes(r.name)).map((r) => [r.name, r.sealed]));
    await this.stub(id).configure(doc, sealed);
  }

  private main() {
    return new Telegram(this.secrets.get(this.cfg.bot.token), this.cfg.bot.token);
  }

  private presets(): Preset[] {
    return Object.entries(PRESETS).map(([name, p]) => ({
      name,
      roles: Object.keys(p.options.roles),
      ownerRole: p.options.ownerRole,
      // the switches a preset offers: every feature its chart or options name
      features: [...new Set([...JSON.stringify(p).matchAll(/"features":(?:"(\w+)"|\[([^\]]*)\])/g)].flatMap((m) => (m[1] ? [m[1]] : m[2].match(/\w+/g) ?? [])))],
    }));
  }

  // ---- the wizard's host ----

  private host(): ManageHost {
    const reg = this.registry;
    const cfg = this.cfg;
    const tg = this.main();
    const bots = new TelegramBots(tg);
    const key = this.key;
    const self = this;
    const presets = this.presets();
    const botOf = (id: string) => this.kv(`bot:${id}`);
    const host: ManageHost = {
      ownBots: true,
      botUsername: cfg.bot.username,
      publicUrl: cfg.publicUrl,
      presets: () => presets,
      refusal(user, replacing) {
        const creators = cfg.creators ?? [cfg.owner];
        if (!creators.includes(user) && user !== cfg.owner) return "Only the people this instance allows may set up workspaces; ask its owner.";
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
      async checkRepos(sealed, repos) {
        const token = await unseal(await key(), sealed);
        const out: string[] = [];
        for (const repo of repos) {
          const status = await new GitHub({ repo, api: cfg.trackerApi, token, tokenName: "the token" }).probe();
          if (status !== 200) out.push(`GitHub answered ${status} for ${repo}: the repository does not exist or the token cannot reach it.`);
        }
        return out;
      },
      async adoptBot(s, botId) {
        const token = await bots.token(botId);
        const hook = randomSecret();
        s.draft.botToken = await seal(await key(), token);
        s.draft.hook = await seal(await key(), hook);
        await new Telegram(token, "the new bot's token").setWebhook(`${cfg.publicUrl}/telegram/w/${s.draft.id}`, hook);
      },
      async commit(s) {
        const d = s.draft;
        const p = presets.find((x) => x.name === d.preset) ?? presets[0];
        const doc = toDoc(d, s.user, p, cfg.bot, cfg.publicUrl, cfg.trackerApi);
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
        await self.stub(doc.id).fetch(new Request("https://flowee/setup", { method: "POST", headers: { [WORKSPACE_HEADER]: doc.id } }));
        return { id: doc.id, secrets, doc };
      },
      load: (user) => {
        const r = self.store.rows<{ data: string }>("SELECT data FROM sessions WHERE user = ?", user)[0];
        return r && (JSON.parse(r.data) as Session);
      },
      save: (s) => void self.store.exec("INSERT OR REPLACE INTO sessions VALUES (?, ?, ?)", s.user, JSON.stringify(s), s.ts),
      drop: (user) => void self.store.exec("DELETE FROM sessions WHERE user = ?", user),
      draftOf(doc) {
        const d: Draft = fromDoc(doc, presets);
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
      owned: (user) => reg.ownedBy(user).flatMap((id) => reg.get(id) ?? []),
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
      async replaceBotToken(id) {
        const doc = reg.get(id) as WorkspaceDoc;
        const botId = botOf(id);
        if (!botId || !doc.chat) throw new Error("This workspace has no own bot.");
        const token = await bots.replaceToken(botId);
        await self.put(doc.chat.token, id, token);
        const hook = self.secrets.get(doc.chat.webhookSecret) ?? "";
        await new Telegram(token, doc.chat.token).setWebhook(`${cfg.publicUrl}/telegram/w/${id}`, hook);
        await self.push(id);
      },
      access: (id) => bots.access(botOf(id) ?? ""),
      setAccess: (id, a: BotAccess) => bots.setAccess(botOf(id) ?? "", a),
      validate: (doc) => validate(doc),
    };
    return host;
  }

  private dropSecret(name: string) {
    this.store.exec("DELETE FROM vault WHERE name = ?", name);
    this.plain?.delete(name);
  }

  private tools(tg: Telegram) {
    const host = this.host();
    const wizard = new Wizard(tg, host, () => Date.now());
    const say = (at: ChatRef, html: string, buttons?: Button[][]) => tg.text(at, html, { html: true, ...(buttons ? { buttons } : {}) });
    const manager = new Manager(wizard, host, say, (at, name, data, caption) => tg.sendFile(at, name, data, caption));
    return { host, wizard, manager, say };
  }

  private seen(bot: string, update: unknown) {
    const id = (update as { update_id?: unknown })?.update_id;
    if (typeof id !== "number") return true;
    if (this.store.rows("SELECT 1 FROM updates WHERE bot = ? AND id = ?", bot, id).length) return true;
    this.store.exec("INSERT INTO updates VALUES (?, ?, ?)", bot, id, Date.now());
    return false;
  }

  /** `/bind <code>` sent in a group (or a topic of it) to the bot of a waiting setup. */
  private async bind(m: ChatMessage, tg: Telegram): Promise<boolean> {
    const c = /^\/bind(?:@\w+)?\s+([a-z0-9-]+)\s*$/.exec(m.text ?? "");
    if (!c || m.chatKind !== "group") return false;
    const s = this.store
      .rows<{ data: string }>("SELECT data FROM sessions")
      .map((r) => JSON.parse(r.data) as Session)
      .find((x) => x.step === "bind" && x.draft.bindCode === c[1] && x.user === m.from);
    if (!s) return false;
    const label = m.at.topic ? `topic ${m.at.topic} of group ${m.at.chat}` : `group ${m.at.chat}`;
    await tg.text(m.at, "✅ This chat is bound; the cards of the workspace will come here.").catch(() => {});
    await this.tools(this.main()).wizard.input(s.user, s.at, { kind: "bound", chat: m.at.chat, topic: m.at.topic, label });
    return true;
  }

  // ---- RPC from the Worker ----

  /** An update of the instance bot. */
  async mainUpdate(doc: InstanceDoc, update: unknown): Promise<Routed> {
    await this.ready(doc);
    if (this.seen("main", update)) return {};
    const tg = this.main();
    const e = tg.parse(update);
    if (!e) return {};
    const { wizard, manager, say } = this.tools(tg);
    const dm = (user: string): ChatRef => ({ chat: user });
    if (e.kind === "managed") {
      await wizard.input(e.from, dm(e.from), { kind: "managed", botId: e.bot.id, username: e.bot.username, name: e.bot.name });
      return {};
    }
    const bound = e.at && this.registry.byChat(e.at);
    if (e.kind === "press") {
      const at = e.at ?? dm(e.from);
      if (e.data === "w:new") {
        await tg.answer(e.query).catch(() => {});
        await wizard.start(e.from, at);
        return {};
      }
      if ((await wizard.input(e.from, at, { kind: "press", data: e.data, message: e.message })) || (await manager.press(e.from, at, e.data))) {
        await tg.answer(e.query).catch(() => {});
        return {};
      }
      return bound ? this.to(bound.id) : {};
    }
    if (await this.bind(e, tg)) return {};
    if (e.chatKind !== "private") return bound ? this.to(bound.id) : {};
    if (e.shared) {
      await wizard.input(e.from, e.at, { kind: "bound", chat: e.shared, label: `group ${e.shared}` });
      return {};
    }
    const cmd = /^\/(\w+)(?:@\w+)?(?:\s|$)/.exec(e.text ?? "")?.[1];
    if (cmd === "setup") {
      await wizard.start(e.from, e.at);
      return {};
    }
    if (cmd === "workspaces") {
      await manager.list(e.from, e.at);
      return {};
    }
    if (cmd === "export") {
      await manager.exportAll(e.from, e.at);
      return {};
    }
    if (cmd === "import") {
      this.setKv(`import:${e.from}`, String(Date.now()));
      await say(e.at, "📥 Send the configuration as a <code>.json</code> file, or paste it as your next message.");
      return {};
    }
    const c = e.content;
    if (typeof c === "object" && "files" in c && c.files[0]?.name.endsWith(".json")) {
      this.store.exec("DELETE FROM kv WHERE k = ?", `import:${e.from}`);
      const text = new TextDecoder().decode(await tg.download(c.files[0]));
      await manager.importText(e.from, e.at, text);
      return {};
    }
    // a reply to one of the bot's messages (a card) is never wizard input
    if (typeof e.text === "string" && !e.replyTo && (await wizard.input(e.from, e.at, { kind: "text", text: e.text, message: e.id }))) return {};
    // pasted JSON counts only as the answer to /import; a file always does
    const asked = Number(this.kv(`import:${e.from}`) ?? 0) > Date.now() - 24 * 3600e3;
    if (typeof e.text === "string" && asked) {
      this.store.exec("DELETE FROM kv WHERE k = ?", `import:${e.from}`);
      await manager.importText(e.from, e.at, e.text);
      return {};
    }
    if (bound) return this.to(bound.id);
    await say(e.at, INTRO, [[{ label: "🚀 Set up a workspace", data: "w:new" }]]);
    return {};
  }

  private to(id: string): Routed {
    return this.registry.paused(id) ? {} : { forward: id };
  }

  /** An update of a workspace's own bot, on its own webhook path with its own secret. */
  async ownUpdate(doc: InstanceDoc, id: string, secret: string, update: unknown): Promise<Routed> {
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
    if (!want || !secret || !(await same(secret, want))) return { status: 403 };
    if (this.seen(`w:${id}`, update)) return {};
    const tg = new Telegram(token, "the workspace bot's token");
    const e = tg.parse(update);
    if (e?.kind === "message" && (await this.bind(e, tg))) return {};
    return ws ? this.to(id) : {};
  }

  /** The workspace an API token or id names (null: none). */
  async resolve(doc: InstanceDoc, q: { digest?: string; id?: string }): Promise<{ id: string; paused: boolean } | null> {
    await this.ready(doc);
    const id = q.digest ? this.registry.byDigest(q.digest)?.doc.id : q.id && this.registry.get(q.id) ? q.id : undefined;
    return id ? { id, paused: this.registry.paused(id) } : null;
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
      "Flowee runs a ticket flow for AI agent teams over GitHub repositories and brings the tests, questions and decisions waiting for a human here as cards, answered by replying. Set up a workspace with /setup.";
    const short = p.shortDescription ?? "Ticket flow for AI agent teams, with your inbox as cards.";
    await step("name", name, () => tg.setName(name));
    await step("description", about, () => tg.setDescription(about));
    await step("short_description", short, () => tg.setShortDescription(short));
    await step("commands", PRIVATE_COMMANDS, () => tg.setScopedCommands(PRIVATE_COMMANDS, "private"));
    const settings = { readAllGroupMessages: false, canJoinGroups: true, topicsInPrivate: false, inline: false, manageBots: true };
    await step("settings", settings, () => tg.setSettings(settings));
    const png = p.photo ? await (await fetch(p.photo)).arrayBuffer() : Uint8Array.from(atob(PHOTO), (c) => c.charCodeAt(0)).buffer;
    await step("photo", hex(await sha256(png)), () => tg.setPhoto(png));
    if (secret) {
      const url = `${this.cfg.publicUrl}/telegram`;
      await step("webhook", { url, secret: hex(await sha256(secret)) }, () =>
        tg.call("setWebhook", { url, secret_token: secret, allowed_updates: ["message", "callback_query", "managed_bot"] }),
      );
    }
    // wizard sessions older than a day are gone; the wizard says so when one is touched again
    this.store.exec("DELETE FROM sessions WHERE ts < ?", Date.now() - 7 * 24 * 3600e3);
    this.store.exec("DELETE FROM updates WHERE ts < ?", Date.now() - 7 * 24 * 3600e3);
    return done;
  }
}

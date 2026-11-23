// The management menu (/workspaces), the welcome, export and import in the chat, chat-agnostic like the wizard it
// opens for edits and imports, and shown in the same living message. Buttons carry `m:` data; everything is limited
// to the workspaces the user owns.
import type { WorkspaceDoc } from "../config/document";
import type { SyncStatus } from "../core/events";
import { btn, esc, facts, heading, option, options, question, row, text } from "../envoy/render";
import type { Block, Chat, ChatRef, View } from "../ports/chat";
import type { BotAccess } from "../ports/bots";
import { chatLabel, type Step, Wizard, type WizardHost, wayOf } from "./wizard";

export interface ManageHost extends WizardHost {
  owned(user: string): WorkspaceDoc[];
  doc(id: string): WorkspaceDoc | undefined;
  owner(id: string): string | undefined;
  paused(id: string): boolean;
  setPaused(id: string, paused: boolean): Promise<void>;
  remove(id: string): Promise<void>;
  /** A new secret for one agent; only its fingerprint is kept. */
  rotate(id: string, instance: string): Promise<string>;
  /** A new token for the workspace's own bot (the old one stops working). */
  replaceBotToken(id: string): Promise<void>;
  access(id: string): Promise<BotAccess>;
  setAccess(id: string, a: BotAccess): Promise<void>;
  /** Problems of a document, one sentence each starting with its JSON path. */
  validate(doc: unknown): string[];
  /** The next message of the user is a configuration to import (or no longer is). */
  expectImport(user: string, on: boolean): void;
  /** Webhooks or polling per repository (src/core/events.ts). */
  sync?(id: string): Promise<SyncStatus>;
  /** A hook set up by hand: its URL and a new secret (shown once), where to paste them, the permission instead. */
  manualHook?(id: string, alias: string): Promise<{ url: string; secret: string; where: string; permission: string }>;
}

/** The lines and the button the workspace screen shows for webhooks; also what another chat front end renders. */
export function instantUpdates(s: SyncStatus) {
  const off = s.repos.filter((r) => r.mode === "poll");
  const line = !off.length
    ? "⚡ Instant updates: on"
    : s.webhooks === "off"
      ? "⚡ Instant updates: off (sync.webhooks is off); the tracker is checked every minute"
      : `⚡ Instant updates: off for ${off.map((r) => esc(r.alias)).join(", ")} (${esc(off[0].reason ?? "")}); the tracker is checked every minute`;
  return { line, offer: s.webhooks !== "off" && off.length > 0, off };
}

const b = (label: string, data: string) => btn(label, `m:${data}`);
const code = (s: string) => `<code>${esc(s)}</code>`;
const back = (id: string) => b("« Back", `ws:${id}`);
const mine = (): Block => row(b("📂 My workspaces", "list"));

export class Manager {
  constructor(
    private wizard: Wizard,
    private host: ManageHost,
    private chat: Chat,
  ) {}

  private show(user: string, at: ChatRef, view: View, bottom = false) {
    return this.wizard.living.show(user, at, view, bottom);
  }

  /** What Flowee is, and the way in. */
  welcome(user: string, at: ChatRef, bottom = true) {
    const has = this.host.owned(user).length > 0;
    return this.show(
      user,
      at,
      [
        heading("👋", "Welcome to Flowee"),
        text("Flowee runs a ticket flow for teams of AI agents on your GitHub repositories. The tests, questions and decisions that need you arrive here as cards, and you answer them by replying."),
        text("A <b>workspace</b> is one project: its repositories, its agents and the chat where its tickets appear."),
        row(btn("🚀 Set up a workspace", "w:new")),
        row(...(has ? [b("📂 My workspaces", "list")] : []), b("📥 Import a configuration", "import")),
      ],
      bottom,
    );
  }

  /** Asks for a configuration: the next file or pasted message is imported. */
  importPrompt(user: string, at: ChatRef, bottom = false) {
    this.host.expectImport(user, true);
    return this.show(
      user,
      at,
      [heading("📥", "Import a configuration"), text(`Send the ${code(".json")} file, or paste the configuration as your next message.`), row(b("✖ Cancel", "noimport"))],
      bottom,
    );
  }

  async list(user: string, at: ChatRef, bottom = false) {
    const ws = this.host.owned(user);
    if (!ws.length)
      return this.show(
        user,
        at,
        [heading("📂", "Your workspaces"), text("You have none yet."), row(btn("🚀 Set up a workspace", "w:new"), b("📥 Import", "import"))],
        bottom,
      );
    return this.show(
      user,
      at,
      [
        heading("📂", "Your workspaces"),
        {
          table: {
            head: ["Workspace", "Repositories", "State", ""],
            rows: ws.map((w) => ({
              cells: [esc(w.id), esc(w.tracker.repos.map((r) => (typeof r === "string" ? r : r.repo)).join(", ")), this.host.paused(w.id) ? "⏸ paused" : "▶ running"],
              buttons: [{ label: "Open", data: `m:ws:${w.id}`, style: "primary" as const }],
            })),
          },
        },
        row(btn("🚀 New workspace", "w:new"), b("📥 Import", "import")),
      ],
      bottom,
    );
  }

  private mine(user: string, id: string) {
    const d = this.host.doc(id);
    return d && this.manages(user, d) ? d : undefined;
  }

  /** Managing (configuration, secrets, pause, delete, export) is the creator's and the document's managers' only. */
  private manages(user: string, d: WorkspaceDoc) {
    return this.host.owner(d.id) === user || !!d.managers?.includes(user);
  }

  private where(user: string, d: WorkspaceDoc) {
    const c = d.chat;
    if (!c) return "nowhere: used through its API only";
    if (c.chatId === user) return c.managed ? `your private chat with ${c.username ? `@${esc(c.username)}` : "its bot"}` : "your private chat with this bot";
    return chatLabel(c.chatId, c.topicId);
  }

  /** One workspace: what it is, and everything that can be done with it. */
  private async workspace(user: string, at: ChatRef, d: WorkspaceDoc, note?: string) {
    const sync = await this.host.sync?.(d.id).catch(() => undefined);
    const hooks = sync && instantUpdates(sync);
    const own = !!d.chat?.managed;
    const paused = this.host.paused(d.id);
    const edit = (step: Step) => b("✏️ Change", `edit:${d.id}:${step}`);
    return this.show(user, at, [
      heading("📂", code(d.id), paused ? "⏸ paused" : "▶ running"),
      ...(note ? [text(note)] : []),
      facts([
        { cells: ["📦 Repositories", d.tracker.repos.map((r) => code(typeof r === "string" ? r : r.repo)).join(", ")], buttons: [edit("repos")] },
        ["🤖 Bot", own ? `its own${d.chat?.username ? `, @${esc(d.chat.username)}` : ""}` : "this bot"],
        { cells: ["🔀 Way of working", wayOf(d.features)], buttons: [edit("flow")] },
        { cells: ["💬 Tickets appear", this.where(user, d)], buttons: [edit("bind")] },
        { cells: ["🔑 GitHub token", "never shown"], buttons: [edit("credential")] },
        { cells: ["👥 Agents", d.roles.filter((r) => r.role !== this.host.flow().ownerRole).map((r) => esc(r.instance)).join(", ") || "none"], buttons: [edit("roles")] },
        ...(hooks ? [hooks.offer ? { cells: ["⚡ Instant updates", hooks.line.replace(/^⚡ Instant updates: /, "")], buttons: [b("⚡ Turn on", `hook:${d.id}`)] } : ["⚡ Instant updates", hooks.line.replace(/^⚡ Instant updates: /, "")]] : []),
      ]),
      options(
        option("🔑 New agent secret", "One agent gets a new secret; its old one stops working.", b("🔑 New secret", `rot:${d.id}`)),
        ...(own
          ? [
              option("♻️ New bot token", "The bot gets a new token; the old one stops working.", b("♻️ New token", `tok:${d.id}`)),
              option("🔐 Who may use the bot", "Anyone, or only the people you allow.", b("🔐 Open", `acc:${d.id}`)),
            ]
          : []),
        option("📤 Export", "The configuration without secrets, as a file to edit and import again.", b("📤 Export", `exp:${d.id}`)),
        paused
          ? option("▶ Resume", "The agents' API and the chat work again.", b("▶ Resume", `resume:${d.id}`))
          : option("⏸ Pause", "The agents' API answers that it is paused, and the chat stays quiet.", b("⏸ Pause", `pause:${d.id}`)),
        option("🗑 Delete", "Its configuration, secrets and state go; the repositories stay.", b("🗑 Delete", `del:${d.id}`)),
      ),
      row(b("« All workspaces", "list")),
    ]);
  }

  /** A management button; null when the data is not the menu's, else the toast for the press (if any). */
  async press(user: string, at: ChatRef, data: string): Promise<string | undefined | null> {
    if (!data.startsWith("m:")) return null;
    const [k, id, v] = data.slice(2).split(":");
    if (k === "list") {
      await this.list(user, at);
      return;
    }
    if (k === "import") {
      await this.importPrompt(user, at);
      return;
    }
    if (k === "noimport") {
      this.host.expectImport(user, false);
      await this.welcome(user, at, false);
      return;
    }
    const d = this.mine(user, id);
    if (!d) {
      const exists = !!this.host.doc(id);
      await this.show(user, at, [
        heading("⚠️", exists ? "Not yours to manage" : "Workspace not found"),
        text(exists ? `Only the people who manage ${code(id)} can change it; ask the one who set it up.` : "That workspace no longer exists."),
        mine(),
      ]);
      return;
    }
    switch (k) {
      case "ws":
        await this.workspace(user, at, d);
        return;
      case "edit": {
        const draft = this.host.draftOf(d);
        draft.replaces = d.id;
        await this.wizard.over(user, at, draft, v as Step);
        return;
      }
      case "rot":
        if (!v || !d.roles.some((r) => r.instance === v)) {
          await this.show(user, at, [
            heading("🔑", "New agent secret", code(id)),
            question("Which agent gets a new secret?"),
            text("Its old secret stops working at once."),
            options(...d.roles.map((r) => option(esc(r.instance), esc(r.role), b("🔑 New secret", `rot:${id}:${r.instance}`)))),
            row(back(id)),
          ]);
          return;
        }
        await this.show(user, at, [heading("🔑", `New secret for ${code(v)}`), text("It is in the file below, <b>shown only this once</b>. The old one no longer works."), row(back(id))]);
        await this.wizard.handOver(at, id, { [v]: await this.host.rotate(id, v) });
        return "🔑 New secret below";
      case "exp":
        if (this.chat.sendFile) await this.chat.sendFile(at, `${id}.flowee.json`, `${JSON.stringify(d, null, 2)}\n`, "📤 The configuration, without secrets: edit it and send it back to import it.");
        return "📤 Sent below";
      case "tok":
        await this.host.replaceBotToken(id);
        await this.workspace(user, at, d, "♻️ The bot has a new token; the old one no longer works.");
        return "♻️ New token";
      case "acc": {
        const a = await this.host.access(id);
        if (v === "toggle") {
          await this.host.setAccess(id, { restricted: !a.restricted, users: a.users });
          a.restricted = !a.restricted;
        }
        await this.show(user, at, [
          heading("🔐", "Who may use the bot", code(id)),
          options(
            option(
              `${a.restricted ? "✅" : "⬜"} Only me`,
              a.restricted ? `Only you${a.users.length ? ` and ${a.users.length} more people` : ""} can start the bot.` : "Anyone can start the bot; it answers only the workspace's owners.",
              b(a.restricted ? "Switch off" : "Switch on", `acc:${id}:toggle`),
            ),
          ),
          row(back(id)),
        ]);
        return;
      }
      case "hook": {
        const s = await this.host.sync?.(id);
        const off = s ? instantUpdates(s).off : [];
        const r = off.find((x) => x.alias === v);
        if (!r || !this.host.manualHook) {
          const need = off.find((x) => x.missing)?.missing;
          await this.show(user, at, [
            heading("⚡", "Turn on instant updates", code(id)),
            text(
              need
                ? `Flowee sets up the tracker's webhook itself when its token has ${esc(need)}. Give the token that permission (✏️ Change beside the token) and it switches on within half an hour.`
                : "Flowee could not set up the tracker's webhook itself; it checks the tracker every minute until it can.",
            ),
            text("Or add the webhook by hand: pick the repository, paste the address and the secret it shows into the tracker."),
            options(...off.map((x) => option(`🔗 ${esc(x.alias)}`, code(x.repo), b("🔗 By hand", `hook:${id}:${x.alias}`)))),
            row(back(id)),
          ]);
          return;
        }
        const m = await this.host.manualHook(id, r.alias);
        await this.show(user, at, [
          heading("⚡", `Webhook for ${code(r.repo)}`),
          text(`In ${esc(m.where)}, add a webhook with:`),
          facts([
            ["Address", code(m.url)],
            ["Secret", `${code(m.secret)} (<b>shown only this once</b>)`],
            ["Events", "issues, comments, pushes, pull or merge requests, checks or pipelines, releases"],
          ]),
          text("Instant updates switch on with its first delivery; until then the tracker is checked every minute."),
          row(back(id)),
        ]);
        return "⚡ Webhook details below";
      }
      case "pause":
      case "resume":
        await this.host.setPaused(id, k === "pause");
        await this.workspace(
          user,
          at,
          d,
          k === "pause" ? "⏸ Paused: the agents' API answers that it is paused, and the chat stays quiet until you resume it." : "▶ Running again.",
        );
        return k === "pause" ? "⏸ Paused" : "▶ Running";
      case "del":
        if (v !== "yes") {
          await this.show(user, at, [
            heading("🗑", `Delete ${code(id)}?`),
            text("Its configuration, secrets and stored state go for good; the repositories and their issues stay."),
            row(b("🗑 Delete it", `del:${id}:yes`), b("« Keep it", `ws:${id}`)),
          ]);
          return;
        }
        await this.host.remove(id);
        await this.show(user, at, [heading("🗑", `${code(id)} is deleted`), text("The repositories and their issues are untouched."), mine()]);
        return "🗑 Deleted";
    }
    return;
  }

  /** All the user's workspaces as one configuration file. */
  async exportAll(user: string, at: ChatRef) {
    const ws = this.host.owned(user);
    if (!ws.length || !this.chat.sendFile) return this.list(user, at, true);
    await this.chat.sendFile(at, "flowee.json", `${JSON.stringify({ flowee: 1, workspaces: ws }, null, 2)}\n`, "📤 Your workspaces, without secrets.");
  }

  /**
   * A configuration sent as a file or pasted: validated, every problem reported with its JSON path in the living
   * message; a valid one opens the wizard, which asks only for what is still missing (secrets, the bot, the chat).
   */
  async importText(user: string, at: ChatRef, text0: string) {
    const refuse = (problems: string[]) => {
      this.host.expectImport(user, true);
      return this.show(user, at, [
        heading("⚠️", "Not imported"),
        text(problems.length > 1 ? `The configuration has ${problems.length} problems:` : "The configuration has a problem:"),
        facts(problems.map((x) => [esc(x)])),
        text("Fix it and send it again; nothing was changed."),
        row(b("✖ Cancel", "noimport")),
      ]);
    };
    let raw: unknown;
    try {
      raw = JSON.parse(text0);
    } catch (e) {
      return refuse([`$: is not JSON (${e instanceof Error ? e.message : String(e)}).`]);
    }
    const many = !!raw && typeof raw === "object" && "workspaces" in raw;
    const docs = (many ? ((raw as { workspaces: unknown[] }).workspaces ?? []) : [raw]) as WorkspaceDoc[];
    const problems = many && !Array.isArray((raw as { workspaces: unknown }).workspaces) ? ["$.workspaces: must be an array."] : [];
    docs.forEach((d, i) => {
      const p = many ? `$.workspaces[${i}]` : "$";
      problems.push(...this.host.validate(d).map((e) => e.replace(/^\$/, p)));
      const old = d && typeof d.id === "string" ? this.host.doc(d.id) : undefined;
      if (old && !this.manages(user, old)) problems.push(`${p}.id: '${d.id}' belongs to someone else; choose another id.`);
    });
    if (!docs.length) problems.push("$.workspaces: must have at least 1 item(s).");
    if (problems.length) return refuse(problems);
    for (const d of docs) {
      const old = this.host.doc(d.id);
      const why = this.host.refusal(user, old && this.manages(user, old) ? d.id : undefined);
      if (why) return refuse([why]);
    }
    this.host.expectImport(user, false);
    const lines = docs.map((d) => `${this.host.doc(d.id) ? "replace" : "create"} ${code(d.id)}`);
    const [first, ...rest] = docs;
    await this.wizard.over(user, at, this.host.draftOf(first), undefined, rest, {
      lead: [text(`📥 The configuration is valid and will ${lines.join(", ")}. I ask only for what is missing, then you confirm.`)],
    });
  }
}

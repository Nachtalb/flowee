// The management menu (/workspaces), the welcome, export and import in the chat, chat-agnostic like the wizard it
// opens for edits and imports, and shown in the same living message. Buttons carry `m:` data; everything is limited
// to the workspaces the user owns.
import type { WorkspaceDoc } from "../config/document";
import { btn, bullets, esc, heading, question, row, text } from "../envoy/render";
import type { Block, Chat, ChatRef, View } from "../ports/chat";
import type { BotAccess } from "../ports/bots";
import { chatLabel, featureName, presetName, type Step, Wizard, type WizardHost } from "./wizard";

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
}

const b = (label: string, data: string) => btn(label, `m:${data}`);
const code = (s: string) => `<code>${esc(s)}</code>`;
const parts: [Step, string][] = [
  ["repos", "Repositories"],
  ["flow", "Way of working"],
  ["bind", "Where tickets appear"],
  ["credential", "GitHub token"],
  ["roles", "Agents"],
];
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
              button: { label: "Open", data: `m:ws:${w.id}`, style: "primary" as const },
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
    return d && this.host.owner(id) === user ? d : undefined;
  }

  private where(user: string, d: WorkspaceDoc) {
    const c = d.chat;
    if (!c) return "nowhere: used through its API only";
    if (c.chatId === user) return c.managed ? `your private chat with ${c.username ? `@${esc(c.username)}` : "its bot"}` : "your private chat with this bot";
    return chatLabel(c.chatId, c.topicId);
  }

  /** One workspace: what it is, and everything that can be done with it. */
  private workspace(user: string, at: ChatRef, d: WorkspaceDoc, note?: string) {
    const own = !!d.chat?.managed;
    const paused = this.host.paused(d.id);
    const on = Object.entries(d.features ?? {}).filter(([, v]) => v).map(([k]) => featureName(k));
    return this.show(user, at, [
      heading("📂", code(d.id), paused ? "⏸ paused" : "▶ running"),
      bullets([
        `📦 Repositories: ${d.tracker.repos.map((r) => code(typeof r === "string" ? r : r.repo)).join(", ")}`,
        `🤖 Bot: ${own ? `its own${d.chat?.username ? `, @${esc(d.chat.username)}` : ""}` : "this bot"}`,
        `🔀 Way of working: ${presetName("preset" in d.flow ? d.flow.preset : undefined)}${on.length ? `, with ${on.join(", ")}` : ""}`,
        `💬 Tickets appear: ${this.where(user, d)}`,
        `👥 Agents: ${d.roles.filter((r) => !this.host.presets().some((p) => p.ownerRole === r.role)).map((r) => esc(r.instance)).join(", ") || "none"}`,
      ]),
      ...(note ? [text(note)] : []),
      row(...parts.slice(0, 2).map(([s, l]) => b(`✏️ ${l}`, `edit:${d.id}:${s}`))),
      row(...parts.slice(2, 4).map(([s, l]) => b(`✏️ ${l}`, `edit:${d.id}:${s}`))),
      row(b(`✏️ ${parts[4][1]}`, `edit:${d.id}:${parts[4][0]}`), b("🔑 New agent secret", `rot:${d.id}`)),
      ...(own ? [row(b("♻️ New bot token", `tok:${d.id}`), b("🔐 Who may use the bot", `acc:${d.id}`))] : []),
      row(b("📤 Export", `exp:${d.id}`), b(paused ? "▶ Resume" : "⏸ Pause", `${paused ? "resume" : "pause"}:${d.id}`), b("🗑 Delete", `del:${d.id}`)),
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
      await this.show(user, at, [heading("⚠️", "Workspace not found"), text("That workspace is not yours, or it no longer exists."), mine()]);
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
            ...chunk(d.roles.map((r) => b(esc(r.instance), `rot:${id}:${r.instance}`)), 3).map((r) => row(...r)),
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
          text(a.restricted ? `Only you${a.users.length ? ` and ${a.users.length} more people` : ""} can start the bot.` : "Anyone can start the bot; it answers only the workspace's owners."),
          row(b(a.restricted ? "🔓 Open it to everyone" : "🔒 Only me", `acc:${id}:toggle`)),
          row(back(id)),
        ]);
        return;
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
        bullets(problems.map(esc)),
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
      const owner = d && typeof d.id === "string" ? this.host.owner(d.id) : undefined;
      if (owner !== undefined && owner !== user) problems.push(`${p}.id: '${d.id}' belongs to someone else; choose another id.`);
    });
    if (!docs.length) problems.push("$.workspaces: must have at least 1 item(s).");
    if (problems.length) return refuse(problems);
    for (const d of docs) {
      const why = this.host.refusal(user, this.host.owner(d.id) === user ? d.id : undefined);
      if (why) return refuse([why]);
    }
    this.host.expectImport(user, false);
    const lines = docs.map((d) => `${this.host.owner(d.id) === user ? "replace" : "create"} ${code(d.id)}`);
    const [first, ...rest] = docs;
    await this.wizard.over(user, at, this.host.draftOf(first), undefined, rest, {
      lead: [text(`📥 The configuration is valid and will ${lines.join(", ")}. I ask only for what is missing, then you confirm.`)],
    });
  }
}

const chunk = <T>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

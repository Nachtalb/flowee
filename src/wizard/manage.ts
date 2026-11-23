// The management menu (/workspaces) and export/import in the chat, chat-agnostic like the wizard it opens for
// edits and imports. Buttons carry `m:` data; everything is limited to the workspaces the user owns.
import type { WorkspaceDoc } from "../config/document";
import { esc } from "../envoy/render";
import type { BotAccess } from "../ports/bots";
import type { Button, ChatRef } from "../ports/chat";
import { type Step, Wizard, type WizardHost } from "./wizard";

export interface ManageHost extends WizardHost {
  owned(user: string): WorkspaceDoc[];
  doc(id: string): WorkspaceDoc | undefined;
  owner(id: string): string | undefined;
  paused(id: string): boolean;
  setPaused(id: string, paused: boolean): Promise<void>;
  remove(id: string): Promise<void>;
  /** A new secret for one agent; only its digest is kept. */
  rotate(id: string, instance: string): Promise<string>;
  /** A new token for the workspace's own bot (the old one stops working). */
  replaceBotToken(id: string): Promise<void>;
  access(id: string): Promise<BotAccess>;
  setAccess(id: string, a: BotAccess): Promise<void>;
  /** Problems of a document, one sentence each starting with its JSON path. */
  validate(doc: unknown): string[];
}

const b = (label: string, data: string): Button => ({ label, data: `m:${data}` });
const parts: [Step, string][] = [
  ["repos", "Repositories"],
  ["flow", "Flow"],
  ["bind", "Chat"],
  ["credential", "GitHub token"],
  ["roles", "Agents"],
];

export class Manager {
  constructor(
    private wizard: Wizard,
    private host: ManageHost,
    private say: (at: ChatRef, html: string, buttons?: Button[][]) => Promise<number>,
    private file: (at: ChatRef, name: string, data: string, caption: string) => Promise<unknown>,
  ) {}

  async list(user: string, at: ChatRef) {
    const ws = this.host.owned(user);
    if (!ws.length) return this.say(at, "You have no workspace yet. /setup creates one; /import takes a configuration file.");
    return this.say(
      at,
      `<b>Your workspaces</b> (${ws.length})`,
      ws.map((w) => [b(`${this.host.paused(w.id) ? "⏸ " : ""}${w.id}`, `ws:${w.id}`)]),
    );
  }

  private mine(user: string, id: string) {
    const d = this.host.doc(id);
    return d && this.host.owner(id) === user ? d : undefined;
  }

  private show(at: ChatRef, d: WorkspaceDoc) {
    const own = !!d.chat?.managed;
    const paused = this.host.paused(d.id);
    const repos = d.tracker.repos.map((r) => (typeof r === "string" ? r : `${r.repo} (${r.alias ?? ""})`));
    const html = [
      `<b>${esc(d.id)}</b>${paused ? " · ⏸ paused" : ""}`,
      `Bot: ${own ? `own${d.chat?.username ? ` @${esc(d.chat.username)}` : ""}` : "this bot"}`,
      `Repositories: ${repos.map(esc).join(", ")}`,
      `Flow: ${esc("preset" in d.flow ? d.flow.preset : "inline")}${d.features ? ` (${Object.entries(d.features).filter(([, v]) => v).map(([k]) => esc(k)).join(", ")})` : ""}`,
      `Chat: ${d.chat ? `${esc(d.chat.chatId)}${d.chat.topicId ? `, topic ${d.chat.topicId}` : ""}` : "none"}`,
      `Agents: ${d.roles.map((r) => esc(r.instance)).join(", ")}`,
    ].join("\n");
    const rows: Button[][] = [
      parts.slice(0, 3).map(([s, l]) => b(`✏️ ${l}`, `edit:${d.id}:${s}`)),
      parts.slice(3).map(([s, l]) => b(`✏️ ${l}`, `edit:${d.id}:${s}`)),
      [b("🔑 New agent secret", `rot:${d.id}`), b("📤 Export", `exp:${d.id}`)],
      ...(own ? [[b("♻️ New bot token", `tok:${d.id}`), b("🔐 Bot access", `acc:${d.id}`)]] : []),
      [b(paused ? "▶ Resume" : "⏸ Pause", `${paused ? "resume" : "pause"}:${d.id}`), b("🗑 Delete", `del:${d.id}`)],
      [b("« All workspaces", "list")],
    ];
    return this.say(at, html, rows);
  }

  /** A management button; false when the data is not the menu's. */
  async press(user: string, at: ChatRef, data: string): Promise<boolean> {
    if (!data.startsWith("m:")) return false;
    const [k, id, v] = data.slice(2).split(":");
    if (k === "list") {
      await this.list(user, at);
      return true;
    }
    const d = this.mine(user, id);
    if (!d) {
      await this.say(at, "That workspace is not yours or no longer exists.");
      return true;
    }
    switch (k) {
      case "ws":
        await this.show(at, d);
        break;
      case "edit": {
        const draft = this.host.draftOf(d);
        draft.replaces = d.id;
        await this.wizard.over(user, at, draft, v as Step);
        break;
      }
      case "rot":
        if (!v) await this.say(at, "<b>New secret for which agent?</b> Its old secret stops working at once.", d.roles.map((r) => [b(r.instance, `rot:${id}:${r.instance}`)]));
        else if (d.roles.some((r) => r.instance === v)) await this.wizard.handOver(at, id, { [v]: await this.host.rotate(id, v) });
        break;
      case "exp":
        await this.file(at, `${id}.flowee.json`, `${JSON.stringify(d, null, 2)}\n`, "The configuration, without secrets: edit it and send it back to import it.");
        break;
      case "tok":
        await this.host.replaceBotToken(id);
        await this.say(at, "♻️ The bot has a new token; the old one no longer works. Its webhook was set again.");
        break;
      case "acc": {
        const a = await this.host.access(id);
        if (v === "toggle") {
          await this.host.setAccess(id, { restricted: !a.restricted, users: a.users });
          a.restricted = !a.restricted;
        }
        await this.say(
          at,
          `<b>Bot access</b>\n${a.restricted ? `Only you${a.users.length ? ` and ${a.users.length} more` : ""} can use the bot.` : "Anyone can start the bot (only the workspace's owners are answered)."}`,
          [[b(a.restricted ? "🔓 Open to everyone" : "🔒 Only me", `acc:${id}:toggle`)], [b("« Back", `ws:${id}`)]],
        );
        break;
      }
      case "pause":
      case "resume":
        await this.host.setPaused(id, k === "pause");
        await this.say(at, k === "pause" ? `⏸ ${esc(id)} is paused: the API answers 503 and the chat is quiet until you resume it.` : `▶ ${esc(id)} runs again.`);
        break;
      case "del":
        if (v !== "yes") await this.say(at, `Delete <b>${esc(id)}</b>? Its configuration, secrets and stored state go; the repositories and their issues stay.`, [[b("🗑 Delete", `del:${id}:yes`), b("Keep", `ws:${id}`)]]);
        else {
          await this.host.remove(id);
          await this.say(at, `🗑 ${esc(id)} is deleted.`);
        }
        break;
    }
    return true;
  }

  /** All the user's workspaces as one instance document file. */
  async exportAll(user: string, at: ChatRef) {
    const ws = this.host.owned(user);
    if (!ws.length) return this.say(at, "You have no workspace to export.");
    await this.file(at, "flowee.json", `${JSON.stringify({ flowee: 1, workspaces: ws }, null, 2)}\n`, "Your workspaces, without secrets.");
  }

  /**
   * A configuration document sent as a file or pasted: validated, every problem reported with its JSON path;
   * valid ones open the wizard, which asks only for what is still missing (secrets, the bot, the chat).
   */
  async importText(user: string, at: ChatRef, text: string) {
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch (e) {
      return this.say(at, `⚠️ Not imported: $: is not JSON (${esc(e instanceof Error ? e.message : String(e))}).`);
    }
    const many = !!raw && typeof raw === "object" && "workspaces" in raw;
    const docs = (many ? ((raw as { workspaces: unknown[] }).workspaces ?? []) : [raw]) as WorkspaceDoc[];
    const problems = many && !Array.isArray((raw as { workspaces: unknown }).workspaces) ? ["$.workspaces: must be an array."] : [];
    docs.forEach((d, i) => {
      const p = many ? `$.workspaces[${i}]` : "$";
      problems.push(...this.host.validate(d).map((e) => e.replace(/^\$/, p)));
      const owner = d && typeof d.id === "string" ? this.host.owner(d.id) : undefined;
      if (owner !== undefined && owner !== user) problems.push(`${p}.id: '${d.id}' belongs to another user; choose another id.`);
    });
    if (!docs.length) problems.push("$.workspaces: must have at least 1 item(s).");
    if (problems.length) return this.say(at, `⚠️ Not imported, ${problems.length} problem${problems.length > 1 ? "s" : ""}:\n${problems.map((p) => `• ${esc(p)}`).join("\n")}`);
    const lines = docs.map((d) => `• ${this.host.owner(d.id) === user ? "replace" : "create"} <code>${esc(d.id)}</code>`);
    for (const d of docs) {
      const why = this.host.refusal(user, this.host.owner(d.id) === user ? d.id : undefined);
      if (why) return this.say(at, `⚠️ Not imported: ${esc(why)}`);
    }
    await this.say(at, `📥 The document is valid. It will:\n${lines.join("\n")}\nI ask only for what is missing, then you confirm.`);
    const [first, ...rest] = docs;
    await this.wizard.over(user, at, this.host.draftOf(first), undefined, rest);
  }
}

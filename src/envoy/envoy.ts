// The owner's inbox in a chat, as docs/envoy.md specifies it,
// written against the Chat port: which chat it is (Telegram, …) is the adapter's business.
import type { Flowee, Inbox } from "../core/service";
import { Fail } from "../core/errors";
import { parseCard } from "../core/card";
import { fill, hex, sha256 } from "../core/text";
import type { Chat, ChatMessage, ChatPress, ChatRef, Command, FileRef, Sender, View } from "../ports/chat";
import type { Files } from "../ports/files";
import {
  back,
  type Content,
  card,
  esc,
  hasTerms,
  type Item,
  list,
  nav,
  newBar,
  next,
  okRow,
  page,
  parseNumber,
  postponed,
  results,
  search,
  todo,
  todoHeader,
  visit,
  waited,
} from "./render";

const MAX_DOWNLOAD = 20 * 1024 * 1024;
const KV = {
  nav: "next_msg",
  current: "current_card",
  history: "history",
  card: "card_msg",
  prompt: "prompt_msg",
  menu: "menu_count",
  find: "find_msg",
  results: "results_msg",
  query: "search_query",
  new: "new_msg",
  newDraft: "new_draft",
  digest: "digest_day",
  seeded: "seeded",
  ui: "ui",
};
const draftKey = (n: number) => `draft:${n}`;
const OPEN = "status IN ('queued', 'sent')";
// bumped when the welcome must reach a workspace that already ran the migration
const UI = "envoy.2";

export const COMMANDS: Command[] = [
  { command: "start", description: "what this bot does" },
  { command: "todo", description: "open items" },
  { command: "postponed", description: "postponed tickets" },
  { command: "new", description: "new ticket" },
];
/** A workspace's own bot: no inline mode, no bot management, joins groups, privacy mode on (docs/telegram.md). */
export const OWN_BOT = { readAllGroupMessages: false, canJoinGroups: true, topicsInPrivate: false, inline: false, manageBots: false };
const NAMES = ["start", "todo", "postponed", "new", "next", "prev", "skip", "stats", "help", "search"];
const SEARCH_USAGE = "Usage: /search words to find";

type Row = { n: number; comment_id: number | null; card: string; title: string; url: string; status: string; ts: number };
type Toast = string | undefined;
type Button =
  | { b: "p" | "s" | "n" | "b" | "f" | "k" | "t" | "F" | "X" }
  | { b: "L" | "S" | "P"; page: number }
  | { b: "o" | "q"; n: number };

const toItem = (r: Row, label: (n: number) => string, postponedItem = false): Item => ({
  n: r.n,
  label: label(r.n),
  cid: r.comment_id ?? 0,
  title: r.title,
  url: r.url,
  content: JSON.parse(r.card) as Content,
  since: r.ts,
  status: r.status === "answered" ? "answered" : r.status === "gone" ? "gone" : "open",
  postponed: postponedItem,
});
const num = (v?: string) => (v === undefined || v === "" ? undefined : Number(v));
const html = (h: string): View => [{ html: h }];

export function parseButton(data: string): Button | undefined {
  if (data === "next") return { b: "n" };
  if (["p", "s", "n", "b", "f", "k", "t", "F", "X"].includes(data)) return { b: data as "p" };
  let m = /^([LSPi]):(\d+)$/.exec(data);
  if (m) return { b: (m[1] === "i" ? "L" : m[1]) as "L", page: Number(m[2]) };
  m = /^([oqml]):(\d+):(\d+)$/.exec(data);
  if (m) return { b: m[1] === "q" ? "q" : "o", n: Number(m[2]) };
  // the old interface's buttons open the card
  m = /^(?:a:(\d+):\w+|c:(\d+))$/.exec(data);
  if (m) return { b: "o", n: Number(m[1] ?? m[2]) };
  return undefined;
}

export const safeName = (name: string) => name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+|\.+$/g, "") || "file";

export function withLinks(caption: string, files: [string, string, boolean][]) {
  let s = caption.trim();
  for (const [name, url, image] of files) {
    if (s) s += "\n\n";
    s += image ? `![${name}](${url})` : `[${name}](${url})`;
  }
  return s;
}

/** The hand-over of a ticket: the newest signed comment with a valid card, else an excerpt of the newest signed one. */
export function handover(comments: { id: number; body: string; createdAt?: string }[], signs: string[], heading: string, samples = false) {
  const signed = comments.filter((c) => signs.some((s) => c.body.trimStart().startsWith(`${s}:`)));
  const at = (c?: { createdAt?: string }) => (c?.createdAt ? Date.parse(c.createdAt) : Date.now());
  for (const c of [...signed].reverse()) {
    try {
      return { cid: c.id, at: at(c), content: parseCard(c.body, heading, samples) as Content };
    } catch {}
  }
  const c = signed[signed.length - 1];
  if (!c) return { cid: 0, at: at(comments[comments.length - 1]), content: { kind: "none" } as Content };
  const b = c.body.trim();
  const x = [...b];
  return { cid: c.id, at: at(c), content: { kind: "excerpt", text: x.length > 600 ? `${x.slice(0, 600).join("").trimEnd()}…` : b } as Content };
}

/** A ticket title from the owner's words: the first line, cut at a word. */
export function ticketTitle(text: string, untitled: string): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return untitled;
  const c = [...line];
  if (c.length <= 80) return line;
  const head = c.slice(0, 80).join("");
  const sp = head.lastIndexOf(" ");
  return `${sp >= 0 ? head.slice(0, sp) : head}…`;
}

export class Envoy implements Inbox {
  /** Work the reference does behind the screen (recording, filing): run after the update was answered. */
  private deferred: (() => Promise<void>)[] = [];
  readonly at: ChatRef;
  /** The deployed version: the profile step runs once per version. */
  version = "dev";

  constructor(
    private f: Flowee,
    private chat: Chat,
    private files?: Files,
    /** Bytes of the profile photo, when the workspace has one. */
    private photo?: () => Promise<ArrayBuffer | undefined>,
  ) {
    const c = f.s.chat;
    if (!c) throw new Error("the workspace has no chat");
    this.at = c.topic ? { chat: c.chat, topic: c.topic } : { chat: c.chat };
  }

  // ---- storage ----

  private rows<R>(q: string, ...a: (string | number | null)[]) {
    return this.f.db.rows(q, ...a) as unknown as R[];
  }
  private exec(q: string, ...a: (string | number | null)[]) {
    return this.f.db.exec(q, ...a);
  }
  private get = (k: string) => this.rows<{ v: string }>("SELECT v FROM meta WHERE k = ?", k)[0]?.v;
  private set = (k: string, v: string | number) => void this.exec("INSERT OR REPLACE INTO meta VALUES (?, ?)", k, String(v));
  private del = (k: string) => void this.exec("DELETE FROM meta WHERE k = ?", k);
  private now = () => this.f.clock.now();

  private item = (n: number) => this.rows<Row>("SELECT * FROM inbox WHERE n = ?", n).map((r) => toItem(r, this.f.label))[0];
  private liveOf = (n: number) => this.rows<Row>("SELECT * FROM inbox WHERE n = ? AND status != 'gone'", n).map((r) => toItem(r, this.f.label))[0];
  private openItems = () => this.rows<Row>(`SELECT * FROM inbox WHERE ${OPEN} ORDER BY skip_seq, ts, n`).map((r) => toItem(r, this.f.label));
  private openCount = () => this.openItems().length;
  private workOrder = (): [number, boolean][] =>
    this.rows<Row>("SELECT * FROM inbox WHERE status != 'gone' ORDER BY skip_seq, ts, n").map((r) => [r.n, r.status !== "answered"]);
  private postponedItems = () =>
    this.rows<Row>("SELECT n, comment_id, card, title, url, 'sent' AS status, since AS ts FROM postponed ORDER BY since, n").map((r) => toItem(r, this.f.label, true));
  private postponedItem = (n: number) => this.postponedItems().find((i) => i.n === n);
  private answeredAt = (n: number) => this.rows<{ a: number | null }>("SELECT answered_at AS a FROM inbox WHERE n = ?", n)[0]?.a ?? null;

  markAnswered(n: number, by?: string) {
    return this.exec(`UPDATE inbox SET status = 'answered', answered_at = ?, answered_by = ? WHERE n = ? AND ${OPEN}`, this.now(), by ?? null, n).rowsWritten > 0;
  }
  private reopen = (n: number) => void this.exec("UPDATE inbox SET status = 'sent', answered_at = NULL, answered_by = NULL WHERE n = ? AND status = 'answered'", n);

  /** The tickets appear in a group or topic: its members work them as a team, each answer signed by who gave it. */
  private get team() {
    return this.at.chat.startsWith("-");
  }

  /** A team member's signature (docs/envoy.md, "Teams"); undefined in a private chat, where the owner's stays. */
  private signature(u: Sender & { from: string }): string | undefined {
    if (!this.team) return undefined;
    const name = u.name ?? `User ${u.from}`;
    const at = u.username ? `@${u.username}` : "";
    return fill(this.f.s.texts.memberSign, { who: at ? `${name} (${at})` : name, name, username: at }).trim() || name;
  }

  /**
   * The first answer to an item in a group wins: marks it answered by `by`, or returns who answered it before.
   * Synchronous between the check and the write, so two people answering at once cannot both win.
   */
  private claimAnswer(n: number, by: string): string | undefined {
    const r = this.rows<{ status: string; answered_by: string | null }>("SELECT status, answered_by FROM inbox WHERE n = ?", n)[0];
    if (r?.status === "answered" && r.answered_by && r.answered_by !== by) return r.answered_by;
    this.markAnswered(n, by);
    return undefined;
  }
  private map = (id: number, n: number, kind = "card") => void this.exec("INSERT OR REPLACE INTO messages VALUES (?, ?, ?, NULL, 0)", id, n, kind);
  private route = (id: number) => this.rows<{ n: number }>("SELECT n FROM messages WHERE message_id = ? AND kind NOT IN ('filed', 'note')", id)[0]?.n;

  /** The workspace's wall clock: the digest hour and "answered today". */
  private local(ms: number) {
    const p = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone: this.f.s.timezone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(ms)
        .map((x) => [x.type, x.value]),
    );
    const local = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
    const offset = local - Math.floor(ms / 60e3) * 60e3;
    return { day: `${p.year}-${p.month}-${p.day}`, hour: +p.hour, midnight: Date.UTC(+p.year, +p.month - 1, +p.day) - offset };
  }

  private answeredToday = () =>
    this.rows<{ c: number }>("SELECT COUNT(DISTINCT n) AS c FROM answers WHERE ts >= ? AND n IN (SELECT n FROM inbox)", this.local(this.now()).midnight)[0].c;

  // ---- sending ----

  private send = (text: string, buttons?: { label: string; data: string }[][], quiet = false) =>
    this.chat.text(this.at, text, { html: true, quiet, ...(buttons ? { buttons } : {}) });
  private reply = (to: ChatMessage, text: string) => this.chat.text(this.at, text, { replyTo: to.id, noPreview: true });
  private forceReply = (h: string, placeholder: string) => this.chat.view(this.at, html(h), { forceReply: placeholder });

  private async react(id: number, emoji: string) {
    await this.chat.react(this.at, id, emoji).catch((e) => console.warn("reaction failed", e));
  }

  private async deleteTracked(k: string) {
    const id = num(this.get(k));
    if (id === undefined) return;
    await this.chat.remove(this.at, id).catch(() => {});
    this.del(k);
  }

  // ---- rendering with state ----

  private current = () => num(this.get(KV.current));
  private history = () => (this.get(KV.history) ?? "").split(",").filter(Boolean).map(Number);
  private cardHtml = (it: Item, open: boolean) => card(it, it.status === "answered" ? this.answeredAt(it.n) : null, open, this.now());

  private navView(): View {
    // a ticket with text in it stays on screen as File/Cancel until one of them is pressed
    if (this.get(KV.newDraft)) return newBar();
    const c = this.current();
    return nav(c !== undefined && this.item(c) ? c : undefined, this.openCount());
  }

  private listView(p: number) {
    const open = this.openItems();
    const [q, pages, a, b] = page(open.length, p);
    return list(open.slice(a, b), `${open.length} open · ${this.answeredToday()} answered today`, q, pages, this.now());
  }

  private postponedView(p: number) {
    const all = this.postponedItems();
    const [q, pages, a, b] = page(all.length, p);
    return postponed(all.slice(a, b), all.length, q, pages, this.now());
  }

  private resultsView(p: number) {
    const query = this.get(KV.query) ?? "";
    const hits = search(this.openItems(), query);
    const [q, pages, a, b] = page(hits.length, p);
    return results(hits.slice(a, b), hits.length, query, q, pages, this.now());
  }

  /** A new item: its card with the details folded and ✅ OK. 'queued' when the chat is unavailable (cron retries). */
  async sendCard(n: number): Promise<"sent" | "queued"> {
    const it = this.item(n);
    if (!it) return "queued";
    const id = await this.chat.view(this.at, [{ html: this.cardHtml(it, false) }, ...okRow()]);
    this.map(id, n);
    this.exec("UPDATE inbox SET status = CASE status WHEN 'queued' THEN 'sent' ELSE status END WHERE n = ?", n);
    await this.refreshMenu();
    return "sent";
  }

  /** An answer recorded elsewhere (the API): the card on screen says so. */
  async closeCards(n: number) {
    const id = num(this.get(KV.card));
    const it = this.item(n);
    if (id !== undefined && it && this.route(id) === n)
      await this.chat.editView(this.at, id, html(this.cardHtml(it, true))).catch((e) => console.error("edit card", n, e));
    await this.refreshMenu().catch(() => {});
  }

  /** Replaces the bar with a new one at the bottom, as a reply to the current card. */
  private async postNav(view: View) {
    await this.deleteTracked(KV.nav);
    this.del(KV.results);
    const c = this.current();
    const cur = c !== undefined && this.item(c) ? c : undefined;
    const cardId = cur !== undefined ? num(this.get(KV.card)) : undefined;
    const id = await this.chat.view(this.at, view, cardId ? { replyTo: cardId } : {});
    if (cur !== undefined) this.map(id, cur);
    this.set(KV.nav, id);
  }

  private async showItem(n: number, remember: boolean) {
    const it = this.item(n);
    if (!it) return;
    if (this.current() !== n) await this.flush();
    if (this.get(KV.newDraft) === "") {
      // New ticket was pressed but nothing written: opening a card ends it
      this.del(KV.newDraft);
      await this.deleteTracked(KV.new);
    }
    if (remember) {
      const h = this.history();
      visit(h, this.current(), n);
      this.set(KV.history, h.join(","));
    }
    this.set(KV.current, n);
    await this.deleteTracked(KV.prompt);
    await this.deleteTracked(KV.find);
    await this.deleteTracked(KV.nav);
    const id = await this.forceReply(this.cardHtml(it, true), it.content.kind === "test" ? "Your test result…" : it.content.kind === "sample" ? "Where the sample is…" : "Your answer…");
    this.map(id, n);
    this.set(KV.card, id);
    await this.postNav(this.navView());
  }

  /** Sends what was typed under the current card, if anything. */
  private async flush(): Promise<boolean> {
    const n = this.current();
    if (n === undefined) return false;
    const text = this.get(draftKey(n));
    if (text === undefined) return false;
    this.del(draftKey(n));
    await this.showAnswered(n);
    this.record(n, text, true);
    return true;
  }

  private async showAnswered(n: number) {
    this.markAnswered(n);
    await this.deleteTracked(KV.prompt);
    const id = num(this.get(KV.card));
    const it = this.item(n);
    if (id !== undefined && it && this.route(id) === n) await this.chat.editView(this.at, id, html(this.cardHtml(it, true))).catch(() => {});
  }

  /** Records an answer after the update is handled; `answer` is his message when it is the whole answer, `by` who gave it in a group. */
  private record(n: number, text: string, wasOpen: boolean, answer?: number, by?: string) {
    this.deferred.push(async () => {
      let failed: string | undefined;
      try {
        await this.f.answer(n, text, "chat", by);
      } catch (e) {
        if (!(e instanceof Fail)) console.error("answer", n, e);
        const why = (e instanceof Error ? e.message : String(e)).replace(/\.$/, "");
        failed = e instanceof Fail && e.status < 500 ? `flow refused: ${why}` : why;
      }
      if (answer) await this.react(answer, failed ? "👎" : "👍");
      if (failed) {
        if (wasOpen) this.reopen(n);
        let warn = `⚠️ ${this.f.label(n)}: not recorded: ${failed}`;
        if (!answer) {
          this.set(draftKey(n), text);
          warn += ". It is open again and your text is kept.";
        }
        await this.chat.text(this.at, warn, answer ? { replyTo: answer } : {}).catch(() => {});
      }
      await this.refreshMenu();
    });
  }

  private async goNext(): Promise<Toast> {
    await this.flush();
    const k = next(this.workOrder(), this.current());
    if (k !== undefined) return void (await this.showItem(k, true));
    await this.deleteTracked(KV.prompt);
    await this.postNav(this.navView());
    return "✨ Inbox empty";
  }

  private async goPrev(): Promise<Toast> {
    const order = this.workOrder();
    const h = this.history();
    const b = back(h, this.current(), (k) => order.some(([x]) => x === k));
    this.set(KV.history, h.join(","));
    if (b === undefined) return "Nothing before this one";
    await this.showItem(b, false);
    return undefined;
  }

  private async skip(key?: number): Promise<Toast> {
    const k = key ?? this.current();
    if (k === undefined) return "Nothing to skip";
    if (this.current() === k && (await this.flush())) {
      // something was typed: that is an answer, not a skip
      await this.goNext();
      return `📨 ${this.f.label(k)} sent`;
    }
    if (this.item(k)?.status !== "open") return `${this.f.label(k)} isn't open`;
    this.exec("UPDATE inbox SET skip_seq = (SELECT COALESCE(MAX(skip_seq), 0) + 1 FROM inbox) WHERE n = ?", k);
    this.set(KV.current, k);
    await this.goNext();
    return `⏭ ${this.f.label(k)} moved to the end`;
  }

  private async ok(pressed?: number, q?: ChatPress): Promise<Toast> {
    const key = pressed === undefined ? undefined : this.route(pressed);
    if (key === undefined) return "Nothing to OK here";
    const by = q && this.signature(q);
    const before = by && this.rows<{ b: string | null }>("SELECT answered_by AS b FROM inbox WHERE n = ?", key)[0]?.b;
    if (this.item(key)?.status !== "open") return before && before !== by ? `${this.f.label(key)} was already answered by ${before}` : `${this.f.label(key)} isn't open`;
    const d = this.get(draftKey(key));
    this.del(draftKey(key));
    const text = d === undefined ? "OK" : `${d}\n\nOK`;
    if (by) {
      const prior = this.claimAnswer(key, by);
      if (prior) return `${this.f.label(key)} was already answered by ${prior}`;
    } else this.markAnswered(key);
    const inCycle = this.current() === key;
    const cardId = inCycle ? num(this.get(KV.card)) : pressed !== num(this.get(KV.nav)) ? pressed : undefined;
    const it = this.item(key);
    // the card says it is answered, and a note's OK button goes
    if (cardId !== undefined && it && this.route(cardId) === key) await this.chat.editView(this.at, cardId, html(this.cardHtml(it, inCycle))).catch(() => {});
    if (inCycle) await this.goNext();
    this.record(key, text, true, undefined, by);
    return `✅ ${this.f.label(key)} OK`;
  }

  async sendTodo(header: string, quiet: boolean) {
    const items = this.openItems();
    const parts = todo(items, header);
    for (const [i, p] of parts.entries()) {
      const last = i === parts.length - 1 && items.length > 0;
      await this.send(p, last ? [[{ label: "▶ Start", data: "n" }]] : undefined, quiet);
    }
  }

  /** The open and postponed counts in the chat's command menu, set only when the menu changed. */
  async refreshMenu() {
    const n = this.openCount();
    const p = this.postponedItems().length;
    const cmds = COMMANDS.map((c) =>
      c.command === "todo" ? { ...c, description: `${n} open items` } : c.command === "postponed" ? { ...c, description: `${p} postponed tickets` } : c,
    );
    const mark = cmds.map((c) => `${c.command}=${c.description};`).join("");
    if (this.get(KV.menu) === mark) return;
    // e.g. "chat not found" until the owner has started the bot: /start clears the mark and retries
    await this.chat.setCommands(cmds, this.at).catch((e) => console.warn("menu count not updated", e));
    this.set(KV.menu, mark);
  }

  // ---- routing his messages ----

  /** A ticket typed on its own: `7`, `#7`, or `app#7` with several repositories. */
  private typed(text: string) {
    const n = parseNumber(text);
    return n !== undefined ? this.f.tracker.parse(n) : this.f.tracker.multi ? this.f.tracker.parse(text) : undefined;
  }

  /** The item shown by the bot message he replied to. */
  private target(m: ChatMessage): number | undefined {
    if (!m.replyTo?.fromBot) return undefined;
    return this.route(m.replyTo.id);
  }

  /** The ticket whose "filed" note he replied to. */
  private filed(m: ChatMessage): number | undefined {
    if (!m.replyTo?.fromBot) return undefined;
    return this.rows<{ n: number }>("SELECT n FROM messages WHERE message_id = ? AND kind IN ('filed', 'note')", m.replyTo.id)[0]?.n;
  }

  private isSearch(m: ChatMessage) {
    const r = m.replyTo;
    return !!r?.fromBot && [KV.find, KV.results].some((k) => this.get(k) === String(r.id));
  }

  private async showResults(query: string): Promise<Toast> {
    if (!hasTerms(query)) return SEARCH_USAGE;
    await this.deleteTracked(KV.find);
    this.set(KV.query, query.trim());
    await this.postNav(this.resultsView(0));
    const id = this.get(KV.nav);
    if (id) this.set(KV.results, id);
    return undefined;
  }

  /** `/name[@bot] args`; anything else (other bots, unknown names) is not a command. */
  private command(text?: string): { name: string; args: string } | undefined {
    if (!text?.startsWith("/")) return undefined;
    const sp = text.indexOf(" ");
    const [name, bot] = (sp < 0 ? text : text.slice(0, sp)).slice(1).split("@");
    if (bot !== undefined && bot.toLowerCase() !== (this.f.s.chat?.username ?? "").toLowerCase()) return undefined;
    if (!NAMES.includes(name)) return undefined;
    return { name, args: sp < 0 ? "" : text.slice(sp + 1) };
  }

  private async onCommand(m: ChatMessage, name: string, args: string) {
    let toast: Toast;
    switch (name) {
      case "start":
      case "help": {
        this.del(KV.menu);
        // straight to the work: the current item (or the first open one) with the bar under it
        const order = this.workOrder();
        const c = this.current();
        const k = c !== undefined && order.some(([x]) => x === c) ? c : next(order);
        if (k !== undefined) await this.showItem(k, false);
        else await this.postNav(this.navView());
        break;
      }
      case "todo":
        await this.postNav(this.listView(0));
        break;
      case "postponed":
        await this.postNav(this.postponedView(0));
        break;
      case "search":
        toast = await this.showResults(args);
        break;
      case "next":
        toast = await this.goNext();
        break;
      case "prev":
        toast = await this.goPrev();
        break;
      case "new":
        toast = await this.askNew();
        break;
      case "skip":
        toast = await this.skip(this.target(m));
        break;
      case "stats": {
        const open = this.openItems();
        toast = `📋 ${open.length} open · ✅ ${this.answeredToday()} answered today`;
        const oldest = [...open].sort((a, b) => a.since - b.since)[0];
        if (oldest) toast += `\n⏳ oldest: ${this.f.label(oldest.n)} (${waited(oldest.since, this.now())})`;
      }
    }
    if (toast) await this.send(esc(toast));
    await this.refreshMenu();
  }

  private async callback(q: ChatPress): Promise<Toast> {
    const button = parseButton(q.data);
    if (!button) return;
    const pressed = q.message;
    switch (button.b) {
      case "n":
        return this.goNext();
      case "p":
        return this.goPrev();
      case "s":
        return this.skip();
      case "k":
        return this.ok(pressed, q);
      case "o":
        return void (await this.showItem(button.n, true));
      case "t":
        return this.askNew();
      case "F":
        return this.fileTicket();
      case "X":
        this.del(KV.newDraft);
        await this.deleteTracked(KV.new);
        await this.postNav(this.navView());
        return "New ticket dropped";
      case "f": {
        // a forced reply opens the reply box on the prompt: the words come back as a reply to it
        await this.deleteTracked(KV.find);
        this.set(KV.find, await this.forceReply("<p>🔎 Search</p>", "Words to find…"));
        return;
      }
      case "q": {
        // just the card: a reply to it is the whole answer, but it never becomes current
        const it = this.postponedItem(button.n);
        if (!it) return `${this.f.label(button.n)} isn't postponed any more`;
        this.map(await this.chat.view(this.at, html(this.cardHtml(it, true))), it.n);
        return;
      }
      default: {
        // the list, the results and the bar take turns in the same message
        if (pressed === undefined) return;
        const view =
          button.b === "L"
            ? this.listView(button.page)
            : button.b === "S"
              ? this.resultsView(button.page)
              : button.b === "P"
                ? this.postponedView(button.page)
                : this.navView();
        await this.chat.editView(this.at, pressed, view);
        if (button.b === "S") this.set(KV.results, pressed);
        else if (num(this.get(KV.results)) === pressed) this.del(KV.results);
        return undefined;
      }
    }
  }

  private async onPress(q: ChatPress) {
    let text: string | undefined;
    try {
      text = await this.callback(q);
    } catch (e) {
      console.error("button failed", q.data, e);
      text = [...`⚠️ ${e instanceof Error ? e.message : String(e)}`].slice(0, 190).join("");
    }
    await this.chat.answer(q.query, text).catch(() => {});
    await this.refreshMenu();
  }

  // ---- his messages: answers, files, new tickets ----

  private async upload(file: FileRef): Promise<string> {
    if (!this.files) throw new Error("no file store configured");
    return this.files.upload(file.name, await this.chat.download(file));
  }

  /** The text of one answer: the words plus links to the uploaded files; undefined when he was told why not. */
  private async collect(msgs: ChatMessage[], first: ChatMessage): Promise<string | undefined> {
    let caption = "";
    const files: FileRef[] = [];
    for (const m of msgs) {
      const c = m.content;
      if (c === "voice") {
        await this.reply(m, "🎙 Sorry, voice messages aren't supported. Please type the answer (screenshots and files work).");
        return;
      }
      if (c === "unsupported") {
        await this.reply(m, "Sorry, I can only pass on text, photos, videos and files.");
        return;
      }
      if ("text" in c) caption = c.text;
      else {
        if (c.caption) caption = c.caption;
        files.push(...c.files);
      }
    }
    const links: [string, string, boolean][] = [];
    for (const file of files) {
      if (file.size > MAX_DOWNLOAD) {
        await this.reply(first, `⚠️ ${file.name} is over 20 MB, which bots can't download. Nothing recorded.`);
        return;
      }
      try {
        links.push([file.name, await this.upload(file), file.image]);
      } catch (e) {
        console.error("upload failed", e);
        await this.reply(first, `⚠️ Upload failed (${e instanceof Error ? e.message : e}). Nothing recorded.`);
        return;
      }
    }
    const text = withLinks(caption, links);
    return text.trim() ? text : undefined;
  }

  /** One answer from one message, or from all messages of an album. */
  private async handle(msgs: ChatMessage[]) {
    const first = msgs[0];
    if (!first) return;
    // search words first: a reply to the results bar must not answer the item under it
    if (msgs.some((m) => this.isSearch(m))) {
      const t = msgs.length === 1 && first.text && hasTerms(first.text) ? first.text : undefined;
      if (t) await this.showResults(t);
      else await this.reply(first, "🔎 Type a few words to find.");
      return;
    }
    const fn = msgs.map((m) => this.filed(m)).find((x) => x !== undefined);
    if (fn !== undefined) {
      // more for a ticket he just filed: recorded at once as his answer on it
      const text = await this.collect(msgs, first);
      if (text === undefined) return;
      await this.react(first.id, "👀");
      this.record(fn, text, false, first.id, this.signature(first));
      return;
    }
    // while a new ticket is being written, every message that answers no card is part of it
    const composing = this.get(KV.newDraft) !== undefined;
    let key = msgs.map((m) => this.target(m)).find((x) => x !== undefined);
    if (!composing && key === undefined) {
      const n = msgs.length === 1 ? this.typed(first.text ?? "x") : undefined;
      if (n !== undefined) {
        const it = this.liveOf(n);
        if (it) await this.showItem(it.n, true);
        else await this.reply(first, `${this.f.label(n)}: Not in your inbox`);
        return;
      }
      // going through the cards, a plain message belongs to the open card on screen
      const c = this.current();
      const plain = msgs.every((m) => !m.replyTo?.fromBot);
      key = c !== undefined && plain && this.item(c)?.status === "open" ? c : undefined;
      if (key === undefined) return void (await this.reply(first, "Reply to a card to answer it."));
    }
    const text = await this.collect(msgs, first);
    if (text === undefined) return;
    if (key === undefined) {
      const d = this.get(KV.newDraft);
      this.set(KV.newDraft, d ? `${d}\n\n${text}` : text);
      await this.react(first.id, "✍");
      await this.postNav(newBar());
      return;
    }
    const open = this.item(key)?.status === "open";
    const by = this.signature(first);
    if (open && this.current() === key && !by) {
      // an answer can take several messages: nothing is recorded until a button leaves the card
      const d = this.get(draftKey(key));
      this.set(draftKey(key), d !== undefined ? `${d}\n\n${text}` : text);
      await this.react(first.id, "✍");
      await this.postNav(this.navView());
      return;
    }
    // a reply to any other card or note is the whole answer; in a group the first one wins
    if (by) {
      const prior = this.claimAnswer(key, by);
      if (prior) return void (await this.reply(first, `⚠️ ${this.f.label(key)} was already answered by ${esc(prior)}; yours was not recorded.`));
    }
    await this.react(first.id, "👀");
    await this.showAnswered(key);
    await this.postNav(this.navView());
    this.record(key, text, open, first.id, by);
  }

  private async askNew(): Promise<Toast> {
    await this.deleteTracked(KV.new);
    if (this.get(KV.newDraft) === undefined) this.set(KV.newDraft, "");
    this.set(KV.new, await this.forceReply("<p>➕ New ticket: send text and files, then press 📨 File ticket</p>", "What should be built or fixed…"));
    await this.postNav(newBar());
    return undefined;
  }

  private async fileTicket(): Promise<Toast> {
    const text = this.get(KV.newDraft);
    if (!text?.trim()) return "Nothing written yet";
    this.del(KV.newDraft);
    await this.deleteTracked(KV.new);
    const status = await this.chat.text(this.at, "⏳ Filing your ticket…");
    await this.postNav(this.navView());
    this.deferred.push(async () => {
      const quoted = text
        .split("\n")
        .map((l) => `> ${l}\n`)
        .join("");
      const t = this.f.s.texts;
      let note: string;
      try {
        const { n } = await this.f.fileIssue(ticketTitle(text, t.untitled), `${t.filedBody}\n\n${quoted}`);
        try {
          await this.f.answer(n, text, "chat");
        } catch (e) {
          throw new Error(`${this.f.label(n)} filed, but your words were not logged: ${e instanceof Error ? e.message.replace(/\.$/, "") : e}`);
        }
        // a reply to the note adds to the ticket
        this.map(status, n, "filed");
        note = `🆕 ${this.f.label(n)} filed for the Board`;
      } catch (e) {
        console.error("ticket not filed", e);
        // nothing is lost: New ticket shows it again, ready to file
        this.set(KV.newDraft, text);
        note = `⚠️ Ticket not filed: ${e instanceof Error ? e.message.replace(/\.$/, "") : e}. Your text is kept: ➕ New ticket, then 📨 File ticket.`;
      }
      await this.chat.editText(this.at, status, note).catch((e) => console.warn("filing status", e));
    });
    return undefined;
  }

  // ---- updates ----

  private async run(fn: () => Promise<void>) {
    try {
      await fn();
    } finally {
      while (this.deferred.length) await (this.deferred.shift() as () => Promise<void>)().catch((e) => console.error("deferred", e));
    }
  }

  private here = (at?: ChatRef) => !!at && at.chat === this.at.chat && (this.at.topic === undefined || at.topic === this.at.topic);

  /** Who works the inbox: the owners; in a group or topic every member there, or the document's `chat.members`. */
  private allowed(u: { from: string; at?: ChatRef }) {
    if (this.f.s.owners.includes(u.from)) return true;
    const members = this.f.s.chat?.members;
    return this.team && this.here(u.at) && (!members || members.includes(u.from));
  }

  /** One chat update; each update id is handled once, whatever the chat retries. Only those `allowed()` in the bound chat count. */
  async onUpdate(raw: unknown) {
    const u = this.chat.parse(raw);
    if (!u || this.rows("SELECT 1 FROM updates WHERE update_id = ?", u.update).length) return;
    this.exec("INSERT INTO updates VALUES (?, ?)", u.update, this.now());
    if (u.kind === "managed" || !this.allowed(u)) return;
    if (u.kind === "press") return this.run(() => this.onPress(u));
    if (!this.here(u.at)) return;
    const c = this.command(u.text);
    if (c) return this.run(() => this.onCommand(u, c.name, c.args));
    if (u.album) {
      // an album arrives as one message per file: collect them, answer once
      const first = !this.rows("SELECT 1 FROM albums WHERE group_id = ?", u.album).length;
      this.exec("INSERT INTO albums VALUES (?, ?, ?)", u.album, JSON.stringify(u), this.now());
      if (first) await this.f.clock.wake(2500);
      return;
    }
    await this.run(() => this.handle([u]));
  }

  /** The alarm: albums whose last part arrived 2 s ago or more. */
  async onAlarm() {
    const groups = this.rows<{ g: string; t: number }>("SELECT group_id AS g, MAX(ts) AS t FROM albums GROUP BY group_id");
    for (const { g, t } of groups) {
      if (t > this.now() - 2000) {
        await this.f.clock.wake(2500);
        continue;
      }
      const msgs = this.rows<{ msg: string }>("SELECT msg FROM albums WHERE group_id = ? ORDER BY rowid", g).map((r) => JSON.parse(r.msg) as ChatMessage);
      this.exec("DELETE FROM albums WHERE group_id = ?", g);
      await this.run(() => this.handle(msgs)).catch((e) => console.error("album answer failed", e));
    }
  }

  // ---- the inbox from the tracker (poll.rs) ----

  private signs() {
    const o = this.f.flow.options;
    return Object.keys(o.roles)
      .filter((r) => r !== o.ownerRole)
      .map((r) => this.f.signWord(r));
  }

  /**
   * Brings the inbox in line with the tracker: inbox-state tickets never carded become items (notified, except on
   * the very first run), items whose ticket left the inbox go, and the parked tickets are kept.
   */
  async sync() {
    const f = this.f;
    const issues = await f.events.openIssues();
    const seeding = this.get(KV.seeded) === undefined;
    const inbox = f.inbox(issues);
    const heading = f.s.texts.cardHeading;
    for (const i of inbox) {
      const row = this.rows<Row & { answered_at: number | null }>("SELECT * FROM inbox WHERE n = ?", i.n)[0];
      if (row && row.status !== "gone") {
        if (row.title !== i.title) this.exec("UPDATE inbox SET title = ? WHERE n = ?", i.title, i.n);
        continue;
      }
      const h = handover(await f.tracker.comments(i.n), this.signs(), heading, !!f.s.features.samples);
      if (row && (row.comment_id ?? 0) === h.cid) {
        // the same hand-over back in the inbox
        this.exec("UPDATE inbox SET status = ? WHERE n = ?", row.answered_at ? "answered" : "sent", i.n);
        continue;
      }
      this.exec(
        "INSERT OR REPLACE INTO inbox (n, comment_id, kind, card, title, url, status, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        i.n,
        h.cid,
        h.content.kind,
        JSON.stringify(h.content),
        i.title,
        i.url,
        seeding ? "sent" : "queued",
        h.at,
      );
    }
    const keep = new Set(inbox.map((i) => i.n));
    for (const r of this.rows<{ n: number }>("SELECT n FROM inbox WHERE status != 'gone'")) if (!keep.has(r.n)) this.exec("UPDATE inbox SET status = 'gone' WHERE n = ?", r.n);
    const parked = issues.filter((i) => {
      const s = f.stateOrNull(i);
      return s !== null && f.flow.meta(s).parked;
    });
    for (const i of parked) {
      if (this.rows("SELECT 1 FROM postponed WHERE n = ? AND updated_at = ?", i.n, i.updatedAt).length) continue;
      const h = handover(await f.tracker.comments(i.n), this.signs(), heading, !!f.s.features.samples);
      this.exec("INSERT OR REPLACE INTO postponed VALUES (?, ?, ?, ?, ?, ?, ?)", i.n, h.cid, JSON.stringify(h.content), i.title, i.url, h.at, i.updatedAt);
    }
    const still = new Set(parked.map((i) => i.n));
    for (const r of this.rows<{ n: number }>("SELECT n FROM postponed")) if (!still.has(r.n)) this.exec("DELETE FROM postponed WHERE n = ?", r.n);
    if (seeding) this.set(KV.seeded, this.now());
  }

  /** Once a day in the digest hours of the workspace's time zone, quietly; none on the first day. */
  private async digest() {
    const z = this.local(this.now());
    const { from, to } = this.f.s.digest;
    const last = this.get(KV.digest);
    if (last === undefined) return this.set(KV.digest, z.hour < from ? this.local(this.now() - 86400e3).day : z.day);
    if (z.hour < from || z.hour >= to || last === z.day) return;
    this.set(KV.digest, z.day);
    const n = this.openCount();
    if (n) await this.sendTodo(`☀️ <b>Good morning: ${n} open</b>`, true);
  }

  /** A one-line note to the owner, quietly (the sync state: webhooks off or back on). */
  async notice(text: string) {
    await this.send(esc(text), undefined, true);
  }

  /** The poller's minute: inbox sync, new item notes, the menu counts, the digest. */
  async tick() {
    await this.sync().catch((e) => console.warn("poll failed", e));
    for (const q of this.rows<{ n: number }>("SELECT n FROM inbox WHERE status = 'queued' ORDER BY ts, n"))
      await this.sendCard(q.n).catch((e) => console.error("notification failed", q.n, e));
    await this.refreshMenu().catch((e) => console.warn("menu", e));
    await this.digest().catch((e) => console.error("digest failed", e));
  }

  /** Once: the old interface's cards become notes in the new layout (no card is sent twice), then the welcome. */
  private async migrate(): Promise<Record<string, string>> {
    if (this.get(KV.ui) === UI) return {};
    const used = this.rows("SELECT 1 FROM inbox UNION ALL SELECT 1 FROM messages LIMIT 1").length > 0;
    await this.sync();
    const old = this.rows<{ message_id: number; n: number }>("SELECT message_id, n FROM messages WHERE open = 1");
    let edited = 0;
    for (const m of old) {
      const it = this.item(m.n);
      try {
        if (!it) throw new Error("no item");
        await this.chat.editView(this.at, m.message_id, [{ html: this.cardHtml(it, false) }, ...(it.status === "open" ? okRow() : [])]);
        edited++;
      } catch {
        await this.chat.dropButtons(this.at, m.message_id).catch(() => {});
      }
      this.exec("UPDATE messages SET open = 0, kind = 'card', html = NULL WHERE message_id = ?", m.message_id);
    }
    const done: Record<string, string> = old.length ? { cards: `${edited}/${old.length} re-rendered` } : {};
    if (used || old.length) {
      await this.send(this.f.s.texts.welcome);
      await this.sendTodo(todoHeader(this.openCount()), false);
      done.hello = "sent";
    }
    this.set(KV.ui, UI);
    return done;
  }

  /**
   * The bot's profile and webhook, once per deployed version (`version`); each item only when the hash of what
   * was last applied differs, so redeploys stay within the chat's limits on profile changes.
   */
  async setup(version = this.version): Promise<Record<string, string>> {
    if (this.rows("SELECT 1 FROM meta WHERE k = 'setup' AND v = ?", version).length) return { setup: "current" };
    const done: Record<string, string> = {};
    const step = async (item: string, value: unknown, apply: () => Promise<unknown>, check?: () => Promise<boolean>) => {
      const h = hex(await sha256(typeof value === "string" ? value : JSON.stringify(value)));
      const same = this.rows("SELECT 1 FROM meta WHERE k = ? AND v = ?", `profile:${item}`, h).length > 0;
      if (same && (!check || (await check()))) return void (done[item] = "current");
      await apply();
      this.exec("INSERT OR REPLACE INTO meta VALUES (?, ?)", `profile:${item}`, h);
      done[item] = "set";
    };
    const s = this.f.s;
    const hook = s.webhook;
    const secret = hook && this.f.secrets.get(hook.secret);
    if ((hook && secret) || s.polling) {
      const t = s.texts;
      await step("name", t.botName, () => this.chat.setName(t.botName));
      await step("description", t.about, () => this.chat.setDescription(t.about));
      await step("short_description", t.shortAbout, () => this.chat.setShortDescription(t.shortAbout));
      await step("commands", COMMANDS, () => this.chat.setCommands(COMMANDS));
      const set = this.chat.setSettings;
      // only a workspace's own bot: the standalone bot's settings stay as its owner made them in BotFather
      if (s.ownBot && set) await step("settings", OWN_BOT, () => set.call(this.chat, OWN_BOT));
      const png = await this.photo?.();
      if (png) await step("photo", hex(await sha256(png)), () => this.chat.setPhoto(png));
      const url = hook?.url;
      if (hook && secret && url) await step(
        "webhook",
        { url, secret: hex(await sha256(secret)), ALLOWED_UPDATES: ["message", "callback_query"] },
        () => this.chat.setWebhook(url, secret),
        async () => (await this.chat.webhookUrl()) === url,
      );
    }
    Object.assign(done, await this.migrate());
    this.exec("INSERT OR REPLACE INTO meta VALUES ('setup', ?)", version);
    return done;
  }
}

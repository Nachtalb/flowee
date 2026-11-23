// The Chat port over the terminal client protocol (docs/tui-protocol.md): no messenger in between, the workspace's
// own store is the conversation. Every view, edit, removal, reaction, toast and menu change is an event with a
// sequence number in `tui_log`; `tui_messages` is what the conversation shows now. Terminals pull the events after
// the last sequence they saw (`since`) and are rung (`ring`) when there are new ones. `Tee` shows a Telegram
// conversation in the terminals too: Telegram's message ids, the same living messages.
import type { BotSettings, Button, Chat, ChatEvent, ChatRef, Command, CommandScope, FileRef, View, ViewOptions } from "../ports/chat";
import type { Store } from "../ports/store";
import type { TuiEvent, TuiFrame, TuiMessage, TuiPerson, TuiSync } from "../ports/tui";

export type { TuiFrame, TuiPerson, TuiSync };

const KEEP_EVENTS = 2000;
const KEEP_MESSAGES = 300;
export const MAX_FILE = 20 * 1024 * 1024;

const stripButtons = (v: View): View =>
  v.filter((b) => !("buttons" in b)).map((b) => ("table" in b ? { table: { ...b.table, rows: b.table.rows.map((r) => ({ cells: r.cells })) } } : b));

export class Terminal implements Chat {
  constructor(
    private db: Store,
    private at: ChatRef,
    /** Called with the newest sequence number after every event (the runtime rings the connected terminals). */
    private ring?: (seq: number) => void,
    private now: () => number = () => Date.now(),
  ) {}

  private state = (k: string) => this.db.rows<{ v: string }>("SELECT v FROM tui_state WHERE k = ?", k)[0]?.v;
  private setState = (k: string, v: string | number) => void this.db.exec("INSERT OR REPLACE INTO tui_state VALUES (?, ?)", k, String(v));
  private counter(k: string) {
    const n = Number(this.state(k) ?? 0) + 1;
    this.setState(k, n);
    return n;
  }
  private get seq() {
    return Number(this.state("seq") ?? 0);
  }

  private log(ev: TuiEvent extends infer E ? (E extends { seq: number } ? Omit<E, "seq"> : never) : never) {
    const seq = this.counter("seq");
    this.db.exec("INSERT INTO tui_log (seq, ev) VALUES (?, ?)", seq, JSON.stringify({ seq, ...ev }));
    if (seq % 100 === 0) this.db.exec("DELETE FROM tui_log WHERE seq <= ?", seq - KEEP_EVENTS);
    this.ring?.(seq);
  }

  private msg = (id: number) => {
    const r = this.db.rows<{ msg: string }>("SELECT msg FROM tui_messages WHERE id = ?", id)[0];
    return r ? (JSON.parse(r.msg) as TuiMessage) : undefined;
  };

  private store(m: TuiMessage, fresh: boolean) {
    if (fresh) {
      const ord = this.counter("ord");
      this.db.exec("INSERT OR REPLACE INTO tui_messages (id, ord, msg) VALUES (?, ?, ?)", m.id, ord, JSON.stringify(m));
      if (ord % 50 === 0) this.db.exec("DELETE FROM tui_messages WHERE ord <= ?", ord - KEEP_MESSAGES);
    } else this.db.exec("UPDATE tui_messages SET msg = ? WHERE id = ?", JSON.stringify(m), m.id);
    this.log({ op: "put", msg: m });
  }

  /** A message under a given id (the mirrored chat's), or the next of this conversation's own. */
  put(id: number | undefined, view: View, o: ViewOptions = {}): number {
    const n = id ?? this.counter("msg");
    this.store(
      {
        id: n,
        at: this.now(),
        view,
        ...(o.forceReply ? { reply: o.forceReply } : {}),
        ...(o.replyTo ? { replyTo: o.replyTo } : {}),
        ...(o.quiet ? { quiet: true } : {}),
      },
      true,
    );
    return n;
  }

  edit(id: number, view: View): boolean {
    const m = this.msg(id);
    if (!m?.view) return false;
    this.store({ ...m, view }, false);
    return true;
  }

  drop(id: number) {
    if (!this.msg(id)) return;
    this.db.exec("DELETE FROM tui_messages WHERE id = ?", id);
    this.log({ op: "del", id });
  }

  /**
   * A terminal's action as the update the envoy takes (ChatEvent via `parse`), once per frame id; what a person
   * types or sends is put into the conversation first, so every terminal shows who said it.
   */
  frame(f: TuiFrame, p: TuiPerson): Record<string, unknown> | null {
    if (typeof f?.id !== "string" || !f.id || f.id.length > 100) return null;
    if (this.db.rows("SELECT 1 FROM tui_frames WHERE id = ?", f.id).length) return null;
    this.db.exec("INSERT INTO tui_frames VALUES (?, ?)", f.id, this.now());
    this.db.exec("DELETE FROM tui_frames WHERE ts < ?", this.now() - 7 * 86400e3);
    const update = -this.counter("update");
    if (f.press && typeof f.press.data === "string") return { tui: { press: f.press }, person: p, update };
    const said = (text: string, replyTo?: number) => {
      const id = -this.counter("said");
      this.store({ id, at: this.now(), by: p.name, said: text, ...(replyTo ? { replyTo } : {}) }, true);
      return id;
    };
    if (f.text && typeof f.text.text === "string" && f.text.text.trim()) return { tui: { text: f.text }, person: p, update, message: said(f.text.text, f.text.replyTo) };
    if (f.file && typeof f.file.name === "string" && typeof f.file.data === "string") {
      const size = Math.floor((f.file.data.length * 3) / 4);
      const fid = `tui:${-update}`;
      if (size <= MAX_FILE) this.db.exec("INSERT OR REPLACE INTO tui_files VALUES (?, ?, ?)", fid, f.file.data, this.now());
      this.db.exec("DELETE FROM tui_files WHERE ts < ?", this.now() - 86400e3);
      const words = [f.file.caption?.trim(), `📎 ${f.file.name}`].filter(Boolean).join("\n");
      return { tui: { file: { ...f.file, data: undefined, id: fid, size } }, person: p, update, message: said(words, f.file.replyTo) };
    }
    return null;
  }

  /** The events after `after`, or the whole conversation when the log no longer reaches back that far. */
  since(after: number): TuiSync {
    const seq = this.seq;
    const oldest = this.db.rows<{ s: number | null }>("SELECT MIN(seq) AS s FROM tui_log")[0]?.s ?? seq + 1;
    if (after === seq) return { seq, events: [] };
    if (after > seq || after < oldest - 1 || after < 0) {
      const messages = this.db.rows<{ msg: string }>("SELECT msg FROM tui_messages ORDER BY ord").map((r) => JSON.parse(r.msg) as TuiMessage);
      const panel = this.state("panel");
      return { seq, events: [], reset: { messages, menu: JSON.parse(this.state("menu") ?? "[]") as Command[], ...(panel ? { panel: JSON.parse(panel) as View } : {}) } };
    }
    const events = this.db.rows<{ ev: string }>("SELECT ev FROM tui_log WHERE seq > ? ORDER BY seq LIMIT 500", after).map((r) => JSON.parse(r.ev) as TuiEvent);
    return { seq: events.length ? events[events.length - 1].seq : seq, events };
  }

  // ---- the Chat port ----

  parse(update: unknown): ChatEvent | null {
    const u = update as { tui?: { press?: TuiFrame["press"]; text?: TuiFrame["text"]; file?: { name: string; id: string; size: number; caption?: string; replyTo?: number } }; person?: TuiPerson; update?: number; message?: number };
    if (!u?.tui || !u.person || typeof u.update !== "number") return null;
    const from = `tui:${u.person.id}`;
    const who = { from, name: u.person.name };
    const t = u.tui;
    if (t.press) return { kind: "press", update: u.update, ...who, query: `${from}:${-u.update}`, data: t.press.data, at: this.at, ...(typeof t.press.message === "number" ? { message: t.press.message } : {}) };
    const replyTo = t.text?.replyTo ?? t.file?.replyTo;
    const base = {
      kind: "message" as const,
      update: u.update,
      at: this.at,
      ...who,
      id: u.message ?? 0,
      chatKind: this.at.chat.startsWith("-") ? ("group" as const) : ("private" as const),
      ...(typeof replyTo === "number" ? { replyTo: { id: replyTo, fromBot: replyTo > 0 } } : {}),
    };
    if (t.text) return { ...base, text: t.text.text, content: { text: t.text.text } };
    if (t.file) {
      const image = /\.(png|jpe?g|gif|webp)$/i.test(t.file.name);
      return { ...base, content: { caption: t.file.caption ?? "", files: [{ id: t.file.id, name: t.file.name, image, size: t.file.size }] } };
    }
    return null;
  }

  async view(_to: ChatRef, view: View, o?: ViewOptions) {
    return this.put(undefined, view, o);
  }
  async editView(_to: ChatRef, id: number, view: View) {
    if (!this.edit(id, view)) throw new Error("no such message");
  }
  async remove(_to: ChatRef, id: number) {
    this.drop(id);
  }
  async dropButtons(_to: ChatRef, id: number) {
    const m = this.msg(id);
    if (m?.view) this.store({ ...m, view: stripButtons(m.view) }, false);
  }
  async react(_to: ChatRef, id: number, emoji: string) {
    const m = this.msg(id);
    if (m) this.store({ ...m, reaction: emoji }, false);
  }
  async answer(query: string, text?: string) {
    // the toast goes to the person who pressed: `tui:<person>:<n>`
    if (text) this.log({ op: "toast", text, to: query.split(":")[1] });
  }
  async setCommands(commands: Command[], to?: ChatRef) {
    if (!to) return;
    const v = JSON.stringify(commands);
    if (this.state("menu") === v) return;
    this.setState("menu", v);
    this.log({ op: "menu", commands });
  }
  async sendFile(_to: ChatRef, name: string, data: string, caption?: string) {
    return this.file(undefined, name, data, caption);
  }
  async panel(_to: ChatRef, view: View) {
    const v = JSON.stringify(view);
    if (this.state("panel") === v) return;
    this.setState("panel", v);
    this.log({ op: "panel", view });
  }
  file(id: number | undefined, name: string, data: string, caption?: string) {
    const n = id ?? this.counter("msg");
    this.store({ id: n, at: this.now(), file: { name, data, ...(caption ? { caption } : {}) } }, true);
    return n;
  }
  async download(file: FileRef): Promise<ArrayBuffer> {
    const r = this.db.rows<{ data: string }>("SELECT data FROM tui_files WHERE id = ?", file.id)[0];
    if (!r) throw new Error(file.size > MAX_FILE ? "the file is over 20 MB" : "the file is gone");
    return Uint8Array.from(atob(r.data), (c) => c.charCodeAt(0)).buffer;
  }
  // a terminal has no profile, webhook or bot settings
  async setName() {}
  async setDescription() {}
  async setShortDescription() {}
  async setPhoto() {}
  async setWebhook() {}
  async webhookUrl() {
    return "";
  }
}

/**
 * A Telegram conversation shown in the terminals as well: Telegram gives the message ids, the terminals mirror every
 * message under the same id, and an action from either side reaches the one envoy. What a person types in a
 * terminal carries a negative id, which Telegram never sees.
 */
export class Tee implements Chat {
  constructor(
    private tg: Chat,
    readonly term: Terminal,
  ) {}
  parse(update: unknown) {
    return (update as { tui?: unknown })?.tui ? this.term.parse(update) : this.tg.parse(update);
  }
  async view(to: ChatRef, view: View, o: ViewOptions = {}) {
    const { replyTo, ...rest } = o;
    const id = await this.tg.view(to, view, replyTo !== undefined && replyTo < 0 ? rest : o);
    return this.term.put(id, view, o);
  }
  async editView(to: ChatRef, id: number, view: View) {
    if (id > 0) await this.tg.editView(to, id, view);
    else throw new Error("no such message");
    this.term.edit(id, view);
  }
  async remove(to: ChatRef, id: number) {
    this.term.drop(id);
    if (id > 0) await this.tg.remove(to, id);
  }
  async dropButtons(to: ChatRef, id: number) {
    await this.term.dropButtons(to, id);
    if (id > 0) await this.tg.dropButtons(to, id);
  }
  async react(to: ChatRef, id: number, emoji: string) {
    await this.term.react(to, id, emoji);
    if (id > 0) await this.tg.react(to, id, emoji);
  }
  answer(query: string, text?: string) {
    return query.startsWith("tui:") ? this.term.answer(query, text) : this.tg.answer(query, text);
  }
  async setCommands(commands: Command[], to?: ChatRef) {
    await this.term.setCommands(commands, to);
    await this.tg.setCommands(commands, to);
  }
  setScopedCommands(commands: Command[], scope: CommandScope) {
    return this.tg.setScopedCommands?.(commands, scope) ?? Promise.resolve();
  }
  setSettings(s: BotSettings) {
    return this.tg.setSettings?.(s) ?? Promise.resolve();
  }
  async sendFile(to: ChatRef, name: string, data: string, caption?: string, buttons?: Button[][]) {
    const id = this.tg.sendFile ? await this.tg.sendFile(to, name, data, caption, buttons) : undefined;
    return this.term.file(id, name, data, caption);
  }
  panel(to: ChatRef, view: View) {
    return this.term.panel(to, view);
  }
  download(file: FileRef) {
    return file.id.startsWith("tui:") ? this.term.download(file) : this.tg.download(file);
  }
  setName(n: string) {
    return this.tg.setName(n);
  }
  setDescription(t: string) {
    return this.tg.setDescription(t);
  }
  setShortDescription(t: string) {
    return this.tg.setShortDescription(t);
  }
  setPhoto(p: ArrayBuffer) {
    return this.tg.setPhoto(p);
  }
  setWebhook(u: string, s: string) {
    return this.tg.setWebhook(u, s);
  }
  webhookUrl() {
    return this.tg.webhookUrl();
  }
}


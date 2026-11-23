// The terminal interface's screens and keys, without a terminal: main.ts feeds it input and the server's answers
// and writes what `draw()` paints; the tests do the same against a headless Screen. docs/tui.md describes the
// screens, docs/chat-style.md ("In a terminal") the rules they follow.
import type { Button, View } from "../src/ports/chat";
import type { TuiFrame, TuiSeat, TuiSync } from "../src/ports/tui";
import { buttonText, layout, type Laid, type Line, plainOf, type Target } from "./html";
import type { Input, Key, Mouse } from "./input";
import { B, clip, DIM, fg, graphemes, IT, pad, REV, Screen, type Style, UL, width } from "./screen";
import { type Shown, Conversation } from "./state";

/** What the client needs of the machine it runs on (main.ts; the tests give a stand-in). */
export interface Sys {
  /** Saves a handed-over file with mode 600; returns its path. */
  save(name: string, data: string): string;
  /** A file to send: its name and its bytes as base64; throws an Error with one sentence. */
  read(path: string): { name: string; data: string; size: number };
  list(dir: string): { name: string; dir: boolean }[];
  cwd: string;
  home: string;
  /** Opens a link where it can (a desktop) and says what it did. */
  open(url: string): string;
  copy(text: string): void;
  now(): number;
}

export type Conn = "connecting" | "online" | "polling" | "offline";

type Region = { x: number; y: number; w: number; h: number; click: (m: Mouse) => void; wheel?: (d: number) => void };

type Overlay =
  | { kind: "help"; scroll: number }
  | { kind: "notices"; scroll: number }
  | { kind: "seats"; sel: number }
  | { kind: "files"; dir: string; filter: string; sel: number; entries: { name: string; dir: boolean }[]; error?: string }
  | { kind: "prompt"; title: string; hint: string; value: Editor; submit: (v: string) => void; mask?: boolean };

const MAX_SEND = 20 * 1024 * 1024;

/** A small multi-line editor: logical lines, a cursor by grapheme, soft-wrapped when drawn. */
export class Editor {
  lines: string[][] = [[]];
  r = 0;
  c = 0;
  get text() {
    return this.lines.map((l) => l.join("")).join("\n");
  }
  set(t: string) {
    this.lines = t.split("\n").map((l) => graphemes(l));
    this.r = this.lines.length - 1;
    this.c = this.lines[this.r].length;
  }
  get empty() {
    return !this.text.trim();
  }
  insert(s: string) {
    const parts = s.split("\n");
    parts.forEach((p, i) => {
      if (i) this.newline();
      const g = graphemes(p.replace(/\t/g, "  ").replace(/[\x00-\x08\x0b-\x1f]/g, ""));
      this.lines[this.r].splice(this.c, 0, ...g);
      this.c += g.length;
    });
  }
  newline() {
    const rest = this.lines[this.r].splice(this.c);
    this.lines.splice(this.r + 1, 0, rest);
    this.r++;
    this.c = 0;
  }
  backspace() {
    if (this.c > 0) this.lines[this.r].splice(--this.c, 1);
    else if (this.r > 0) {
      const l = this.lines.splice(this.r, 1)[0];
      this.r--;
      this.c = this.lines[this.r].length;
      this.lines[this.r].push(...l);
    }
  }
  del() {
    if (this.c < this.lines[this.r].length) this.lines[this.r].splice(this.c, 1);
    else if (this.r + 1 < this.lines.length) this.lines[this.r].push(...this.lines.splice(this.r + 1, 1)[0]);
  }
  move(name: string) {
    const l = this.lines;
    if (name === "left") {
      if (this.c > 0) this.c--;
      else if (this.r > 0) this.c = l[--this.r].length;
    } else if (name === "right") {
      if (this.c < l[this.r].length) this.c++;
      else if (this.r + 1 < l.length) {
        this.r++;
        this.c = 0;
      }
    } else if (name === "up" && this.r > 0) this.c = Math.min(this.c, l[--this.r].length);
    else if (name === "down" && this.r + 1 < l.length) this.c = Math.min(this.c, l[++this.r].length);
    else if (name === "home") this.c = 0;
    else if (name === "end") this.c = l[this.r].length;
  }
  /** The lines wrapped at `w` cells, and where the cursor is among them. */
  wrapped(w: number): { rows: string[]; cr: number; cc: number } {
    const rows: string[] = [];
    let cr = 0;
    let cc = 0;
    this.lines.forEach((l, r) => {
      let row = "";
      let rw = 0;
      let start = rows.length;
      l.forEach((g, i) => {
        if (r === this.r && i === this.c) [cr, cc] = [rows.length, rw];
        const gw = width(g);
        if (rw + gw > w) {
          rows.push(row);
          row = "";
          rw = 0;
          if (r === this.r && i === this.c) [cr, cc] = [rows.length, 0];
        }
        row += g;
        rw += gw;
      });
      if (r === this.r && this.c >= l.length) [cr, cc] = rw >= w ? [rows.length + 1, 0] : [rows.length, rw];
      rows.push(row);
      if (rw >= w && r === this.r && this.c >= l.length) rows.push("");
      void start;
    });
    return { rows, cr, cc };
  }
}

/** The key each of the envoy's buttons answers to, shown on the bar. */
export function hotkey(b: Button): string | undefined {
  const d = b.data ?? "";
  if (/^[LSP]:\d+$/.test(d)) return b.label.startsWith("◀") ? "[" : b.label.startsWith("▶") ? "]" : d.startsWith("L") ? "l" : undefined;
  return ({ t: "t", p: "p", k: "o", s: "s", n: "n", b: "b", f: "/", F: "f", X: "x" } as Record<string, string>)[d];
}

/** The seat id of the managed instance's setup and management (src/runtime/router.ts, INSTANCE_SEAT). */
export const SETUP = "@instance";

/** The sync and socket path of a seat. */
export const seatPath = (id: string) => (id === SETUP ? "instance" : `w/${id}`);

export const HELP: [string, string][] = [
  ["n  /  p", "Next item / previous item"],
  ["o", "OK: answer the card with OK"],
  ["s", "Skip: move the item to the end"],
  ["l", "List the open items"],
  ["t", "New ticket (then f to file it, x to drop it)"],
  ["a  or  Enter", "Write an answer to the card on screen"],
  ["Ctrl+S", "Send what you wrote (n then records it and moves on)"],
  ["Ctrl+O", "Attach a file to the answer (a file picker)"],
  ["Esc", "Leave the editor (the draft stays) or close a window"],
  ["/", "Search the open items"],
  ["P", "Postponed tickets"],
  [":", "A command: todo, postponed, stats, new, search words, start"],
  ["Tab  Shift+Tab", "Move between the inbox, the card and the editor"],
  ["↑ ↓  j k", "Move in the inbox; move between buttons on the card"],
  ["Enter  Space", "Open the selected item; press the selected button; open or close a fold"],
  ["PgUp  PgDn", "Scroll the card"],
  ["[  ]", "Previous / next page of a list"],
  ["b", "Back from a list to the bar"],
  ["w", "Switch the workspace (when your key opens several)"],
  ["!", "Notices: the digest, new items, sync messages"],
  ["r", "Fetch now"],
  ["?", "This help"],
  ["q  Ctrl+C", "Quit"],
  ["Mouse", "Click buttons, rows, folds and links; the wheel scrolls"],
];

export class App {
  w = 80;
  h = 24;
  color = true;
  seats: TuiSeat[] = [];
  ws?: string;
  convs = new Map<string, Conversation>();
  outbox = new Map<string, TuiFrame[]>();
  conn: Conn = "connecting";
  signin?: { editor: Editor; note: string; digest?: string; mode: "paste" | "wait" };
  area: "inbox" | "view" | "editor" = "view";
  overlay?: Overlay;
  status?: { text: string; at: number; error?: boolean };
  quit = false;
  private drafts = new Map<string, Editor>();
  private folds = new Map<number, Map<string, boolean>>();
  private scrolls = new Map<number, number>();
  private picks = new Map<number, number>();
  private inboxSel = 0;
  private inboxTop = 0;
  private regions: Region[] = [];
  private frameN = 0;
  private started = new Set<string>();
  private laid?: { key: string; laid: Laid };
  private cid: string;
  /** Asks main.ts for a sync of this workspace (frames are waiting), or to switch, sign in, make a key. */
  kick: (ws: string) => void = () => {};
  onSwitch: (ws: string) => void = () => {};
  onKey: (key: string) => void = () => {};
  onNewKey: () => void = () => {};

  constructor(
    readonly sys: Sys,
    cid = Math.random().toString(36).slice(2, 10),
  ) {
    this.cid = cid;
  }

  get conv(): Conversation {
    const ws = this.ws ?? "";
    let c = this.convs.get(ws);
    if (!c) {
      c = new Conversation();
      this.convs.set(ws, c);
    }
    return c;
  }
  get seat() {
    return this.seats.find((s) => s.id === this.ws);
  }

  /** The managed instance's own conversation: setup and management, where typing always goes to the screen. */
  get setup() {
    return this.ws === SETUP;
  }

  /** What typing answers: the card or prompt on screen; in the setup, the setup itself. */
  target(): Shown | undefined {
    const t = this.conv.replyTarget();
    if (t || !this.setup) return t;
    return this.conv.focus() ?? ({ id: 0, at: 0, touched: 0, reply: "Type here: repositories, a token, a name…" } as Shown);
  }

  say(text: string, error = false) {
    this.status = { text, at: this.sys.now(), error };
  }

  // ---- from the server ----

  /** An answer of sync for `ws`: applied, toasts shown, handed-over files saved. */
  synced(ws: string, s: TuiSync) {
    const c = this.convs.get(ws) ?? new Conversation();
    this.convs.set(ws, c);
    const toasts = c.apply(s, this.seats.find((x) => x.id === ws)?.person.id);
    if (ws === this.ws && toasts.length) this.say(toasts[toasts.length - 1]);
    // a conversation without the bar has not been started here: /start shows the current item and the bar
    if (!this.started.has(ws) && !c.bar()) {
      this.started.add(ws);
      const q = this.outbox.get(ws) ?? [];
      q.push({ id: `${this.cid}-${this.sys.now().toString(36)}-${++this.frameN}`, text: { text: "/start" } });
      this.outbox.set(ws, q);
      this.kick(ws);
    } else this.started.add(ws);
    while (c.files.length) {
      const m = c.files.shift() as Shown;
      const f = m.file as NonNullable<Shown["file"]>;
      try {
        const full = this.sys.save(f.name, f.data);
        const home = full.startsWith(`${this.sys.home}/`) ? `~${full.slice(this.sys.home.length)}` : full;
        // the file's name must stay readable: a long folder is cut from the left
        const path = width(home) > 72 ? `…${home.slice(-71)}` : home;
        this.say(`💾 Saved to ${path}: readable by you only.${f.caption ? ` ${f.caption}` : ""}`);
      } catch (e) {
        this.say(`${f.name} could not be saved: ${e instanceof Error ? e.message : e}`, true);
      }
    }
    if (this.area === "editor" && !this.target()) this.area = "view";
  }

  /** The frames waiting for `ws`, taken; give them back with `requeue` when the request failed. */
  take(ws: string): TuiFrame[] {
    const f = this.outbox.get(ws) ?? [];
    this.outbox.delete(ws);
    return f;
  }
  requeue(ws: string, frames: TuiFrame[]) {
    this.outbox.set(ws, [...frames, ...(this.outbox.get(ws) ?? [])]);
  }

  private send(frame: Omit<TuiFrame, "id">) {
    if (!this.ws) return;
    const q = this.outbox.get(this.ws) ?? [];
    q.push({ id: `${this.cid}-${this.sys.now().toString(36)}-${++this.frameN}`, ...frame });
    this.outbox.set(this.ws, q);
    this.kick(this.ws);
  }

  press(b: Button, message?: number) {
    if (b.data !== undefined) this.send({ press: { data: b.data, ...(message !== undefined ? { message } : {}) } });
    else if (b.url !== undefined) this.say(this.sys.open(b.url));
    else if (b.copy !== undefined) {
      this.sys.copy(b.copy);
      this.say("Copied.");
    }
  }

  private command(text: string) {
    this.send({ text: { text } });
  }

  // ---- input ----

  input(e: Input) {
    if (e.type === "mouse") return this.mouse(e);
    if (e.type === "paste") {
      if (this.signin?.mode === "paste") return this.signin.editor.insert(e.text.trim());
      if (this.overlay?.kind === "prompt") return this.overlay.value.insert(e.text.replace(/\n/g, " "));
      if (this.overlay?.kind === "files") return void (this.overlay.filter += e.text.trim());
      if (!this.target()) return;
      this.area = "editor";
      return this.editor()?.insert(e.text);
    }
    this.key(e);
  }

  private key(k: Key) {
    if (k.ctrl && k.name === "c") return void (this.quit = true);
    if (this.signin) return this.signinKey(k);
    if (this.overlay) return this.overlayKey(k);
    if (this.area === "editor" && this.editorKey(k)) return;
    const bar = this.conv.bar();
    if (!k.ctrl && !k.alt && bar) {
      const hit = this.conv.buttons(bar).find((b) => hotkey(b) === (k.ch ?? k.name));
      if (hit) return this.press(hit, bar.id);
    }
    const ch = k.ch ?? "";
    // the bar's keys work before the bar arrived, as the commands they stand for
    const cmd = !bar && !this.setup && !k.ctrl && !k.alt ? ({ n: "/next", p: "/prev", s: "/skip", t: "/new", l: "/todo" } as Record<string, string>)[ch] : undefined;
    if (cmd) return this.command(cmd);
    if (!k.ctrl && !k.alt)
      switch (ch) {
        case "q":
          return void (this.quit = true);
        case "?":
          return void (this.overlay = { kind: "help", scroll: 0 });
        case "!":
          return void (this.overlay = { kind: "notices", scroll: 0 });
        case "w":
          if (this.seats.length > 1) this.overlay = { kind: "seats", sel: Math.max(0, this.seats.findIndex((s) => s.id === this.ws)) };
          else this.say("Your key opens only this workspace.");
          return;
        case "/":
          return this.prompt("🔎 Search", "Words to find; all must match", (v) => v.trim() && this.command(`/search ${v.trim()}`));
        case ":":
          return this.prompt("Command", "todo · postponed · stats · new · start · search words", (v) => v.trim() && this.command(`/${v.trim().replace(/^\//, "")}`));
        case "P":
          return this.command("/postponed");
        case "r":
          if (this.ws) this.kick(this.ws);
          return this.say("Fetching…");
        case "a":
        case "e":
        case "i":
          return this.toEditor();
      }
    if (k.name === "tab") return this.cycle(k.shift ? -1 : 1);
    if (k.name === "backtab") return this.cycle(-1);
    if (k.ctrl && k.name === "o") return this.attach();
    if (this.area === "inbox") return this.inboxKey(k);
    return this.viewKey(k);
  }

  private cycle(d: number) {
    const areas: ("inbox" | "view" | "editor")[] = ["inbox", "view", ...(this.target() ? ["editor" as const] : [])];
    this.area = areas[(areas.indexOf(this.area) + d + areas.length) % areas.length];
  }

  private toEditor() {
    if (!this.target()) return this.say("Nothing on screen takes an answer: open an item first (n, or Enter in the inbox).");
    this.area = "editor";
  }

  private prompt(title: string, hint: string, submit: (v: string) => void, mask = false) {
    this.overlay = { kind: "prompt", title, hint, value: new Editor(), submit, mask };
  }

  /** The editor of the card on screen: one draft per ticket, kept while you go elsewhere. */
  editor(): Editor | undefined {
    const t = this.target();
    if (!t) return undefined;
    const k = `${this.ws}:${this.setup ? "setup" : ticketOf(t)}`;
    let e = this.drafts.get(k);
    if (!e) {
      e = new Editor();
      this.drafts.set(k, e);
    }
    return e;
  }

  private hasDraft(label: string) {
    return !(this.drafts.get(`${this.ws}:${label}`)?.empty ?? true);
  }

  private editorKey(k: Key): boolean {
    const e = this.editor();
    if (!e) return false;
    if (k.name === "escape") return (this.area = "view"), true;
    if ((k.ctrl && k.name === "s") || (k.alt && k.name === "enter") || (k.ctrl && k.name === "d")) return this.sendAnswer(), true;
    if (k.ctrl && k.name === "o") return this.attach(), true;
    if (k.name === "tab" || k.name === "backtab") return false;
    if (k.name === "enter") e.newline();
    else if (k.name === "backspace") e.backspace();
    else if (k.name === "delete") e.del();
    else if (["left", "right", "up", "down", "home", "end"].includes(k.name)) e.move(k.name);
    else if (k.ctrl && k.name === "u") e.set("");
    else if (k.ch && !k.ctrl && !k.alt) e.insert(k.ch);
    else if (k.name === "space") e.insert(" ");
    return true;
  }

  sendAnswer() {
    const t = this.target();
    const e = this.editor();
    if (!t || !e || e.empty) return this.say("Write something first.");
    this.send({ text: { text: e.text.trim(), ...(t.reply && t.id ? { replyTo: t.id } : {}) } });
    e.set("");
    this.area = "view";
    this.say(this.setup ? "Sent." : "Sent. n records it and moves on; o adds OK; a writes more.");
  }

  /** The file picker (Ctrl+O): a path typed or chosen; the file goes with the draft as its caption. */
  attach() {
    if (!this.target()) return this.say("Open an item first: a file answers the card on screen.");
    this.openDir(this.sys.cwd);
  }

  private openDir(dir: string) {
    try {
      const entries = this.sys.list(dir).sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name));
      this.overlay = { kind: "files", dir, filter: "", sel: 0, entries: [{ name: "..", dir: true }, ...entries] };
    } catch (e) {
      this.overlay = { kind: "files", dir, filter: "", sel: 0, entries: [{ name: "..", dir: true }], error: e instanceof Error ? e.message : String(e) };
    }
  }

  private sendFile(path: string) {
    const t = this.target();
    if (!t) return;
    try {
      const f = this.sys.read(path);
      if (f.size > MAX_SEND) return this.say(`${f.name} is over 20 MB, which cannot be sent.`, true);
      const e = this.editor();
      const caption = e && !e.empty ? e.text.trim() : undefined;
      this.send({ file: { name: f.name, data: f.data, ...(caption ? { caption } : {}), ...(t.reply && t.id ? { replyTo: t.id } : {}) } });
      e?.set("");
      this.overlay = undefined;
      this.area = "view";
      this.say(`📎 ${f.name} sent. n records it and moves on.`);
    } catch (e) {
      this.say(e instanceof Error ? e.message : String(e), true);
    }
  }

  private overlayKey(k: Key) {
    const o = this.overlay as Overlay;
    if (k.name === "escape" || (o.kind !== "prompt" && o.kind !== "files" && k.ch === "q")) return void (this.overlay = undefined);
    if (o.kind === "help" || o.kind === "notices") {
      if (k.name === "down" || k.ch === "j") o.scroll++;
      if (k.name === "up" || k.ch === "k") o.scroll = Math.max(0, o.scroll - 1);
      if (k.name === "pagedown") o.scroll += 10;
      if (k.name === "pageup") o.scroll = Math.max(0, o.scroll - 10);
      if (k.name === "enter" || k.ch === "?" || k.ch === "!") this.overlay = undefined;
      return;
    }
    if (o.kind === "seats") {
      if (k.name === "down" || k.ch === "j") o.sel = Math.min(this.seats.length - 1, o.sel + 1);
      if (k.name === "up" || k.ch === "k") o.sel = Math.max(0, o.sel - 1);
      if (k.name === "enter") {
        this.switchTo(this.seats[o.sel].id);
        this.overlay = undefined;
      }
      return;
    }
    if (o.kind === "prompt") {
      if (k.name === "enter") {
        this.overlay = undefined;
        return o.submit(o.value.text);
      }
      if (k.name === "backspace") o.value.backspace();
      else if (["left", "right", "home", "end"].includes(k.name)) o.value.move(k.name);
      else if (k.ch && !k.ctrl && !k.alt) o.value.insert(k.ch);
      else if (k.name === "space") o.value.insert(" ");
      return;
    }
    // the file picker: typing filters (or is a path), arrows choose, Enter opens a folder or sends the file
    const shown = this.pickerEntries(o);
    if (k.name === "down") o.sel = Math.min(shown.length - 1, o.sel + 1);
    else if (k.name === "up") o.sel = Math.max(0, o.sel - 1);
    else if (k.name === "backspace") {
      o.filter = graphemes(o.filter).slice(0, -1).join("");
      o.sel = 0;
    } else if (k.name === "enter") {
      if (/^[/~]/.test(o.filter)) {
        const p = o.filter.replace(/^~(?=\/|$)/, this.sys.home);
        return /\/$/.test(p) ? this.openDir(p.replace(/\/+$/, "") || "/") : this.sendFile(p);
      }
      const e = shown[o.sel];
      if (!e) return;
      const p = e.name === ".." ? o.dir.replace(/\/[^/]*$/, "") || "/" : `${o.dir.replace(/\/$/, "")}/${e.name}`;
      if (e.dir) this.openDir(p);
      else this.sendFile(p);
    } else if (k.ch && !k.ctrl && !k.alt) {
      o.filter += k.ch;
      o.sel = 0;
    } else if (k.name === "space") o.filter += " ";
  }

  private pickerEntries(o: Extract<Overlay, { kind: "files" }>) {
    if (/^[/~]/.test(o.filter)) return [];
    const f = o.filter.toLowerCase();
    return o.entries.filter((e) => !f || e.name.toLowerCase().includes(f));
  }

  switchTo(ws: string) {
    if (ws === this.ws) return;
    this.ws = ws;
    this.area = "view";
    this.laid = undefined;
    this.onSwitch(ws);
    this.say(`Workspace ${this.seat?.name ?? ws}.`);
  }

  private inboxRows(): { label: string; kind: string; age: string; title: string; button?: Button }[] {
    const t = this.conv.panel?.find((b) => "table" in b) as { table: { rows: { cells: string[]; buttons?: Button[] }[] } } | undefined;
    return (t?.table.rows ?? []).map((r) => {
      const [label, kind, age, title] = r.cells.map((c) => plainOf([{ html: c }]));
      return { label: label.startsWith("#") || /[a-z]#/.test(label) ? label : `#${label}`, kind, age, title, button: r.buttons?.[0] };
    });
  }

  private inboxKey(k: Key) {
    const rows = this.inboxRows();
    if (k.name === "down" || k.ch === "j") this.inboxSel = Math.min(rows.length - 1, this.inboxSel + 1);
    else if (k.name === "up" || k.ch === "k") this.inboxSel = Math.max(0, this.inboxSel - 1);
    else if (k.name === "home" || k.ch === "g") this.inboxSel = 0;
    else if (k.name === "end" || k.ch === "G") this.inboxSel = rows.length - 1;
    else if (k.name === "enter" || k.name === "space" || k.name === "right") {
      const b = rows[this.inboxSel]?.button;
      if (b) {
        this.press(b);
        this.area = "view";
      }
    }
  }

  private viewKey(k: Key) {
    const f = this.conv.focus();
    if (!f || !this.laid) {
      if (k.name === "enter") this.toEditor();
      return;
    }
    const ts = this.laid.laid.targets;
    const cur = this.picks.get(f.id) ?? -1;
    const top = this.scrolls.get(f.id) ?? 0;
    const view = this.viewH;
    const move = (d: number) => {
      const here = ts[cur];
      const order = ts.map((t, i) => [t, i] as const).sort((a, b) => a[0].line - b[0].line || a[0].col - b[0].col);
      const pos = here ? order.findIndex(([, i]) => i === cur) : d > 0 ? -1 : order.length;
      const next = order[pos + d];
      if (next && Math.abs(next[0].line - (here?.line ?? top)) <= view) {
        this.picks.set(f.id, next[1]);
        this.reveal(f.id, next[0].line);
      } else this.scrolls.set(f.id, Math.max(0, top + d));
    };
    if (k.name === "down" || k.ch === "j") move(1);
    else if (k.name === "up" || k.ch === "k") move(-1);
    else if (k.name === "pagedown" || k.name === "space") this.scrolls.set(f.id, top + Math.max(1, view - 2));
    else if (k.name === "pageup") this.scrolls.set(f.id, Math.max(0, top - Math.max(1, view - 2)));
    else if (k.name === "home" || k.ch === "g") this.scrolls.set(f.id, 0);
    else if (k.name === "end" || k.ch === "G") this.scrolls.set(f.id, this.laid.laid.lines.length);
    else if (k.name === "enter") {
      const t = ts[cur];
      if (t) this.act(f, t);
      else this.toEditor();
    }
  }

  private reveal(id: number, line: number) {
    const top = this.scrolls.get(id) ?? 0;
    if (line < top) this.scrolls.set(id, line);
    else if (line >= top + this.viewH) this.scrolls.set(id, line - this.viewH + 1);
  }

  private act(m: Shown, t: Target) {
    if (t.kind === "button") this.press(t.button, m.id);
    else if (t.kind === "link") this.say(this.sys.open(t.href));
    else {
      const f = this.folds.get(m.id) ?? new Map();
      f.set(t.fold, !t.open);
      this.folds.set(m.id, f);
      this.laid = undefined;
    }
  }

  private mouse(m: Mouse) {
    if (m.action === "wheelup" || m.action === "wheeldown") {
      const r = [...this.regions].reverse().find((r) => r.wheel && m.x >= r.x && m.x < r.x + r.w && m.y >= r.y && m.y < r.y + r.h);
      return r?.wheel?.(m.action === "wheelup" ? -3 : 3);
    }
    if (m.action !== "down" || m.button !== 0) return;
    const r = [...this.regions].reverse().find((r) => m.x >= r.x && m.x < r.x + r.w && m.y >= r.y && m.y < r.y + r.h);
    r?.click(m);
  }

  private signinKey(k: Key) {
    const s = this.signin as NonNullable<App["signin"]>;
    if (k.name === "escape" || (s.mode === "wait" && k.ch === "q")) return void (this.quit = true);
    if (s.mode === "wait") {
      if (k.ch === "p") s.mode = "paste";
      return;
    }
    if (k.ctrl && k.name === "n") return this.onNewKey();
    if (k.name === "enter") {
      const key = s.editor.text.trim();
      if (!/^\S{20,}$/.test(key)) return void (s.note = "That is not a key: paste the whole key you were given.");
      s.editor.set("");
      s.note = "Checking the key…";
      return this.onKey(key);
    }
    if (k.name === "backspace") s.editor.backspace();
    else if (k.ch && !k.ctrl && !k.alt) s.editor.insert(k.ch);
  }

  // ---- drawing ----

  private viewH = 10;

  draw(sc: Screen) {
    this.regions = [];
    sc.fill(0, 0, sc.w, sc.h);
    if (this.status && this.sys.now() - this.status.at > 8000 && !this.status.error) this.status = undefined;
    if (this.signin) return this.drawSignin(sc);
    this.drawHeader(sc);
    const barRows = this.barLines(sc.w);
    const bodyH = sc.h - 2 - barRows.length;
    const wide = sc.w >= 100;
    // the setup has no inbox: its screens take the whole width
    if (this.setup) this.drawFocus(sc, 0, 1, sc.w, bodyH);
    else if (wide) {
      const lw = Math.max(34, Math.min(56, Math.floor(sc.w * 0.36)));
      this.drawInbox(sc, 0, 1, lw, bodyH);
      this.drawFocus(sc, lw, 1, sc.w - lw, bodyH);
    } else {
      const ih = Math.max(4, Math.min(9, Math.round(bodyH * 0.3)));
      this.drawInbox(sc, 0, 1, sc.w, ih);
      this.drawFocus(sc, 0, 1 + ih, sc.w, bodyH - ih);
    }
    this.drawBar(sc, sc.h - 1 - barRows.length, barRows);
    this.drawStatus(sc, sc.h - 1);
    if (this.overlay) this.drawOverlay(sc);
  }

  private c(s: Style) {
    return this.color ? s : s & 0xff;
  }

  private box(sc: Screen, x: number, y: number, w: number, h: number, title: string, focused: boolean, click?: () => void) {
    const s = this.c(focused ? B | fg("cyan") : DIM);
    if (w < 4 || h < 2) return;
    // the focused pane has heavy lines: visible without colour too
    const [tl, hz, tr, vt, bl, br] = focused ? ["┏", "━", "┓", "┃", "┗", "┛"] : ["┌", "─", "┐", "│", "└", "┘"];
    sc.put(x, y, `${tl}${hz.repeat(w - 2)}${tr}`, s);
    for (let r = 1; r < h - 1; r++) {
      sc.put(x, y + r, vt, s);
      sc.put(x + w - 1, y + r, vt, s);
    }
    sc.put(x, y + h - 1, `${bl}${hz.repeat(w - 2)}${br}`, s);
    const t = clip(` ${title} `, w - 4);
    sc.put(x + 2, y, t, this.c(focused ? B | fg("cyan") : B));
    if (click) this.regions.push({ x, y, w, h, click });
  }

  private drawHeader(sc: Screen) {
    sc.fill(0, 0, sc.w, 1, this.c(REV));
    const name = this.seat ? `${this.seat.name}${this.seats.length > 1 ? " ▾" : ""}` : "";
    const left = ` Flowee · ${name}`;
    const counts = this.conv.menu.filter((m) => m.command === "todo" || m.command === "postponed").map((m) => m.description.replace(/ items$| tickets$/, ""));
    const conn = { connecting: "◌ connecting", online: "● live", polling: "◐ polling", offline: "○ offline, retrying" }[this.conn];
    const right = `${counts.join(" · ")}${counts.length ? "  " : ""}${conn}  ? help `;
    const lw = Math.max(0, sc.w - width(right) - 1);
    sc.put(0, 0, clip(left, lw), this.c(REV | B), lw);
    if (this.seats.length > 1) this.regions.push({ x: 0, y: 0, w: Math.min(lw, width(left)), h: 1, click: () => (this.overlay = { kind: "seats", sel: Math.max(0, this.seats.findIndex((s) => s.id === this.ws)) }) });
    const connStyle = this.conn === "online" ? fg("green") : this.conn === "offline" ? fg("red") : fg("yellow");
    let x = Math.max(lw, sc.w - width(right));
    const before = `${counts.join(" · ")}${counts.length ? "  " : ""}`;
    x = sc.put(x, 0, before, this.c(REV));
    x = sc.put(x, 0, conn, this.c(REV | B | connStyle));
    sc.put(x, 0, "  ? help ", this.c(REV));
    this.regions.push({ x: sc.w - 8, y: 0, w: 8, h: 1, click: () => (this.overlay = { kind: "help", scroll: 0 }) });
  }

  private drawInbox(sc: Screen, x: number, y: number, w: number, h: number) {
    const focused = this.area === "inbox";
    const head = this.conv.panel?.find((b) => "html" in b) as { html: string } | undefined;
    const title = head ? plainOf([head]).replace(/^📋 /, "") : "Inbox";
    this.box(sc, x, y, w, h, title, focused, () => (this.area = "inbox"));
    const rows = this.inboxRows();
    const iw = w - 2;
    const ih = h - 2;
    this.inboxSel = Math.max(0, Math.min(this.inboxSel, rows.length - 1));
    if (this.inboxSel < this.inboxTop) this.inboxTop = this.inboxSel;
    if (this.inboxSel >= this.inboxTop + ih) this.inboxTop = this.inboxSel - ih + 1;
    if (!rows.length) {
      sc.put(x + 2, y + 1, clip(this.conv.panel ? "✨ Inbox empty" : "Loading…", iw - 2), this.c(DIM), x + w - 1);
      return;
    }
    this.regions.push({ x, y, w, h, click: () => (this.area = "inbox"), wheel: (d) => (this.inboxSel = Math.max(0, Math.min(rows.length - 1, this.inboxSel + d))) });
    const lw = Math.max(...rows.map((r) => width(r.label)));
    const current = ticketOf(this.conv.replyTarget());
    rows.slice(this.inboxTop, this.inboxTop + ih).forEach((r, i) => {
      const n = this.inboxTop + i;
      const yy = y + 1 + i;
      const sel = n === this.inboxSel;
      const mark = r.label === current ? "▶" : this.hasDraft(r.label) ? "✎" : " ";
      const age = r.age.padStart(6);
      const kind = iw >= 44 ? ` ${KINDS[r.kind] ?? "·"} ${pad(r.kind, 8)}` : ` ${KINDS[r.kind] ?? "·"}`;
      const fixed = `${mark} ${pad(r.label, lw)}${kind} ${age}  `;
      const line = fixed + clip(r.title, Math.max(1, iw - width(fixed)));
      const s = sel ? (focused ? REV | B : B) : 0;
      sc.fill(x + 1, yy, iw, 1, this.c(s));
      sc.put(x + 1, yy, clip(line, iw), this.c(s), x + w - 1);
      this.regions.push({
        x: x + 1,
        y: yy,
        w: iw,
        h: 1,
        click: () => {
          this.inboxSel = n;
          this.area = "inbox";
          if (r.button) this.press(r.button);
        },
      });
    });
    if (rows.length > ih) sc.put(x + w - 1, y + 1 + Math.floor((this.inboxTop / Math.max(1, rows.length - ih)) * (ih - 1)), "▐", this.c(fg("cyan")));
  }

  private drawFocus(sc: Screen, x: number, y: number, w: number, h: number) {
    const f = this.conv.focus();
    const target = f?.reply ? f : this.setup ? this.target() : undefined;
    const said = target ? this.conv.said().filter((m) => m.replyTo === target.id).slice(-3) : [];
    const eh = target ? Math.max(4, Math.min(8, Math.floor(h * 0.32))) : 0;
    const vh = h - eh;
    const focused = this.area === "view";
    const ticket = ticketOf(f);
    const title = f?.reply ? (ticket.includes("#") ? `Card ${ticket}` : "Write") : "Flowee";
    this.box(sc, x, y, w, vh, title, focused, () => (this.area = "view"));
    const iw = w - 4;
    if (!f) {
      const hint = this.setup ? "Fetching…" : this.conv.panel ? "Nothing open on screen." : "Fetching the inbox…";
      const help = this.setup ? "" : "<p>n opens the next item, t writes a new ticket, l lists them all, ? shows every key.</p>";
      layout([{ html: `<p>${hint}</p>${help}` }], iw).lines.slice(0, vh - 2).forEach((l, i) => {
        let cx = x + 2;
        for (const seg of l) cx = sc.put(cx, y + 1 + i, seg.t, this.c(i ? DIM : 0), x + w - 2);
      });
    } else {
      const key = `${f.id}:${f.touched}:${iw}:${JSON.stringify([...(this.folds.get(f.id) ?? new Map())])}`;
      // the bar showing a list: its button rows are on the action bar already
      const view = f === this.conv.bar() ? (f.view as View).filter((b) => !("buttons" in b)) : (f.view as View);
      if (this.laid?.key !== key) this.laid = { key, laid: layout(view, iw, { folds: this.folds.get(f.id) }) };
      const laid = this.laid.laid;
      const extra: Line[] = said.map((m) => [
        { t: `${m.by ?? "You"}: `, s: B | fg("yellow") },
        { t: clip((m.said ?? "").replace(/\n/g, " ⏎ "), Math.max(1, iw - width(`${m.by ?? "You"}: `) - 3)), s: IT },
        ...(m.reaction ? [{ t: ` ${m.reaction}`, s: 0 }] : []),
      ]);
      const lines = extra.length ? [...laid.lines, [], ...extra] : laid.lines;
      this.viewH = vh - 2;
      const maxTop = Math.max(0, lines.length - this.viewH);
      const top = Math.min(this.scrolls.get(f.id) ?? 0, maxTop);
      this.scrolls.set(f.id, top);
      const pick = this.picks.get(f.id);
      lines.slice(top, top + this.viewH).forEach((line, i) => {
        let cx = x + 2;
        for (const seg of line) {
          const picked = seg.at !== undefined && seg.at === pick && focused;
          cx = sc.put(cx, y + 1 + i, seg.t, this.c(seg.s | (picked ? REV : 0)), x + w - 2);
        }
      });
      this.regions.push({ x, y, w, h: vh, click: () => (this.area = "view"), wheel: (d) => this.scrolls.set(f.id, Math.max(0, Math.min(maxTop, top + d))) });
      for (const [i, t] of laid.targets.entries()) {
        const ly = t.line - top;
        if (ly < 0 || ly >= this.viewH) continue;
        this.regions.push({
          x: x + 2 + t.col,
          y: y + 1 + ly,
          w: t.w,
          h: 1,
          click: () => {
            this.picks.set(f.id, i);
            this.area = "view";
            this.act(f, t);
          },
        });
      }
      if (lines.length > this.viewH) {
        const bar = Math.floor((top / Math.max(1, maxTop)) * (this.viewH - 1));
        sc.put(x + w - 1, y + 1 + bar, "▐", this.c(fg("cyan")));
        if (top < maxTop) sc.put(x + w - 8, y + vh - 1, " more ", this.c(DIM));
      }
    }
    if (target) this.drawEditor(sc, x, y + vh, w, eh, target);
  }

  private drawEditor(sc: Screen, x: number, y: number, w: number, h: number, t: Shown) {
    const focused = this.area === "editor";
    const e = this.editor() as Editor;
    const hint = focused ? "Ctrl+S send · Ctrl+O attach · Esc leave" : "a to write";
    const placeholder = t.reply ?? (this.setup ? "Type here: a link, a token, a name…" : "Your answer…");
    this.box(sc, x, y, w, h, `✎ ${placeholder} · ${hint}`, focused, () => (this.area = "editor"));
    const iw = w - 4;
    const ih = h - 2;
    const { rows, cr, cc } = e.wrapped(iw);
    if (e.empty && !focused) {
      sc.put(x + 2, y + 1, clip(placeholder, iw), this.c(DIM | IT), x + w - 2);
      return;
    }
    const top = Math.max(0, cr - ih + 1);
    rows.slice(top, top + ih).forEach((r, i) => sc.put(x + 2, y + 1 + i, r, 0, x + w - 2));
    if (focused) {
      const yy = y + 1 + cr - top;
      const row = sc.row(yy);
      const cell = row[x + 2 + cc];
      if (cell) sc.mark(x + 2 + cc, yy, 1, REV);
    }
  }

  private barLines(w: number): { b: Button; key?: string; text: string }[][] {
    const bar = this.conv.bar();
    // the bar's own button rows; a list's rows keep their buttons in the main pane
    const items = (bar?.view ?? []).flatMap((b) => ("buttons" in b ? b.buttons : [])).map((b) => {
      const key = hotkey(b);
      return { b, key, text: `${key ? `${key} ` : ""}${b.label}` };
    });
    const out: { b: Button; key?: string; text: string }[][] = [[]];
    let lw = 1;
    for (const it of items) {
      const iw = width(it.text) + 4;
      if (lw + iw > w && out[out.length - 1].length) {
        out.push([]);
        lw = 1;
      }
      out[out.length - 1].push(it);
      lw += iw;
    }
    return out.length > 2 ? [out.flat()] : out;
  }

  private drawBar(sc: Screen, y: number, rows: { b: Button; key?: string; text: string }[][]) {
    const bar = this.conv.bar();
    rows.forEach((items, r) => {
      sc.fill(0, y + r, sc.w, 1, this.c(0));
      let x = 1;
      for (const it of items) {
        const enabled = it.b.data !== undefined || it.b.url !== undefined;
        const start = x;
        if (it.key) x = sc.put(x, y + r, ` ${it.key} `, this.c(enabled ? REV | B | fg("cyan") : DIM));
        x = sc.put(x, y + r, ` ${it.b.label}`, this.c(enabled ? (it.b.style === "primary" ? B : 0) : DIM));
        if (enabled && bar) this.regions.push({ x: start, y: y + r, w: x - start, h: 1, click: () => this.press(it.b, bar.id) });
        x += 1;
      }
    });
  }

  private drawStatus(sc: Screen, y: number) {
    const notices = this.conv.notices();
    const latest = notices[notices.length - 1];
    const right = notices.length ? ` ! ${notices.length} notice${notices.length === 1 ? "" : "s"}` : "";
    const rw = width(right);
    let left: string;
    let s: Style = DIM;
    if (this.status) {
      left = this.status.text;
      s = this.status.error ? B | fg("red") : B | fg("green");
    } else if (latest?.view && this.sys.now() - latest.at < 60_000) left = `🔔 ${plainOf(latest.view)}`;
    else left = this.area === "editor" ? "Writing: Ctrl+S sends, Esc leaves the editor." : "? shows every key.";
    sc.put(1, y, clip(left.replace(/\n/g, " "), Math.max(1, sc.w - rw - 3)), this.c(s), sc.w - rw - 1);
    if (right) {
      sc.put(sc.w - rw, y, right, this.c(B | fg("yellow")));
      this.regions.push({ x: sc.w - rw, y, w: rw, h: 1, click: () => (this.overlay = { kind: "notices", scroll: 0 }) });
    }
  }

  private drawOverlay(sc: Screen) {
    const o = this.overlay as Overlay;
    const w = Math.min(sc.w - 4, o.kind === "help" ? 76 : 90);
    const maxH = sc.h - 4;
    const x = Math.floor((sc.w - w) / 2);
    let lines: Line[] = [];
    let title = "";
    const iw = w - 4;
    if (o.kind === "help") {
      title = "Keys · Esc closes";
      const kw = Math.min(18, Math.floor(iw * 0.35));
      lines = HELP.flatMap(([k, d]) => {
        const laid = layout([{ html: `<p>${escape(d)}</p>` }], Math.max(10, iw - kw - 1));
        return laid.lines.map((l, i) => [{ t: pad(i ? "" : clip(k, kw), kw + 1), s: B | fg("cyan") }, ...l]);
      });
    } else if (o.kind === "notices") {
      title = "Notices · Esc closes";
      const ns = this.conv.notices().reverse();
      if (!ns.length) lines = [[{ t: "No notices.", s: DIM }]];
      for (const m of ns) {
        const when = new Date(m.at).toISOString().slice(5, 16).replace("T", " ");
        lines.push([{ t: when, s: DIM }]);
        lines.push(...layout((m.view as View).filter((b) => !("buttons" in b)), iw).lines, []);
      }
    } else if (o.kind === "seats") {
      title = "Workspaces · Enter switches";
      lines = this.seats.map((s, i) => [{ t: clip(`${i === o.sel ? "▸" : " "} ${s.name}${s.paused ? " (paused)" : ""} · ${s.person.role}`, iw), s: i === o.sel ? REV | B : 0 }]);
    } else if (o.kind === "prompt") {
      title = `${o.title} · Enter · Esc`;
      lines = [[{ t: clip(o.hint, iw), s: DIM }], [], [{ t: `› ${o.mask ? "•".repeat(o.value.text.length) : o.value.text}`, s: B }, { t: " ", s: REV }]];
    } else {
      title = "Attach a file · type to filter or a path · Enter · Esc";
      const shown = this.pickerEntries(o);
      lines = [[{ t: clip(o.dir, iw), s: B }], [{ t: `› ${o.filter}`, s: 0 }, { t: " ", s: REV }]];
      if (o.error) lines.push([{ t: clip(o.error, iw), s: fg("red") }]);
      lines.push([]);
      const room = maxH - 2 - lines.length;
      const start = Math.max(0, o.sel - room + 1);
      shown.slice(start, start + room).forEach((e, i) => lines.push([{ t: clip(`${e.dir ? "📁" : "  "} ${e.name}${e.dir ? "/" : ""}`, iw), s: start + i === o.sel ? REV | B : e.dir ? B : 0 }]));
    }
    const scroll = o.kind === "help" || o.kind === "notices" ? Math.min(o.scroll, Math.max(0, lines.length - (maxH - 2))) : 0;
    if (o.kind === "help" || o.kind === "notices") o.scroll = scroll;
    const h = Math.min(maxH, lines.length + 2);
    const y = Math.floor((sc.h - h) / 2);
    sc.fill(x, y, w, h);
    this.box(sc, x, y, w, h, title, true);
    lines.slice(scroll, scroll + h - 2).forEach((l, i) => {
      let cx = x + 2;
      for (const seg of l) cx = sc.put(cx, y + 1 + i, seg.t, this.c(seg.s), x + w - 2);
    });
    // a click outside closes it; inside it scrolls
    this.regions.push({ x: 0, y: 0, w: sc.w, h: sc.h, click: () => (this.overlay = undefined) });
    this.regions.push({ x, y, w, h, click: () => {}, wheel: (d) => (o.kind === "help" || o.kind === "notices") && (o.scroll = Math.max(0, o.scroll + d)) });
  }

  private drawSignin(sc: Screen) {
    const s = this.signin as NonNullable<App["signin"]>;
    const w = Math.min(sc.w - 4, 76);
    const x = Math.floor((sc.w - w) / 2);
    const iw = w - 4;
    const text =
      s.mode === "wait"
        ? `<p><b>🔑 Waiting for your key to be added</b></p><p>Give this digest to whoever runs your Flowee (an admin adds it under the workspace's people, or a manager with <i>Add a person</i>):</p><pre>${s.digest ?? ""}</pre><p>This screen signs you in by itself once it is added. p pastes a key you were given instead; q quits.</p>`
        : `<p><b>🔑 Sign in to Flowee</b></p><p>Paste the key you were given, then press Enter. It is saved in your config directory, readable by you only, and never shown.</p><p>No key yet? Ctrl+N makes one here and shows its digest for your admin.</p>`;
    const laid = layout([{ html: text }], iw);
    const lines: Line[] = [...laid.lines];
    if (s.mode === "paste") lines.push([], [{ t: `› ${"•".repeat(Math.min(iw - 3, s.editor.text.length))}`, s: B }, { t: " ", s: REV }]);
    if (s.note) lines.push([], [{ t: clip(s.note, iw), s: fg("yellow") }]);
    const h = Math.min(sc.h - 2, lines.length + 2);
    const y = Math.max(0, Math.floor((sc.h - h) / 2));
    this.box(sc, x, y, w, h, "Flowee", true);
    lines.slice(0, h - 2).forEach((l, i) => {
      let cx = x + 2;
      for (const seg of l) cx = sc.put(cx, y + 1 + i, seg.t, this.c(seg.s), x + w - 2);
    });
  }
}

const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** A card's ticket (`#12`, `app#12`): the first link's text of its view; else the message id. */
function ticketOf(m?: Shown): string {
  if (!m) return "";
  for (const b of m.view ?? []) if ("html" in b) {
    const t = /<a [^>]*>([^<]+)<\/a>/.exec(b.html)?.[1];
    if (t) return t;
  }
  return `m${m.id}`;
}

const KINDS: Record<string, string> = { Question: "❓", Test: "🧪", Decision: "⚖️", Sample: "📎", Review: "👀", Postponed: "💤" };

export { UL };

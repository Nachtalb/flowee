// The client's copy of one workspace's conversation (docs/tui-protocol.md): the events applied in order, and what
// the screen makes of them: the card being worked on, the bar, the inbox pane, the notices, the files to save.
import type { Button, Command, View } from "../src/ports/chat";
import type { TuiMessage, TuiSync } from "../src/ports/tui";

/** Buttons of the envoy's bar (render.ts: nav, newBar, the lists' paging): they make a message the bar. */
const NAV = /^(t|p|k|s|n|b|f|F|X|[LSP]:\d+)$/;

export type Shown = TuiMessage & { touched: number };

export function buttons(v: View | undefined): Button[] {
  const out: Button[] = [];
  for (const b of v ?? []) {
    if ("buttons" in b) out.push(...b.buttons);
    else if ("table" in b) for (const r of b.table.rows) out.push(...(r.buttons ?? []));
  }
  return out;
}

const hasTable = (v?: View) => !!v?.some((b) => "table" in b && b.table.rows.some((r) => r.buttons?.length));
const navOnly = (v?: View) => buttons(v).length > 0 && buttons(v).every((b) => !b.data || NAV.test(b.data));
const okOnly = (v?: View) => {
  const b = buttons(v);
  return b.length === 1 && b[0].data === "k";
};

export class Conversation {
  seq = 0;
  private msgs = new Map<number, Shown>();
  private clock = 0;
  menu: Command[] = [];
  panel?: View;
  /** Files the server handed over (secrets, exports), oldest first; the client saves and drops them. */
  files: TuiMessage[] = [];
  private savedFiles = new Set<number>();

  /** Applies an answer of `sync`; returns the toasts meant for `me`. */
  apply(s: TuiSync, me?: string): string[] {
    const toasts: string[] = [];
    if (s.reset) {
      this.msgs.clear();
      for (const m of s.reset.messages) this.put(m);
      this.menu = s.reset.menu;
      this.panel = s.reset.panel;
    }
    for (const e of s.events) {
      if (e.seq <= this.seq) continue;
      if (e.op === "put") this.put(e.msg);
      else if (e.op === "del") this.msgs.delete(e.id);
      else if (e.op === "toast" && (!e.to || !me || e.to === me)) toasts.push(e.text);
      else if (e.op === "menu") this.menu = e.commands;
      else if (e.op === "panel") this.panel = e.view;
      this.seq = e.seq;
    }
    this.seq = Math.max(this.seq, s.seq);
    return toasts;
  }

  private put(m: TuiMessage) {
    this.msgs.set(m.id, { ...m, touched: ++this.clock });
    if (m.file && !this.savedFiles.has(m.id)) {
      this.savedFiles.add(m.id);
      this.files.push(m);
    }
  }

  get messages(): Shown[] {
    return [...this.msgs.values()].sort((a, b) => a.at - b.at || a.touched - b.touched);
  }

  get(id: number) {
    return this.msgs.get(id);
  }

  buttons(m: TuiMessage) {
    return buttons(m.view);
  }

  /** The envoy's bar: the newest message holding its navigation buttons. */
  bar(): Shown | undefined {
    return this.newest((m) => !m.reply && !okOnly(m.view) && buttons(m.view).some((b) => !!b.data && NAV.test(b.data)) && !buttons(m.view).some((b) => b.data?.startsWith("w:")));
  }

  /**
   * What the main pane shows: the most recently changed message that asks for something: the card being answered
   * (it takes typing), a list or search results in the bar, a wizard or menu screen. Notes and notices never take it.
   */
  focus(): Shown | undefined {
    return this.newest((m) => !!m.view && (!!m.reply || hasTable(m.view) || (buttons(m.view).length > 0 && !navOnly(m.view) && !okOnly(m.view))));
  }

  /** The message typing answers: the focus when it takes a reply. */
  replyTarget(): Shown | undefined {
    const f = this.focus();
    return f?.reply ? f : undefined;
  }

  /** Notices: what the bot said that asks for nothing (digest, filing notes, sync state) and new-item notes. */
  notices(): Shown[] {
    const bar = this.bar();
    const focus = this.focus();
    return this.messages.filter((m) => m.view && m !== bar && m !== focus && !m.reply && (okOnly(m.view) || buttons(m.view).length === 0 || navOnly(m.view)));
  }

  /** What people typed, newest last. */
  said(): Shown[] {
    return this.messages.filter((m) => m.said !== undefined);
  }

  private newest(ok: (m: Shown) => boolean) {
    let best: Shown | undefined;
    for (const m of this.msgs.values()) if (ok(m) && (!best || m.touched > best.touched)) best = m;
    return best;
  }
}

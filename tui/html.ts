// A view (the Chat port's blocks, docs/tui-protocol.md "Views") laid out for a terminal of a given width: styled
// lines, and the targets a key or a click can reach (buttons, links, folds), each at its line and column. Rules
// in docs/chat-style.md, "In a terminal": a choice's button stays in its row, nothing is cut off, every button is
// reachable.
import type { Block, Button, View } from "../src/ports/chat";
import { B, clip, DIM, fg, graphemes, gWidth, IT, REV, type Style, UL, width } from "./screen";

export interface Seg {
  t: string;
  s: Style;
  /** The target this text belongs to (its index in `targets`). */
  at?: number;
}
export type Line = Seg[];

export type Target =
  | { kind: "button"; button: Button; line: number; col: number; w: number }
  | { kind: "link"; href: string; line: number; col: number; w: number }
  | { kind: "fold"; fold: string; open: boolean; line: number; col: number; w: number };

export interface Laid {
  lines: Line[];
  targets: Target[];
}

export interface LayoutOptions {
  /** Folds the person opened or closed (key: block index and position), overriding the view's own `open`. */
  folds?: Map<string, boolean>;
  color?: boolean;
}

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };
const decode = (s: string) => s.replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) => ENT[e]);

// ---- the HTML subset as a tree ----

interface Node {
  tag: string;
  attrs: Record<string, string>;
  kids: (Node | string)[];
}

function parse(html: string): Node {
  const root: Node = { tag: "root", attrs: {}, kids: [] };
  const stack = [root];
  const re = /<(\/?)([a-zA-Z][\w-]*)([^>]*)>|([^<]+)|(<)/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    const top = stack[stack.length - 1];
    if (m[4] !== undefined || m[5] !== undefined) top.kids.push(decode(m[4] ?? m[5]));
    else if (m[1]) {
      const i = stack.map((n) => n.tag).lastIndexOf(m[2].toLowerCase());
      if (i > 0) stack.length = i;
    } else {
      const attrs: Record<string, string> = {};
      for (const a of m[3].matchAll(/([\w-]+)(?:="([^"]*)")?/g)) attrs[a[1]] = decode(a[2] ?? "");
      const n: Node = { tag: m[2].toLowerCase(), attrs, kids: [] };
      top.kids.push(n);
      if (!["br", "img", "hr"].includes(n.tag)) stack.push(n);
    }
  }
  return root;
}

const INLINE = new Set(["b", "strong", "i", "em", "a", "code", "u", "s", "span", "tg-spoiler", "br"]);

type Run = { t: string; s: Style; href?: string };

function runs(n: Node | string, s: Style, out: Run[], href?: string) {
  if (typeof n === "string") return void out.push({ t: n.replace(/\s+/g, " "), s, href });
  let st = s;
  let h = href;
  if (n.tag === "b" || n.tag === "strong") st |= B;
  if (n.tag === "i" || n.tag === "em") st |= IT;
  if (n.tag === "u") st |= UL;
  if (n.tag === "code") st |= fg("magenta");
  if (n.tag === "a") {
    st |= UL | fg("blue");
    h = n.attrs.href;
  }
  if (n.tag === "br") return void out.push({ t: "\n", s });
  for (const k of n.kids) runs(k, st, out, h);
}

// ---- wrapping ----

type TargetInit = Target extends infer T ? (T extends unknown ? Omit<T, "line" | "col" | "w"> : never) : never;

class Out {
  lines: Line[] = [];
  targets: Target[] = [];
  /** Cells every line is moved in (the inside of an open fold). */
  ind = 0;
  constructor(readonly w: number) {}
  push(line: Line) {
    this.lines.push(this.ind ? [{ t: " ".repeat(this.ind), s: 0 }, ...line] : line);
  }
  blank() {
    if (this.lines.length && this.lines[this.lines.length - 1].length) this.lines.push([]);
  }
  target(t: TargetInit, line: number, col: number, w: number) {
    this.targets.push({ ...t, line, col: col + this.ind, w } as Target);
    return this.targets.length - 1;
  }
}

const lineWidth = (l: Line) => l.reduce((a, x) => a + width(x.t), 0);

/** Inline runs wrapped at word boundaries into lines of `w` cells, `indent` cells in from the second line on. */
function wrap(o: Out, rs: Run[], w: number, prefix: Seg[] = [], indent = 0) {
  const words: { t: string; s: Style; href?: string; space: boolean }[] = [];
  for (const r of rs) {
    if (r.t === "\n") {
      words.push({ t: "\n", s: r.s, space: false });
      continue;
    }
    const parts = r.t.split(/( )/);
    for (const p of parts) {
      if (p === "") continue;
      if (p === " ") {
        if (words.length) words[words.length - 1].space = true;
        continue;
      }
      words.push({ t: p, s: r.s, href: r.href, space: false });
    }
  }
  let line: Line = [...prefix];
  let col = lineWidth(line);
  const links = new Map<string, number>();
  const flush = () => {
    o.push(line);
    line = indent ? [{ t: " ".repeat(indent), s: 0 }] : [];
    col = indent;
  };
  for (let i = 0; i < words.length; i++) {
    const wd = words[i];
    if (wd.t === "\n") {
      flush();
      continue;
    }
    let ww = width(wd.t);
    if (col + ww > w && col > indent) flush();
    // a word longer than the line is broken
    let text = wd.t;
    while (ww > w - col && w - col > 0) {
      let head = "";
      let hw = 0;
      for (const g of graphemes(text)) {
        if (hw + gWidth(g) > w - col) break;
        head += g;
        hw += gWidth(g);
      }
      if (!head) break;
      seg(head);
      text = text.slice(head.length);
      ww = width(text);
      flush();
    }
    seg(text);
    if (wd.space && i + 1 < words.length && words[i + 1].t !== "\n") {
      if (col + 1 <= w) {
        line.push({ t: " ", s: wd.href && words[i + 1].href === wd.href ? wd.s : wd.s & ~UL });
        col += 1;
      }
    }
    function seg(t: string) {
      if (!t) return;
      const s: Seg = { t, s: wd.s };
      if (wd.href) {
        const key = `${o.lines.length}:${wd.href}`;
        let at = links.get(key);
        if (at === undefined || (o.targets[at] as { line: number }).line !== o.lines.length) {
          at = o.target({ kind: "link", href: wd.href }, o.lines.length, col, 0);
          links.set(key, at);
        }
        (o.targets[at] as { w: number }).w = col + o.ind + width(t) - (o.targets[at] as { col: number }).col;
        s.at = at;
      }
      line.push(s);
      col += width(t);
    }
  }
  if (line.length > (indent ? 1 : 0) || !o.lines.length || prefix.length) o.push(line);
}

// ---- blocks ----

function flow(o: Out, n: Node, w: number, key: string, opt: LayoutOptions, depth = 0) {
  let inline: Run[] = [];
  const end = () => {
    if (inline.some((r) => r.t.trim())) wrap(o, trimRuns(inline), w);
    inline = [];
  };
  n.kids.forEach((k, i) => {
    const kk = `${key}.${i}`;
    if (typeof k === "string" || INLINE.has(k.tag)) return void runs(k, 0, inline);
    end();
    if (k.tag === "p" || k.tag === "summary" || k.tag === "div") {
      const rs: Run[] = [];
      for (const c of k.kids) runs(c, 0, rs);
      if (rs.some((r) => r.t.trim())) wrap(o, trimRuns(rs), w);
    } else if (k.tag === "pre") {
      const lang = (k.kids.find((c) => typeof c !== "string" && c.tag === "code") as Node | undefined)?.attrs.class?.replace(/^language-/, "");
      const text = textOf(k);
      if (lang) o.push([{ t: clip(` ${lang}`, w), s: DIM }]);
      for (const raw of text.replace(/\n$/, "").split("\n")) {
        // code keeps its lines: wrapped at the edge with a mark, never reflowed
        let rest = raw.replace(/\t/g, "  ");
        do {
          let head = "";
          let hw = 0;
          for (const g of graphemes(rest)) {
            if (hw + gWidth(g) > w - 2) break;
            head += g;
            hw += gWidth(g);
          }
          rest = rest.slice(head.length);
          o.push([{ t: "│ ", s: DIM }, { t: head, s: fg("cyan") }]);
        } while (rest.length);
      }
    } else if (k.tag === "ul" || k.tag === "ol") {
      let nth = 0;
      for (const li of k.kids) {
        if (typeof li === "string" || li.tag !== "li") continue;
        nth++;
        const mark = k.tag === "ol" ? `${nth}. ` : "• ";
        const rs: Run[] = [];
        const sub: Node[] = [];
        for (const c of li.kids) typeof c !== "string" && (c.tag === "ul" || c.tag === "ol") ? sub.push(c) : runs(c, 0, rs);
        const ind = "  ".repeat(depth);
        wrap(o, trimRuns(rs), w, [{ t: ind + mark, s: DIM }], width(ind + mark));
        for (const s of sub) flow(o, { tag: "root", attrs: {}, kids: [s] }, w, kk, opt, depth + 1);
      }
    } else if (k.tag === "details") {
      const open = opt.folds?.get(kk) ?? "open" in k.attrs;
      const sum = k.kids.find((c) => typeof c !== "string" && c.tag === "summary") as Node | undefined;
      const label = `${open ? "▾" : "▸"} ${sum ? textOf(sum).trim() : "Details"}`;
      const at = o.target({ kind: "fold", fold: kk, open }, o.lines.length, 0, width(label));
      o.push([{ t: label, s: B | fg("cyan"), at }]);
      if (open) {
        o.ind += 2;
        flow(o, { tag: "root", attrs: {}, kids: k.kids.filter((c) => c !== sum) }, w - 2, kk, opt, depth);
        o.ind -= 2;
      }
    } else flow(o, k, w, kk, opt, depth);
  });
  end();
}

const textOf = (n: Node | string): string => (typeof n === "string" ? n : n.kids.map(textOf).join(""));

function trimRuns(rs: Run[]): Run[] {
  const out = rs.map((r) => ({ ...r }));
  while (out.length && !out[0].t.trim() && out[0].t !== "\n") out.shift();
  if (out.length) out[0].t = out[0].t.replace(/^ +/, "");
  while (out.length && !out[out.length - 1].t.trim()) out.pop();
  if (out.length) out[out.length - 1].t = out[out.length - 1].t.replace(/ +$/, "");
  return out;
}

/** A button as it is drawn: `[ label ]`; primary bold; without an action dim. */
export const buttonText = (b: Button) => `[ ${b.label}${b.url ? " ↗" : b.copy !== undefined ? " ⧉" : ""} ]`;
const buttonStyle = (b: Button): Style => (b.data === undefined && b.url === undefined && b.copy === undefined ? DIM : b.style === "primary" ? B | fg("green") : B);

function buttonRow(o: Out, bs: Button[], w: number, center: boolean) {
  // as many per line as fit, centred; a label wider than the line still shows whole on a line of its own
  let line: Button[] = [];
  let lw = 0;
  const flush = () => {
    if (!line.length) return;
    const left = center ? Math.max(0, Math.floor((w - lw) / 2)) : 0;
    const segs: Line = left ? [{ t: " ".repeat(left), s: 0 }] : [];
    let col = left;
    for (const [i, b] of line.entries()) {
      if (i) {
        segs.push({ t: " ", s: 0 });
        col++;
      }
      const t = buttonText(b);
      const at = b.data !== undefined || b.url !== undefined || b.copy !== undefined ? o.target({ kind: "button", button: b }, o.lines.length, col, width(t)) : undefined;
      segs.push({ t, s: buttonStyle(b), ...(at !== undefined ? { at } : {}) });
      col += width(t);
    }
    o.push(segs);
    line = [];
    lw = 0;
  };
  for (const b of bs) {
    const bw = width(buttonText(b));
    if (line.length && lw + 1 + bw > w) flush();
    lw += (line.length ? 1 : 0) + bw;
    line.push(b);
  }
  flush();
}

function table(o: Out, t: NonNullable<Extract<Block, { table: unknown }>["table"]>, w: number, opt: LayoutOptions) {
  const cellRuns = (html: string) => {
    const rs: Run[] = [];
    runs(parse(html), 0, rs);
    return trimRuns(rs);
  };
  const rows = t.rows.map((r) => ({ cells: r.cells.map(cellRuns), buttons: r.buttons ?? [] }));
  const cols = Math.max(t.head?.filter(Boolean).length ?? 0, ...rows.map((r) => r.cells.length));
  const btnW = Math.max(0, ...rows.map((r) => r.buttons.reduce((a, b, i) => a + width(buttonText(b)) + (i ? 1 : 0), 0)));
  const natural = Array.from({ length: cols }, (_, c) =>
    Math.max(width(t.head?.[c] ?? ""), ...rows.map((r) => (r.cells[c] ? width(r.cells[c].map((x) => x.t).join("")) : 0))),
  );
  const gaps = cols - 1 + (btnW ? 1 : 0);
  const fits = natural.reduce((a, b) => a + b, 0) + gaps * 2 + btnW <= w;
  if (cols > 1 && (fits || w >= 60)) {
    // a grid: the last text column takes what is left, the others their natural width (capped)
    const avail = w - btnW - gaps * 2;
    const widths = natural.map((n) => Math.min(n, Math.max(6, Math.floor(avail / cols))));
    const used = widths.reduce((a, b) => a + b, 0);
    widths[cols - 1] = Math.max(4, Math.min(natural[cols - 1], widths[cols - 1] + avail - used));
    const textW = widths.reduce((a, b) => a + b, 0) + (cols - 1) * 2;
    if (t.head?.some(Boolean)) {
      const segs: Line = [];
      t.head.slice(0, cols).forEach((h, c) => segs.push({ t: (c ? "  " : "") + clip(decode(h.replace(/<[^>]+>/g, "")), widths[c]).padEnd(widths[c]), s: B | DIM }));
      o.push(segs);
    }
    for (const r of rows) {
      const line: Line = [];
      r.cells.slice(0, cols).forEach((cell, c) => {
        if (c) line.push({ t: "  ", s: 0 });
        const text = cell.map((x) => x.t).join("");
        const shown = clip(text, widths[c]);
        // the first run's style for the cell (cells are short facts)
        line.push({ t: shown + " ".repeat(Math.max(0, widths[c] - width(shown))), s: cell[0]?.s ?? 0 });
      });
      for (let c = r.cells.length; c < cols; c++) line.push({ t: " ".repeat(widths[c] + 2), s: 0 });
      let col = textW;
      if (r.buttons.length) {
        line.push({ t: "  ", s: 0 });
        col += 2;
        for (const [i, b] of r.buttons.entries()) {
          if (i) {
            line.push({ t: " ", s: 0 });
            col++;
          }
          const bt = buttonText(b);
          const at = o.target({ kind: "button", button: b }, o.lines.length, col, width(bt));
          line.push({ t: bt, s: buttonStyle(b), at });
          col += width(bt);
        }
      }
      o.push(line);
    }
    return;
  }
  // narrow, or one column (choices, toggles, facts): each row its text wrapped, its buttons right after it
  for (const r of rows) {
    const rs: Run[] = [];
    r.cells.forEach((c, i) => {
      if (i) rs.push({ t: " · ", s: DIM });
      rs.push(...c);
    });
    const bw = r.buttons.reduce((a, b, i) => a + width(buttonText(b)) + (i ? 1 : 0), 0);
    const before = o.lines.length;
    if (rs.length) wrap(o, rs, w);
    if (!r.buttons.length) continue;
    const last = o.lines[o.lines.length - 1];
    if (o.lines.length > before && lineWidth(last) + 2 + bw <= w) {
      // the buttons close the row's last line, right-aligned
      let col = lineWidth(last);
      const gap = w - col - bw;
      last.push({ t: " ".repeat(gap), s: 0 });
      col += gap;
      for (const [i, b] of r.buttons.entries()) {
        if (i) {
          last.push({ t: " ", s: 0 });
          col++;
        }
        const bt = buttonText(b);
        const at = o.target({ kind: "button", button: b }, o.lines.length - 1, col, width(bt));
        last.push({ t: bt, s: buttonStyle(b), at });
        col += width(bt);
      }
    } else buttonRow(o, r.buttons, w, false);
  }
  void opt;
}

/** The view laid out `w` cells wide. */
export function layout(view: View, w: number, opt: LayoutOptions = {}): Laid {
  const o = new Out(w);
  view.forEach((b, i) => {
    if ("html" in b) flow(o, parse(b.html), w, `b${i}`, opt);
    else if ("buttons" in b) {
      o.blank();
      buttonRow(o, b.buttons, w, true);
    } else {
      o.blank();
      table(o, b.table, w, opt);
      o.blank();
    }
  });
  while (o.lines.length && !o.lines[o.lines.length - 1].length) o.lines.pop();
  return { lines: o.lines, targets: o.targets };
}

/** The view's text without markup, for one-line summaries (notices, the status line). */
export function plainOf(view: View): string {
  return view
    .map((b) => ("html" in b ? textOf(parse(b.html.replace(/<\/(p|li|summary|pre)>/g, "$& "))) : "table" in b ? b.table.rows.map((r) => r.cells.map((c) => textOf(parse(c))).join(" · ")).join(" · ") : ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

export { REV };

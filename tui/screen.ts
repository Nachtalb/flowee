// The terminal's cell grid: the client paints every frame into a Screen, then writes only the rows that changed.
// Tests paint into the same grid without a terminal (a headless screen buffer) and read it back as text.

/** Style bits; the colour is one of the terminal's own eight (it follows a light or a dark theme). */
export const B = 1, DIM = 2, IT = 4, UL = 8, REV = 16;
export const FG = { none: 0, red: 1, green: 2, yellow: 3, blue: 4, magenta: 5, cyan: 6 } as const;
export const fg = (c: keyof typeof FG) => FG[c] << 8;
export type Style = number;

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

const ZERO: [number, number][] = [
  [0x300, 0x36f], [0x483, 0x489], [0x591, 0x5bd], [0x610, 0x61a], [0x64b, 0x65f], [0x1ab0, 0x1aff], [0x1dc0, 0x1dff],
  [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x2064], [0x20d0, 0x20ff], [0xfe00, 0xfe0f], [0xfe20, 0xfe2f], [0xe0000, 0xe01ef],
];
const WIDE: [number, number][] = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3], [0x25fd, 0x25fe],
  [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1], [0x26aa, 0x26ab], [0x26bd, 0x26be],
  [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa],
  [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b], [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755],
  [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
  [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f251], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f7e0, 0x1f7eb],
  [0x1f90c, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x3fffd],
];
const inRanges = (cp: number, r: [number, number][]) => {
  let lo = 0;
  let hi = r.length - 1;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (cp < r[m][0]) hi = m - 1;
    else if (cp > r[m][1]) lo = m + 1;
    else return true;
  }
  return false;
};

/** Cells one code point takes: 0 (control, combining), 1, or 2 (East Asian wide, emoji). */
export function cpWidth(cp: number): number {
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (cp < 0x300) return 1;
  if (inRanges(cp, ZERO)) return 0;
  return inRanges(cp, WIDE) ? 2 : 1;
}

/** One grapheme's cells: a base with VS16 (emoji presentation) or an emoji sequence is two. */
export function gWidth(g: string): number {
  const cps = [...g].map((c) => c.codePointAt(0) ?? 0);
  const base = cpWidth(cps[0] ?? 0);
  if (base === 1 && cps.includes(0xfe0f)) return 2;
  return base;
}

export const graphemes = (s: string) => [...segmenter.segment(s)].map((x) => x.segment);

export function width(s: string): number {
  let w = 0;
  for (const g of graphemes(s)) w += gWidth(g);
  return w;
}

/** `s` cut to `max` cells, with `…` when cut. */
export function clip(s: string, max: number): string {
  if (width(s) <= max) return s;
  let out = "";
  let w = 0;
  for (const g of graphemes(s)) {
    const gw = gWidth(g);
    if (w + gw > max - 1) break;
    out += g;
    w += gw;
  }
  return `${out}…`;
}

export const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - width(s)));

interface Cell {
  g: string;
  s: Style;
}

export class Screen {
  cells: Cell[];
  /** Cells a paint wanted beyond its limit (a test asserts none). */
  overflow = 0;
  constructor(
    readonly w: number,
    readonly h: number,
  ) {
    this.cells = Array.from({ length: w * h }, () => ({ g: " ", s: 0 }));
  }

  /** Writes `text` at (x, y) up to column `max` (exclusive); returns the column after it. */
  put(x: number, y: number, text: string, s: Style = 0, max = this.w): number {
    if (y < 0 || y >= this.h) return x;
    const end = Math.min(max, this.w);
    for (const g of graphemes(text)) {
      if (g === "\n") continue;
      const gw = gWidth(g);
      if (gw === 0) continue;
      if (x + gw > end) {
        this.overflow += gw;
        if (x < end) this.cells[y * this.w + x] = { g: " ", s };
        return end;
      }
      if (x >= 0) {
        this.cells[y * this.w + x] = { g, s };
        if (gw === 2) this.cells[y * this.w + x + 1] = { g: "", s };
      }
      x += gw;
    }
    return x;
  }

  fill(x: number, y: number, w: number, h: number, s: Style = 0, g = " ") {
    for (let r = Math.max(0, y); r < Math.min(this.h, y + h); r++) for (let c = Math.max(0, x); c < Math.min(this.w, x + w); c++) this.cells[r * this.w + c] = { g, s };
  }

  /** Adds style bits to cells already painted (a focus mark over a row). */
  mark(x: number, y: number, w: number, s: Style) {
    if (y < 0 || y >= this.h) return;
    for (let c = Math.max(0, x); c < Math.min(this.w, x + w); c++) this.cells[y * this.w + c].s |= s;
  }

  row(y: number) {
    return this.cells.slice(y * this.w, (y + 1) * this.w);
  }

  /** The grid as text, one line per row, trailing blanks dropped. */
  text(): string {
    const out: string[] = [];
    for (let y = 0; y < this.h; y++) out.push(this.row(y).map((c) => c.g).join("").trimEnd());
    return out.join("\n");
  }

  /** The escape sequences that turn `prev` (or a blank terminal) into this grid; `color` false: no colours. */
  ansi(prev: Screen | undefined, color: boolean): string {
    let out = "";
    for (let y = 0; y < this.h; y++) {
      const row = this.row(y);
      if (prev && prev.w === this.w && prev.h === this.h && prev.row(y).every((c, i) => c.g === row[i].g && c.s === row[i].s)) continue;
      out += `\x1b[${y + 1};1H`;
      let cur = -1;
      for (const c of row) {
        if (c.g === "") continue;
        if (c.s !== cur) {
          out += sgr(c.s, color);
          cur = c.s;
        }
        out += c.g;
      }
      out += "\x1b[0m";
    }
    return out;
  }
}

function sgr(s: Style, color: boolean): string {
  const p = ["0"];
  if (s & B) p.push("1");
  if (s & DIM) p.push("2");
  if (s & IT) p.push("3");
  if (s & UL) p.push("4");
  if (s & REV) p.push("7");
  const c = (s >> 8) & 15;
  if (color && c) p.push(String(30 + c));
  return `\x1b[${p.join(";")}m`;
}

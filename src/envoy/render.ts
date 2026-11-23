// Message views and the pure parts of navigation and search (docs/envoy.md): chat-agnostic views (rich HTML blocks, button rows, tables) for cards, the bar and the lists, and
// HTML text for plain messages.
import type { Card } from "../core/card";
import type { Block, Button, TableRow, View } from "../ports/chat";

export type Content = Card | { kind: "excerpt"; text: string } | { kind: "none" };
export type Status = "open" | "answered" | "gone";
export interface Item {
  n: number;
  /** `#12`, or `app#12` with several repositories (default `#n`). */
  label?: string;
  cid: number;
  title: string;
  url: string;
  content: Content;
  since: number;
  status: Status;
  postponed?: boolean;
}

// the ticket's number in its repository (ids of further repositories carry their slot above 10⁹)
const local = (it: Item) => it.n % 1_000_000_000;

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const len = (s: string) => [...s].length;

/** Markdown-ish text as rich blocks, never quoted: fences `<pre>`, `- ` runs a list, `x` `<code>`. */
export function md(s: string): string {
  let out = "";
  let rest = s;
  for (let start = rest.indexOf("```"); start >= 0; start = rest.indexOf("```")) {
    const after = rest.slice(start + 3);
    const end = after.indexOf("```");
    if (end < 0) break;
    out += lines(rest.slice(0, start));
    const body = after.slice(0, end);
    const nl = body.indexOf("\n");
    let lang: string | undefined;
    let code = body;
    if (nl >= 0) {
      const l = body.slice(0, nl).trim();
      if (l && !/\s/.test(l)) [lang, code] = [l, body.slice(nl + 1)];
      else if (body.slice(0, nl) === "") code = body.slice(nl + 1);
    }
    if (code.endsWith("\n")) code = code.slice(0, -1);
    out += lang ? `<pre><code class="language-${esc(lang)}">${esc(code)}</code></pre>` : `<pre>${esc(code)}</pre>`;
    rest = after.slice(end + 3);
  }
  return out + lines(rest);
}

function lines(s: string): string {
  let out = "";
  let list = false;
  for (const l of s.split("\n").map((x) => x.trim()).filter(Boolean)) {
    const item = l.startsWith("- ") || l.startsWith("* ") ? l.slice(2) : undefined;
    if (item !== undefined && !list) out += "<ul>";
    if (item === undefined && list) out += "</ul>";
    list = item !== undefined;
    const h = /^#{1,6}\s+(.*)$/.exec(l);
    out += item !== undefined ? `<li>${inline(item)}</li>` : h ? `<p><b>${inline(h[1])}</b></p>` : `<p>${inline(l)}</p>`;
  }
  return list ? `${out}</ul>` : out;
}

function inline(s: string): string {
  let out = "";
  let rest = s;
  for (let a = rest.indexOf("`"); a >= 0; a = rest.indexOf("`")) {
    const after = rest.slice(a + 1);
    const b = after.indexOf("`");
    if (b > 0) {
      out += `${plain(rest.slice(0, a))}<code>${esc(after.slice(0, b))}</code>`;
      rest = after.slice(b + 1);
    } else {
      out += plain(rest.slice(0, a + 1));
      rest = after;
    }
  }
  return out + plain(rest);
}

/** Text outside code spans: `**bold**` and `[text](https://…)`. */
function plain(s: string): string {
  return esc(s)
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2">$1</a>');
}

export function kind(it: Item): [string, string] {
  if (it.postponed) return ["💤", "Postponed"];
  switch (it.content.kind) {
    case "test":
      return ["🧪", "Test"];
    case "question":
      return ["❓", "Question"];
    case "decision":
      return ["⚖️", "Decision"];
    case "sample":
      return ["📎", "Sample"];
    default:
      return ["👀", "Review"];
  }
}

/** "12 min", "5 h", "3 d". */
export function waited(since: number, now: number): string {
  const mins = Math.max(0, Math.floor((now - since) / 60e3));
  if (mins < 60) return `${mins} min`;
  if (mins < 2880) return `${Math.floor(mins / 60)} h`;
  return `${Math.floor(mins / 1440)} d`;
}

export const itemUrl = (it: Item) => (it.cid > 0 ? `${it.url}#issuecomment-${it.cid}` : it.url);
const label = (it: Item) => it.label ?? `#${it.n}`;
const link = (it: Item) => `<a href="${esc(itemUrl(it))}">${label(it)}</a>`;

export function cut(s: string, max: number): string {
  const c = [...s];
  return c.length <= max ? s : `${c.slice(0, max - 1).join("").trimEnd()}…`;
}

// ---- the building blocks of every screen: envoy, wizard and menu (docs/chat-style.md) ----

/** A button pressed back to the bot. */
export const btn = (label: string, data: string, style?: "primary"): Button => ({ label, data, ...(style ? { style } : {}) });
/** A button that opens a link. */
export const linkBtn = (label: string, url: string): Button => ({ label, url });
/** A button that copies a text. */
export const copyBtn = (label: string, copy: string): Button => ({ label, copy });
/** A centred row of buttons. */
export const row = (...buttons: Button[]): Block => ({ buttons });
/** The first line of every message: an emoji, the bold name, then facts after ` · ` (a card: kind · #n · age). */
export const headline = (emoji: string, name: string, ...facts: string[]) => `<p>${emoji} <b>${name}</b>${facts.map((f) => ` · ${f}`).join("")}</p>`;
export const heading = (emoji: string, name: string, ...facts: string[]): Block => ({ html: headline(emoji, name, ...facts) });
/** The second line: what the screen asks or shows, bold (a card's title). */
export const question = (html: string): Block => ({ html: `<p><b>${html}</b></p>` });
export const text = (html: string): Block => ({ html: `<p>${html}</p>` });
/** Lines of HTML as paragraphs: a notice of the envoy. */
export const paragraphs = (html: string): Block[] =>
  html
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => ({ html: `<p>${l}</p>` }));
/** One choice or toggle: its name and one-line description in one cell, its own buttons in the same row. */
export const option = (name: string, description: string, ...buttons: Button[]): TableRow => ({ cells: [`<b>${name}</b> · ${description}`], buttons });
/** Choices as a single-column table, a button per row (docs/chat-style.md: never a list, never buttons apart). */
export const options = (...rows: TableRow[]): Block => ({ table: { rows } });
/** What something is, as a two-column table (a summary), or lines as a one-column table; a row may carry its button. */
export const facts = (rows: (string[] | TableRow)[]): Block => ({ table: { rows: rows.map((r) => (Array.isArray(r) ? { cells: r } : r)) } });
/** Help that most readers skip, folded like a card's details. */
export const details = (summary: string, html: string): Block => ({ html: `<details><summary>${summary}</summary>${html}</details>` });
/** One sentence under the prompt saying what was wrong with the last answer. */
export const warning = (sentence: string): Block => ({ html: `<p>⚠️ ${esc(sentence)}</p>` });

/** A card: kind, link and age, the title, the hand-over folded (`open` for the card being worked on). */
export function card(it: Item, answered: number | null, open: boolean, now: number): string {
  const [e, k] = kind(it);
  let s = headline(e, k, link(it), answered !== null ? `✓ answered ${waited(answered, now)} ago` : `⏳ ${waited(it.since, now)}`);
  s += `<p><b>${esc(it.title)}</b></p>`;
  const c = it.content;
  let body: string;
  if (c.kind === "none") return `${s}<p><i>Older ticket without a hand-over note: open the issue for the details.</i></p>`;
  if (c.kind === "excerpt") body = md(c.text);
  else {
    body = "";
    if (c.changed) body += `<p><b>Changed:</b></p>${md(c.changed)}`;
    const names = (c.samples ?? "")
      .split(",")
      .map((x) => x.trim().replace(/^`+|`+$/g, ""))
      .filter((x) => x && x.toLowerCase() !== "none");
    if (names.length) body += `<p><b>Samples:</b> ${names.map((x) => `<code>${esc(x)}</code>`).join(", ")}</p>`;
    if (c.check) body += `<p><b>Check:</b></p>${md(c.check)}`;
    if (c.question) body += `<p><b>Question:</b></p>${md(c.question)}`;
  }
  const version = c.kind === "excerpt" ? undefined : c.version;
  return `${s}<details${open ? " open" : ""}><summary>Details</summary>${body}</details>${version ? `<p>📦 In ${esc(version)} or later</p>` : ""}`;
}

export const okRow = (): View => [row(btn("✅ OK", "k"))];
export const newBar = (): View => [row(btn("✖ Cancel", "X"), btn("📨 File ticket", "F"))];

/** The bar at the bottom; under a card it is buttons only. */
export function nav(current: number | undefined, left: number): View {
  const v: View = [];
  if (left === 0) v.push({ html: "<p>✨ Inbox empty</p>" });
  else if (current === undefined) v.push({ html: `<p>${left} open</p>` });
  v.push(row(btn("➕ New ticket", "t")));
  const b = [btn("◀ Prev", "p")];
  if (current !== undefined && left > 0) b.push(btn("✅ OK", "k"), btn("⏭ Skip", "s"));
  b.push(btn("📋 List", "L:0"));
  if (left > 0) b.push(btn("▶ Next", "n"));
  return [...v, row(...b)];
}

function table(rows: Item[], open: string, now: number): Block {
  return {
    table: {
      head: ["#", "Kind", "Waiting", "Title", ""],
      rows: rows.map((it) => ({
        cells: [label(it).replace(/^#/, ""), kind(it)[1], waited(it.since, now), esc(cut(it.title, 40))],
        buttons: [{ label: "Open", data: `${open}:${it.n}:${it.cid}`, style: "primary" }],
      })),
    },
  };
}

function listButtons(prefix: string, page: number, pages: number, search: boolean): Block {
  const b: Button[] = [];
  if (pages > 1)
    b.push(btn("◀", `${prefix}:${(page + pages - 1) % pages}`), { label: `${page + 1}/${pages}` }, btn("▶", `${prefix}:${(page + 1) % pages}`));
  if (search) b.push(btn("🔎 Search", "f"));
  b.push(btn("« Back", "b"));
  return row(...b);
}

export function list(rows: Item[], heading: string, page: number, pages: number, now: number): View {
  return [
    { html: `<p><b>${esc(heading)}</b></p>` },
    rows.length ? table(rows, "o", now) : { html: "<p>✨ Inbox empty</p>" },
    listButtons("L", page, pages, true),
  ];
}

/** The open items in one table, every row with its Open button: a backend's side view (the terminal's inbox pane). */
export function panel(rows: Item[], postponedCount: number, answeredToday: number, now: number): View {
  const facts = [`${rows.length} open`, `${answeredToday} answered today`, ...(postponedCount ? [`💤 ${postponedCount} postponed`] : [])];
  return [{ html: `<p><b>📋 Inbox</b> · ${facts.join(" · ")}</p>` }, rows.length ? table(rows, "o", now) : { html: "<p>✨ Inbox empty</p>" }];
}

export function postponed(rows: Item[], total: number, page: number, pages: number, now: number): View {
  return [
    { html: `<p><b>💤 ${total} postponed</b></p>` },
    rows.length ? table(rows, "q", now) : { html: "<p>Nothing postponed</p>" },
    listButtons("P", page, pages, false),
  ];
}

export function results(hits: Hit[], found: number, query: string, page: number, pages: number, now: number): View {
  const q = esc(cut(query.trim(), 60));
  if (!hits.length) return [{ html: `<p>No open item matches <b>${q}</b></p>` }, listButtons("S", 0, 1, true)];
  const v: View = [
    { html: `<p>🔎 <b>${q}</b> · ${found} found</p>` },
    table(
      hits.map((h) => h.item),
      "o",
      now,
    ),
  ];
  const snippets = hits.filter((h) => h.snippet).map((h) => [`<b>${label(h.item)}</b> ${h.snippet}`]);
  if (snippets.length) v.push(facts(snippets));
  return [...v, listButtons("S", page, pages, true)];
}

/** One line per open item, split into messages under a chat message's 4096 characters. */
export function todo(items: Item[], header: string): string[] {
  if (!items.length) return ["✨ Inbox empty"];
  const out = [header];
  for (const it of items) {
    const line = `\n${kind(it)[0]} ${link(it)} ${esc(cut(it.title, 70))}`;
    if (len(out[out.length - 1]) + len(line) > 3800) out.push(line.trimStart());
    else out[out.length - 1] += line;
  }
  return out;
}

export const todoHeader = (n: number) => `📋 <b>${n} open</b>`;

// ---- navigation (nav.rs) ----

export const HISTORY = 30;
export const PAGE = 8;

/** The first open item after `current` in work order, wrapping; `current` only when it is the last open one. */
export function next(order: [number, boolean][], current?: number): number | undefined {
  const i = current === undefined ? -1 : order.findIndex(([k]) => k === current);
  const start = i + 1;
  for (let j = 0; j < order.length; j++) {
    const [k, open] = order[(start + j) % order.length];
    if (open && k !== current) return k;
  }
  return order.some(([k, open]) => k === current && open) ? current : undefined;
}

export function visit(history: number[], current: number | undefined, to: number) {
  if (current === undefined || current === to) return;
  const i = history.indexOf(current);
  if (i >= 0) history.splice(i, 1);
  history.push(current);
  if (history.length > HISTORY) history.shift();
}

export function back(history: number[], current: number | undefined, exists: (k: number) => boolean): number | undefined {
  for (let k = history.pop(); k !== undefined; k = history.pop()) if (k !== current && exists(k)) return k;
  return undefined;
}

export function page(n: number, p: number): [number, number, number, number] {
  const pages = Math.max(1, Math.ceil(n / PAGE));
  const q = Math.min(p, pages - 1);
  return [q, pages, q * PAGE, Math.min(q * PAGE + PAGE, n)];
}

/** `7` or `#7` typed on its own. */
export function parseNumber(text: string): number | undefined {
  const t = text.trim().replace(/^#/, "");
  if (!/^\d{1,7}$/.test(t)) return undefined;
  const n = Number(t);
  return n > 0 ? n : undefined;
}

// ---- search (search.rs) ----

export interface Hit {
  item: Item;
  snippet?: string;
}
type Term = { n: number } | { words: string[] };
interface Word {
  start: number;
  end: number;
  folded: string;
}

const FOLD: Record<string, string> = {};
for (const [to, from] of Object.entries({
  a: "àáâãäåāăą",
  c: "çćč",
  d: "ďđ",
  e: "èéêëēėęě",
  i: "ìíîïīįı",
  l: "łľ",
  n: "ñńň",
  o: "òóôõöøōő",
  r: "ř",
  s: "śšş",
  ss: "ß",
  t: "ť",
  u: "ùúûüūůű",
  y: "ýÿ",
  z: "źżž",
}))
  for (const c of from) FOLD[c] = to;

const fold = (c: string) => [...c.toLowerCase()].map((l) => FOLD[l] ?? l).join("");

function words(s: string): Word[] {
  const out: Word[] = [];
  let open = false;
  for (let i = 0; i < s.length; ) {
    const c = String.fromCodePoint(s.codePointAt(i) ?? 0);
    if (/[\p{L}\p{N}]/u.test(c)) {
      if (!open) out.push({ start: i, end: i, folded: "" });
      open = true;
      const w = out[out.length - 1];
      w.end = i + c.length;
      w.folded += fold(c);
    } else open = false;
    i += c.length;
  }
  return out;
}

const folded = (s: string) => words(s).map((w) => w.folded);

function parse(query: string): Term[] {
  const terms: Term[] = [];
  query
    .replace(/[“”„]/g, '"')
    .split('"')
    .forEach((part, i) => {
      if (i % 2 === 1) return void terms.push({ words: folded(part) });
      for (const w of part.split(/\s+/).filter(Boolean)) {
        const m = /^#(\d+)$/.exec(w);
        terms.push(m ? { n: Number(m[1]) } : { words: folded(w) });
      }
    });
  return terms.filter((t) => !("words" in t) || t.words.length);
}

export const hasTerms = (q: string) => parse(q).length > 0;

function positions(text: Word[], term: string[]): number[] {
  const out: number[] = [];
  for (let i = 0; term.length && i + term.length <= text.length; i++)
    if (term.every((q, j) => text[i + j].folded.startsWith(q))) out.push(i);
  return out;
}

function body(it: Item): string[] {
  const c = it.content;
  const v = c.kind === "excerpt" ? [c.text] : c.kind === "none" ? [] : [c.changed, c.check, c.question].filter((x): x is string => !!x);
  return [...v, kind(it)[1]];
}

function snippet(text: string, ws: Word[], first: number, terms: string[][]): string {
  const s = Math.max(0, first - 5);
  const e = Math.min(first + 8, ws.length - 1);
  let out = s > 0 ? "… " : "";
  for (let i = s; i <= e; i++) {
    if (i > s) out += esc(text.slice(ws[i - 1].end, ws[i].start).replace(/\s+/g, " "));
    const word = esc(text.slice(ws[i].start, ws[i].end));
    out += terms.some((t) => t.some((q) => ws[i].folded.startsWith(q))) ? `<b>${word}</b>` : word;
  }
  return out;
}

/** The items matching every word of `query`, best first; `items` in inbox order. */
export function search(items: Item[], query: string): Hit[] {
  const terms = parse(query);
  if (!terms.length) return [];
  const phrases = terms.flatMap((t) => ("words" in t ? [t.words] : []));
  const hits: [number, number, Hit][] = [];
  for (const it of items) {
    const title = words(it.title);
    const fields = body(it).map((t) => [t, words(t)] as const);
    let inTitle = 0;
    let count = 0;
    let all = true;
    for (const t of terms) {
      let th: number;
      let bh = 0;
      if ("n" in t) th = t.n === local(it) ? 1 : 0;
      else {
        th = positions(title, t.words).length + (t.words.length === 1 && t.words[0] === String(local(it)) ? 1 : 0);
        for (const [, f] of fields) bh += positions(f, t.words).length;
      }
      if (th + bh === 0) {
        all = false;
        break;
      }
      inTitle += th > 0 ? 1 : 0;
      count += th + bh;
    }
    if (!all) continue;
    let snip: string | undefined;
    for (const [text, ws] of fields.slice(0, -1)) {
      const firsts = phrases.map((p) => positions(ws, p)[0]).filter((x) => x !== undefined);
      if (firsts.length) {
        snip = snippet(text, ws, Math.min(...firsts), phrases);
        break;
      }
    }
    hits.push([inTitle, count, { item: it, snippet: snip }]);
  }
  return hits.sort((a, b) => b[0] - a[0] || b[1] - a[1]).map((h) => h[2]);
}

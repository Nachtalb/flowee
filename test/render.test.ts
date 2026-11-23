// The reference envoy's render, navigation and search cases.
import { describe, expect, it } from "vitest";
import { richHtml } from "../src/adapters/chat-telegram";
import {
  back,
  card,
  HISTORY,
  type Item,
  kind,
  list as listV,
  md,
  nav as navV,
  newBar as newBarV,
  next,
  okRow as okRowV,
  page,
  parseNumber,
  postponed as postponedV,
  results as resultsV,
  search,
  todo,
  todoHeader,
  visit,
  waited,
  hasTerms,
} from "../src/envoy/render";

// the views as the Telegram adapter renders them: the original assertions on rich HTML hold unchanged
const nav = (...a: Parameters<typeof navV>) => richHtml(navV(...a));
const newBar = () => richHtml(newBarV());
const okRow = () => richHtml(okRowV());
const list = (...a: Parameters<typeof listV>) => richHtml(listV(...a));
const postponed = (...a: Parameters<typeof postponedV>) => richHtml(postponedV(...a));
const results = (...a: Parameters<typeof resultsV>) => richHtml(resultsV(...a));

const NOW = Date.parse("2026-11-13T09:00:00Z");
const mk = (o: Partial<Item> = {}): Item => ({
  n: 12,
  cid: 34,
  title: "A <b> & c",
  url: "https://github.com/acme/shop/issues/12",
  content: { kind: "none" },
  since: Date.parse("2026-11-10T09:00:00Z"),
  status: "open",
  ...o,
});

describe("cards", () => {
  it("lays out kind, link, age, title and the folded hand-over", () => {
    const t = mk({ content: { kind: "test", changed: "lessons load faster", check: "- open a lesson\n- zoom" } });
    const c = card(t, null, true, NOW);
    expect(c).toBe(
      '<p>🧪 <b>Test</b> · <a href="https://github.com/acme/shop/issues/12#issuecomment-34">#12</a> · ⏳ 3 d</p><p><b>A &lt;b&gt; &amp; c</b></p><details open><summary>Details</summary><p><b>Changed:</b></p><p>lessons load faster</p><p><b>Check:</b></p><ul><li>open a lesson</li><li>zoom</li></ul></details>',
    );
    expect(card(t, null, false, NOW)).toContain("<details><summary>");
    const a = card(t, Date.parse("2026-11-13T07:00:00Z"), true, NOW);
    expect(a).toContain("✓ answered 2 h ago");
    expect(a).not.toContain("⏳");
    const q = card(mk({ content: { kind: "decision", question: "A or B?" } }), null, true, NOW);
    expect(q).toContain("<p>⚖️ <b>Decision</b>");
    expect(q).toContain("<p><b>Question:</b></p><p>A or B?</p>");
    expect(kind(mk({ content: { kind: "question", question: "x" } }))).toEqual(["❓", "Question"]);
    const old = mk({ content: { kind: "excerpt", text: "Tester: <script>" } });
    expect(kind(old)).toEqual(["👀", "Review"]);
    expect(card(old, null, true, NOW)).toContain("<p>Tester: &lt;script&gt;</p>");
    expect(card(mk(), null, true, NOW)).toContain(
      "<p><i>Older ticket without a hand-over note: open the issue for the details.</i></p>",
    );
    expect(card(mk(), null, true, NOW)).not.toContain("<details");
    expect(card(mk({ cid: 0 }), null, true, NOW)).toContain('href="https://github.com/acme/shop/issues/12">');
  });

  it("shows code as code, never as a quote", () => {
    const x = 'Tester: run `cargo test <x>` then:\n```sh\nls -la && echo "<ok>"\n```\nand ```\nplain\n``` done';
    const c = card(mk({ content: { kind: "excerpt", text: x } }), null, true, NOW);
    expect(c).not.toContain("blockquote");
    expect(c).toContain(
      '<p>Tester: run <code>cargo test &lt;x&gt;</code> then:</p><pre><code class="language-sh">ls -la &amp;&amp; echo &quot;&lt;ok&gt;&quot;</code></pre><p>and</p><pre>plain</pre><p>done</p>',
    );
    expect(md("a ` b")).toBe("<p>a ` b</p>");
    expect(md("```\nopen")).toBe("<p>```</p><p>open</p>");
  });

  it("ages", () => {
    expect(waited(Date.parse("2026-11-13T08:30:00Z"), NOW)).toBe("30 min");
    expect(waited(Date.parse("2026-11-12T08:00:00Z"), NOW)).toBe("25 h");
  });
});

describe("bar and lists", () => {
  it("OK only under an item; New ticket's bar", () => {
    expect(nav(7, 3)).toContain('data="k">✅ OK');
    expect(nav(undefined, 3)).not.toContain('data="k"');
    expect(okRow()).toBe('<tg-button-row align="center"><tg-button type="callback_data" data="k">✅ OK</tg-button></tg-button-row>');
    expect(newBar()).toBe(
      '<tg-button-row align="center"><tg-button type="callback_data" data="X">✖ Cancel</tg-button><tg-button type="callback_data" data="F">📨 File ticket</tg-button></tg-button-row>',
    );
  });

  it("the bar under a card is buttons only, Next last", () => {
    expect(nav(977, 3)).toBe(
      '<tg-button-row align="center"><tg-button type="callback_data" data="t">➕ New ticket</tg-button></tg-button-row><tg-button-row align="center"><tg-button type="callback_data" data="p">◀ Prev</tg-button><tg-button type="callback_data" data="k">✅ OK</tg-button><tg-button type="callback_data" data="s">⏭ Skip</tg-button><tg-button type="callback_data" data="L:0">📋 List</tg-button><tg-button type="callback_data" data="n">▶ Next</tg-button></tg-button-row>',
    );
    expect(nav(undefined, 3).startsWith("<p>3 open</p>")).toBe(true);
    const empty = nav(977, 0);
    expect(empty.startsWith("<p>✨ Inbox empty</p>")).toBe(true);
    expect(empty).not.toContain('data="n"');
    expect(empty).not.toContain('data="s"');
  });

  it("the list is a table with Open per row, paging wraps", () => {
    const a = mk({ n: 977, title: "PDF <forms> & annotations render blank on page two" });
    const l = list([a], "1 open · 0 answered today", 1, 3, NOW);
    expect(l.startsWith("<p><b>1 open · 0 answered today</b></p><table bordered striped compact><tr><th>#</th>")).toBe(true);
    expect(l).toContain(
      '<tr><td>977</td><td>Review</td><td>3 d</td><td>PDF &lt;forms&gt; &amp; annotations render blank…</td><td><tg-button type="callback_data" style="primary" data="o:977:34">Open</tg-button></td></tr></table>',
    );
    expect(l.endsWith(
      '<tg-button-row align="center"><tg-button type="callback_data" data="L:0">◀</tg-button><tg-button type="disabled">2/3</tg-button><tg-button type="callback_data" data="L:2">▶</tg-button><tg-button type="callback_data" data="f">🔎 Search</tg-button><tg-button type="callback_data" data="b">« Back</tg-button></tg-button-row>',
    )).toBe(true);
    expect(list([], "0 open", 0, 1, NOW)).not.toContain("L:");
    expect(list([], "0 open", 0, 1, NOW)).toContain("<p>✨ Inbox empty</p>");
  });

  it("postponed opens cards only", () => {
    const a = mk({ postponed: true });
    expect(kind(a)).toEqual(["💤", "Postponed"]);
    const l = postponed([a], 9, 0, 2, NOW);
    expect(l.startsWith("<p><b>💤 9 postponed</b></p>")).toBe(true);
    expect(l).toContain('data="q:12:34">Open');
    expect(l).not.toContain('data="o:');
    expect(l).toContain('data="P:1"');
    expect(l).not.toContain('data="f"');
    expect(postponed([], 0, 0, 1, NOW)).toContain("<p>Nothing postponed</p>");
  });

  it("results are the list's table with snippets", () => {
    const a = mk({ n: 977, title: "PDF thumbnails" });
    const b = mk({ n: 978 });
    const r = results([{ item: a }, { item: b, snippet: "… big <b>thumb</b> &lt;x&gt;" }], 9, "thumb <x>", 0, 2, NOW);
    expect(r.startsWith("<p>🔎 <b>thumb &lt;x&gt;</b> · 9 found</p><table bordered striped compact>")).toBe(true);
    expect(r).toContain("</table><ul><li><b>#978</b> … big <b>thumb</b> &lt;x&gt;</li></ul>");
    expect(r).not.toContain("<b>#977</b>");
    expect(results([], 0, "zzz", 0, 1, NOW)).toBe(
      '<p>No open item matches <b>zzz</b></p><tg-button-row align="center"><tg-button type="callback_data" data="f">🔎 Search</tg-button><tg-button type="callback_data" data="b">« Back</tg-button></tg-button-row>',
    );
  });

  it("todo lines split under 4096 characters", () => {
    expect(todo([], "x")).toEqual(["✨ Inbox empty"]);
    expect(todo([mk({ content: { kind: "question", question: "q" } })], todoHeader(1))).toEqual([
      '📋 <b>1 open</b>\n❓ <a href="https://github.com/acme/shop/issues/12#issuecomment-34">#12</a> A &lt;b&gt; &amp; c',
    ]);
    const parts = todo(Array.from({ length: 200 }, () => mk()), todoHeader(200));
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect([...p].length).toBeLessThanOrEqual(4096);
  });
});

describe("navigation", () => {
  it("next walks open items and wraps", () => {
    const order: [number, boolean][] = [
      [1, true],
      [2, false],
      [3, true],
      [4, true],
    ];
    expect(next(order)).toBe(1);
    expect(next(order, 1)).toBe(3);
    expect(next(order, 4)).toBe(1);
    expect(next(order, 2)).toBe(3);
    expect(next(order, 9)).toBe(1);
    expect(next([[1, true]], 1)).toBe(1);
    expect(next([[1, false]], 1)).toBeUndefined();
    expect(next([])).toBeUndefined();
  });

  it("history dedupes, is capped and skips gone items", () => {
    const h: number[] = [];
    visit(h, 1, 2);
    visit(h, 2, 3);
    visit(h, 1, 4);
    expect(h).toEqual([2, 1]);
    visit(h, 4, 4);
    expect(h.length).toBe(2);
    expect(back(h, 4, (k) => k !== 1)).toBe(2);
    for (let i = 0; i < 100; i++) visit(h, i, i + 1);
    expect(h.length).toBe(HISTORY);
  });

  it("pages and numbers", () => {
    expect(page(0, 0)).toEqual([0, 1, 0, 0]);
    expect(page(9, 7)).toEqual([1, 2, 8, 9]);
    expect(parseNumber(" #977 ")).toBe(977);
    for (const t of ["#", "977 please", "0", "-5", "12345678", "hello"]) expect(parseNumber(t)).toBeUndefined();
  });
});

describe("search", () => {
  const item = (n: number, title: string, changed: string): Item =>
    mk({ n, cid: n, title, content: { kind: "test", changed, check: "scan.pdf, photo.heic" } });
  const inbox = () => [
    item(10, "PDF viewer crashes", "Thumbnails of big PDF files load slowly"),
    item(20, "Thumbnail grid spacing", "Spacing between thumbnails is even"),
    item(30, "Zürich café menu", "Opens `menu.docx` in the Word viewer"),
    mk({ n: 1027, cid: 1027, title: "Gallery", content: { kind: "excerpt", text: "Tester: the gallery thumbnail is blurry" } }),
  ];
  const found = (q: string) => search(inbox(), q).map((h) => h.item.n);

  it("matches word starts, case and accents ignored, every word", () => {
    expect(found("thumb")).toEqual([20, 10, 1027]);
    expect(found("THUMBNAILS")).toEqual([10, 20]);
    expect(found("zurich cafe")).toEqual([30]);
    expect(found("humb")).toEqual([]);
    expect(found("slowly pdf")).toEqual([10]);
    expect(found("heic scan")).toEqual([10, 20, 30]);
  });

  it("numbers and phrases", () => {
    expect(found("#1027")).toEqual([1027]);
    expect(found("1027")).toEqual([1027]);
    expect(found("#10")).toEqual([10]);
    expect(found('"grid spacing"')).toEqual([20]);
    expect(found("“spacing grid”")).toEqual([]);
    expect(found("menu.docx")).toEqual([30]);
    expect(found("viewer")).toEqual([10, 30]);
  });

  it("snippets around the first body match", () => {
    expect(search(inbox(), "slow")[0].snippet).toBe("… of big PDF files load <b>slowly</b>");
    expect(search(inbox(), "word")[0].snippet).toBe("Opens `menu.docx` in the <b>Word</b> viewer");
    expect(search(inbox(), "crash")[0].snippet).toBeUndefined();
    for (const q of ["", "   ", '""', "-- ..."]) expect(hasTerms(q)).toBe(false);
  });
});

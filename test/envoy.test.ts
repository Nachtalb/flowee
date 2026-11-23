// The Telegram side against docs/envoy.md (row numbers in the test names): exact texts and button layouts.
import { runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { richHtml } from "../src/adapters/chat-telegram";
import { texts as textsOf } from "../src/config/registry";
import { nav as navV, newBar as newBarV, okRow as okRowV } from "../src/envoy/render";
import workspaces from "./workspaces.json";
import type { FakeGitHub, FakePaste, FakeTelegram } from "./fake";
import { CARD_Q, CARD_TEST, call, hook, inFlow, setup, stub, wipe } from "./helpers";

const nav = (...a: Parameters<typeof navV>) => richHtml(navV(...a));
const newBar = () => richHtml(newBarV());
const okRow = () => richHtml(okRowV());
const WELCOME = textsOf(workspaces.workspaces[0] as never).welcome.split("\n").filter((l) => l.trim()).join("\n");

let gh: FakeGitHub;
let tg: FakeTelegram;
let paste: FakePaste;
let uid = 1;
beforeEach(async () => {
  ({ gh, tg, paste } = setup());
  await wipe();
});
afterEach(() => void vi.useRealTimers());

const OWNER = { id: 100000001, is_bot: false, first_name: "Ann" };
const BOT = { id: 999, is_bot: true, first_name: "Shop Envoy" };
const CHAT = { id: 100000001, type: "private" };
const msg = (text: string | undefined, reply?: number, extra: Record<string, unknown> = {}) => ({
  update_id: uid++,
  message: {
    message_id: 5000 + uid,
    from: OWNER,
    chat: CHAT,
    date: 1,
    ...(text === undefined ? {} : { text }),
    ...(reply ? { reply_to_message: { message_id: reply, from: BOT } } : {}),
    ...extra,
  },
});
const press = (data: string, message_id = 1) => ({
  update_id: uid++,
  callback_query: { id: `q${uid}`, from: OWNER, data, message: { message_id, chat: CHAT } },
});
const html = (p: Record<string, any>) => (p.rich_message?.html ?? "") as string;
const rich = () => tg.sent("sendRichMessage");
const toasts = () => tg.of("answerCallbackQuery").map((a) => a.text);
/** The envoy's notices (rich, one paragraph per line, a digest's items as a table) as text, one line per paragraph or row. */
const isNotice = (m: Record<string, any>) => !m.reply_markup?.force_reply && !/<details|Older ticket|<th>|data="t"|data="f"/.test(html(m));
const texts = () =>
  rich()
    .filter(isNotice)
    .map((m) =>
      html(m)
        .replace(/<tg-button-row.*$/s, "")
        .replace(/<\/(p|tr)>(?=<(p|tr|table)[ >])/g, "\n")
        .replace(/<\/?(p|table|tr|td)( [^>]*)?>/g, ""),
    );
const reactions = () => tg.of("setMessageReaction").map((r) => r.reaction[0].emoji);
const status = (n: number) => inFlow((f) => f.rows<{ status: string }>("SELECT status FROM inbox WHERE n = ?", n)[0]?.status);
const ISSUE = (n: number) => `https://github.com/acme/shop/issues/${n}`;
const Q1 = (cid: number, n = 1, age = "⏳ 0 min", open = false) =>
  `<p>❓ <b>Question</b> · <a href="${ISSUE(n)}#issuecomment-${cid}">#${n}</a> · ${age}</p><p><b>Ticket ${n}</b></p><details${open ? " open" : ""}><summary>Details</summary><p><b>Question:</b></p><p>Blue or green? I recommend blue.</p></details>`;

/** Escalates #n; returns the id of its new-item note. */
async function escalated(n = 1, card = CARD_Q) {
  gh.add({ number: n, state_label: "board review" });
  await call("board", "escalate", { n, comment: card });
  const id = rich().at(-1)?.id as number;
  tg.calls = [];
  return id;
}

/** /start: returns the ids of the card and the bar. */
async function start() {
  await hook(msg("/start"));
  const [c, b] = rich().slice(-2);
  tg.calls = [];
  return { card: c.id, bar: b.id };
}

describe("webhook and owner (51)", () => {
  it("refuses a wrong or missing secret", async () => {
    expect((await hook(msg("/start"), "nope")).status).toBe(403);
    expect(tg.calls).toEqual([]);
  });

  it("ignores everyone but the owner's private chat, without a reply", async () => {
    const u = msg("/start");
    u.message.from = { ...OWNER, id: 42 };
    expect((await hook(u)).status).toBe(200);
    const g = msg("/start");
    g.message.chat = { id: -5, type: "group" };
    await hook(g);
    await hook({ update_id: uid++, callback_query: { id: "x", from: { id: 42 }, data: "n" } });
    expect(tg.calls).toEqual([]);
  });

  it("a retried update is handled once", async () => {
    const note = await escalated();
    const u = msg("Green.", note);
    await hook(u);
    await hook(u);
    expect(gh.issues.get(1)?.comments.filter((c) => c.body === "Ann: Green.")).toHaveLength(1);
  });
});

describe("cards and notes (12-18, 20, 47)", () => {
  it("escalate sends the folded card with a centred ✅ OK and sets the menu counts (2)", async () => {
    gh.add({ number: 1, state_label: "board review" });
    expect((await call("board", "escalate", { n: 1, comment: CARD_Q })).body.telegram).toBe("sent");
    const [note] = rich();
    expect(html(note)).toBe(Q1(1) + okRow());
    expect(note.chat_id).toBe("100000001");
    expect(tg.of("setMyCommands")[0]).toEqual({
      commands: [
        { command: "start", description: "what this bot does" },
        { command: "todo", description: "1 open items" },
        { command: "postponed", description: "0 postponed tickets" },
        { command: "new", description: "new ticket" },
      ],
      scope: { type: "chat", chat_id: "100000001" },
    });
  });

  it("the cron picks up human review tickets: none on the first pass, a note for later ones; gone ones leave (20)", async () => {
    gh.add({ number: 3, state_label: "human review" }).comments.push({ id: 30, body: `Board: escalated\n\n${CARD_Q}` });
    await inFlow((f) => f.cron());
    expect(rich().filter((m) => !isNotice(m))).toEqual([]);
    expect(await status(3)).toBe("sent");
    gh.add({ number: 4, state_label: "human review" }).comments.push({ id: 40, body: "Tester: something <odd>" });
    await inFlow((f) => f.cron());
    expect(html(rich().filter((m) => !isNotice(m))[0])).toBe(
      `<p>👀 <b>Review</b> · <a href="${ISSUE(4)}#issuecomment-40">#4</a> · ⏳ 0 min</p><p><b>Ticket 4</b></p><details><summary>Details</summary><p>Tester: something &lt;odd&gt;</p></details>${okRow()}`,
    );
    gh.issues.get(3)!.labels = [{ name: "needs triage" }];
    await inFlow((f) => f.cron());
    expect(await status(3)).toBe("gone");
  });

  it("Telegram down: queued, the cron sends it", async () => {
    gh.add({ number: 1, state_label: "board review" });
    tg.down = true;
    expect((await call("board", "escalate", { n: 1, comment: CARD_TEST })).body.telegram).toBe("queued");
    tg.down = false;
    tg.calls = [];
    await inFlow((f) => f.cron());
    expect(html(rich()[0])).toContain("<p>🧪 <b>Test</b>");
  });
});

describe("the bar (21-28)", () => {
  it("/start shows the first card with ForceReply, the bar as a reply to it (4, 21, 22)", async () => {
    await escalated(1, CARD_TEST);
    await hook(msg("/start"));
    const [c, b] = rich();
    expect(c.reply_markup).toEqual({ force_reply: true, input_field_placeholder: "Your test result…" });
    expect(html(c)).toContain("<details open><summary>Details</summary><p><b>Changed:</b></p><p>Lessons load faster</p>");
    expect(html(b)).toBe(nav(1, 1));
    expect(html(b)).toBe(
      '<tg-button-row align="center"><tg-button type="callback_data" data="t">➕ New ticket</tg-button></tg-button-row><tg-button-row align="center"><tg-button type="callback_data" data="p">◀ Prev</tg-button><tg-button type="callback_data" data="k">✅ OK</tg-button><tg-button type="callback_data" data="s">⏭ Skip</tg-button><tg-button type="callback_data" data="L:0">📋 List</tg-button><tg-button type="callback_data" data="n">▶ Next</tg-button></tg-button-row>',
    );
    expect(b.reply_parameters).toEqual({ message_id: c.id, allow_sending_without_reply: true });
    await hook(msg("/start"));
    expect(tg.of("deleteMessage").map((d) => d.message_id)).toContain(b.id);
  });

  it("/start with nothing open: the bar alone", async () => {
    await hook(msg("/start"));
    expect(rich().map(html)).toEqual([nav(undefined, 0)]);
    expect(html(rich()[0]).startsWith("<p>✨ Inbox empty</p>")).toBe(true);
  });

  it("plain messages under the card are collected; ▶ Next sends them (23, 35)", async () => {
    await escalated();
    const { card } = await start();
    await hook(msg("The list is empty"));
    await hook(msg("and slow"));
    expect(reactions()).toEqual(["✍", "✍"]);
    expect(gh.last(1)).toContain("Board:");
    const bar = rich().at(-1)?.id as number;
    tg.calls = [];
    await hook(press("n", bar));
    expect(gh.last(1)).toBe("Ann: The list is empty\n\nand slow");
    expect(gh.label(1)).toEqual(["needs triage"]);
    expect(tg.of("editMessageText")[0]).toMatchObject({ message_id: card });
    expect(html(tg.of("editMessageText")[0])).toContain("· ✓ answered 0 min ago");
    expect(toasts()).toEqual(["✨ Inbox empty"]);
  });

  it("✅ OK on the bar records OK and moves on; on a note only the note changes (26)", async () => {
    const note1 = await escalated(1);
    await escalated(2);
    const { card, bar } = await start();
    await hook(press("k", bar));
    expect(gh.last(1)).toBe("Ann: OK");
    expect(toasts()).toEqual(["✅ #1 OK"]);
    expect(tg.of("editMessageText")[0]).toMatchObject({ message_id: card });
    expect(rich()[0].reply_markup.force_reply).toBe(true);
    expect(html(rich()[0])).toContain("#2</a>");
    tg.calls = [];
    await hook(press("k", note1));
    expect(toasts()).toEqual(["#1 isn't open"]);
    const note3 = await escalated(3);
    await hook(press("k", note3));
    expect(html(tg.of("editMessageText")[0])).toBe(Q1(4, 3, "✓ answered 0 min ago"));
    expect(toasts()).toEqual(["✅ #3 OK"]);
    await hook(press("k", 77));
    expect(toasts().at(-1)).toBe("Nothing to OK here");
  });

  it("⏭ Skip puts the item last, ◀ Prev goes back to it (24, 25)", async () => {
    await escalated(1);
    await escalated(2);
    const { bar } = await start();
    await hook(press("s", bar));
    expect(toasts()).toEqual(["⏭ #1 moved to the end"]);
    expect(html(rich()[0])).toContain("#2</a>");
    await hook(press("p"));
    expect(html(rich().at(-2) as never)).toContain("#1</a>");
    await hook(press("p"));
    expect(toasts().at(-1)).toBe("Nothing before this one");
    await hook(msg("/skip"));
    expect(texts().at(-1)).toBe("⏭ #1 moved to the end");
    await hook(msg("typed"));
    await hook(press("s"));
    expect(toasts().at(-1)).toBe("📨 #2 sent");
    expect(gh.last(2)).toBe("Ann: typed");
  });

  it("📋 List, paging, Open and « Back take turns in the bar (5, 27, 28)", async () => {
    for (let n = 1; n <= 9; n++) await escalated(n);
    await hook(msg("/todo"));
    const [list] = rich();
    expect(html(list).startsWith("<p><b>9 open · 0 answered today</b></p><table bordered striped compact>")).toBe(true);
    expect(html(list)).toContain(
      '<tr><td>1</td><td>Question</td><td>0 min</td><td>Ticket 1</td><td><tg-button type="callback_data" style="primary" data="o:1:1">Open</tg-button></td></tr>',
    );
    expect(html(list)).toContain('<tg-button type="disabled">1/2</tg-button>');
    await hook(press("L:1", list.id));
    const [page2] = tg.of("editMessageText");
    expect(page2.message_id).toBe(list.id);
    expect(html(page2)).toContain("<td>9</td>");
    expect(html(page2)).not.toContain("<td>1</td>");
    await hook(press("o:9:9"));
    expect(html(rich().at(-2) as never)).toContain("#9</a>");
    await hook(press("b", list.id));
    expect(html(tg.of("editMessageText").at(-1) as never)).toBe(nav(9, 9));
  });
});

describe("search, numbers, postponed (29-32)", () => {
  it("🔎 Search asks with ForceReply; replies search; « Back (10, 29)", async () => {
    await escalated(1);
    await escalated(2, "### For Ann\nKind: question\nQuestion: Is the thumbnail grid right?");
    await hook(msg("/todo"));
    const bar = rich()[0].id;
    await hook(press("f", bar));
    const prompt = rich().at(-1) as ReturnType<typeof rich>[number];
    expect(html(prompt)).toBe("<p>🔎 Search</p>");
    expect(prompt.reply_markup).toEqual({ force_reply: true, input_field_placeholder: "Words to find…" });
    await hook(msg("thumb", prompt.id));
    const res = rich().at(-1) as ReturnType<typeof rich>[number];
    expect(html(res).startsWith("<p>🔎 <b>thumb</b> · 1 found</p>")).toBe(true);
    expect(html(res)).toContain("<table bordered striped compact><tr><td><b>#2</b> Is the <b>thumbnail</b> grid right</td></tr></table>");
    expect(gh.last(1)).toContain("Board:");
    await hook(msg("zzz", res.id));
    expect(html(rich().at(-1) as never)).toContain("<p>No open item matches <b>zzz</b></p>");
    await hook(msg("--", rich().at(-1)?.id));
    expect(texts().at(-1)).toBe("🔎 Type a few words to find.");
    await hook(msg("/search"));
    expect(texts().at(-1)).toBe("Usage: /search words to find");
  });

  it("a typed number opens that item; unknown: Not in your inbox (32)", async () => {
    await escalated(1);
    await hook(msg("#1"));
    expect(rich()[0].reply_markup.force_reply).toBe(true);
    await hook(msg("99"));
    expect(texts()).toEqual(["#99: Not in your inbox"]);
  });

  it("/postponed lists parked tickets; Open sends the card alone; a reply to it is the answer (6, 31)", async () => {
    gh.add({ number: 5, state_label: "postponed" }).comments.push({ id: 50, body: `Board: parked\n\n${CARD_Q}` });
    await inFlow((f) => f.cron());
    tg.calls = [];
    await hook(msg("/postponed"));
    const [list] = rich();
    expect(html(list).startsWith("<p><b>💤 1 postponed</b></p>")).toBe(true);
    expect(html(list)).toContain('data="q:5:50">Open');
    expect(html(list)).not.toContain('data="f"');
    await hook(press("q:5:50", list.id));
    const c = rich().at(-1) as ReturnType<typeof rich>[number];
    expect(html(c)).toContain('<p>💤 <b>Postponed</b> · <a href="https://github.com/acme/shop/issues/5#issuecomment-50">#5</a>');
    expect(html(c)).toContain("<details open>");
    expect(c.reply_markup).toBeUndefined();
    await hook(msg("Go ahead now", c.id));
    expect(gh.last(5)).toBe("Ann: Go ahead now");
    expect(gh.label(5)).toEqual(["needs triage"]);
    await inFlow((f) => f.cron());
    await hook(press("q:5:50", list.id));
    expect(toasts().at(-1)).toBe("#5 isn't postponed any more");
  });
});

describe("answers (34-42)", () => {
  it("a reply to a note is the whole answer: 👀 then 👍 (36)", async () => {
    const note = await escalated();
    await hook(msg("Blue.", note));
    expect(gh.last(1)).toBe("Ann: Blue.");
    expect(reactions()).toEqual(["👀", "👍"]);
    expect(await status(1)).toBe("answered");
    expect(html(rich().at(-1) as never)).toBe(nav(undefined, 0));
  });

  it("not recorded: the warning as a reply, 👎, open again (37)", async () => {
    const note = await escalated();
    gh.fail = () => 503;
    const u = msg("Blue.", note);
    await hook(u);
    expect(reactions()).toEqual(["👀", "👎"]);
    expect(rich().filter(isNotice)[0]).toMatchObject({
      rich_message: { html: "<p>⚠️ #1: not recorded: GitHub answered 503 for reading #1</p>" },
      reply_parameters: { message_id: u.message.message_id },
    });
    expect(await status(1)).toBe("sent");
  });

  it("collected text that fails is kept: It is open again (37)", async () => {
    await escalated();
    const { bar } = await start();
    await hook(msg("Blue."));
    gh.fail = () => 503;
    await hook(press("n", bar));
    expect(texts().at(-1)).toBe("⚠️ #1: not recorded: GitHub answered 503 for reading #1. It is open again and your text is kept.");
  });

  it("nothing on screen: Reply to a card to answer it; unknown commands are text (3, 38)", async () => {
    await hook(msg("hello"));
    await hook(msg("/inbox"));
    expect(texts()).toEqual(["Reply to a card to answer it.", "Reply to a card to answer it."]);
  });

  it("photos and files are uploaded to paste.example and linked (39)", async () => {
    const note = await escalated();
    const u = msg(undefined, note, {
      caption: "See this",
      photo: [
        { file_id: "small", width: 90, height: 160, file_size: 1000 },
        { file_id: "big", width: 720, height: 1280, file_size: 90000 },
      ],
    });
    await hook(u);
    const name = `screenshot-${u.message.message_id}.jpg`;
    expect(paste.uploads).toEqual([{ name, body: "bytes of big", auth: "paste-test", expire: "90d" }]);
    expect(gh.last(1)).toBe(`Ann: See this\n\n![${name}](https://paste.example/${name})`);
    const note2 = await escalated(2);
    await hook(msg(undefined, note2, { document: { file_id: "d", file_name: "my log.txt", mime_type: "text/plain", file_size: 12 } }));
    expect(gh.last(2)).toBe("Ann: [my_log.txt](https://paste.example/my_log.txt)");
  });

  it("too big, upload failure, voice and stickers are refused with the reference's texts (40, 41)", async () => {
    const note = await escalated();
    await hook(msg(undefined, note, { document: { file_id: "d", file_name: "big.mp4", file_size: 30 * 1024 * 1024 } }));
    paste.fail = true;
    await hook(msg(undefined, note, { document: { file_id: "d", file_name: "a.txt", file_size: 3 } }));
    await hook(msg(undefined, note, { voice: { file_id: "v", duration: 3 } }));
    await hook(msg(undefined, note, { sticker: { file_id: "s" } }));
    expect(texts()).toEqual([
      "⚠️ big.mp4 is over 20 MB, which bots can't download. Nothing recorded.",
      "⚠️ Upload failed (upload failed: 401 unauthorized). Nothing recorded.",
      "🎙 Sorry, voice messages aren't supported. Please type the answer (screenshots and files work).",
      "Sorry, I can only pass on text, photos, videos and files.",
    ]);
    expect(gh.last(1)).toContain("Board:");
  });

  it("an album is one answer (42)", async () => {
    const note = await escalated();
    const part = (id: string, caption?: string) =>
      msg(undefined, note, { media_group_id: "g1", photo: [{ file_id: id, width: 1, height: 1, file_size: 5 }], ...(caption ? { caption } : {}) });
    await hook(part("a", "Both broken"));
    await hook(part("b"));
    expect(tg.calls).toEqual([]);
    await inFlow((f) => f.sql.exec("UPDATE albums SET ts = ts - 5000"));
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(gh.issues.get(1)?.comments.filter((c) => c.body.startsWith("Ann:"))).toHaveLength(1);
    expect(gh.last(1)).toMatch(/^Ann: Both broken\n\n!\[screenshot-\d+\.jpg\]\(https:\/\/paste\.example\/screenshot-\d+\.jpg\)\n\n!\[screenshot-\d+\.jpg\]/);
  });

  it("an answer through the API re-renders the card on screen", async () => {
    await escalated();
    const { card } = await start();
    await call("owner", "answer", { n: 1, text: "Ann: blue" });
    expect(tg.of("editMessageText")[0]).toMatchObject({ message_id: card });
    expect(html(tg.of("editMessageText")[0])).toContain("✓ answered");
  });
});

describe("new ticket (7, 43-46)", () => {
  it("➕ asks, collects, files and records his words; a reply to the note adds", async () => {
    await hook(press("t"));
    const [prompt, bar] = rich();
    expect(html(prompt)).toBe("<p>➕ New ticket: send text and files, then press 📨 File ticket</p>");
    expect(prompt.reply_markup).toEqual({ force_reply: true, input_field_placeholder: "What should be built or fixed…" });
    expect(html(bar)).toBe(newBar());
    await hook(msg("Dark mode is too dark\nThe text is unreadable."));
    expect(reactions()).toEqual(["✍"]);
    expect(html(rich().at(-1) as never)).toBe(newBar());
    tg.calls = [];
    await hook(press("F"));
    const st = rich().find((m) => html(m) === "<p>⏳ Filing your ticket…</p>") as Record<string, any>;
    expect(st).toBeDefined();
    expect(tg.of("editMessageText").find((e) => e.message_id === st.id)).toEqual({ chat_id: "100000001", message_id: st.id, rich_message: { html: "<p>🆕 #1 filed for the Board</p>" } });
    const i = gh.issues.get(1)!;
    expect(i.title).toBe("Dark mode is too dark");
    expect(i.body).toBe(
      "Filed by Ann through Envoy; the Board writes the spec from his words.\n\n> Dark mode is too dark\n> The text is unreadable.\n",
    );
    expect(gh.last(1)).toBe("Ann: Dark mode is too dark\nThe text is unreadable.");
    await hook(msg("Also on mobile.", st.id));
    expect(gh.last(1)).toBe("Ann: Also on mobile.");
    expect(reactions().slice(-2)).toEqual(["👀", "👍"]);
  });

  it("Nothing written yet; ✖ Cancel drops it; /new is ➕", async () => {
    await hook(press("F"));
    expect(toasts()).toEqual(["Nothing written yet"]);
    await hook(msg("/new"));
    expect(html(rich()[0])).toContain("➕ New ticket");
    await hook(press("X"));
    expect(toasts().at(-1)).toBe("New ticket dropped");
    expect(html(rich().at(-1) as never)).toBe(nav(undefined, 0));
  });

  it("a long first line is cut at a word", async () => {
    await hook(press("t"));
    await hook(msg("word ".repeat(40)));
    await hook(press("F"));
    expect(gh.issues.get(1)?.title).toMatch(/^(word ){15}word…$/);
  });
});

describe("commands, digest, old interface (1-11, 33, 48, 49, 52)", () => {
  it("/stats", async () => {
    await escalated();
    await hook(msg("/stats"));
    expect(texts()).toEqual(["📋 1 open · ✅ 0 answered today\n⏳ oldest: #1 (0 min)"]);
  });

  it("the old interface's buttons open the card or the list (33)", async () => {
    await escalated();
    await hook(press("a:1:ok"));
    expect(rich()[0].reply_markup.force_reply).toBe(true);
    await hook(press("i:0", 300));
    expect(html(tg.of("editMessageText").at(-1) as never)).toContain("1 open · 0 answered today");
  });

  it("the morning digest: once, quietly, between 9 and 12 Zurich time (48)", async () => {
    await escalated();
    await inFlow((f) => f.sql.exec("INSERT OR REPLACE INTO meta VALUES ('digest_day', '2026-01-01')"));
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-23T08:30:00Z"));
    await inFlow((f) => f.cron());
    await inFlow((f) => f.cron());
    const d = rich().filter((m) => html(m).startsWith("<p>☀️"));
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({
      rich_message: {
        html: `<p>☀️ <b>Good morning: 1 open</b></p><table bordered striped compact><tr><td>❓ <a href="${ISSUE(1)}#issuecomment-1">#1</a> Ticket 1</td></tr></table><tg-button-row align="center"><tg-button type="callback_data" data="n">▶ Start</tg-button></tg-button-row>`,
      },
      disable_notification: true,
    });
  });

  it("the new version re-renders the old cards once and sends the welcome (49)", async () => {
    const { SELF } = await import("cloudflare:test");
    gh.add({ number: 1, state_label: "human review" });
    await inFlow((f) => {
      f.sql.exec(
        "INSERT INTO inbox (n, comment_id, kind, card, title, url, status, ts) VALUES (1, 7, 'question', ?, 'Ticket 1', ?, 'sent', ?)",
        JSON.stringify({ kind: "question", question: "Blue or green? I recommend blue." }),
        ISSUE(1),
        Date.now(),
      );
      f.sql.exec("INSERT INTO messages VALUES (42, 1, 'card', '<b>old</b>', 1)");
    });
    const r = (await (await SELF.fetch("https://flow.test/setup")).json<Record<string, Record<string, string>>>()).shop;
    expect(r).toMatchObject({ cards: "1/1 re-rendered", hello: "sent" });
    expect(tg.of("editMessageText")[0]).toMatchObject({ message_id: 42, rich_message: { html: Q1(7) + okRow() } });
    expect(texts()).toEqual([WELCOME, `📋 <b>1 open</b>\n❓ <a href="${ISSUE(1)}#issuecomment-7">#1</a> Ticket 1`]);
    await hook(msg("Green.", 42));
    expect(gh.last(1)).toBe("Ann: Green.");
    await inFlow((f) => f.sql.exec("DELETE FROM meta WHERE k = 'setup'"));
    tg.calls = [];
    const again = (await (await SELF.fetch("https://flow.test/setup")).json<Record<string, Record<string, string>>>()).shop;
    expect(again.hello).toBeUndefined();
    expect(texts()).toEqual([]);
  });

  it("a Worker already in use without old cards gets the welcome and the todo list once (49)", async () => {
    const { SELF } = await import("cloudflare:test");
    await escalated();
    await inFlow((f) => f.sql.exec("DELETE FROM meta WHERE k IN ('ui', 'setup')"));
    tg.calls = [];
    expect((await (await SELF.fetch("https://flow.test/setup")).json<Record<string, Record<string, string>>>()).shop.hello).toBe("sent");
    expect(texts()).toEqual([WELCOME, `📋 <b>1 open</b>\n❓ <a href="${ISSUE(1)}#issuecomment-1">#1</a> Ticket 1`]);
    expect(html(rich().filter(isNotice)[1])).toMatch(/<\/table><tg-button-row align="center"><tg-button type="callback_data" data="n">▶ Start<\/tg-button><\/tg-button-row>$/);
    expect(tg.of("editMessageText")).toEqual([]);
  });

  it("GET /setup publishes the profile, the commands and the webhook once (1, 52)", async () => {
    const { SELF } = await import("cloudflare:test");
    const first = (await (await SELF.fetch("https://flow.test/setup")).json<Record<string, Record<string, string>>>()).shop;
    expect(first).toEqual({ name: "set", description: "set", short_description: "set", commands: "set", photo: "set", webhook: "set" });
    expect(tg.of("setMyName")[0]).toEqual({ name: "Shop Envoy" });
    expect(tg.of("setMyDescription")[0]).toEqual({
      description: "Your shop review inbox as a todo list: tests, questions and decisions waiting for you, answered by replying.",
    });
    expect(tg.of("setMyShortDescription")[0]).toEqual({ short_description: "The shop review inbox as a todo list." });
    expect(tg.of("setMyCommands")[0]).toEqual({
      commands: [
        { command: "start", description: "what this bot does" },
        { command: "todo", description: "open items" },
        { command: "postponed", description: "postponed tickets" },
        { command: "new", description: "new ticket" },
      ],
    });
    const photo = tg.of("setMyProfilePhoto")[0];
    expect(JSON.parse(photo.photo)).toEqual({ type: "static", photo: "attach://f" });
    expect(tg.of("setWebhook")[0]).toEqual({
      url: "https://shop-envoy.example.workers.dev/telegram",
      secret_token: "hook-test",
      allowed_updates: ["message", "callback_query"],
    });
    tg.calls = [];
    expect((await (await SELF.fetch("https://flow.test/setup")).json<Record<string, Record<string, string>>>()).shop).toEqual({ setup: "current" });
    await inFlow((f) => f.cron());
    tg.calls = [];
    await inFlow((f) => f.cron());
    expect(tg.calls).toEqual([]);
    await inFlow((f) => f.sql.exec("DELETE FROM meta WHERE k = 'setup'"));
    const again = (await (await SELF.fetch("https://flow.test/setup")).json<Record<string, Record<string, string>>>()).shop;
    expect(Object.values(again)).toEqual(Array(6).fill("current"));
    expect(tg.calls.map((c) => c.method)).toEqual(["getWebhookInfo"]);
  });
});

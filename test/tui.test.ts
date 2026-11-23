// The terminal backend over its protocol (docs/tui-protocol.md) with a scripted client: keys and seats, the card
// answered, retried frames, reconnecting by sequence number, two people (the first answer wins), files, and a
// workspace on Telegram and the terminal at once.
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { FakeGitHub, FakePaste, FakeTelegram } from "./fake";
import { CARD_Q, CARD_TEST, call, setup, wipe } from "./helpers";
import { Scripted } from "./tui-client";

let f: ReturnType<typeof setup>;
let tg: FakeTelegram;
let paste: FakePaste;
beforeEach(async () => {
  f = setup();
  ({ tg, paste } = f);
  for (const w of ["desk", "team", "duo"]) await wipe(w);
});

const escalate = async (gh: FakeGitHub, prefix: string, n = 1, card = CARD_Q) => {
  gh.add({ number: n, state_label: "board review" });
  const r = await call("board", "escalate", { n, comment: card }, undefined, prefix);
  expect(r.status, JSON.stringify(r.body)).toBe(200);
};
const plainText = (v: unknown) => (JSON.stringify(v) ?? "").replace(/<[^>]+>/g, "");

describe("terminal keys", () => {
  it("a key opens the workspaces whose people name its digest; anything else is refused", async () => {
    const me = await new Scripted("tui-ann", "desk").me();
    expect(me.status).toBe(200);
    expect(me.body.workspaces.map((w: { id: string }) => w.id).sort()).toEqual(["desk", "duo", "team"]);
    expect(me.body.person).toEqual({ id: "ann", name: "Ann", role: "manager" });
    expect((await new Scripted("tui-bob", "team").me()).body.workspaces.map((w: { id: string }) => w.id)).toEqual(["team"]);
    expect((await new Scripted("nope", "desk").me()).status).toBe(401);
    // bob's key does not open desk
    expect((await new Scripted("tui-bob", "desk").sync()).status).toBe(403);
    // a person header of the client's own is never believed
    const res = await SELF.fetch("https://flow.test/w/desk/v1/sync", { headers: { "x-flowee-person": '{"id":"ann"}' } });
    expect(res.status).toBe(401);
  });
});

describe("one person", () => {
  it("a card arrives, /start opens it, typed text and ▶ Next record the answer once", async () => {
    await escalate(f.desk, "t");
    const c = new Scripted("tui-ann", "desk");
    await c.sync();
    expect(c.c.panel && plainText(c.c.panel)).toContain("Ticket 1");
    expect(c.c.notices().some((m) => plainText(m.view).includes("Ticket 1"))).toBe(true);
    await c.type("/start");
    const card = c.c.replyTarget();
    expect(card?.reply).toBe("Your answer…");
    expect(plainText(card?.view)).toContain("Blue or green?");
    expect(c.c.bar() && c.c.buttons(c.c.bar()!).map((b) => b.label)).toEqual(["➕ New ticket", "◀ Prev", "✅ OK", "⏭ Skip", "📋 List", "▶ Next"]);
    await c.type("Green.");
    expect(c.c.said().at(-1)).toMatchObject({ by: "Ann", said: "Green.", reaction: "✍" });
    await c.press("▶ Next");
    expect(c.toasts).toContain("✨ Inbox empty");
    expect(f.desk.issues.get(1)?.comments.filter((x) => x.body === "Ann: Green.")).toHaveLength(1);
  });

  it("a retried frame is handled once; a reconnect resumes after its sequence number; a lost log resets", async () => {
    await escalate(f.desk, "t");
    const a = new Scripted("tui-ann", "desk");
    await a.sync();
    await a.type("/start");
    const frame = { id: "same-frame", press: { data: "k", message: a.c.replyTarget()!.id } };
    const post = (after: number) =>
      SELF.fetch("https://flow.test/tui/v1/w/desk/sync", { method: "POST", headers: { authorization: "Bearer tui-ann" }, body: JSON.stringify({ after, send: [frame] }) }).then((r) => r.json() as Promise<any>);
    const before = a.c.seq;
    const one = await post(before);
    const two = await post(before);
    expect(f.desk.issues.get(1)?.comments.filter((x) => x.body === "Ann: OK")).toHaveLength(1);
    // the retry brings the same events, nothing twice in the log
    expect(two.events.map((e: any) => e.seq)).toEqual(one.events.map((e: any) => e.seq));
    // a second terminal that saw nothing gets every event in order, then only the new ones
    const b = new Scripted("tui-ann", "desk");
    await b.sync();
    expect(b.c.seq).toBe(one.seq);
    const again = await post(b.c.seq);
    expect(again.events).toEqual([]);
    // a terminal ahead of the server (the store was wiped) gets the whole conversation
    const r = await SELF.fetch("https://flow.test/tui/v1/w/desk/sync", { method: "POST", headers: { authorization: "Bearer tui-ann" }, body: JSON.stringify({ after: one.seq + 1000 }) }).then((x) => x.json() as Promise<any>);
    expect(r.reset.messages.length).toBeGreaterThan(0);
    const c = new Scripted("tui-ann", "desk");
    c.c.apply(r);
    expect(c.c.messages.map((m) => [m.id, plainText(m.view)])).toEqual(b.c.messages.map((m) => [m.id, plainText(m.view)]));
  });

  it("a file answers the card: uploaded, linked in the comment", async () => {
    await escalate(f.desk, "t", 1, CARD_TEST);
    const c = new Scripted("tui-ann", "desk");
    await c.type("/start");
    await c.file("shot.png", "PNGDATA", "Works.");
    await c.press("▶ Next");
    expect(paste.uploads.map((x) => [x.name, x.body])).toContainEqual(["shot.png", "PNGDATA"]);
    expect(f.desk.issues.get(1)?.comments.at(-1)?.body).toBe("Ann: Works.\n\n![shot.png](https://paste.example/shot.png)");
  });

  it("New ticket: text then 📨 File ticket files it; /todo lists the open items", async () => {
    const c = new Scripted("tui-ann", "desk");
    await c.press("➕ New ticket").catch(async () => {
      await c.type("/start");
      await c.press("➕ New ticket");
    });
    expect(c.c.replyTarget()?.reply).toBe("What should be built or fixed…");
    await c.type("Dark mode please");
    await c.press("📨 File ticket");
    expect([...f.desk.issues.values()].map((i) => i.title)).toContain("Dark mode please");
    await escalate(f.desk, "t", 7);
    await c.type("/todo");
    expect(c.c.focus() && plainText(c.c.focus()!.view)).toContain("Ticket 7");
  });
});

describe("two people", () => {
  it("both see the same conversation; the first answer wins, the second is told who gave it", async () => {
    await escalate(f.team, "e");
    const ann = new Scripted("tui-ann", "team", "ann");
    const bob = new Scripted("tui-bob", "team", "bob");
    await ann.sync();
    await bob.sync();
    const note = (s: Scripted) => s.c.notices().find((m) => plainText(m.view).includes("Ticket 1"))!;
    await ann.sync({ press: { data: "k", message: note(ann).id } });
    await bob.sync({ press: { data: "k", message: note(bob).id } });
    expect(ann.toasts).toContain("✅ #1 OK");
    expect(bob.toasts).toEqual(["#1 was already answered by Ann"]);
    expect(f.team.issues.get(1)?.comments.filter((x) => x.body.startsWith("Ann"))).toHaveLength(1);
    // the toast is the presser's: Ann's terminal never shows Bob's
    await ann.sync();
    expect(ann.toasts).not.toContain("#1 was already answered by Ann");
    expect(plainText(note(bob).view)).toContain("answered");
  });
});

describe("Telegram and the terminal at once", () => {
  it("the same messages under Telegram's ids; an answer in the terminal edits the Telegram card", async () => {
    await escalate(f.duo, "w");
    const sent = tg.sent("sendRichMessage").filter((m) => m.chat_id === "424243");
    expect(sent).toHaveLength(1);
    const c = new Scripted("tui-ann", "duo");
    await c.sync();
    expect(c.c.get(sent[0].id)).toBeDefined();
    tg.calls = [];
    await c.sync({ press: { data: "k", message: sent[0].id } });
    expect(c.toasts).toEqual(["✅ #1 OK"]);
    // the press was the terminal's: no Telegram callback answer, but Telegram's card says answered
    expect(tg.of("answerCallbackQuery")).toEqual([]);
    expect(tg.of("editMessageText").at(-1)?.rich_message.html).toContain("✓ answered");
    expect(plainText(c.c.get(sent[0].id)?.view)).toContain("✓ answered");
    expect(f.duo.issues.get(1)?.comments.at(-1)?.body).toBe("Ann: OK");
  });
});

describe("the doorbell", () => {
  it("a connected socket is rung with the new sequence number", async () => {
    const res = await SELF.fetch("https://flow.test/tui/v1/w/desk/socket", { headers: { authorization: "Bearer tui-ann", upgrade: "websocket" } });
    const ws = (res as Response & { webSocket?: WebSocket }).webSocket;
    if (!ws) {
      // the bun runtime upgrades in Bun.serve only: test/bun/tui.test.ts rings a real socket
      expect(res.status).toBe(426);
      return;
    }
    expect(res.status).toBe(101);
    ws.accept();
    const got = new Promise<string>((ok) => ws.addEventListener("message", (e) => ok(String(e.data))));
    await escalate(f.desk, "t");
    expect(JSON.parse(await got).seq).toBeGreaterThan(0);
    ws.close();
  });
});

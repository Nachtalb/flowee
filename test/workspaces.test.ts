// Two workspaces in one instance: tokens, chat updates and stored state each resolve to their own workspace, and
// neither sees the other's tickets, claims or inbox. The instance is standalone: nothing manages workspaces or bots.
import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { FakeGitHub, FakeTelegram } from "./fake";
import { CARD_Q, call, claim, hook, inFlow, setup, wipe } from "./helpers";

let gh: FakeGitHub;
let gh2: FakeGitHub;
let tg: FakeTelegram;
beforeEach(async () => {
  ({ gh, gh2, tg } = setup());
  await wipe("shop");
  await wipe("other");
});

const other = (who: string, cmd: string, body?: unknown) => call(who, cmd, body, undefined, "o");
let uid = 90000;
const msg = (chat: number, from: number, text: string) => ({
  update_id: uid++,
  message: { message_id: uid, from: { id: from, is_bot: false, first_name: "x" }, chat: { id: chat, type: "private" }, date: 1, text },
});

describe("two workspaces", () => {
  it("tokens resolve to their workspace; a token of one is unknown in the other", async () => {
    expect((await other("dev1", "whoami")).body).toEqual({ ok: true, instance: "dev1", role: "developer" });
    const r = await SELF.fetch("https://flow.test/w/shop/v1/whoami", { headers: { authorization: "Bearer o-dev1" } });
    expect(r.status).toBe(401);
    const ok = await SELF.fetch("https://flow.test/w/other/v1/whoami", { headers: { authorization: "Bearer o-dev1" } });
    expect(await ok.json()).toEqual({ ok: true, instance: "dev1", role: "developer" });
    expect((await SELF.fetch("https://flow.test/w/nope/v1/whoami")).status).toBe(404);
  });

  it("tickets, claims and queues stay in their workspace", async () => {
    gh.add({ number: 1, state_label: "ready" });
    gh2.add({ number: 1, state_label: "ready" });
    gh2.add({ number: 2, state_label: "ready" });
    expect((await other("dev1", "queue")).body.queue).toEqual([1, 2]);
    expect((await call("dev1", "next", {})).body.ticket.n).toBe(1);
    // dev1 of the other workspace is another instance: its claim and queue are its own
    expect((await other("dev1", "next", {})).body.ticket).toMatchObject({ n: 1, resumed: false });
    expect(gh.label(1)).toEqual(["in development"]);
    expect(gh2.label(1)).toEqual(["in development"]);
    expect(await inFlow((f) => f.rows("SELECT n, instance FROM claims"), "shop")).toEqual([{ n: 1, instance: "dev1" }]);
    expect(await inFlow((f) => f.rows("SELECT n, instance FROM claims"), "other")).toEqual([{ n: 1, instance: "dev1" }]);
    await claim(2, "dev2", "developer", Date.now(), "other");
    expect((await call("dev2", "queue")).body.claim).toBeNull();
    expect((await other("dev2", "queue")).body.claim).toMatchObject({ n: 2 });
  });

  it("the inbox and the chat are per workspace", async () => {
    gh2.add({ number: 3, state_label: "board review" });
    const r = await other("board", "escalate", { n: 3, comment: CARD_Q.replace("For Ann", "For the owner") });
    expect(r.body).toEqual({ ok: true, state: "human review", telegram: "sent" });
    expect(tg.of("sendRichMessage").map((m) => m.chat_id)).toEqual(["555"]);
    expect(gh2.last(3)).toBe("Board: ### For the owner\nKind: question\nQuestion: Blue or green? I recommend blue.");
    expect((await call("board", "queue")).body.inbox).toEqual([]);
    expect((await other("board", "queue")).body.inbox).toEqual([3]);
    tg.calls = [];
    // the owner of the other workspace answers in his chat; the shop owner's chat stays untouched
    const note = await inFlow((f) => f.rows<{ message_id: number }>("SELECT message_id FROM messages")[0].message_id, "other");
    const u = msg(555, 555, "Blue.");
    (u.message as Record<string, unknown>).reply_to_message = { message_id: note, from: { id: 999 } };
    await hook(u);
    expect(gh2.last(3)).toBe("Owner: Blue.");
    expect(gh.issues.size).toBe(0);
    expect(tg.calls.every((c) => c.params.chat_id === undefined || c.params.chat_id === "555")).toBe(true);
    // a stranger in the other chat, and an owner of one workspace in the other's chat, are ignored
    tg.calls = [];
    await hook(msg(555, 100000001, "/start"));
    await hook(msg(100000001, 555, "/start"));
    await hook(msg(4242, 4242, "/start"));
    expect(tg.calls).toEqual([]);
  });
});

describe("standalone mode", () => {
  it("ignores management updates and commands and never calls a managed-bot method", async () => {
    await hook({ update_id: uid++, managed_bot: { user: { id: 100000001 }, bot: { id: 77, is_bot: true, first_name: "B" } } });
    await hook({ update_id: uid++, my_chat_member: { chat: { id: -100 }, from: { id: 100000001 } } });
    for (const t of ["/newworkspace", "/workspaces", "/newbot", "/setup"]) await hook(msg(100000001, 100000001, t));
    await hook({
      update_id: uid++,
      message: { message_id: 7, from: { id: 100000001 }, chat: { id: 100000001, type: "private" }, managed_bot_created: { bot: { id: 77 } } },
    });
    expect(tg.calls.some((c) => /ManagedBot/i.test(c.method))).toBe(false);
    // the owner's private chat answers as to any stray message; the rest gets no reply at all
    expect(texts()).toEqual(Array(5).fill("Reply to a card to answer it."));
  });

  it("refuses to run in any other mode", async () => {
    const r = await worker.fetch(new Request("https://flow.test/v1/whoami"), { ...env, FLOWEE_MODE: "kanban" });
    expect(r.status).toBe(501);
    expect(await r.json()).toEqual({ ok: false, error: "unsupported", message: "FLOWEE_MODE 'kanban' is not available; use standalone or managed." });
    const admin = await SELF.fetch("https://flow.test/admin/workspaces", { headers: { authorization: "Bearer x" } });
    expect(admin.status).toBe(501);
  });
});

const texts = () => tg.of("sendMessage").map((m) => m.text);

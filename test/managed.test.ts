// The managed mode end to end against the fake Telegram and GitHub: the setup wizard for each variant, Back,
// Cancel, resume and expiry, the deleted credential message, routing by bot, chat and topic, two users kept
// apart, export and import through the chat and the API, the instance bot's profile, and who may create.
import { env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Instance } from "../src/adapters/instance-durable-object";
import worker from "../src/index";
import type { FakeGitHub, FakeTelegram } from "./fake";
import { setup } from "./helpers";
import workspaces from "./workspaces.json";

const CFG = {
  flowee: 1,
  instance: {
    bot: { token: "TELEGRAM_BOT_TOKEN", webhookSecret: "TG_WEBHOOK_SECRET", username: "FloweeTestBot" },
    publicUrl: "https://flowee.test",
    owner: "100",
    creators: ["100", "200"],
    limits: { workspacesPerUser: 3 },
  },
  workspaces: [],
};
let cfg: object = CFG;
const menv = () => ({ ...env, FLOWEE_MODE: "managed", FLOWEE_CONFIG: JSON.stringify(cfg), FLOWEE_ADMIN_TOKEN: "admin-test" }) as typeof env;
const TOKEN = `github_pat_${"a".repeat(40)}`;
const CARD = "### For the owner\nKind: question\nQuestion: Blue or green?";

let app: FakeGitHub;
let gh2: FakeGitHub;
let lib: FakeGitHub;
let tg: FakeTelegram;
let uid = 500000;
const files: Record<string, string> = {};

beforeEach(async () => {
  ({ app, gh2, lib, tg } = setup());
  cfg = CFG;
  const fake = globalThis.fetch;
  globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(new Request(i, init).url);
    const name = u.pathname.split("/").pop() ?? "";
    if (u.pathname.startsWith("/file/") && name in files) return new Response(files[name]);
    return fake(i, init);
  }) as typeof fetch;
  await runInDurableObject(env.INSTANCE.get(env.INSTANCE.idFromName("instance")), (o: Instance) => {
    for (const t of ["vault", "sessions", "updates", "kv"]) o.store.exec(`DELETE FROM ${t}`);
    o.store.exec("DROP TABLE IF EXISTS workspaces");
    Object.assign(o, { reg: undefined, plain: undefined });
  });
});

const post = (path: string, body: unknown, secret = "hook-test") =>
  worker.fetch(
    new Request(`https://flowee.test${path}`, { method: "POST", headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": secret }, body: JSON.stringify(body) }),
    menv(),
  );
const msg = (from: number, text: string | undefined, chat: Record<string, unknown> = { id: from, type: "private" }, extra: Record<string, unknown> = {}) => ({
  update_id: ++uid,
  message: { message_id: uid, from: { id: from, is_bot: false, first_name: "U" }, chat, date: 1, ...(text === undefined ? {} : { text }), ...extra },
});
const dm = (from: number, text: string, extra: Record<string, unknown> = {}) => post("/telegram", msg(from, text, undefined, extra));
const tap = (from: number, data: string, chat = from) =>
  post("/telegram", { update_id: ++uid, callback_query: { id: `q${uid}`, from: { id: from }, data, message: { message_id: 1, chat: { id: chat } } } });
const said = () => tg.of("sendMessage").at(-1)?.text as string;
const api = async (secret: string, path: string, body?: unknown) => {
  const r = await worker.fetch(
    new Request(`https://flowee.test${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    menv(),
  );
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};
const admin = async (method: string, path: string, body?: unknown, token = "admin-test") => {
  const r = await worker.fetch(
    new Request(`https://flowee.test${path}`, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }),
    menv(),
  );
  return { status: r.status, body: (await r.json()) as Record<string, any> };
};
/** The secrets file handed over at the end: instance -> secret. */
async function handed(): Promise<Record<string, string>> {
  const f = tg.of("sendDocument").at(-1)?.document as File;
  const text = await f.text();
  return Object.fromEntries([...text.matchAll(/^([a-z0-9-]+) = ([0-9a-f]{64})$/gm)].map((m) => [m[1], m[2]]));
}

/** The shared bot, one repository, this private chat; returns the agents' secrets. */
async function sharedSetup(user = 100, repo = "acme/app") {
  await dm(user, "/setup");
  await tap(user, "w:bot:shared");
  await dm(user, repo);
  await tap(user, "w:flow:trunk");
  await tap(user, "w:flow:done");
  await tap(user, "w:bind:here");
  await dm(user, TOKEN);
  await tap(user, "w:role:board:1");
  await tap(user, "w:role:developer:1");
  await tap(user, "w:role:tester:1");
  await tap(user, "w:roles:done");
  await tap(user, "w:confirm");
  return handed();
}

describe("the setup wizard", () => {
  it("shared bot, one repository, this private chat: every step, the token deleted, the workspace serving", async () => {
    await dm(100, "/start");
    expect(said()).toContain("<b>Flowee</b> runs a ticket flow");
    expect(tg.of("sendMessage").at(-1)?.reply_markup).toEqual({ inline_keyboard: [[{ text: "🚀 Set up a workspace", callback_data: "w:new" }]] });
    await tap(100, "w:new");
    expect(said()).toContain("<b>New workspace · 1 Bot</b>");
    await tap(100, "w:bot:shared");
    expect(said()).toContain("2 Repositories");
    await dm(100, "acme");
    expect(said()).toContain("⚠️ 'acme' is not owner/name.");
    await dm(100, "acme/app");
    expect(said()).toContain("3 Flow");
    await tap(100, "w:flow:trunk");
    await tap(100, "w:flow:done");
    // the shared bot offers the chat picker (a reply keyboard) and this private chat
    const pick = tg.of("sendMessage").at(-2);
    expect(pick?.reply_markup.keyboard[0][0]).toEqual({ text: "👥 Pick a group", request_chat: { request_id: 2, chat_is_channel: false, bot_is_member: true } });
    expect(pick?.text).toContain("<code>/bind app</code>");
    await tap(100, "w:bind:here");
    expect(said()).toContain("I delete your message right after reading it");
    await dm(100, TOKEN);
    const tokenMsg = uid;
    expect(tg.of("deleteMessage").at(-1)).toEqual({ chat_id: "100", message_id: tokenMsg });
    expect(tg.of("sendMessage").at(-2)?.text).toBe("🔒 Token checked and stored; your message was deleted.");
    expect(app.auth.at(-1)).toBe(`Bearer ${TOKEN}`);
    expect(said()).toContain("6 Agents");
    await tap(100, "w:roles:done");
    expect(said()).toContain("⚠️ At least one agent is needed.");
    await tap(100, "w:role:board:1");
    await tap(100, "w:role:developer:1");
    await tap(100, "w:role:developer:1");
    await tap(100, "w:role:tester:1");
    await tap(100, "w:roles:done");
    expect(said()).toContain("Create workspace <code>app</code>");
    expect(said()).toContain("Agents: board, dev1, dev2, tester");
    await tap(100, "w:confirm");
    expect(tg.of("sendMessage").at(-1)?.text).toContain("✅ Workspace <code>app</code> is ready.");
    const s = await handed();
    expect(Object.keys(s)).toEqual(["board", "dev1", "dev2", "tester", "owner"]);
    expect(await (tg.of("sendDocument").at(-1)?.document as File).text()).toContain('url = "https://flowee.test"\nworkspace = "app"');
    // the API serves it by token and by path; the token never shows in the configuration or the sealed store
    expect((await api(s.dev1, "/v1/whoami")).body).toEqual({ ok: true, instance: "dev1", role: "developer" });
    expect((await api(s.dev2, "/w/app/v1/whoami")).body).toEqual({ ok: true, instance: "dev2", role: "developer" });
    const doc = (await admin("GET", "/admin/workspaces/app")).body;
    expect(doc.workspace).toMatchObject({ id: "app", tracker: { repos: ["acme/app"], token: "W_APP_TRACKER" }, chat: { chatId: "100", token: "TELEGRAM_BOT_TOKEN" }, owners: [{ chat: "100" }] });
    expect(doc.missing).toEqual([]);
    expect(JSON.stringify(doc)).not.toContain(TOKEN);
    const sealed = await runInDurableObject(env.INSTANCE.get(env.INSTANCE.idFromName("instance")), (o: Instance) => o.store.rows<{ sealed: string }>("SELECT sealed FROM vault"));
    expect(sealed.length).toBe(6);
    expect(JSON.stringify(sealed)).not.toContain(TOKEN.slice(11));
    // the envoy works in the bound private chat: the card comes, a reply answers it
    app.add({ number: 1, state_label: "board review" });
    expect((await api(s.board, "/v1/escalate", { n: 1, comment: CARD })).body).toEqual({ ok: true, state: "human review", telegram: "sent" });
    const card = tg.sent("sendRichMessage").at(-1);
    expect(card?.chat_id).toBe("100");
    await dm(100, "Blue.", { reply_to_message: { message_id: card?.id, from: { id: 999 } } });
    expect(app.last(1)).toBe("Owner: Blue.");
  });

  it("own managed bot, several repositories, one topic of a group: bot created, bound by /bind in the topic", async () => {
    await dm(200, "/setup");
    await tap(200, "w:bot:own");
    await dm(200, "acme/widget acme/lib");
    const req = tg.of("sendMessage").at(-2);
    expect(req?.reply_markup.keyboard[0][0]).toEqual({
      text: "🤖 Create the bot",
      request_managed_bot: { request_id: 1, suggested_name: "Widget envoy", suggested_username: "widget_envoy_bot" },
    });
    // someone else's managed bot update changes nothing
    await post("/telegram", { update_id: ++uid, managed_bot: { user: { id: 300 }, bot: { id: 778, is_bot: true, first_name: "X" } } });
    expect(tg.of("getManagedBotToken")).toEqual([]);
    await post("/telegram", { update_id: ++uid, managed_bot: { user: { id: 200 }, bot: { id: 777, is_bot: true, first_name: "Widget", username: "WidgetEnvoyBot" } } });
    expect(tg.of("getManagedBotToken")).toEqual([{ user_id: 777 }]);
    const hook = tg.calls.find((c) => c.method === "setWebhook" && c.bot === "777:own-token")?.params as Record<string, string>;
    expect(hook.url).toBe("https://flowee.test/telegram/w/widget");
    expect(said()).toContain("3 Flow");
    await tap(200, "w:flow:trunk");
    await tap(200, "w:flow:done");
    expect(said()).toContain("add @WidgetEnvoyBot to the group, then send\n<code>/bind widget</code>");
    const topic = (text: string, from = 200, thread = 9) =>
      msg(from, text, { id: -100500, type: "supergroup", is_forum: true }, { message_thread_id: thread, is_topic_message: true });
    expect((await post("/telegram/w/widget", topic("/bind widget"), "wrong")).status).toBe(403);
    // only the user running the setup binds
    await post("/telegram/w/widget", topic("/bind widget", 300), hook.secret_token);
    expect(said()).toContain("add @WidgetEnvoyBot");
    await post("/telegram/w/widget", topic("/bind widget"), hook.secret_token);
    const ack = tg.calls.filter((c) => c.method === "sendMessage" && c.bot === "777:own-token").at(-1)?.params;
    expect(ack).toMatchObject({ chat_id: "-100500", message_thread_id: 9, text: "✅ This chat is bound; the cards of the workspace will come here." });
    expect(said()).toContain("5 GitHub token");
    await dm(200, TOKEN);
    expect(gh2.auth.at(-1)).toBe(`Bearer ${TOKEN}`);
    expect(lib.auth.at(-1)).toBe(`Bearer ${TOKEN}`);
    await tap(200, "w:role:board:1");
    await tap(200, "w:role:developer:1");
    await tap(200, "w:roles:done");
    expect(said()).toContain("Bot: own (@WidgetEnvoyBot)");
    expect(said()).toContain("Cards go to: topic 9 of group -100500");
    await tap(200, "w:confirm");
    const s = await handed();
    const doc = (await admin("GET", "/admin/workspaces/widget")).body.workspace;
    expect(doc.tracker.repos).toEqual([
      { repo: "acme/widget", alias: "widget" },
      { repo: "acme/lib", alias: "lib" },
    ]);
    expect(doc.chat).toEqual({
      type: "telegram",
      token: "W_WIDGET_BOT",
      webhookSecret: "W_WIDGET_HOOK",
      chatId: "-100500",
      topicId: 9,
      managed: true,
      publicUrl: "https://flowee.test",
      username: "WidgetEnvoyBot",
    });
    // the own bot got its profile and settings from its workspace (the name the user gave it, the bundled photo)
    const own = (m: string) => tg.calls.filter((c) => c.method === m && c.bot === "777:own-token").map((c) => c.params);
    expect(own("setMySettings").map((p) => p.can_manage_bots)).toEqual([false]);
    expect(own("setMyName")).toEqual([{ name: "Widget" }]);
    expect(own("setMyDescription")[0].description).toBe("Your widget review inbox as a todo list: tests, questions and decisions waiting for you, answered by replying.");
    expect(own("setMyProfilePhoto").length).toBe(1);
    expect(own("setWebhook").at(-1)?.url).toBe("https://flowee.test/telegram/w/widget");
    // hash-gated: a new version's /setup changes nothing that did not change
    const before = tg.calls.length;
    await runInDurableObject(env.WORKSPACE.get(env.WORKSPACE.idFromName("widget")), (o) => o.store.exec("DELETE FROM meta WHERE k = 'setup'"));
    await worker.fetch(new Request("https://flowee.test/setup"), menv());
    expect(tg.calls.slice(before).filter((c) => c.bot === "777:own-token" && c.method.startsWith("set"))).toEqual([]);
    // the card goes to the topic through the own bot; only the owner's reply in that topic answers
    lib.add({ number: 1, state_label: "board review" });
    expect((await api(s.board, "/v1/escalate", { n: "lib#1", comment: CARD })).body.telegram).toBe("sent");
    const card = tg.calls.filter((c) => c.method === "sendRichMessage").at(-1);
    expect(card?.bot).toBe("777:own-token");
    expect(card?.params).toMatchObject({ chat_id: "-100500", message_thread_id: 9 });
    const reply = (from: number, thread: number) => topic("Green.", from, thread);
    const r = (u: ReturnType<typeof topic>) => Object.assign(u.message, { reply_to_message: { message_id: card?.id, from: { id: 777 } } }) && u;
    await post("/telegram/w/widget", r(reply(300, 9)), hook.secret_token);
    await post("/telegram/w/widget", r(reply(200, 10)), hook.secret_token);
    expect(lib.issues.get(1)?.comments.length).toBe(1);
    await post("/telegram/w/widget", r(reply(200, 9)), hook.secret_token);
    expect(lib.last(1)).toBe("Owner: Green.");
  });

  it("Back, Cancel, resume and expiry", async () => {
    await dm(100, "/setup");
    await tap(100, "w:bot:shared");
    expect(said()).toContain("2 Repositories");
    await tap(100, "w:back");
    expect(said()).toContain("1 Bot");
    await tap(100, "w:cancel");
    expect(said()).toBe("✖ Cancelled; nothing was changed.");
    await tap(100, "w:bot:shared");
    expect(said()).toBe("This setup expired or was finished. /setup starts a new one.");
    await dm(100, "/setup");
    await tap(100, "w:bot:shared");
    await dm(100, "/setup");
    expect(said()).toContain("<b>Unfinished setup</b>");
    await tap(100, "w:resume");
    expect(said()).toContain("2 Repositories");
    await runInDurableObject(env.INSTANCE.get(env.INSTANCE.idFromName("instance")), (o: Instance) => {
      const row = o.store.rows<{ data: string }>("SELECT data FROM sessions WHERE user = '100'")[0];
      const s = JSON.parse(row.data);
      s.ts -= 25 * 3600e3;
      o.store.exec("UPDATE sessions SET data = ? WHERE user = '100'", JSON.stringify(s));
    });
    await dm(100, "acme/app");
    expect(said()).toBe("That setup expired after a day without an answer; nothing was created. /setup starts a new one.");
    expect((await admin("GET", "/admin/workspaces")).body.workspaces).toEqual([]);
  });

  it("only allowed users create workspaces, up to the limit; users never see each other's workspaces", async () => {
    await dm(300, "/setup");
    expect(said()).toBe("Only the people this instance allows may set up workspaces; ask its owner.");
    await sharedSetup(100);
    await tap(200, "m:ws:app");
    expect(said()).toBe("That workspace is not yours or no longer exists.");
    await dm(200, "/workspaces");
    expect(said()).toBe("You have no workspace yet. /setup creates one; /import takes a configuration file.");
    await dm(100, "/workspaces");
    expect(tg.of("sendMessage").at(-1)?.reply_markup.inline_keyboard).toEqual([[{ text: "app", callback_data: "m:ws:app" }]]);
  });
});

describe("groups, topics and preconfigured workspaces", () => {
  it("the shared bot bound to a group picked with the chat request: only owners, only that chat; commands scoped", async () => {
    await dm(100, "/setup");
    await tap(100, "w:bot:shared");
    await dm(100, "acme/app");
    await tap(100, "w:flow:trunk");
    await tap(100, "w:flow:done");
    await post("/telegram", msg(100, undefined, undefined, { chat_shared: { request_id: 2, chat_id: -100777 } }));
    expect(tg.of("sendMessage").at(-2)?.text).toBe("Bound to group -100777.");
    await dm(100, TOKEN);
    await tap(100, "w:role:board:1");
    await tap(100, "w:roles:done");
    await tap(100, "w:confirm");
    const s = await handed();
    app.add({ number: 3, state_label: "board review" });
    await api(s.board, "/v1/escalate", { n: 3, comment: CARD });
    const card = tg.sent("sendRichMessage").at(-1);
    expect(card).toMatchObject({ chat_id: "-100777" });
    expect(card?.message_thread_id).toBeUndefined();
    const group = (from: number, text: string, extra: Record<string, unknown> = {}) => post("/telegram", msg(from, text, { id: -100777, type: "supergroup" }, extra));
    tg.calls = [];
    // a stranger's command and reply in the group: silence
    await group(300, "/todo");
    await group(300, "No.", { reply_to_message: { message_id: card?.id, from: { id: 999 } } });
    expect(tg.calls).toEqual([]);
    // the owner's reply (Telegram adds a thread id to replies in groups without topics) answers it
    await group(100, "Yes.", { reply_to_message: { message_id: card?.id, from: { id: 999 } }, message_thread_id: card?.id });
    expect(app.last(3)).toBe("Owner: Yes.");
    // the wizard runs in private chats only: in the bound group /setup is the envoy's unknown command (text)
    tg.calls = [];
    await group(100, "/setup");
    expect(tg.of("sendMessage").map((m) => [m.chat_id, m.text])).toEqual([["-100777", "Reply to a card to answer it."]]);
  });

  it("a preconfigured workspace of FLOWEE_CONFIG is served, owned by the instance owner, editable in the menu", async () => {
    const other = { ...workspaces.workspaces[1] };
    cfg = { ...CFG, workspaces: [other] };
    expect((await api("o-dev1", "/v1/whoami")).body).toEqual({ ok: true, instance: "dev1", role: "developer" });
    await dm(100, "/workspaces");
    expect(tg.of("sendMessage").at(-1)?.reply_markup.inline_keyboard).toEqual([[{ text: "other", callback_data: "m:ws:other" }]]);
    // editing the flow keeps everything else; nothing new to hand over
    await tap(100, "m:edit:other:flow");
    expect(said()).toContain("3 Flow");
    await tap(100, "w:flow:trunk");
    await tap(100, "w:flow:done");
    expect(said()).toContain("Replace workspace <code>other</code>");
  });
});

describe("management", () => {
  it("rotate, pause and resume, delete with confirmation", async () => {
    const s = await sharedSetup(100);
    await tap(100, "m:rot:app:dev1");
    const fresh = await handed();
    expect(Object.keys(fresh)).toEqual(["dev1"]);
    expect((await api(s.dev1, "/v1/whoami")).status).toBe(401);
    expect((await api(fresh.dev1, "/v1/whoami")).body.instance).toBe("dev1");
    await tap(100, "m:pause:app");
    expect((await api(fresh.dev1, "/v1/whoami")).body).toMatchObject({ ok: false, error: "paused" });
    await tap(100, "m:resume:app");
    expect((await api(fresh.dev1, "/v1/whoami")).status).toBe(200);
    await tap(100, "m:del:app");
    expect(said()).toContain("Delete <b>app</b>?");
    await tap(100, "m:del:app:yes");
    expect((await api(fresh.dev1, "/v1/whoami")).status).toBe(401);
    expect((await admin("GET", "/admin/workspaces")).body.workspaces).toEqual([]);
  });

  it("an own bot: new token through replaceManagedBotToken, access settings", async () => {
    await dm(200, "/setup");
    await tap(200, "w:bot:own");
    await dm(200, "acme/widget");
    await post("/telegram", { update_id: ++uid, managed_bot: { user: { id: 200 }, bot: { id: 777, is_bot: true, first_name: "W", username: "WBot" } } });
    await tap(200, "w:flow:trunk");
    await tap(200, "w:flow:done");
    await tap(200, "w:bind:here");
    await dm(200, TOKEN);
    await tap(200, "w:role:developer:1");
    await tap(200, "w:roles:done");
    await tap(200, "w:confirm");
    await tap(200, "m:tok:widget");
    expect(tg.of("replaceManagedBotToken")).toEqual([{ user_id: 777 }]);
    expect(tg.calls.filter((c) => c.method === "setWebhook" && c.bot === "777:new-token").map((c) => c.params.url)).toEqual(["https://flowee.test/telegram/w/widget"]);
    await tap(200, "m:acc:widget:toggle");
    expect(tg.of("setManagedBotAccessSettings")).toEqual([{ user_id: 777, is_access_restricted: true, added_user_ids: [] }]);
  });
});

describe("export and import", () => {
  it("export -> edit -> import through the chat: only the missing secrets are asked", async () => {
    await sharedSetup(100);
    await dm(100, "/export");
    const out = JSON.parse(await (tg.of("sendDocument").at(-1)?.document as File).text());
    expect(out).toMatchObject({ flowee: 1, workspaces: [{ id: "app" }] });
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    const twin = { ...out.workspaces[0], id: "app-copy" };
    delete twin.chat;
    files["doc-0"] = JSON.stringify(twin);
    await post("/telegram", msg(100, undefined, undefined, { document: { file_id: "doc-0", file_name: "twin.json", file_size: 10 } }));
    expect(said()).toBe("⚠️ Not imported, 1 problem:\n• $.tracker.repos[0]: 'acme/app' is already in workspace 'app'; a repository belongs to one workspace only.");
    const copy = { ...out.workspaces[0], id: "app-copy", tracker: { ...out.workspaces[0].tracker, repos: ["acme/lib"] }, texts: { project: "Copy" } };
    delete copy.chat;
    files["doc-1"] = JSON.stringify(copy);
    await post("/telegram", msg(100, undefined, undefined, { document: { file_id: "doc-1", file_name: "app-copy.json", file_size: 10 } }));
    expect(tg.of("sendMessage").at(-2)?.text).toBe("📥 The document is valid. It will:\n• create <code>app-copy</code>\nI ask only for what is missing, then you confirm.");
    // bot, repositories, flow, chat (none) and agents come from the document: only the token is asked
    expect(said()).toContain("5 GitHub token");
    await dm(100, TOKEN);
    expect(said()).toContain("Create workspace <code>app-copy</code>");
    await tap(100, "w:confirm");
    const s = await handed();
    expect(Object.keys(s)).toEqual(["board", "dev1", "tester", "owner"]);
    const doc = (await admin("GET", "/admin/workspaces/app-copy")).body.workspace;
    expect(doc.texts).toEqual({ project: "Copy" });
    expect(doc.chat).toBeUndefined();
    expect((await api(s.dev1, "/w/app-copy/v1/whoami")).body.instance).toBe("dev1");
  });

  it("a pasted document with problems: one sentence each with its JSON path, nothing created", async () => {
    await dm(100, "/import");
    await dm(100, JSON.stringify({ flowee: 1, id: "Bad Id", flow: { preset: "kanban" }, tracker: { type: "github", repos: [], token: "x" }, roles: [], owners: [] }));
    expect(said()).toBe(
      [
        "⚠️ Not imported, 6 problems:",
        "• $.id: must match ^[a-z0-9][a-z0-9-]{0,62}$.",
        `• $.flow.preset: must be one of ${'"trunk", "pr-release"'}.`,
        "• $.tracker.repos: must have at least 1 item(s).",
        "• $.tracker.token: must match ^[A-Z][A-Z0-9_]*$.",
        "• $.roles: must have at least 1 item(s).",
        "• $.owners: must have at least 1 item(s).",
      ].join("\n").replace(/"/g, "&quot;"),
    );
    await dm(100, "/import");
    await dm(100, "{not json");
    expect(said()).toMatch(/^⚠️ Not imported: \$: is not JSON \(/);
  });

  it("a repository already in a workspace is refused in the wizard and over the API", async () => {
    await sharedSetup(100);
    await dm(200, "/setup");
    await tap(200, "w:bot:shared");
    await dm(200, "acme/app");
    expect(said()).toContain("⚠️ 'acme/app' is already in workspace 'app'; a repository belongs to one workspace only.");
    const doc = { flowee: 1, id: "twin", flow: { preset: "trunk" }, tracker: { type: "github", repos: ["acme/app"], token: "X" }, roles: [{ instance: "owner", role: "owner", secret: "Y" }], owners: [{ name: "A" }] };
    const r = await admin("PUT", "/admin/workspaces/twin", doc);
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("$.workspaces[1].tracker.repos[0]: 'acme/app' is already in workspace 'app'; a repository belongs to one workspace only.");
  });

  it("pasted JSON is imported only as the answer to /import", async () => {
    const doc = JSON.stringify({ flowee: 1, id: "pasted", flow: { preset: "trunk" }, tracker: { type: "github", repos: ["acme/app"], token: "X" }, roles: [{ instance: "owner", role: "owner", secret: "Y" }], owners: [{ name: "A" }] });
    await dm(100, doc);
    expect(said()).toContain("<b>Flowee</b> runs a ticket flow");
    await dm(100, "/import");
    expect(said()).toBe("📥 Send the configuration as a <code>.json</code> file, or paste it as your next message.");
    await dm(100, doc);
    expect(tg.of("sendMessage").at(-2)?.text).toBe("📥 The document is valid. It will:\n• create <code>pasted</code>\nI ask only for what is missing, then you confirm.");
    await tap(100, "w:cancel");
    await dm(100, doc);
    expect(said()).toContain("<b>Flowee</b> runs a ticket flow");
  });

  it("the API: import names the missing secrets, secrets are stored (agents' as digests), export has none", async () => {
    const doc = {
      flowee: 1,
      id: "auto",
      flow: { preset: "trunk" },
      tracker: { type: "github", repos: ["acme/app"], token: "AUTO_GH" },
      roles: [
        { instance: "board", role: "board", secret: "AUTO_BOARD" },
        { instance: "owner", role: "owner", secret: "AUTO_OWNER" },
      ],
      owners: [{ name: "Ann" }],
    };
    expect((await admin("PUT", "/admin/workspaces/auto", doc, "wrong")).status).toBe(401);
    const bad = await admin("PUT", "/admin/workspaces/auto", { ...doc, roles: [] });
    expect(bad.body).toMatchObject({ ok: false, error: "bad_config", problems: ["$.roles: must have at least 1 item(s)."] });
    const r = await admin("PUT", "/admin/workspaces/auto", doc);
    expect(r.body).toEqual({ ok: true, id: "auto", created: true, missing: ["AUTO_GH", "AUTO_BOARD", "AUTO_OWNER"] });
    const sec = await admin("PUT", "/admin/workspaces/auto/secrets", { AUTO_GH: "gh-auto", AUTO_BOARD: "board-secret" });
    expect(sec.body).toEqual({ ok: true, id: "auto", stored: ["AUTO_BOARD", "AUTO_GH"], missing: ["AUTO_OWNER"] });
    expect((await admin("PUT", "/admin/workspaces/auto/secrets", { NOPE: "x" })).body.message).toBe("NOPE: the workspace names no such secret.");
    expect((await api("board-secret", "/v1/whoami")).body).toEqual({ ok: true, instance: "board", role: "board" });
    expect((await api("board-secret", "/w/auto/config")).body.workspace).toEqual(doc);
    const all = await admin("GET", "/admin/workspaces");
    expect(all.body).toEqual({ ok: true, flowee: 1, workspaces: [doc] });
    expect(JSON.stringify(all.body)).not.toMatch(/gh-auto|board-secret/);
    expect((await admin("DELETE", "/admin/workspaces/auto")).body).toEqual({ ok: true, id: "auto", deleted: true });
  });
});

describe("the instance bot's profile", () => {
  it("is set on /setup once per change, with the settings Flowee needs", async () => {
    const first = (await (await worker.fetch(new Request("https://flowee.test/setup"), menv())).json()) as Record<string, Record<string, string>>;
    expect(first.instance).toEqual({ name: "set", description: "set", short_description: "set", commands: "set", settings: "set", photo: "set", webhook: "set" });
    expect(tg.of("setMySettings")).toEqual([
      {
        can_read_all_group_messages: false,
        can_join_groups: true,
        has_topics_enabled: false,
        has_topic_sidebar: false,
        supports_inline_queries: false,
        can_manage_bots: true,
        callback_query_mode: "default",
      },
    ]);
    expect(tg.of("setMyCommands")[0].scope).toEqual({ type: "all_private_chats" });
    expect(tg.of("setWebhook")[0]).toMatchObject({ url: "https://flowee.test/telegram", allowed_updates: ["message", "callback_query", "managed_bot"] });
    expect(tg.of("setMyDescription")[0].description).not.toMatch(/Ann|owner's name/);
    tg.calls = [];
    const again = (await (await worker.fetch(new Request("https://flowee.test/setup"), menv())).json()) as Record<string, Record<string, string>>;
    expect(Object.values(again.instance).every((v) => v === "current")).toBe(true);
    expect(tg.calls).toEqual([]);
  });
});

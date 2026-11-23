// The managed mode end to end against the fake Telegram and GitHub: every screen of the setup wizard and the menu
// with its exact payload, each an edit of the one living message (docs/chat-style.md); typed answers deleted, the
// one reply keyboard and its removal, the new message where an edit is refused; Back, Cancel, resume and expiry,
// routing by bot, chat and topic, two users kept apart, export and import through the chat and the API, the
// instance bot's profile, and who may create.
import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Instance } from "../src/runtime/cloudflare/worker";
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
    for (const t of ["vault", "sessions", "updates", "kv"]) o.host.store.exec(`DELETE FROM ${t}`);
    o.host.store.exec("DROP TABLE IF EXISTS workspaces");
    Object.assign(o.host, { reg: undefined, plain: undefined });
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
/** The living message of a chat: the newest one of the bot with buttons. */
const living = (chat: number | string) => tg.shown(String(chat)).filter((m) => m.html?.includes('<tg-button type="callback_data"')).at(-1);
const screen = (chat: number | string = 100) => living(chat)?.html as string;
const tap = (from: number, data: string, chat = from, message = living(chat)?.id ?? 1) =>
  post("/telegram", { update_id: ++uid, callback_query: { id: `q${uid}`, from: { id: from }, data, message: { message_id: message, chat: { id: chat } } } });
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
  return Object.fromEntries([...text.matchAll(/^mkdir -p \S+ && install -m 600 \/dev\/stdin \S+\/([a-z0-9-]+) <<'EOF'\n([0-9a-f]{64})\nEOF$/gm)].map((m) => [m[1], m[2]]));
}

// ---- the Telegram rich-message markup the screens use ----
const ROW = (...b: string[]) => `<tg-button-row align="center">${b.join("")}</tg-button-row>`;
const CB = (label: string, data: string) => `<tg-button type="callback_data" data="${data}">${label}</tg-button>`;
const URL_ = (label: string, url: string) => `<tg-button type="url" url="${url.replace(/&/g, "&amp;")}">${label}</tg-button>`;
const NAV = ROW(CB("◀ Back", "w:back"), CB("✖ Cancel", "w:cancel"));
const NEXT = (data: string) => ROW(CB("◀ Back", "w:back"), CB("▶ Next", data), CB("✖ Cancel", "w:cancel"));
const DIS = (label: string) => `<tg-button type="disabled">${label}</tg-button>`;
const COPY = (label: string, text: string) => `<tg-button type="copy_text" text="${text}">${label}</tg-button>`;
/** A single-column table of choices or facts, as docs/chat-style.md wants it. */
const TABLE = (...rows: string[]) => `<table bordered striped compact>${rows.join("")}</table>`;
/** One choice: its name and description in one cell, its own buttons in the same row. */
const OPT = (name: string, desc: string, ...buttons: string[]) => `<tr><td><b>${name}</b> · ${desc}</td><td>${buttons.join("")}</td></tr>`;
const FACT = (...cells: string[]) => `<tr>${cells.map((c) => `<td>${c}</td>`).join("")}</tr>`;
const CANCEL = ROW(CB("✖ Cancel", "w:cancel"));

const WELCOME = [
  "<p>👋 <b>Welcome to Flowee</b></p>",
  "<p>Flowee runs a ticket flow for teams of AI agents on your GitHub or GitLab repositories. The tests, questions and decisions that need you arrive here as cards, and you answer them by replying.</p>",
  "<p>A <b>workspace</b> is one project: its repositories, its agents and the chat where its tickets appear.</p>",
  ROW(CB("🚀 Set up a workspace", "w:new")),
  ROW(CB("📥 Import a configuration", "m:import")),
].join("");
const REPOS = (step = "Step 1 of 6", extra = "") =>
  `<p>🆕 <b>New workspace</b> · ${step}</p><p><b>Which repository is this workspace for?</b></p><p>Paste the repository's link from GitHub or GitLab, for example <code>https://github.com/octo/app</code>. Several: one per line.</p>${extra}`;
const BOT = [
  "<p>🆕 <b>New workspace</b> · Step 2 of 6</p>",
  "<p><b>Which bot should bring you the tickets?</b></p>",
  TABLE(
    OPT("💬 This bot (@FloweeTestBot)", "I bring them myself, next to your other workspaces.", CB("💬 Choose", "w:bot:shared")),
    OPT("🤖 A new bot", "Its own name and picture; you create it with two taps, I set it up.", CB("🤖 Choose", "w:bot:own")),
  ),
  NAV,
].join("");
const FLOW = [
  "<p>🆕 <b>New workspace</b> · Step 3 of 6</p>",
  "<p><b>How should the agents bring in their code?</b></p>",
  "<p>Choose one. Versioning and the other options come next; each works with either.</p>",
  TABLE(
    OPT("🌿 Single branch", "The agents commit straight to the main branch; the tester tests the main branch.", CB("🌿 Choose", "w:branch:single")),
    OPT("🔀 Feature branches", "One branch and one pull request per ticket; its checks must be green, and it is merged when the tester passes it.", CB("🔀 Choose", "w:branch:feature")),
  ),
  NAV,
].join("");
const OPTION_TEXT: Record<string, [string, string, string?]> = {
  releases: ["Versioning", "You get a test card only once a published version has the ticket's code; the card says “In 1.4 or later”."],
  uiReview: ["UI review", "A pass that changes the screens comes to you first; it needs the paths that count as UI."],
  dependencyTickets: ["Dependency updates", "Each update pull request (e.g. Dependabot) becomes a ticket the developers merge."],
  userFeedback: ["User feedback", "Tickets carrying the feedback label are triaged by the board automatically.", "Tickets carrying the feedback label wait for a human first."],
};
/** The values an option asked for, in its row once it is on (the defaults here). */
const LINES: Record<string, string> = {
  pullRequests: "Branch name: <code>flowee/{n}</code>; Required checks: none; Merge method: Merge; Who merges: On the pass",
  releases: "Release source: Latest release; Tested tag: none; Hold test cards: on",
  dependencyTickets: "Authors: <code>dependabot[bot]</code>; Labels: none",
  userFeedback: "Feedback label: <code>feedback</code>",
};
const ASKS = new Set(["releases", "uiReview", "dependencyTickets", "userFeedback"]);
const TOGGLE = (f: string, on: Record<string, boolean>, lines: Record<string, string> = {}) =>
  OPT(
    `${on[f] ? "✅" : "⬜"} ${OPTION_TEXT[f][0]}`,
    `${(!on[f] && OPTION_TEXT[f][2]) || OPTION_TEXT[f][1]}${on[f] && ASKS.has(f) ? ` ${lines[f] ?? LINES[f]}` : ""}`,
    CB(on[f] ? "Switch off" : "Switch on", `w:feat:${f}`),
    ...(on[f] && ASKS.has(f) ? [CB("⚙️ Change", `w:in:open:${f}`)] : []),
  );
/** The second screen of the flow step: versioning, then the more options, each a toggle row. */
const OPTIONS = (branching: string, on: Record<string, boolean> = {}, note = "", lines: Record<string, string> = {}) =>
  [
    "<p>🆕 <b>New workspace</b> · Step 3 of 6</p>",
    "<p><b>What else should the flow do?</b></p>",
    `<p>With <b>${branching}</b>. Each switch works on its own; one that needs details asks for them next. You can change them later.</p>`,
    note,
    branching === "Feature branches" ? TABLE(OPT("⚙️ Feature branches", lines.pullRequests ?? LINES.pullRequests, CB("⚙️ Change", "w:in:open:pullRequests"))) : "",
    TABLE(TOGGLE("releases", on, lines)),
    "<p><b>More options</b></p>",
    TABLE(...["uiReview", "dependencyTickets", "userFeedback"].map((f) => TOGGLE(f, on, lines))),
    NEXT("w:flow:done"),
  ].join("");
const WHERE_HERE = [
  "<p>🆕 <b>New workspace</b> · Step 4 of 6</p>",
  "<p><b>Where should the tickets appear?</b></p>",
  TABLE(OPT("💬 Here", "In this chat with me.", CB("💬 Choose", "w:bind:here")), OPT("👥 In a group", "Your team works the tickets together; each answer is recorded with the name of who gave it.", CB("👥 Choose", "w:bind:group"))),
  NAV,
].join("");
const WHERE_GROUP = (bot: string, id: string) =>
  [
    "<p>🆕 <b>New workspace</b> · Step 4 of 6</p>",
    "<p><b>Add the bot to a group</b></p>",
    TABLE(
      OPT("👥 A whole group", `Pick one: Telegram adds @${bot} there, and the group is set.`, URL_("👥 Choose a group", `https://t.me/${bot}?startgroup=${id}`)),
      OPT("🧵 One topic of a forum group", `Add @${bot} to the group, then send <code>/bind ${id}</code> inside that topic.`, COPY("📋 Copy", `/bind ${id}`)),
    ),
    NAV,
  ].join("");
const TOKEN_URL = (id: string, repo: string) =>
  `https://github.com/settings/personal-access-tokens/new?name=Flowee+${id}&description=Flowee%3A+${repo.replace("/", "%2F")}&target_name=${repo.split("/")[0]}&expires_in=366&issues=write&contents=read&repository_hooks=write`;
const CREDENTIAL = (id: string, repo: string, extra = "", step = "Step 5 of 6", lead = "") =>
  [
    `<p>🆕 <b>New workspace</b> · ${step}</p>`,
    lead,
    `<p><b>Send me a GitHub token for <code>${repo}</code></b></p>`,
    "<p>Tap <b>🔑 Create a token</b>: GitHub opens the form with the name, the owner, the permissions and an expiry of 366 days filled in. Create the token and paste it here.</p>",
    TABLE(FACT(`👉 GitHub cannot preselect the repository from a link: under Repository access choose Only select repositories and pick <code>${repo}</code>.`)),
    "<p>🔒 I delete your message right away and keep the token encrypted; it is never shown again.</p>",
    "<p><b>Permissions it needs</b></p>",
    TABLE(FACT("Issues: read and write"), FACT("Contents: read"), FACT("Webhooks: read and write")),
    extra,
    ROW(URL_("🔑 Create a token", TOKEN_URL(id, repo))),
    NAV,
  ].join("");
const AGENT_ROW = (r: string, label: string, desc: string, n: number) => OPT(label, desc, CB("−", `w:role:${r}:-1`), DIS(String(n)), CB("+", `w:role:${r}:1`));
const ROLES = (board: number, dev: number, tester: number, extra = "") =>
  [
    "<p>🆕 <b>New workspace</b> · Step 6 of 6</p>",
    "<p><b>Agent identities</b></p>",
    "<p>Each agent signs in with its own secret, so Flowee knows who holds which ticket. Start with these; you can add or remove agents any time.</p>",
    extra,
    TABLE(
      AGENT_ROW("board", "🧭 Board", "Plans and sorts the tickets, and asks you.", board),
      AGENT_ROW("developer", "🛠 Developers", "Build what the tickets ask for.", dev),
      AGENT_ROW("tester", "🧪 Testers", "Test each ticket before it closes.", tester),
    ),
    NEXT("w:roles:done"),
  ].join("");

/** Everything a step sends: an edit of the living message `id` with this view, and the press answered. */
function edited(id: number, html: string, chat = "100") {
  const edit = tg.calls.filter((c) => c.method === "editMessageText").at(-1)?.params;
  expect(edit).toEqual({ chat_id: chat, message_id: id, rich_message: { html } });
}

/** This bot, one repository, this private chat; returns the agents' secrets. */
async function sharedSetup(user = 100, repo = "acme/app") {
  await dm(user, "/setup");
  await dm(user, repo);
  await tap(user, "w:bot:shared");
  await tap(user, "w:branch:single");
  await tap(user, "w:flow:done");
  await tap(user, "w:bind:here");
  await dm(user, TOKEN);
  await tap(user, "w:roles:done");
  await tap(user, "w:confirm");
  return handed();
}

// The guard of docs/chat-style.md: the wizard and the menu send rich messages only, and a reply keyboard only to
// create a bot. Plain sendMessage calls of the instance bot are allowed only for the envoy's notices listed here.
const ENVOY_NOTICES: RegExp[] = [];
/** docs/chat-style.md, "Layout": no list anywhere, a choice's description and its button in one table row. */
function layout(html: string) {
  expect(html, "list markup in a screen").not.toMatch(/<ul|<ol|<li|<p>[•\-–] /);
  for (const tr of html.match(/<tr>.*?<\/tr>/g) ?? []) if (/^<tr><td><b>[^<]*(<code>[^<]*<\/code>[^<]*)?<\/b> · /.test(tr)) expect(tr, "a choice without its own button in its row").toMatch(/<tg-button/);
  // never a block of descriptions followed by a block of buttons: a button row comes after the last table only
  const lastTable = html.lastIndexOf("</table>");
  if (lastTable >= 0) expect(html.slice(0, lastTable), "buttons between described choices").not.toContain("<tg-button-row");
}

afterEach(() => {
  for (const c of tg.calls) {
    const html = c.params?.rich_message?.html;
    if (typeof html === "string") layout(html);
    if (c.method === "sendMessage") expect(ENVOY_NOTICES.some((n) => n.test(c.params.text)), `plain message: ${c.params.text}`).toBe(true);
    const kb = c.params.reply_markup?.keyboard;
    if (kb) expect(kb.flat().every((k: any) => k.request_managed_bot), "a reply keyboard other than the bot request").toBe(true);
  }
});

describe("the setup wizard: one living message", () => {
  it("this bot, one repository, this chat: every screen exact, each an edit of the same message, typed answers deleted", async () => {
    await dm(100, "/start");
    expect(tg.calls.at(-1)).toMatchObject({ method: "sendRichMessage", params: { chat_id: "100", rich_message: { html: WELCOME } } });
    const id = living(100)?.id as number;
    await tap(100, "w:new");
    edited(id, REPOS() + CANCEL);
    expect(tg.calls.at(-1)).toMatchObject({ method: "answerCallbackQuery", params: { callback_query_id: `q${uid}` } });
    await dm(100, "acme");
    expect(tg.of("deleteMessage").at(-1)).toEqual({ chat_id: "100", message_id: uid });
    edited(id, REPOS("Step 1 of 6", "<p>⚠️ &#39;acme&#39; is not a repository link of GitHub or GitLab; send its link, for example https://github.com/octo/app.</p>".replace(/&#39;/g, "'")) + CANCEL);
    await dm(100, "https://github.com/acme/app/");
    expect(tg.of("deleteMessage").at(-1)).toEqual({ chat_id: "100", message_id: uid });
    edited(id, BOT);
    await tap(100, "w:bot:shared");
    edited(id, FLOW);
    await tap(100, "w:branch:single");
    edited(id, OPTIONS("Single branch"));
    await tap(100, "w:flow:done");
    edited(id, WHERE_HERE);
    await tap(100, "w:bind:group");
    edited(id, WHERE_GROUP("FloweeTestBot", "app"));
    await tap(100, "w:back");
    edited(id, WHERE_HERE);
    await tap(100, "w:bind:here");
    edited(id, CREDENTIAL("app", "acme/app"));
    await dm(100, "too short");
    edited(id, CREDENTIAL("app", "acme/app", "<p>⚠️ That does not look like a GitHub token; paste just the token.</p>"));
    await dm(100, TOKEN);
    expect(tg.of("deleteMessage").at(-1)).toEqual({ chat_id: "100", message_id: uid });
    expect(app.auth.at(-1)).toBe(`Bearer ${TOKEN}`);
    edited(id, ROLES(1, 1, 1));
    await tap(100, "w:role:developer:1");
    edited(id, ROLES(1, 2, 1));
    for (const r of ["board", "developer", "tester", "developer"]) await tap(100, `w:role:${r}:-1`);
    await tap(100, "w:roles:done");
    edited(id, ROLES(0, 0, 0, "<p>⚠️ At least one agent is needed.</p>"));
    for (const r of ["board", "developer", "developer", "tester"]) await tap(100, `w:role:${r}:1`);
    await tap(100, "w:roles:done");
    edited(
      id,
      [
        "<p>🆕 <b>New workspace</b> · Last check</p>",
        "<p><b>Create the workspace <code>app</code>?</b></p>",
        TABLE(
          FACT("📦 Repositories", "<code>acme/app</code> on GitHub"),
          FACT("🤖 Bot", "this bot"),
          FACT("🔀 Way of working", "Single branch"),
          FACT("💬 Tickets appear", "here, in this chat"),
          FACT("🔑 GitHub token", "checked"),
          FACT("👥 Agents", "board, dev1, dev2, tester (each gets a new secret)"),
        ),
        ROW(CB("✅ Create the workspace", "w:confirm")),
        NAV,
      ].join(""),
    );
    await tap(100, "w:confirm");
    edited(
      id,
      [
        "<p>✅ <b>Workspace ready</b> · <code>app</code></p>",
        "<p>These are your agents' sign-in secrets for <code>flowee.py</code>, <b>shown only this once</b>. Save each one on the machine where that agent runs (the file shows where), put the <code>.flowee.toml</code> part into the repository, then delete the file.</p>",
        ROW(CB("📂 My workspaces", "m:list")),
      ].join(""),
    );
    const s = await handed();
    expect(Object.keys(s)).toEqual(["board", "dev1", "dev2", "tester", "owner"]);
    expect(tg.of("sendDocument").at(-1)?.caption).toBe("🔑 Agent secrets: shown only this once.");
    const file = await (tg.of("sendDocument").at(-1)?.document as File).text();
    expect(file).toContain('url = "https://flowee.test"\nworkspace = "app"\ninstance = "board"\nsecret_file = "~/.secrets/flowee/{workspace}/{instance}"');
    expect(file).toContain(`# dev1\nmkdir -p ~/.secrets/flowee/app && install -m 600 /dev/stdin ~/.secrets/flowee/app/dev1 <<'EOF'\n${s.dev1}\nEOF`);
    expect(file.split("\n").slice(0, 4)).toEqual([
      "# Flowee workspace app: the agents' sign-in secrets for flowee.py, shown only this once.",
      "# Flowee keeps only a fingerprint of each; a lost secret is replaced in /workspaces (New agent secret).",
      '# Hand this file to an agent with the address https://flowee.test and say "set this up", or do the two steps below.',
      "# Then delete this file and the message it came in. More: https://flowee.test/docs/agents/",
    ]);
    expect(JSON.parse(tg.of("sendDocument").at(-1)?.reply_markup)).toEqual({
      inline_keyboard: [[{ text: "🗑 Delete this file from the chat", callback_data: "m:rmfile" }], [{ text: "❓ How do I use these?", url: "https://flowee.test/docs/agents/" }]],
    });
    // the whole setup left two messages of the bot in the chat: the living one and the secrets file
    expect(tg.shown("100").map((m) => (m.file ? m.file : m.id))).toEqual([id, "flowee-app-secrets.txt"]);
    expect(tg.of("sendRichMessage").length).toBe(1);
    // the file's own button deletes the file's message, never the living one, and says so in a toast
    const doc0 = tg.sent("sendDocument").at(-1)?.id as number;
    await tap(100, "m:rmfile", 100, doc0);
    expect(tg.of("deleteMessage").at(-1)).toEqual({ chat_id: "100", message_id: doc0 });
    expect(tg.of("answerCallbackQuery").at(-1)?.text).toBe("🗑 Deleted from the chat");
    expect(tg.shown("100").map((m) => m.id)).toEqual([id]);
    // the API serves it by token and by path; the token never shows in the configuration or the sealed store
    expect((await api(s.dev1, "/v1/whoami")).body).toEqual({ ok: true, instance: "dev1", role: "developer" });
    expect((await api(s.dev2, "/w/app/v1/whoami")).body).toEqual({ ok: true, instance: "dev2", role: "developer" });
    const doc = (await admin("GET", "/admin/workspaces/app")).body;
    expect(doc.workspace).toMatchObject({ id: "app", tracker: { repos: ["acme/app"], token: "W_APP_TRACKER" }, chat: { chatId: "100", token: "TELEGRAM_BOT_TOKEN" }, owners: [{ chat: "100" }] });
    expect(doc.missing).toEqual([]);
    // user feedback is a choice either way; left off, it waits for a human first
    expect(doc.workspace.features).toEqual({ userFeedback: { autoTriage: false } });
    expect(JSON.stringify(doc)).not.toContain(TOKEN);
    const sealed = await runInDurableObject(env.INSTANCE.get(env.INSTANCE.idFromName("instance")), (o: Instance) => o.host.store.rows<{ sealed: string }>("SELECT sealed FROM vault"));
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

  it("a new bot of its own, several repositories, one topic of a group: the one reply keyboard and its removal", async () => {
    await dm(200, "/setup");
    const id = living(200)?.id as number;
    await dm(200, "https://github.com/acme/widget/issues/3,\n<git@github.com:acme/lib.git>");
    await tap(200, "w:bot:own");
    edited(
      id,
      [
        "<p>🆕 <b>New workspace</b> · Step 2 of 6</p>",
        "<p><b>Create the new bot</b></p>",
        "<p>Tap <b>🤖 Create the bot</b> on the keyboard below. Telegram suggests the name <b>Widget envoy</b> and the username <code>@widget_envoy_bot</code>; keep them or change them, then confirm.</p>",
        NAV,
      ].join(""),
      "200",
    );
    // the bot can be created only from a reply-keyboard button: it comes on a helper message under the screen
    const helper = tg.calls.filter((c) => c.method === "sendRichMessage").at(-1);
    expect(helper?.params).toEqual({
      chat_id: "200",
      rich_message: { html: "<p>👇 Tap <b>🤖 Create the bot</b> on the keyboard below.</p>" },
      reply_markup: {
        keyboard: [[{ text: "🤖 Create the bot", request_managed_bot: { request_id: 1, suggested_name: "Widget envoy", suggested_username: "widget_envoy_bot" } }]],
        resize_keyboard: true,
        one_time_keyboard: true,
      },
    });
    // someone else's managed bot update changes nothing
    await post("/telegram", { update_id: ++uid, managed_bot: { user: { id: 300 }, bot: { id: 778, is_bot: true, first_name: "X" } } });
    expect(tg.of("getManagedBotToken")).toEqual([]);
    tg.calls = [];
    await post("/telegram", { update_id: ++uid, managed_bot: { user: { id: 200 }, bot: { id: 777, is_bot: true, first_name: "Widget", username: "WidgetEnvoyBot" } } });
    expect(tg.of("getManagedBotToken")).toEqual([{ user_id: 777 }]);
    const hook = tg.calls.find((c) => c.method === "setWebhook" && c.bot === "777:own-token")?.params as Record<string, string>;
    expect(hook.url).toBe("https://flowee.test/telegram/w/widget");
    // the step is done: the keyboard is taken away and both helper messages are gone; the screen moves on
    const gone = tg.calls.find((c) => c.method === "sendRichMessage");
    expect(gone?.params).toEqual({ chat_id: "200", rich_message: { html: "<p>👌</p>" }, reply_markup: { remove_keyboard: true } });
    expect(tg.of("deleteMessage")).toEqual([
      { chat_id: "200", message_id: gone?.id },
      { chat_id: "200", message_id: helper?.id },
    ]);
    expect(screen(200)).toContain("<p><b>How should the agents bring in their code?</b></p>");
    // the note Telegram adds about the new bot is deleted too
    await post("/telegram", msg(200, undefined, undefined, { managed_bot_created: { bot: { id: 777 } } }));
    expect(tg.of("deleteMessage").at(-1)).toEqual({ chat_id: "200", message_id: uid });
    expect(tg.shown("200").map((m) => m.id)).toEqual([id]);
    await tap(200, "w:branch:single");
    await tap(200, "w:flow:done");
    edited(
      id,
      [
        "<p>🆕 <b>New workspace</b> · Step 4 of 6</p>",
        "<p><b>Where should the tickets appear?</b></p>",
        TABLE(
          OPT("💬 In my private chat with @WidgetEnvoyBot", "Open it and press <b>Start</b> once, so it may write to you.", URL_("↗ Open", "https://t.me/WidgetEnvoyBot"), CB("💬 Choose", "w:bind:here")),
          OPT("👥 In a group", "Your team works the tickets together; each answer is recorded with the name of who gave it.", CB("👥 Choose", "w:bind:group")),
        ),
        NAV,
      ].join(""),
      "200",
    );
    await tap(200, "w:bind:group");
    edited(id, WHERE_GROUP("WidgetEnvoyBot", "widget"), "200");
    const topic = (text: string, from = 200, thread = 9) =>
      msg(from, text, { id: -100500, type: "supergroup", is_forum: true, title: "Team" }, { message_thread_id: thread, is_topic_message: true });
    expect((await post("/telegram/w/widget", topic("/bind widget"), "wrong")).status).toBe(403);
    // only the user running the setup binds
    await post("/telegram/w/widget", topic("/bind widget", 300), hook.secret_token);
    expect(screen(200)).toContain("<b>Add the bot to a group</b>");
    await post("/telegram/w/widget", topic("/bind widget"), hook.secret_token);
    const ack = tg.calls.filter((c) => c.method === "sendRichMessage" && c.bot === "777:own-token").at(-1)?.params;
    expect(ack).toEqual({
      chat_id: "-100500",
      message_thread_id: 9,
      rich_message: { html: "<p>✅ <b>Tickets of <code>widget</code> appear here</b></p><p>Your team works the tickets together: reply to a card to answer it, and the ticket records who answered.</p>" },
    });
    expect(screen(200)).toContain("<p><b>Send me a GitHub token for these repositories</b></p>");
    await dm(200, TOKEN);
    expect(gh2.auth.at(-1)).toBe(`Bearer ${TOKEN}`);
    expect(lib.auth.at(-1)).toBe(`Bearer ${TOKEN}`);
    await tap(200, "w:role:tester:-1");
    await tap(200, "w:roles:done");
    expect(screen(200)).toContain(FACT("🤖 Bot", "its own, @WidgetEnvoyBot"));
    expect(screen(200)).toContain(FACT("💬 Tickets appear", "one topic of “Team”"));
    await tap(200, "w:confirm");
    const s = await handed();
    expect(Object.keys(s)).toEqual(["board", "dev1", "owner"]);
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
    await runInDurableObject(env.WORKSPACE.get(env.WORKSPACE.idFromName("widget")), (o) => o.host.store.exec("DELETE FROM meta WHERE k = 'setup'"));
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
    // another topic of the group is not where the tickets are: ignored
    await post("/telegram/w/widget", r(reply(300, 10)), hook.secret_token);
    expect(lib.issues.get(1)?.comments.length).toBe(1);
    // any member in the topic answers, signed with the name Telegram gives
    await post("/telegram/w/widget", r(reply(300, 9)), hook.secret_token);
    expect(lib.last(1)).toBe("U: Green.");
  });

  it("branching, versioning and more options: one choice, then toggles in the same message; their token permissions in the form's link", async () => {
    await dm(100, "/setup");
    await dm(100, "acme/app");
    await tap(100, "w:bot:shared");
    await tap(100, "w:branch:feature");
    expect(screen()).toBe(OPTIONS("Feature branches"));
    // an option that needs details asks for them in the same message; ▶ Done with the defaults switches it on
    await tap(100, "w:feat:releases");
    const HINT = "<p>Tap a value, ✏️ Type your own, or send a <code>.json</code> or text file with the values (an agent can prepare it). ▶ Done keeps what is shown.</p>";
    expect(screen()).toBe(
      [
        "<p>🆕 <b>New workspace</b> · Step 3 of 6</p>",
        "<p><b>How should versioning work?</b></p>",
        HINT,
        TABLE(
          OPT("Release source", "What counts as published: the latest release, or the commit a tag points at.", CB("● Latest release", "w:in:set:source:release"), CB("A tag", "w:in:set:source:tag")),
          OPT("Tested tag", "A tag Flowee moves forward over tested commits; none: no such tag. Now: none.", CB("tested", "w:in:set:testedTag:tested"), CB("✏️ Type", "w:in:type:testedTag")),
          OPT("✅ Hold test cards", "Test cards wait until a published version has the ticket&#39;s code.".replace("&#39;", "'"), CB("Switch off", "w:in:flag:hold")),
        ),
        ROW(CB("◀ Back", "w:in:back"), CB("▶ Done", "w:in:done"), CB("✖ Cancel", "w:cancel")),
      ].join(""),
    );
    // a tag as the source asks for that tag, which is required
    await tap(100, "w:in:set:source:tag");
    expect(screen()).toContain(OPT("Release tag", "The tag that marks the published build. Now: none.", CB("stable", "w:in:set:tag:stable"), CB("latest", "w:in:set:tag:latest"), CB("✏️ Type", "w:in:type:tag")));
    await tap(100, "w:in:done");
    expect(screen()).toContain("<p>⚠️ Release tag: pick one or type your own.</p>");
    await tap(100, "w:in:set:source:release");
    await tap(100, "w:in:done");
    expect(screen()).toBe(OPTIONS("Feature branches", { releases: true }));
    // UI review: suggested paths as rows, typed ones, a sent file; on only once it has one
    await tap(100, "w:feat:uiReview");
    await tap(100, "w:in:done");
    expect(screen()).toContain("<p>⚠️ UI paths: pick at least one, type your own or send a file.</p>");
    expect(screen()).toContain(OPT("⬜ <code>src/components/**</code>", "suggested", CB("Add", "w:in:tog:paths:0")));
    await tap(100, "w:in:tog:paths:0");
    await tap(100, "w:in:type:paths");
    expect(screen()).toContain("<p>Type ui paths as your next message, one per line.</p>");
    await dm(100, "app/ui/**\n- web/views/**");
    expect(tg.of("deleteMessage").at(-1)).toEqual({ chat_id: "100", message_id: uid });
    files["paths-0"] = JSON.stringify({ paths: ["src/components/**", "app/ui/**", "web/views/**", "**/*.css"] });
    await post("/telegram", msg(100, undefined, undefined, { document: { file_id: "paths-0", file_name: "ui.json", file_size: 10 } }));
    expect(screen()).toContain(OPT("UI paths", "A change under one of these comes to you before it closes. Now: <code>src/components/**</code>, <code>app/ui/**</code>, <code>web/views/**</code>, <code>**/*.css</code>.", CB("✏️ Type", "w:in:type:paths"), CB("✖ Clear", "w:in:clear:paths")));
    await tap(100, "w:in:done");
    const UI = "UI paths: <code>src/components/**</code>, <code>app/ui/**</code>, <code>web/views/**</code>, <code>**/*.css</code>";
    expect(screen()).toBe(OPTIONS("Feature branches", { releases: true, uiReview: true }, "", { uiReview: UI }));
    // switched off and on again, the values are kept
    await tap(100, "w:feat:uiReview");
    await tap(100, "w:feat:uiReview");
    await tap(100, "w:in:done");
    expect(screen()).toBe(OPTIONS("Feature branches", { releases: true, uiReview: true }, "", { uiReview: UI }));
    // feature branches: their settings from the row above the options
    await tap(100, "w:in:open:pullRequests");
    await tap(100, "w:in:set:method:squash");
    await tap(100, "w:in:done");
    expect(screen()).toContain(OPT("⚙️ Feature branches", "Branch name: <code>flowee/{n}</code>; Required checks: none; Merge method: Squash; Who merges: On the pass", CB("⚙️ Change", "w:in:open:pullRequests")));
    await tap(100, "w:feat:uiReview");
    // back to the branching: the choice is marked, versioning stays on with the other branching
    await tap(100, "w:back");
    expect(screen()).toBe(FLOW.replace(CB("🔀 Choose", "w:branch:feature"), CB("● Chosen", "w:branch:feature")));
    await tap(100, "w:branch:single");
    expect(screen()).toBe(OPTIONS("Single branch", { releases: true }));
    await tap(100, "w:back");
    await tap(100, "w:branch:feature");
    await tap(100, "w:flow:done");
    await tap(100, "w:bind:here");
    expect(screen()).toContain(
      TABLE(
        FACT("Issues: read and write"),
        FACT("Contents: read and write"),
        FACT("Pull requests: read and write"),
        FACT("Checks: read"),
        FACT("Commit statuses: read"),
        FACT("Webhooks: read and write"),
      ),
    );
    expect(screen()).toContain(
      URL_("🔑 Create a token", "https://github.com/settings/personal-access-tokens/new?name=Flowee+app&description=Flowee%3A+acme%2Fapp&target_name=acme&expires_in=366&issues=write&contents=write&pull_requests=write&checks=read&statuses=read&repository_hooks=write"),
    );
    await dm(100, TOKEN);
    await tap(100, "w:roles:done");
    expect(screen()).toContain(FACT("🔀 Way of working", "Feature branches, Versioning"));
    await tap(100, "w:confirm");
    const doc = (await admin("GET", "/admin/workspaces/app")).body.workspace;
    expect(doc).toMatchObject({ flow: { preset: "pr-release" }, features: { pullRequests: { method: "squash" }, releases: true } });
    expect(doc.features.uiReview).toBeUndefined();
  });

  it("user feedback asks for its label; switched off it still writes the label, waiting for a human", async () => {
    await dm(100, "/setup");
    await dm(100, "acme/app");
    await tap(100, "w:bot:shared");
    await tap(100, "w:branch:single");
    await tap(100, "w:feat:userFeedback");
    expect(screen()).toContain("<p><b>Which label marks user feedback?</b></p>");
    expect(screen()).toContain(OPT("Feedback label", "Tickets carrying this label hold a user&#39;s text. Now: <code>feedback</code>.".replace("&#39;", "'"), CB("user-report", "w:in:set:label:user-report"), CB("✏️ Type", "w:in:type:label")));
    await tap(100, "w:in:type:label");
    await dm(100, "from users");
    await tap(100, "w:in:done");
    expect(screen()).toBe(OPTIONS("Single branch", { userFeedback: true }, "", { userFeedback: "Feedback label: <code>from users</code>" }));
    await tap(100, "w:feat:userFeedback");
    await tap(100, "w:flow:done");
    await tap(100, "w:bind:here");
    await dm(100, TOKEN);
    await tap(100, "w:roles:done");
    await tap(100, "w:confirm");
    expect((await admin("GET", "/admin/workspaces/app")).body.workspace.features).toEqual({ userFeedback: { label: "from users", autoTriage: false } });
  });

  it("a workspace with an extension keeps its extension and the extension's agents through a wizard edit", async () => {
    const doc = {
      flowee: 1,
      id: "pics",
      flow: { preset: "trunk" },
      extensions: ["builtin:samples"],
      tracker: { repos: ["acme/pics"], token: "PICS_TOKEN" },
      roles: [
        { instance: "board", role: "board", secret: "PICS_BOARD" },
        { instance: "sampler", role: "sampler", secret: "PICS_SAMPLER" },
        { instance: "owner", role: "owner", secret: "PICS_OWNER" },
      ],
      owners: [{ chat: "100" }],
    };
    expect((await admin("PUT", "/admin/workspaces/pics", doc)).status).toBe(200);
    await dm(100, "/workspaces");
    await tap(100, "m:ws:pics");
    expect(screen()).toContain(FACT("👥 Agents", "board, sampler"));
    await tap(100, "m:edit:pics:flow");
    await tap(100, "w:branch:single");
    await tap(100, "w:flow:done");
    await tap(100, "w:confirm");
    const after = (await admin("GET", "/admin/workspaces/pics")).body.workspace;
    expect(after.extensions).toEqual(["builtin:samples"]);
    expect(after.roles.map((r: { instance: string }) => r.instance)).toEqual(["board", "sampler", "owner"]);
  });

  it("a token that reaches other repositories: one sentence, use it anyway or make a narrower one", async () => {
    const fake = globalThis.fetch;
    globalThis.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(new Request(i, init).url);
      if (u.pathname === "/user/repos") return Response.json([{ full_name: "acme/app" }, { full_name: "acme/secret" }, { full_name: "acme/other" }]);
      return fake(i, init);
    }) as typeof fetch;
    await dm(100, "/setup");
    await dm(100, "acme/app");
    await tap(100, "w:bot:shared");
    await tap(100, "w:branch:single");
    await tap(100, "w:flow:done");
    await tap(100, "w:bind:here");
    await dm(100, TOKEN);
    expect(screen()).toBe(
      [
        "<p>🆕 <b>New workspace</b> · Step 5 of 6</p>",
        "<p><b>This token reaches more than it needs</b></p>",
        "<p>Besides <code>acme/app</code> it can also reach <code>acme/secret</code>, <code>acme/other</code>; a narrower token limits what a leak could do.</p>",
        TABLE(
          OPT("✅ Use it anyway", "Keep this token; you can replace it later in the workspace's menu.", CB("✅ Use it", "w:wide:keep")),
          OPT("🔑 Make a narrower one", "A token for <code>acme/app</code> only: paste it here when you have it.", CB("🔑 Narrower", "w:wide:new")),
        ),
        NAV,
      ].join(""),
    );
    await tap(100, "w:wide:new");
    expect(screen()).toBe(CREDENTIAL("app", "acme/app"));
    await dm(100, TOKEN);
    await tap(100, "w:wide:keep");
    expect(screen()).toContain("<p><b>Agent identities</b></p>");
    globalThis.fetch = fake;
  });

  it("every choice screen: each option's name, description and own button in one table row", async () => {
    const seen: Record<string, string> = {};
    const at = (name: string) => (seen[name] = screen());
    await dm(100, "/setup");
    await dm(100, "acme/app");
    at("bot");
    await tap(100, "w:bot:shared");
    at("branching");
    await tap(100, "w:branch:single");
    at("options");
    await tap(100, "w:flow:done");
    at("where");
    await tap(100, "w:bind:group");
    at("group");
    await tap(100, "w:back");
    await tap(100, "w:bind:here");
    await dm(100, TOKEN);
    at("agents");
    const rows = { bot: 2, branching: 2, options: 4, where: 2, group: 2, agents: 3 };
    for (const [name, n] of Object.entries(rows)) {
      const options = (seen[name].match(/<tr><td><b>.*?<\/tr>/g) ?? []).filter((tr) => tr.includes("</b> · "));
      expect(options.length, name).toBe(n);
      for (const tr of options) expect(tr, name).toMatch(/<\/td><td>(<tg-button[^>]*>[^<]*<\/tg-button>)+<\/td><\/tr>$/);
      layout(seen[name]);
    }
  });

  it("GitLab: gitlab.com and a self-managed host are recognised; the token step names GitLab, its scope and role, and probes GitLab", async () => {
    const GL = `glpat-${"b".repeat(20)}`;
    await dm(100, "/setup");
    await dm(100, "https://gitlab.com/acme/backend/api/-/issues/3");
    expect(screen()).toContain("<p><b>Which bot should bring you the tickets?</b></p>");
    await tap(100, "w:back");
    expect(screen()).toContain("<p>Now: <code>acme/backend/api</code> on GitLab</p>");
    await tap(100, "w:repos:keep");
    await tap(100, "w:bot:shared");
    await tap(100, "w:branch:feature");
    await tap(100, "w:flow:done");
    await tap(100, "w:bind:here");
    expect(screen()).toContain("<p><b>Send me a GitLab token for <code>acme/backend/api</code></b></p>");
    expect(screen()).toContain("<p>Tap <b>🔑 Create a token</b>: GitLab opens the project&#39;s access token page. Create the token and paste it here.</p>".replace("&#39;", "'"));
    expect(screen()).toContain(TABLE(FACT("👉 GitLab cannot fill in a project token from a link: name it Flowee api, choose the role Developer, the scope api and an expiry date 365 days ahead.")));
    expect(screen()).toContain(TABLE(FACT("Scope: api"), FACT("Role in each project: Developer (Maintainer to merge into a protected main branch)"), FACT("Webhooks: Maintainer, else Flowee checks the tracker every minute")));
    // one project: its project access token page first, a prefilled personal token as the alternative row
    expect(screen()).toContain(
      TABLE(
        OPT("🔑 Project token", "Reaches this project only.", URL_("🔑 Create a token", "https://gitlab.com/acme/backend/api/-/settings/access_tokens")),
        OPT("🔑 A personal token instead", "On GitLab.com a project token needs Premium; a personal token works everywhere but reaches every project you can reach.", URL_("↗ Open", "https://gitlab.com/-/user_settings/personal_access_tokens?name=Flowee+api&description=Flowee%3A+acme%2Fbackend%2Fapi&scopes=api")),
      ),
    );
    expect(screen()).not.toContain("GitHub");
    await dm(100, GL);
    await tap(100, "w:roles:done");
    expect(screen()).toContain(FACT("📦 Repositories", "<code>acme/backend/api</code> on GitLab"));
    expect(screen()).toContain(FACT("🔑 GitLab token", "checked"));
    await tap(100, "w:confirm");
    const doc = (await admin("GET", "/admin/workspaces/api")).body.workspace;
    expect(doc.tracker).toMatchObject({ type: "gitlab", repos: ["acme/backend/api"], token: "W_API_TRACKER" });
    expect(doc.tracker.api).toBeUndefined();
    // a self-managed GitLab, by its host and GitLab's /-/ routes; mixing trackers in one paste is refused in one sentence
    await dm(200, "/setup");
    await dm(200, "https://github.com/acme/widget https://gitlab.com/acme/backend/hooks");
    expect(screen(200)).toContain("<p>⚠️ Paste the repositories of one tracker here; a workspace on several trackers is written as a configuration and imported (📥 Import).</p>");
    await dm(200, "https://gitlab.example.com/team/tools/lib/-/merge_requests/2");
    await tap(200, "w:back");
    expect(screen(200)).toContain("<p>Now: <code>team/tools/lib</code> on GitLab</p>");
  });

  it("leaving the bot step by Back or Cancel takes the reply keyboard away", async () => {
    await dm(200, "/setup");
    await dm(200, "acme/widget");
    await tap(200, "w:bot:own");
    const helper = tg.sent("sendRichMessage").at(-1);
    expect(helper?.reply_markup?.keyboard).toBeDefined();
    await tap(200, "w:back");
    expect(tg.sent("sendRichMessage").at(-1)?.reply_markup).toEqual({ remove_keyboard: true });
    expect(tg.of("deleteMessage").at(-1)).toEqual({ chat_id: "200", message_id: helper?.id });
    expect(screen(200)).toBe(BOT.replace(CB("🤖 Choose", "w:bot:own"), CB("● Chosen", "w:bot:own")));
    await tap(200, "w:bot:own");
    const again = tg.sent("sendRichMessage").at(-1);
    await tap(200, "w:cancel");
    expect(tg.sent("sendRichMessage").at(-1)?.reply_markup).toEqual({ remove_keyboard: true });
    expect(tg.of("deleteMessage").at(-1)).toEqual({ chat_id: "200", message_id: again?.id });
    expect(screen(200)).toBe(
      ["<p>✖ <b>Setup cancelled</b></p>", "<p>Nothing was created.</p>", ROW(CB("🚀 Start again", "w:new"), CB("📂 My workspaces", "m:list"))].join(""),
    );
    expect(tg.shown("200").length).toBe(1);
  });

  it("an edit Telegram refuses: the screen comes as a new message and the old one is deleted", async () => {
    await dm(100, "/setup");
    const old = living(100)?.id as number;
    tg.refuse = { editMessageText: "Bad Request: message can't be edited" };
    await dm(100, "acme/app");
    const fresh = tg.sent("sendRichMessage").at(-1);
    expect(fresh).toMatchObject({ chat_id: "100", rich_message: { html: BOT } });
    expect(tg.of("deleteMessage").at(-1)).toEqual({ chat_id: "100", message_id: old });
    tg.refuse = {};
    await tap(100, "w:bot:shared");
    edited(fresh?.id as number, FLOW);
  });

  it("a typed command shows its screen anew at the bottom and deletes the previous one", async () => {
    await dm(100, "/start");
    const first = living(100)?.id as number;
    await dm(100, "/setup");
    expect(tg.sent("sendRichMessage").at(-1)).toMatchObject({ rich_message: { html: REPOS() + CANCEL } });
    expect(tg.of("deleteMessage").at(-1)).toEqual({ chat_id: "100", message_id: first });
    expect(tg.shown("100").length).toBe(1);
  });

  it("a Telegram refusal in the wizard shows in the living message as one sentence", async () => {
    await dm(200, "/setup");
    await dm(200, "acme/widget");
    await tap(200, "w:bot:own");
    tg.refuse.getManagedBotToken = "Bad Request: bot not found";
    await post("/telegram", { update_id: ++uid, managed_bot: { user: { id: 200 }, bot: { id: 777, is_bot: true, first_name: "Widget", username: "WidgetEnvoyBot" } } });
    expect(screen(200)).toBe(
      ["<p>⚠️ <b>That did not work</b></p>", "<p>Telegram refused getManagedBotToken: Bad Request: bot not found.</p>", ROW(CB("▶ Continue the setup", "w:resume"))].join(""),
    );
    // a press that fails is answered with the error as its toast
    tg.refuse = { editMessageText: "Bad Request: x", sendRichMessage: "Forbidden: bot was blocked by the user" };
    await tap(200, "w:back");
    expect(tg.of("answerCallbackQuery").at(-1)).toEqual({ callback_query_id: `q${uid}`, text: "⚠️ Telegram refused sendRichMessage: Forbidden: bot was blocked by the user." });
  });

  it("a token message the bot cannot delete: the screen asks the user to delete it", async () => {
    await dm(100, "/setup");
    await dm(100, "acme/app");
    await tap(100, "w:bot:shared");
    await tap(100, "w:branch:single");
    await tap(100, "w:flow:done");
    await tap(100, "w:bind:here");
    tg.refuse = { deleteMessage: "Bad Request: message can't be deleted" };
    await dm(100, TOKEN);
    expect(screen()).toBe(
      ROLES(1, 1, 1, "<p>⚠️ I could not delete your message (Telegram refused deleteMessage: Bad Request: message can&#39;t be deleted.); please delete it yourself.</p>".replace("&#39;", "'")),
    );
  });

  it("a refused profile of the own bot: the workspace is made, the user told, the secrets handed over", async () => {
    await dm(200, "/setup");
    await dm(200, "acme/web");
    await tap(200, "w:bot:own");
    await post("/telegram", { update_id: ++uid, managed_bot: { user: { id: 200 }, bot: { id: 777, is_bot: true, first_name: "Widget", username: "WidgetEnvoyBot" } } });
    await tap(200, "w:branch:single");
    await tap(200, "w:flow:done");
    await tap(200, "w:bind:here");
    await dm(200, TOKEN);
    await tap(200, "w:role:board:-1");
    await tap(200, "w:role:tester:-1");
    await tap(200, "w:roles:done");
    tg.refuse = { setMySettings: "Bad Request: not enough rights" };
    await tap(200, "w:confirm");
    expect(screen(200)).toContain(
      "<p>✅ <b>Workspace ready</b> · <code>web</code></p><p>⚠️ The bot&#39;s profile was not set (Telegram refused setMySettings: Bad Request: not enough rights.); the next deploy tries again.</p>".replace("&#39;", "'"),
    );
    expect(Object.keys(await handed())).toEqual(["dev1", "owner"]);
    expect((await admin("GET", "/admin/workspaces/web")).status).toBe(200);
  });

  it("agents' secrets the chat refuses as a file come as a rich message: they are shown once", async () => {
    tg.refuse = { sendDocument: "Bad Request: file is too big" };
    await sharedSetup(100);
    const last = tg.sent("sendRichMessage").at(-1)?.rich_message.html as string;
    expect(last).toMatch(/^<p>🔑 <b>Agent secrets<\/b> · <code>app<\/code><\/p><pre># Flowee workspace app: the agents' sign-in secrets for flowee.py/);
    expect(last).toMatch(/^[0-9a-f]{64}$/m);
    expect(last).toContain('data="m:rmfile">🗑 Delete this file from the chat</tg-button>');
  });

  it("Back, Cancel, resume and expiry", async () => {
    await dm(100, "/setup");
    await dm(100, "acme/app");
    expect(screen()).toBe(BOT);
    await tap(100, "w:back");
    expect(screen()).toBe(
      REPOS("Step 1 of 6", "<p>Now: <code>acme/app</code> on GitHub</p>") + ROW(CB("✅ Keep acme/app", "w:repos:keep")) + CANCEL,
    );
    await tap(100, "w:repos:keep");
    expect(screen()).toBe(BOT);
    await tap(100, "w:cancel");
    expect(screen()).toBe(["<p>✖ <b>Setup cancelled</b></p>", "<p>Nothing was created.</p>", ROW(CB("🚀 Start again", "w:new"), CB("📂 My workspaces", "m:list"))].join(""));
    // an old button of the finished setup
    await tap(100, "w:bot:shared");
    expect(screen()).toBe(["<p>⌛ <b>This setup is over</b></p>", "<p>It was finished or cancelled.</p>", ROW(CB("🚀 Set up a workspace", "w:new"))].join(""));
    await tap(100, "w:new");
    await dm(100, "acme/app");
    await dm(100, "/setup");
    expect(screen()).toBe(
      [
        "<p>🆕 <b>New workspace</b></p>",
        "<p><b>Continue the setup you started?</b></p>",
        "<p>You began setting up a workspace earlier and did not finish it.</p>",
        ROW(CB("▶ Continue", "w:resume"), CB("🆕 Start over", "w:restart")),
      ].join(""),
    );
    await tap(100, "w:resume");
    expect(screen()).toBe(BOT);
    await runInDurableObject(env.INSTANCE.get(env.INSTANCE.idFromName("instance")), (o: Instance) => {
      const row = o.host.store.rows<{ data: string }>("SELECT data FROM sessions WHERE user = '100'")[0];
      const s = JSON.parse(row.data);
      s.ts -= 25 * 3600e3;
      o.host.store.exec("UPDATE sessions SET data = ? WHERE user = '100'", JSON.stringify(s));
    });
    await tap(100, "w:bot:shared");
    expect(screen()).toBe(["<p>⌛ <b>This setup expired</b></p>", "<p>A day passed without an answer, so nothing was created.</p>", ROW(CB("🚀 Start again", "w:new"))].join(""));
    expect((await admin("GET", "/admin/workspaces")).body.workspaces).toEqual([]);
    expect(tg.shown("100").length).toBe(1);
  });

  it("only allowed users create workspaces, up to the limit; users never see each other's workspaces", async () => {
    await dm(300, "/setup");
    expect(screen(300)).toBe(
      ["<p>⚠️ <b>You cannot set up a workspace</b></p>", "<p>Only the people this instance allows may set up workspaces; ask its owner.</p>", ROW(CB("📂 My workspaces", "m:list"))].join(""),
    );
    await sharedSetup(100);
    await dm(200, "/start");
    await tap(200, "m:ws:app");
    expect(screen(200)).toBe(
      ["<p>⚠️ <b>Not yours to manage</b></p>", "<p>Only the people who manage <code>app</code> can change it; ask the one who set it up.</p>", ROW(CB("📂 My workspaces", "m:list"))].join(""),
    );
    await dm(200, "/workspaces");
    expect(screen(200)).toBe(["<p>📂 <b>Your workspaces</b></p>", "<p>You have none yet.</p>", ROW(CB("🚀 Set up a workspace", "w:new"), CB("📥 Import", "m:import"))].join(""));
  });
});

describe("the management menu: one living message", () => {
  const WS = (paused = false, note = "") =>
    [
      `<p>📂 <b><code>app</code></b> · ${paused ? "⏸ paused" : "▶ running"}</p>`,
      note,
      TABLE(
        FACT("📦 Repositories", "<code>acme/app</code>", CB("✏️ Change", "m:edit:app:repos")),
        FACT("🤖 Bot", "this bot"),
        FACT("🔀 Way of working", "Single branch", CB("✏️ Change", "m:edit:app:flow")),
        FACT("💬 Tickets appear", "your private chat with this bot", CB("✏️ Change", "m:edit:app:bind")),
        FACT("🔑 GitHub token", "never shown", CB("✏️ Change", "m:edit:app:credential")),
        FACT("👥 Agents", "board, dev1, tester"),
        FACT("⚡ Instant updates", "off for app (not set up yet); the tracker is checked every minute", CB("⚡ Turn on", "m:hook:app")),
      ),
      TABLE(
        OPT("➕ Add an agent", "A new identity with its own secret; the other agents keep theirs.", CB("➕ Add", "m:add:app")),
        OPT("➖ Remove an agent", "Its secret stops working, and the tickets it holds go back to the queue.", CB("➖ Remove", "m:rmag:app")),
        OPT("🔑 New agent secret", "One agent gets a new secret; its old one stops working.", CB("🔑 New secret", "m:rot:app")),
        OPT("📤 Export", "The configuration without secrets, as a file to edit and import again.", CB("📤 Export", "m:exp:app")),
        paused
          ? OPT("▶ Resume", "The agents' API and the chat work again.", CB("▶ Resume", "m:resume:app"))
          : OPT("⏸ Pause", "The agents' API answers that it is paused, and the chat stays quiet.", CB("⏸ Pause", "m:pause:app")),
        OPT("🗑 Delete", "Its configuration, secrets and state go; the repositories stay.", CB("🗑 Delete", "m:del:app")),
      ),
      ROW(CB("« All workspaces", "m:list")),
    ].join("");

  it("list, workspace, rotate, export, pause and resume, delete: every screen an edit of the same message, with toasts", async () => {
    const s = await sharedSetup(100);
    await dm(100, "/workspaces");
    const id = living(100)?.id as number;
    expect(screen()).toBe(
      [
        "<p>📂 <b>Your workspaces</b></p>",
        '<table bordered striped compact><tr><th>Workspace</th><th>Repositories</th><th>State</th><th></th></tr><tr><td>app</td><td>acme/app</td><td>▶ running</td><td><tg-button type="callback_data" style="primary" data="m:ws:app">Open</tg-button></td></tr></table>',
        ROW(CB("🚀 New workspace", "w:new"), CB("📥 Import", "m:import")),
      ].join(""),
    );
    await tap(100, "m:ws:app");
    edited(id, WS());
    await tap(100, "m:rot:app");
    edited(
      id,
      [
        "<p>🔑 <b>New agent secret</b> · <code>app</code></p>",
        "<p><b>Which agent gets a new secret?</b></p>",
        "<p>Its old secret stops working at once.</p>",
        TABLE(...[["board", "board"], ["dev1", "developer"], ["tester", "tester"], ["owner", "owner"]].map(([i, r]) => OPT(i, r, CB("🔑 New secret", `m:rot:app:${i}`)))),
        ROW(CB("« Back", "m:ws:app")),
      ].join(""),
    );
    await tap(100, "m:rot:app:dev1");
    edited(id, ["<p>🔑 <b>New secret for <code>dev1</code></b></p>", "<p>It is in the file below, <b>shown only this once</b>, with the line that stores it on the agent's machine. The old one no longer works.</p>", ROW(CB("« Back", "m:ws:app"))].join(""));
    expect(tg.of("answerCallbackQuery").at(-1)).toEqual({ callback_query_id: `q${uid}`, text: "🔑 New secret below" });
    const fresh = await handed();
    expect(Object.keys(fresh)).toEqual(["dev1"]);
    expect((await api(s.dev1, "/v1/whoami")).status).toBe(401);
    expect((await api(fresh.dev1, "/v1/whoami")).body.instance).toBe("dev1");
    await tap(100, "m:ws:app");
    await tap(100, "m:exp:app");
    expect(tg.of("sendDocument").at(-1)?.caption).toBe("📤 The configuration, without secrets: edit it and send it back to import it.");
    expect(tg.of("answerCallbackQuery").at(-1)?.text).toBe("📤 Sent below");
    await tap(100, "m:pause:app");
    edited(id, WS(true, "<p>⏸ Paused: the agents' API answers that it is paused, and the chat stays quiet until you resume it.</p>"));
    expect(tg.of("answerCallbackQuery").at(-1)?.text).toBe("⏸ Paused");
    expect((await api(fresh.dev1, "/v1/whoami")).body).toMatchObject({ ok: false, error: "paused" });
    await tap(100, "m:resume:app");
    edited(id, WS(false, "<p>▶ Running again.</p>"));
    expect((await api(fresh.dev1, "/v1/whoami")).status).toBe(200);
    await tap(100, "m:del:app");
    edited(
      id,
      [
        "<p>🗑 <b>Delete <code>app</code>?</b></p>",
        "<p>Its configuration, secrets and stored state go for good; the repositories and their issues stay.</p>",
        ROW(CB("🗑 Delete it", "m:del:app:yes"), CB("« Keep it", "m:ws:app")),
      ].join(""),
    );
    await tap(100, "m:del:app:yes");
    edited(id, ["<p>🗑 <b><code>app</code> is deleted</b></p>", "<p>The repositories and their issues are untouched.</p>", ROW(CB("📂 My workspaces", "m:list"))].join(""));
    expect((await api(fresh.dev1, "/v1/whoami")).status).toBe(401);
    expect((await admin("GET", "/admin/workspaces")).body.workspaces).toEqual([]);
  });

  it("add an agent and remove one: one identity minted or revoked, the others untouched, a removed agent's ticket back in the queue", async () => {
    const s = await sharedSetup(100);
    await dm(100, "/workspaces");
    const id = living(100)?.id as number;
    await tap(100, "m:ws:app");
    await tap(100, "m:add:app");
    edited(
      id,
      [
        "<p>➕ <b>Add an agent</b> · <code>app</code></p>",
        "<p><b>Which kind of agent?</b></p>",
        "<p>It gets its own secret, shown once; the other agents keep theirs.</p>",
        TABLE(
          OPT("🧭 Board", "Plans and sorts the tickets, and asks you.", CB("➕ Add", "m:add:app:board")),
          OPT("🛠 Developers", "Build what the tickets ask for.", CB("➕ Add", "m:add:app:developer")),
          OPT("🧪 Testers", "Test each ticket before it closes.", CB("➕ Add", "m:add:app:tester")),
        ),
        ROW(CB("« Back", "m:ws:app")),
      ].join(""),
    );
    await tap(100, "m:add:app:developer");
    edited(id, ["<p>➕ <b><code>dev2</code> added</b></p>", "<p>Its secret is in the file below, <b>shown only this once</b>; the other agents keep theirs.</p>", ROW(CB("« Back", "m:ws:app"))].join(""));
    expect(tg.of("answerCallbackQuery").at(-1)?.text).toBe("➕ Agent added");
    const dev2 = (await handed()).dev2;
    expect((await api(dev2, "/v1/whoami")).body).toEqual({ ok: true, instance: "dev2", role: "developer" });
    expect((await api(s.dev1, "/v1/whoami")).body.instance).toBe("dev1");
    app.add({ number: 1, state_label: "ready" });
    expect((await api(s.dev1, "/v1/next", {})).body.ticket).toMatchObject({ n: 1 });
    await tap(100, "m:ws:app");
    await tap(100, "m:rmag:app");
    expect(screen()).toContain(OPT("dev1", "🛠 Developers", CB("➖ Remove", "m:rmag:app:dev1")));
    await tap(100, "m:rmag:app:dev1");
    edited(
      id,
      [
        "<p>➖ <b>Remove <code>dev1</code>?</b></p>",
        "<p>Its secret stops working at once, and the tickets it holds go back to the queue; the other agents are not touched.</p>",
        ROW(CB("➖ Remove it", "m:rmag:app:dev1:yes"), CB("« Back", "m:ws:app")),
      ].join(""),
    );
    await tap(100, "m:rmag:app:dev1:yes");
    expect(tg.of("answerCallbackQuery").at(-1)?.text).toBe("➖ Agent removed");
    expect(screen()).toContain("<p>➖ <code>dev1</code> is removed; its tickets go back to the queue.</p>");
    expect(screen()).toContain(FACT("👥 Agents", "board, tester, dev2"));
    expect(tg.of("answerCallbackQuery").at(-1)?.text).toBe("➖ Agent removed");
    expect((await api(s.dev1, "/v1/whoami")).status).toBe(401);
    expect((await api(s.board, "/v1/whoami")).body.instance).toBe("board");
    await runDurableObjectAlarm(env.WORKSPACE.get(env.WORKSPACE.idFromName("app")));
    expect((await api(dev2, "/v1/next", {})).body.ticket).toMatchObject({ n: 1 });
    // the workspace object outlives the test: wipe it, so its claim does not reach the next test's
    await tap(100, "m:del:app:yes");
  });

  it("instant updates: the workspace screen offers them, the manual way shows the address and a secret once; a paused workspace acknowledges deliveries and ignores them", async () => {
    const s = await sharedSetup(100);
    await dm(100, "/workspaces");
    const id = living(100)?.id as number;
    await tap(100, "m:ws:app");
    await tap(100, "m:hook:app");
    expect(screen()).toContain("<p>⚡ <b>Turn on instant updates</b> · <code>app</code></p>");
    expect(screen()).toContain(OPT("🔗 app", "<code>acme/app</code>", CB("🔗 By hand", "m:hook:app:app")));
    await tap(100, "m:hook:app:app");
    const html = screen();
    expect(html).toContain("<code>https://flowee.test/hooks/app/app</code>");
    expect(html).toContain("Settings → Webhooks");
    const secret = /<td>Secret<\/td><td><code>([0-9a-f]{64})<\/code>/.exec(html)?.[1] as string;
    expect(secret).toBeTruthy();
    expect(living(100)?.id).toBe(id);
    const ping = JSON.stringify({ zen: "Design for failure.", hook_id: 1, repository: { full_name: "acme/app" } });
    const sig = async (body: string) => {
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      return `sha256=${[...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)))].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
    };
    const post = async (body: string, signature: string, delivery: string) =>
      worker.fetch(new Request("https://flowee.test/hooks/app/app", { method: "POST", headers: { "x-github-event": "ping", "x-github-delivery": delivery, "x-hub-signature-256": signature }, body }), menv());
    expect((await post(ping, "sha256=00", "d1")).status).toBe(401);
    expect((await post(ping, await sig(ping), "d2")).status).toBe(200);
    await runDurableObjectAlarm(env.WORKSPACE.get(env.WORKSPACE.idFromName("app")));
    expect((await api(s.board, "/w/app/config")).body.sync.repos[0]).toMatchObject({ alias: "app", mode: "webhook", via: "manual" });
    await tap(100, "m:ws:app");
    expect(screen()).toContain(FACT("⚡ Instant updates", "on"));
    await tap(100, "m:pause:app");
    const r = await post(ping, "not even signed", "d3");
    expect([r.status, await r.text()]).toEqual([200, "ok"]);
    expect((await worker.fetch(new Request("https://flowee.test/hooks/nope/app", { method: "POST", body: "{}" }), menv())).status).toBe(401);
  });

  it("editing one part opens that step in the living message, then asks to save", async () => {
    await sharedSetup(100);
    await dm(100, "/workspaces");
    await tap(100, "m:ws:app");
    const id = living(100)?.id as number;
    await tap(100, "m:edit:app:repos");
    edited(
      id,
      [
        "<p>✏️ <b>Change <code>app</code></b></p>",
        "<p><b>Which repository is this workspace for?</b></p>",
        "<p>Paste the repository's link from GitHub or GitLab, for example <code>https://github.com/octo/app</code>. Several: one per line.</p>",
        "<p>Now: <code>acme/app</code> on GitHub</p>",
        ROW(CB("✅ Keep acme/app", "w:repos:keep")),
        CANCEL,
      ].join(""),
    );
    await dm(100, "github.com/acme/app\ngithub.com/acme/lib");
    expect(screen()).toContain("<p><b>Save the changes to <code>app</code>?</b></p>");
    expect(screen()).toContain(ROW(CB("✅ Save the changes", "w:confirm")));
    await tap(100, "w:cancel");
    expect(screen()).toBe(["<p>✖ <b>Nothing changed</b></p>", "<p>The workspace stays as it was.</p>", ROW(CB("📂 My workspaces", "m:list"))].join(""));
  });

  it("an own bot: new token through replaceManagedBotToken, access settings", async () => {
    await dm(200, "/setup");
    await dm(200, "acme/widget");
    await tap(200, "w:bot:own");
    await post("/telegram", { update_id: ++uid, managed_bot: { user: { id: 200 }, bot: { id: 777, is_bot: true, first_name: "W", username: "WBot" } } });
    await tap(200, "w:branch:single");
    await tap(200, "w:flow:done");
    await tap(200, "w:bind:here");
    await dm(200, TOKEN);
    await tap(200, "w:roles:done");
    await tap(200, "w:confirm");
    await tap(200, "m:ws:widget");
    expect(screen(200)).toContain(OPT("♻️ New bot token", "The bot gets a new token; the old one stops working.", CB("♻️ New token", "m:tok:widget")));
    expect(screen(200)).toContain(OPT("🔐 Who may use the bot", "Anyone, or only the people you allow.", CB("🔐 Open", "m:acc:widget")));
    await tap(200, "m:tok:widget");
    expect(tg.of("replaceManagedBotToken")).toEqual([{ user_id: 777 }]);
    expect(tg.calls.filter((c) => c.method === "setWebhook" && c.bot === "777:new-token").map((c) => c.params.url)).toEqual(["https://flowee.test/telegram/w/widget"]);
    expect(screen(200)).toContain("<p>♻️ The bot has a new token; the old one no longer works.</p>");
    await tap(200, "m:acc:widget");
    expect(screen(200)).toBe(
      [
        "<p>🔐 <b>Who may use the bot</b> · <code>widget</code></p>",
        TABLE(OPT("⬜ Only me", "Anyone can start the bot; it answers only the workspace's owners.", CB("Switch on", "m:acc:widget:toggle"))),
        ROW(CB("« Back", "m:ws:widget")),
      ].join(""),
    );
    await tap(200, "m:acc:widget:toggle");
    expect(tg.of("setManagedBotAccessSettings")).toEqual([{ user_id: 777, is_access_restricted: true, added_user_ids: [] }]);
    expect(screen(200)).toContain(OPT("✅ Only me", "Only you can start the bot.", CB("Switch off", "m:acc:widget:toggle")));
  });
});

describe("groups, topics and preconfigured workspaces", () => {
  it("this bot added to a group by its link: /start <code> there binds it; the group is a team, only the creator manages", async () => {
    await dm(100, "/setup");
    await dm(100, "acme/app");
    await tap(100, "w:bot:shared");
    await tap(100, "w:branch:single");
    await tap(100, "w:flow:done");
    await tap(100, "w:bind:group");
    // what Telegram makes the user send when the link t.me/<bot>?startgroup=app added the bot
    const group = (from: number, text: string, extra: Record<string, unknown> = {}) => post("/telegram", msg(from, text, { id: -100777, type: "supergroup", title: "Team" }, extra));
    await group(100, "/start@FloweeTestBot app");
    expect(tg.sent("sendRichMessage").at(-1)).toMatchObject({
      chat_id: "-100777",
      rich_message: { html: "<p>✅ <b>Tickets of <code>app</code> appear here</b></p><p>Your team works the tickets together: reply to a card to answer it, and the ticket records who answered.</p>" },
    });
    expect(screen()).toContain("<p><b>Send me a GitHub token for <code>acme/app</code></b></p>");
    await dm(100, TOKEN);
    await tap(100, "w:roles:done");
    expect(screen()).toContain(FACT("💬 Tickets appear", "the group “Team”"));
    await tap(100, "w:confirm");
    const s = await handed();
    app.add({ number: 3, state_label: "board review" });
    await api(s.board, "/v1/escalate", { n: 3, comment: CARD });
    const card = tg.sent("sendRichMessage").at(-1);
    expect(card).toMatchObject({ chat_id: "-100777" });
    expect(card?.message_thread_id).toBeUndefined();
    tg.calls = [];
    // a team: every member of the group works the inbox, and the ticket says who answered
    const bea = { from: { id: 300, is_bot: false, first_name: "Bea", last_name: "Berg", username: "bea" } };
    const cid = { from: { id: 301, is_bot: false, first_name: "Cid" } };
    const onCard = (id = card?.id) => ({ reply_to_message: { message_id: id, from: { id: 999 } } });
    await group(300, "No.", { ...onCard(), ...bea });
    expect(app.last(3)).toBe("Bea Berg (@bea): No.");
    // the second person is told, in one sentence, who answered first; nothing more lands on the ticket
    const comments = app.issues.get(3)?.comments.length;
    await group(100, "Yes.", { ...onCard(), message_thread_id: card?.id });
    expect(app.issues.get(3)?.comments.length).toBe(comments);
    expect(tg.sent("sendRichMessage").at(-1)).toMatchObject({ chat_id: "-100777", rich_message: { html: "<p>⚠️ #3 was already answered by Bea Berg (@bea); yours was not recorded.</p>" } });
    // two members at once: one answer is recorded, the other one hears who was first
    app.add({ number: 4, state_label: "board review" });
    await api(s.board, "/v1/escalate", { n: 4, comment: CARD });
    const card4 = tg.sent("sendRichMessage").at(-1);
    await Promise.all([group(300, "Blue.", { ...onCard(card4?.id), ...bea }), group(301, "Green.", { ...onCard(card4?.id), ...cid })]);
    expect(app.issues.get(4)?.comments.filter((c: { body: string }) => /^(Bea Berg \(@bea\)|Cid): /.test(c.body)).length).toBe(1);
    expect(tg.sent("sendRichMessage").at(-1)?.rich_message.html).toMatch(/^<p>⚠️ #4 was already answered by (Bea Berg \(@bea\)|Cid); yours was not recorded\.<\/p>$/);
    // managing stays with the one who set it up: a member is refused in one sentence
    await dm(300, "/workspaces");
    expect(screen(300)).toContain("<p>You have none yet.</p>");
    await tap(300, "m:ws:app");
    expect(screen(300)).toBe(
      ["<p>⚠️ <b>Not yours to manage</b></p>", "<p>Only the people who manage <code>app</code> can change it; ask the one who set it up.</p>", ROW(CB("📂 My workspaces", "m:list"))].join(""),
    );
    // the wizard runs in private chats only: in the bound group /setup is the envoy's unknown command (text)
    tg.calls = [];
    await group(100, "/setup");
    expect(tg.sent("sendRichMessage").map((m) => [m.chat_id, m.rich_message.html])).toEqual([["-100777", "<p>Reply to a card to answer it.</p>"]]);
  });

  it("a preconfigured workspace of FLOWEE_CONFIG is served, owned by the instance owner, editable in the menu", async () => {
    const other = { ...workspaces.workspaces[1] };
    cfg = { ...CFG, workspaces: [other] };
    expect((await api("o-dev1", "/v1/whoami")).body).toEqual({ ok: true, instance: "dev1", role: "developer" });
    await dm(100, "/workspaces");
    expect(screen()).toContain('<td>other</td>');
    expect(screen()).toContain('data="m:ws:other">Open</tg-button>');
    // editing the flow keeps everything else; nothing new to hand over
    await tap(100, "m:edit:other:flow");
    expect(screen()).toContain("<p>✏️ <b>Change <code>other</code></b></p><p><b>How should the agents bring in their code?</b></p>");
    expect(screen()).toContain(CB("● Chosen", "w:branch:single"));
    await tap(100, "w:branch:single");
    await tap(100, "w:flow:done");
    expect(screen()).toContain("<p><b>Save the changes to <code>other</code>?</b></p>");
  });
});

describe("export and import", () => {
  const PROMPT = ["<p>📥 <b>Import a configuration</b></p>", "<p>Send the <code>.json</code> file, or paste the configuration as your next message.</p>", ROW(CB("✖ Cancel", "m:noimport"))].join("");

  it("managers the creator names in the document manage the workspace too; the creator stays its creator", async () => {
    await sharedSetup(100);
    await dm(100, "/export");
    const out = JSON.parse(await (tg.of("sendDocument").at(-1)?.document as File).text());
    await dm(100, "/import");
    await dm(100, JSON.stringify({ ...out.workspaces[0], managers: ["300"] }));
    await tap(100, "w:confirm");
    expect((await admin("GET", "/admin/workspaces/app")).body.workspace.managers).toEqual(["300"]);
    await dm(300, "/workspaces");
    expect(screen(300)).toContain('data="m:ws:app"');
    await tap(300, "m:ws:app");
    await tap(300, "m:pause:app");
    expect(tg.of("answerCallbackQuery").at(-1)?.text).toBe("⏸ Paused");
    // a manager's changes keep the creator's ownership and do not make the manager an owner of the inbox
    await tap(300, "m:edit:app:roles");
    await tap(300, "w:roles:done");
    await tap(300, "w:confirm");
    const doc = (await admin("GET", "/admin/workspaces/app")).body;
    expect(doc.workspace.owners).toEqual([{ chat: "100" }]);
    await dm(100, "/workspaces");
    expect(screen(100)).toContain('data="m:ws:app"');
  });

  it("export -> edit -> import through the chat: only the missing secrets are asked", async () => {
    await sharedSetup(100);
    await dm(100, "/export");
    expect(tg.of("sendDocument").at(-1)?.caption).toBe("📤 Your workspaces, without secrets.");
    const out = JSON.parse(await (tg.of("sendDocument").at(-1)?.document as File).text());
    expect(out).toMatchObject({ flowee: 1, workspaces: [{ id: "app" }] });
    expect(JSON.stringify(out)).not.toContain(TOKEN);
    const twin = { ...out.workspaces[0], id: "app-copy" };
    delete twin.chat;
    files["doc-0"] = JSON.stringify(twin);
    await post("/telegram", msg(100, undefined, undefined, { document: { file_id: "doc-0", file_name: "twin.json", file_size: 10 } }));
    expect(screen()).toBe(
      [
        "<p>⚠️ <b>Not imported</b></p>",
        "<p>The configuration has a problem:</p>",
        "<table bordered striped compact><tr><td>$.tracker.repos[0]: 'acme/app' is already in workspace 'app'; a repository belongs to one workspace only.</td></tr></table>",
        "<p>Fix it and send it again; nothing was changed.</p>",
        ROW(CB("✖ Cancel", "m:noimport")),
      ].join(""),
    );
    const copy = { ...out.workspaces[0], id: "app-copy", tracker: { ...out.workspaces[0].tracker, repos: ["acme/lib"] }, texts: { project: "Copy" } };
    delete copy.chat;
    files["doc-1"] = JSON.stringify(copy);
    await post("/telegram", msg(100, undefined, undefined, { document: { file_id: "doc-1", file_name: "app-copy.json", file_size: 10 } }));
    // bot, repositories, flow, chat (none) and agents come from the document: only the token is asked
    expect(screen()).toBe(
      CREDENTIAL("app-copy", "acme/lib", "", "Step 1 of 1", "<p>📥 The configuration is valid and will create <code>app-copy</code>. I ask only for what is missing, then you confirm.</p>").replace(NAV, CANCEL),
    );
    await dm(100, TOKEN);
    expect(screen()).toContain("<p><b>Create the workspace <code>app-copy</code>?</b></p>");
    await tap(100, "w:confirm");
    const s = await handed();
    expect(Object.keys(s)).toEqual(["board", "dev1", "tester", "owner"]);
    const doc = (await admin("GET", "/admin/workspaces/app-copy")).body.workspace;
    expect(doc.texts).toEqual({ project: "Copy" });
    expect(doc.chat).toBeUndefined();
    expect((await api(s.dev1, "/w/app-copy/v1/whoami")).body.instance).toBe("dev1");
  });

  it("a pasted document with problems: one sentence each with its JSON path, in the living message; nothing created", async () => {
    await dm(100, "/import");
    expect(screen()).toBe(PROMPT);
    await dm(100, JSON.stringify({ flowee: 1, id: "Bad Id", flow: { preset: "kanban" }, tracker: { type: "github", repos: [], token: "x" }, roles: [], owners: [] }));
    expect(tg.of("deleteMessage").at(-1)).toEqual({ chat_id: "100", message_id: uid });
    expect(screen()).toBe(
      [
        "<p>⚠️ <b>Not imported</b></p>",
        "<p>The configuration has 6 problems:</p>",
        TABLE(
          FACT("$.id: must match ^[a-z0-9][a-z0-9-]{0,62}$."),
          FACT(`$.flow.preset: must be one of ${'"trunk", "pr-release"'.replace(/"/g, "&quot;")}.`),
          FACT("$.tracker.repos: must have at least 1 item(s)."),
          FACT("$.tracker.token: must match ^[A-Z][A-Z0-9_]*$."),
          FACT("$.roles: must have at least 1 item(s)."),
          FACT("$.owners: must have at least 1 item(s)."),
        ),
        "<p>Fix it and send it again; nothing was changed.</p>",
        ROW(CB("✖ Cancel", "m:noimport")),
      ].join(""),
    );
    // still waiting for the configuration
    await dm(100, "{not json");
    expect(screen()).toMatch(/^<p>⚠️ <b>Not imported<\/b><\/p><p>The configuration has a problem:<\/p><table bordered striped compact><tr><td>\$: is not JSON \(/);
    await tap(100, "m:noimport");
    expect(screen()).toBe(WELCOME);
    expect(tg.shown("100").length).toBe(1);
  });

  it("a repository already in a workspace is refused in the wizard and over the API", async () => {
    await sharedSetup(100);
    await dm(200, "/setup");
    await dm(200, "acme/app");
    expect(screen(200)).toContain("<p>⚠️ 'acme/app' is already in your workspace 'app'; a repository belongs to one workspace only.</p>");
    const doc = { flowee: 1, id: "twin", flow: { preset: "trunk" }, tracker: { type: "github", repos: ["acme/app"], token: "X" }, roles: [{ instance: "owner", role: "owner", secret: "Y" }], owners: [{ name: "A" }] };
    const r = await admin("PUT", "/admin/workspaces/twin", doc);
    expect(r.status).toBe(400);
    expect(r.body.message).toBe("$.workspaces[1].tracker.repos[0]: 'acme/app' is already in workspace 'app'; a repository belongs to one workspace only.");
  });

  it("pasted JSON is imported only as the answer to /import or 📥 Import", async () => {
    const doc = JSON.stringify({ flowee: 1, id: "pasted", flow: { preset: "trunk" }, tracker: { type: "github", repos: ["acme/app"], token: "X" }, roles: [{ instance: "owner", role: "owner", secret: "Y" }], owners: [{ name: "A" }] });
    await dm(100, doc);
    expect(screen()).toBe(WELCOME);
    await tap(100, "m:import");
    expect(screen()).toBe(PROMPT);
    await dm(100, doc);
    expect(screen()).toContain("<p>📥 The configuration is valid and will create <code>pasted</code>. I ask only for what is missing, then you confirm.</p>");
    await tap(100, "w:cancel");
    await dm(100, doc);
    expect(screen()).toBe(WELCOME);
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

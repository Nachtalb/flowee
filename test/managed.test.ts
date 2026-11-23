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
import { wording } from "./wording";
import workspaces from "./workspaces.json";
import security from "./fixtures/security-review.json";

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
const api = async (token: string, path: string, body?: unknown) => {
  // `<project key>|<agent>`: the key acting as that agent
  const [secret, agent] = token.split("|");
  const r = await worker.fetch(
    new Request(`https://flowee.test${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${secret}`, "content-type": "application/json", ...(agent ? { "x-flowee-agent": agent } : {}) },
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
/**
 * What the last file handed over: the project key (`key`) and secrets of agents a document names. With a key, the
 * agents `names` are created through the API, each as `<key>|<name>` (the api helper sends the name).
 */
async function handed(names = ["board", "dev1", "dev2", "tester", "owner"]): Promise<Record<string, string>> {
  const f = tg.of("sendDocument").at(-1)?.document as File;
  const text = await f.text();
  const got: Record<string, string> = Object.fromEntries([...text.matchAll(/^mkdir -p \S+ && install -m 600 \/dev\/stdin \S+\/([a-z0-9-]+) <<'EOF'\n([0-9a-f]{64})\nEOF$/gm)].map((m) => [m[1], m[2]]));
  if (got.key)
    for (const n of names) {
      await api(got.key, "/v1/agents", { role: n.startsWith("dev") ? "developer" : n, name: n });
      got[n] = `${got.key}|${n}`;
    }
  return got;
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
const REPOS = (step = "Step 1 of 7", extra = "") =>
  `<p>🆕 <b>New workspace</b> · ${step}</p><p><b>Which repository is this workspace for?</b></p><p>Paste the repository's link from GitHub or GitLab, for example <code>https://github.com/octo/app</code>. Several: one per line.</p>${extra}`;
const BOT = [
  "<p>🆕 <b>New workspace</b> · Step 2 of 7</p>",
  "<p><b>Which bot should bring you the tickets?</b></p>",
  TABLE(
    OPT("💬 This bot (@FloweeTestBot)", "I bring them myself, next to your other workspaces.", CB("💬 Choose", "w:next:shared")),
    OPT("🤖 A new bot", "Its own name and picture; you create it with two taps, I set it up.", CB("🤖 Choose", "w:next:own")),
  ),
  NAV,
].join("");
const FLOW = [
  "<p>🆕 <b>New workspace</b> · Step 3 of 7</p>",
  "<p><b>How should the agents bring in their code?</b></p>",
  TABLE(
    OPT("🌿 Single branch", "The agents commit straight to the main branch, and testing happens there.", CB("🌿 Choose", "w:next:single")),
    OPT("🔀 Feature branches", "Each ticket gets its own branch and pull request, merged once its checks pass and the ticket passed testing.", CB("🔀 Choose", "w:next:feature")),
  ),
  NAV,
].join("");
const OPTION_TEXT: Record<string, [string, string, string?]> = {
  releases: ["Releases", "Each request to test a ticket says which release has its change."],
  uiReview: ["UI review", "A change to the screens comes to you before its ticket is closed."],
  dependencyTickets: ["Dependency updates", "Each update pull request (e.g. from Dependabot) becomes a ticket an agent checks and merges."],
  userFeedback: ["User feedback", "An agent sorts tickets with the feedback label like any other, reading them as text from outside.", "Tickets with the feedback label wait for you before an agent works on them."],
};
/** The values an option asked for, in its row once it is on (the defaults here). */
const LINES: Record<string, string> = {
  pullRequests: "Branch name: <code>flowee/{n}</code>; Required checks: all of them; Merge method: Merge; Who merges: Flowee, after testing",
  releases: "Wait for a release: on; What counts as released: The newest release",
  dependencyTickets: "Opened by: <code>dependabot[bot]</code>",
  userFeedback: "Feedback label: <code>feedback</code>",
};
const ASKS = new Set(["releases", "uiReview", "dependencyTickets", "userFeedback"]);
const TOGGLE = (f: string, on: Record<string, boolean>, lines: Record<string, string> = {}) =>
  OPT(
    `${on[f] ? "✅" : "⬜"} ${OPTION_TEXT[f][0]}`,
    `${(!on[f] && OPTION_TEXT[f][2]) || OPTION_TEXT[f][1]}${on[f] && ASKS.has(f) ? ` ${lines[f] ?? LINES[f]}` : ""}`,
    CB(on[f] ? "Switch off" : "⚙️ Configure", `w:${on[f] ? "switch" : "configure"}:${f}`),
    ...(on[f] && ASKS.has(f) ? [CB("⚙️ Change", `w:configure:${f}`)] : []),
  );
/** The second screen of the flow step: versioning, then the more options, each a toggle row. */
const OPTIONS = (branching: string, on: Record<string, boolean> = {}, note = "", lines: Record<string, string> = {}) =>
  [
    "<p>🆕 <b>New workspace</b> · Step 4 of 7</p>",
    "<p><b>What else should Flowee do?</b></p>",
    note,
    branching === "Feature branches" ? TABLE(OPT("⚙️ Feature branches", lines.pullRequests ?? LINES.pullRequests, CB("⚙️ Change", "w:configure:pullRequests"))) : "",
    TABLE(TOGGLE("releases", on, lines)),
    "<p><b>More options</b></p>",
    TABLE(...["uiReview", "dependencyTickets", "userFeedback"].map((f) => TOGGLE(f, on, lines))),
    TABLE(OPT("🧩 Custom steps", `Steps and rules of your own, from an extension file${lines.ext ? `: ${lines.ext}` : ""}.`, CB(lines.ext ? "🧩 Change" : "🧩 Add", "w:extensions"))),
    NEXT("w:next"),
  ].join("");
const WHERE_HERE = [
  "<p>🆕 <b>New workspace</b> · Step 5 of 7</p>",
  "<p><b>Where should the tickets appear?</b></p>",
  TABLE(OPT("💬 Here", "In this chat with me.", CB("💬 Choose", "w:next:here")), OPT("👥 In a group", "Your team works the tickets together; each answer is recorded with the name of who gave it.", CB("👥 Choose", "w:next:group"))),
  NAV,
].join("");
const WHERE_GROUP = (bot: string, id: string, step = "Step 6 of 8") =>
  [
    `<p>🆕 <b>New workspace</b> · ${step}</p>`,
    "<p><b>Add the bot to a group</b></p>",
    TABLE(
      OPT("👥 A whole group", `Pick one: Telegram adds @${bot} there, and the group is set.`, URL_("👥 Choose a group", `https://t.me/${bot}?startgroup=${id}`)),
      OPT("🧵 One topic of a forum group", `Add @${bot} to the group, then send <code>/bind ${id}</code> inside that topic.`, COPY("📋 Copy", `/bind ${id}`)),
    ),
    NAV,
  ].join("");
const TOKEN_URL = (id: string, repo: string) =>
  `https://github.com/settings/personal-access-tokens/new?name=Flowee+${id}&description=Flowee%3A+${repo.replace("/", "%2F")}&target_name=${repo.split("/")[0]}&expires_in=366&issues=write&contents=read&repository_hooks=write`;
const CREDENTIAL = (id: string, repo: string, extra = "", step = "Step 6 of 7", lead = "") =>
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
/** Everything a step sends: an edit of the living message `id` with this view, and the press answered. */
function edited(id: number, html: string, chat = "100") {
  const edit = tg.calls.filter((c) => c.method === "editMessageText").at(-1)?.params;
  expect(edit).toEqual({ chat_id: chat, message_id: id, rich_message: { html } });
}

/** This bot, one repository, this private chat; returns the project key and the agents made with it. */
async function sharedSetup(user = 100, repo = "acme/app") {
  await dm(user, "/setup");
  await dm(user, repo);
  await tap(user, "w:next:shared");
  await tap(user, "w:next:single");
  await tap(user, "w:next");
  await tap(user, "w:next:here");
  await dm(user, TOKEN);
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
    if (typeof html === "string") {
      layout(html);
      wording(html);
    }
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
    edited(id, REPOS("Step 1 of 7", "<p>⚠️ &#39;acme&#39; is not a repository link of GitHub or GitLab; send its link, for example https://github.com/octo/app.</p>".replace(/&#39;/g, "'")) + CANCEL);
    await dm(100, "https://github.com/acme/app/");
    expect(tg.of("deleteMessage").at(-1)).toEqual({ chat_id: "100", message_id: uid });
    edited(id, BOT);
    await tap(100, "w:next:shared");
    edited(id, FLOW);
    await tap(100, "w:next:single");
    edited(id, OPTIONS("Single branch"));
    await tap(100, "w:next");
    edited(id, WHERE_HERE);
    await tap(100, "w:next:group");
    edited(id, WHERE_GROUP("FloweeTestBot", "app"));
    // back on the screen before: the group is marked, and still counted until another choice
    await tap(100, "w:back");
    edited(id, WHERE_HERE.replace("Step 5 of 7", "Step 5 of 8").replace(CB("👥 Choose", "w:next:group"), CB("● Chosen", "w:next:group")));
    await tap(100, "w:next:here");
    edited(id, CREDENTIAL("app", "acme/app"));
    await dm(100, "too short");
    edited(id, CREDENTIAL("app", "acme/app", "<p>⚠️ That does not look like a GitHub token; paste just the token.</p>"));
    await dm(100, TOKEN);
    expect(tg.of("deleteMessage").at(-1)).toEqual({ chat_id: "100", message_id: uid });
    expect(app.auth.at(-1)).toBe(`Bearer ${TOKEN}`);
    edited(
      id,
      [
        "<p>🆕 <b>New workspace</b> · Step 7 of 7 · Last check</p>",
        "<p><b>Create the workspace <code>app</code>?</b></p>",
        TABLE(
          FACT("📦 Repositories", "<code>acme/app</code> on GitHub"),
          FACT("🤖 Bot", "this bot"),
          FACT("🔀 Way of working", "Single branch"),
          FACT("💬 Tickets appear", "here, in this chat"),
          FACT("🔑 GitHub token", "checked"),
          FACT("🗝 Project key", "a new one, shown once"),
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
        "<p>Below is the workspace's <b>project key</b> for <code>flowee.py</code>, <b>shown only this once</b>. Store it where your agents run (the file shows the line), put the <code>.flowee.toml</code> part into the repository, then delete the file. Your agents read the roles and create themselves with it; you see them in 📂 My workspaces.</p>",
        ROW(CB("📂 My workspaces", "m:list")),
      ].join(""),
    );
    expect(tg.of("sendDocument").at(-1)?.caption).toBe("🔑 Project key: shown only this once.");
    const file = await (tg.of("sendDocument").at(-1)?.document as File).text();
    const key = /\/key <<'EOF'\n([0-9a-f]{64})\nEOF/.exec(file)?.[1] as string;
    expect(file).toContain(`mkdir -p ~/.secrets/flowee/app && install -m 600 /dev/stdin ~/.secrets/flowee/app/key <<'EOF'\n${key}\nEOF`);
    expect(file).toContain('url = "https://flowee.test"\nworkspace = "app"\nkey_file = "~/.secrets/flowee/{workspace}/key"\nagent = "dev1"');
    expect(file).toContain("#    python3 flowee.py roles\n#    python3 flowee.py agents add developer dev1\n#    python3 flowee.py agents\n");
    expect(file.split("\n").slice(0, 5)).toEqual([
      "# Flowee workspace app: the project key for flowee.py, shown only this once.",
      "# With it your agents list the roles of the flow, create themselves and work the tickets. Flowee keeps only a",
      "# fingerprint; a lost key is replaced in /workspaces (New project key), and the old one stops working.",
      '# Hand this file to an agent with the address https://flowee.test and say "set this up", or do the three steps below.',
      "# Then delete this file and the message it came in. More: https://flowee.test/docs/agents/",
    ]);
    expect(JSON.parse(tg.of("sendDocument").at(-1)?.reply_markup)).toEqual({
      inline_keyboard: [[{ text: "🗑 Delete this file from the chat", callback_data: "m:rmfile" }], [{ text: "❓ How do I use this?", url: "https://flowee.test/docs/agents/" }]],
    });
    // the agents create themselves with the key: the roles first, then one agent per run
    expect((await api(key, "/v1/roles")).body.roles.map((r: { name: string }) => r.name)).toEqual(["board", "developer", "tester", "owner"]);
    const s = await handed();
    // the whole setup left two messages of the bot in the chat: the living one and the secrets file
    expect(tg.shown("100").map((m) => (m.file ? m.file : m.id))).toEqual([id, "flowee-app-key.txt"]);
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
    expect(sealed.length).toBe(2);
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
    await tap(200, "w:next:own");
    edited(
      id,
      [
        "<p>🆕 <b>New workspace</b> · Step 3 of 8</p>",
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
    await tap(200, "w:next:single");
    await tap(200, "w:next");
    edited(
      id,
      [
        "<p>🆕 <b>New workspace</b> · Step 6 of 8</p>",
        "<p><b>Where should the tickets appear?</b></p>",
        TABLE(
          OPT("💬 In my private chat with @WidgetEnvoyBot", "Open it and press <b>Start</b> once, so it may write to you.", URL_("↗ Open", "https://t.me/WidgetEnvoyBot"), CB("💬 Choose", "w:next:here")),
          OPT("👥 In a group", "Your team works the tickets together; each answer is recorded with the name of who gave it.", CB("👥 Choose", "w:next:group")),
        ),
        NAV,
      ].join(""),
      "200",
    );
    await tap(200, "w:next:group");
    edited(id, WHERE_GROUP("WidgetEnvoyBot", "widget", "Step 7 of 9"), "200");
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
    expect(screen(200)).toContain(FACT("🤖 Bot", "its own, @WidgetEnvoyBot"));
    expect(screen(200)).toContain(FACT("💬 Tickets appear", "one topic of “Team”"));
    await tap(200, "w:confirm");
    const s = await handed();
    expect(Object.keys(s)).toContain("key");
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
    await tap(100, "w:next:shared");
    await tap(100, "w:next:feature");
    expect(screen()).toBe(OPTIONS("Feature branches"));
    // an option that needs details asks for them in the same message; ✅ Apply with the defaults switches it on
    await tap(100, "w:configure:releases");
    expect(screen()).toBe(
      [
        "<p>🆕 <b>New workspace</b> · Releases</p>",
        "<p><b>How do releases work?</b></p>",
        TABLE(
          OPT("✅ Wait for a release", "You are asked to test a ticket only once a release contains its change.", CB("Switch off", "w:flag:hold")),
          OPT("What counts as released", "The newest release on GitHub, or a git tag you move yourself (e.g. stable).", CB("● The newest release", "w:set:source:release"), CB("A git tag", "w:set:source:tag")),
          OPT("⚙️ Advanced", "Rarely needed: Mark tested code with a tag.", CB("Show", "w:advanced")),
        ),
        ROW(CB("◀ Back", "w:back"), CB("✅ Apply", "w:apply"), CB("✖ Cancel", "w:cancel")),
      ].join(""),
    );
    // a tag as the source asks for that tag, which is required
    await tap(100, "w:set:source:tag");
    // switched off, the row says what happens instead
    await tap(100, "w:flag:hold");
    expect(screen()).toContain(OPT("⬜ Wait for a release", "You are asked right away; the request names the release once one has the change.", CB("Switch on", "w:flag:hold")));
    await tap(100, "w:flag:hold");
    // the rare setting behind Advanced, its value in words
    await tap(100, "w:advanced");
    expect(screen()).toContain(OPT("Mark tested code with a tag", "Flowee keeps a git tag on the newest commit whose tickets all passed testing. Now: off.", CB("tested", "w:set:testedTag:tested"), CB("✏️ Type", "w:type:testedTag")));
    expect(screen()).toContain(OPT("⚙️ Advanced", "Rarely needed: Mark tested code with a tag.", CB("Hide", "w:advanced")));
    expect(screen()).toContain(OPT("Release tag", "The git tag you move onto each released commit. Now: not set yet.", CB("stable", "w:set:tag:stable"), CB("latest", "w:set:tag:latest"), CB("✏️ Type", "w:type:tag")));
    await tap(100, "w:apply");
    expect(screen()).toContain("<p>⚠️ The release tag is not set yet.</p>");
    await tap(100, "w:set:source:release");
    await tap(100, "w:apply");
    expect(screen()).toBe(OPTIONS("Feature branches", { releases: true }));
    // UI review: common paths as rows, typed ones, a sent file; on only once it has one
    await tap(100, "w:configure:uiReview");
    await tap(100, "w:apply");
    expect(screen()).toContain("<p>⚠️ UI files: add at least one.</p>");
    expect(screen()).toContain(OPT("⬜ <code>src/components/**</code>", "not added", CB("Add", "w:tog:paths:0")));
    await tap(100, "w:tog:paths:0");
    await tap(100, "w:type:paths");
    expect(screen()).toContain(CB("✏️ Typing…", "w:type:paths"));
    await dm(100, "app/ui/**\n- web/views/**");
    expect(tg.of("deleteMessage").at(-1)).toEqual({ chat_id: "100", message_id: uid });
    files["paths-0"] = JSON.stringify({ paths: ["src/components/**", "app/ui/**", "web/views/**", "**/*.css"] });
    await post("/telegram", msg(100, undefined, undefined, { document: { file_id: "paths-0", file_name: "ui.json", file_size: 10 } }));
    expect(screen()).toContain(OPT("UI files", "A change to one of these comes to you before its ticket is closed. Now: <code>src/components/**</code>, <code>app/ui/**</code>, <code>web/views/**</code>, <code>**/*.css</code>.", CB("✏️ Type", "w:type:paths"), CB("✖ Clear", "w:clear:paths")));
    await tap(100, "w:apply");
    const UI = "UI files: <code>src/components/**</code>, <code>app/ui/**</code>, <code>web/views/**</code>, <code>**/*.css</code>";
    expect(screen()).toBe(OPTIONS("Feature branches", { releases: true, uiReview: true }, "", { uiReview: UI }));
    // switched off and on again, the values are kept
    await tap(100, "w:switch:uiReview");
    await tap(100, "w:configure:uiReview");
    await tap(100, "w:apply");
    expect(screen()).toBe(OPTIONS("Feature branches", { releases: true, uiReview: true }, "", { uiReview: UI }));
    // feature branches: their settings from the row above the options
    await tap(100, "w:configure:pullRequests");
    await tap(100, "w:set:method:squash");
    await tap(100, "w:apply");
    expect(screen()).toContain(OPT("⚙️ Feature branches", "Branch name: <code>flowee/{n}</code>; Required checks: all of them; Merge method: Squash; Who merges: Flowee, after testing", CB("⚙️ Change", "w:configure:pullRequests")));
    await tap(100, "w:switch:uiReview");
    // back to the branching: the choice is marked, versioning stays on with the other branching
    await tap(100, "w:back");
    expect(screen()).toBe(FLOW.replace(CB("🔀 Choose", "w:next:feature"), CB("● Chosen", "w:next:feature")));
    await tap(100, "w:next:single");
    expect(screen()).toBe(OPTIONS("Single branch", { releases: true }));
    await tap(100, "w:back");
    await tap(100, "w:next:feature");
    await tap(100, "w:next");
    await tap(100, "w:next:here");
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
    expect(screen()).toContain(FACT("🔀 Way of working", "Feature branches, Releases"));
    await tap(100, "w:confirm");
    const doc = (await admin("GET", "/admin/workspaces/app")).body.workspace;
    expect(doc).toMatchObject({ flow: { preset: "pr-release" }, features: { pullRequests: { method: "squash" }, releases: true } });
    expect(doc.features.uiReview).toBeUndefined();
  });

  it("user feedback asks for its label; switched off it still writes the label, waiting for a human", async () => {
    await dm(100, "/setup");
    await dm(100, "acme/app");
    await tap(100, "w:next:shared");
    await tap(100, "w:next:single");
    await tap(100, "w:configure:userFeedback");
    expect(screen()).toContain("<p><b>Which label marks user feedback?</b></p>");
    expect(screen()).toContain(OPT("Feedback label", "The label on tickets your users wrote. Now: <code>feedback</code>.", CB("user-report", "w:set:label:user-report"), CB("✏️ Type", "w:type:label")));
    await tap(100, "w:type:label");
    await dm(100, "from users");
    await tap(100, "w:apply");
    expect(screen()).toBe(OPTIONS("Single branch", { userFeedback: true }, "", { userFeedback: "Feedback label: <code>from users</code>" }));
    await tap(100, "w:switch:userFeedback");
    await tap(100, "w:next");
    await tap(100, "w:next:here");
    await dm(100, TOKEN);
    await tap(100, "w:confirm");
    expect((await admin("GET", "/admin/workspaces/app")).body.workspace.features).toEqual({ userFeedback: { label: "from users", autoTriage: false } });
  });

  it("custom steps: an extension file sent in the wizard is validated, listed by name, its role offered; the menu shows and removes it", async () => {
    await dm(100, "/setup");
    await dm(100, "acme/app");
    await tap(100, "w:next:shared");
    await tap(100, "w:next:single");
    await tap(100, "w:extensions");
    expect(screen()).toBe(
      [
        "<p>🆕 <b>New workspace</b> · Custom steps</p>",
        "<p><b>Custom steps</b></p>",
        "<p>An extension file adds steps, agent roles and rules of your own to how tickets move (<code>https://flowee.test/docs/flows.md</code>, “Extending the flow”). Send the <code>.json</code> file here; an agent can write it from <code>https://flowee.test/flows/flow.json</code>.</p>",
        "<p>None added yet.</p>",
        ROW(CB("◀ Back", "w:back"), CB("✅ Apply", "w:apply"), CB("✖ Cancel", "w:cancel")),
      ].join(""),
    );
    files["ext-bad"] = JSON.stringify({ name: "broken", states: { ready: { meta: { label: "x" } } }, on: { ready: { poke: { target: "nowhere" } } } });
    await post("/telegram", msg(100, undefined, undefined, { document: { file_id: "ext-bad", file_name: "broken.json", file_size: 10 } }));
    expect(screen()).toContain("<p>⚠️ The file was not added: one problem.</p>");
    expect(screen()).toContain(FACT("$.extensions[0].states.ready: extension &#39;broken&#39; adds the state &#39;ready&#39;, which the flow has already; change a state with on, replace or remove.".replace(/&#39;/g, "'")));
    files["ext-ok"] = JSON.stringify(security);
    await post("/telegram", msg(100, undefined, undefined, { document: { file_id: "ext-ok", file_name: "security-review.json", file_size: 10 } }));
    expect(screen()).toContain("<p>⚠️ 🧩 security-review is added; agents of its roles can be created with the project key.</p>");
    expect(screen()).toContain(OPT("🧩 security-review", "A security reviewer looks at a ticket the board sends before it closes.", CB("✖ Remove", "w:remove:0")));
    await tap(100, "w:apply");
    expect(screen()).toBe(OPTIONS("Single branch", {}, "", { ext: "<code>security-review</code>" }));
    await tap(100, "w:next");
    await tap(100, "w:next:here");
    await dm(100, TOKEN);
    await tap(100, "w:confirm");
    const doc = (await admin("GET", "/admin/workspaces/app")).body.workspace;
    expect(doc.extensions).toEqual([security]);
    expect(doc.roles).toBeUndefined();
    // the extension's role is offered to the agents through the API
    const { key } = await handed([]);
    expect((await api(key, "/v1/roles")).body.roles.map((r: { name: string }) => r.name)).toEqual(["board", "developer", "tester", "owner", "security"]);
    await dm(100, "/workspaces");
    await tap(100, "m:ws:app");
    expect(screen()).toContain(FACT("🧩 Custom steps", "<code>security-review</code>", CB("✏️ Change", "m:edit:app:ext")));
    await tap(100, "m:edit:app:ext");
    await tap(100, "w:remove:0");
    await tap(100, "w:apply");
    await tap(100, "w:next");
    await tap(100, "w:confirm");
    const after = (await admin("GET", "/admin/workspaces/app")).body.workspace;
    expect(after.extensions).toBeUndefined();
    expect((await api(key, "/v1/roles")).body.roles.map((r: { name: string }) => r.name)).toEqual(["board", "developer", "tester", "owner"]);
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
    expect(screen()).toContain(FACT("👥 Agents", "board, sampler, owner", CB("👥 Agents", "m:ag:pics")));
    await tap(100, "m:edit:pics:flow");
    await tap(100, "w:next:single");
    await tap(100, "w:next");
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
    await tap(100, "w:next:shared");
    await tap(100, "w:next:single");
    await tap(100, "w:next");
    await tap(100, "w:next:here");
    await dm(100, TOKEN);
    expect(screen()).toBe(
      [
        "<p>🆕 <b>New workspace</b> · Step 7 of 8</p>",
        "<p><b>This token reaches more than it needs</b></p>",
        "<p>Besides <code>acme/app</code> it can also reach <code>acme/secret</code>, <code>acme/other</code>; a narrower token limits what a leak could do.</p>",
        TABLE(
          OPT("✅ Use it anyway", "Keep this token; you can replace it later in the workspace's menu.", CB("✅ Use it", "w:next")),
          OPT("🔑 Make a narrower one", "A token for <code>acme/app</code> only: paste it here when you have it.", CB("🔑 Narrower", "w:narrower")),
        ),
        NAV,
      ].join(""),
    );
    await tap(100, "w:narrower");
    expect(screen()).toBe(CREDENTIAL("app", "acme/app"));
    await dm(100, TOKEN);
    await tap(100, "w:next");
    expect(screen()).toContain("<p><b>Create the workspace <code>app</code>?</b></p>");
    globalThis.fetch = fake;
  });

  it("every choice screen: each option's name, description and own button in one table row", async () => {
    const seen: Record<string, string> = {};
    const at = (name: string) => (seen[name] = screen());
    await dm(100, "/setup");
    await dm(100, "acme/app");
    at("bot");
    await tap(100, "w:next:shared");
    at("branching");
    await tap(100, "w:next:single");
    at("options");
    await tap(100, "w:next");
    at("where");
    await tap(100, "w:next:group");
    at("group");
    await tap(100, "w:back");
    await tap(100, "w:next:here");
    const rows = { bot: 2, branching: 2, options: 5, where: 2, group: 2 };
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
    await tap(100, "w:next");
    await tap(100, "w:next:shared");
    await tap(100, "w:next:feature");
    await tap(100, "w:next");
    await tap(100, "w:next:here");
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
    await tap(200, "w:next:own");
    const helper = tg.sent("sendRichMessage").at(-1);
    expect(helper?.reply_markup?.keyboard).toBeDefined();
    await tap(200, "w:back");
    expect(tg.sent("sendRichMessage").at(-1)?.reply_markup).toEqual({ remove_keyboard: true });
    expect(tg.of("deleteMessage").at(-1)).toEqual({ chat_id: "200", message_id: helper?.id });
    expect(screen(200)).toBe(BOT.replace("Step 2 of 7", "Step 2 of 8").replace(CB("🤖 Choose", "w:next:own"), CB("● Chosen", "w:next:own")));
    await tap(200, "w:next:own");
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
    await tap(100, "w:next:shared");
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
    await tap(200, "w:next:own");
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
    await tap(100, "w:next:shared");
    await tap(100, "w:next:single");
    await tap(100, "w:next");
    await tap(100, "w:next:here");
    tg.refuse = { deleteMessage: "Bad Request: message can't be deleted" };
    await dm(100, TOKEN);
    expect(screen()).toContain("<p>🆕 <b>New workspace</b> · Step 7 of 7 · Last check</p>");
    expect(screen()).toContain("</table><p>⚠️ I could not delete your message (Telegram refused deleteMessage: Bad Request: message can&#39;t be deleted.); please delete it yourself.</p>".replace("&#39;", "'"));
  });

  it("a refused profile of the own bot: the workspace is made, the user told, the secrets handed over", async () => {
    await dm(200, "/setup");
    await dm(200, "acme/web");
    await tap(200, "w:next:own");
    await post("/telegram", { update_id: ++uid, managed_bot: { user: { id: 200 }, bot: { id: 777, is_bot: true, first_name: "Widget", username: "WidgetEnvoyBot" } } });
    await tap(200, "w:next:single");
    await tap(200, "w:next");
    await tap(200, "w:next:here");
    await dm(200, TOKEN);
    tg.refuse = { setMySettings: "Bad Request: not enough rights" };
    await tap(200, "w:confirm");
    expect(screen(200)).toContain(
      "<p>✅ <b>Workspace ready</b> · <code>web</code></p><p>⚠️ The bot&#39;s profile was not set (Telegram refused setMySettings: Bad Request: not enough rights.); the next deploy tries again.</p>".replace("&#39;", "'"),
    );
    expect(Object.keys(await handed([]))).toEqual(["key"]);
    expect((await admin("GET", "/admin/workspaces/web")).status).toBe(200);
  });

  it("a project key the chat refuses as a file comes as a rich message: it is shown once", async () => {
    tg.refuse = { sendDocument: "Bad Request: file is too big" };
    await sharedSetup(100);
    const last = tg.sent("sendRichMessage").at(-1)?.rich_message.html as string;
    expect(last).toMatch(/^<p>🔑 <b>Project key<\/b> · <code>app<\/code><\/p><pre># Flowee workspace app: the project key for flowee.py, shown only this once./);
    expect(last).toMatch(/^[0-9a-f]{64}$/m);
    expect(last).toContain('data="m:rmfile">🗑 Delete this file from the chat</tg-button>');
  });

  it("Back, Cancel, resume and expiry", async () => {
    await dm(100, "/setup");
    await dm(100, "acme/app");
    expect(screen()).toBe(BOT);
    await tap(100, "w:back");
    expect(screen()).toBe(
      REPOS("Step 1 of 7", "<p>Now: <code>acme/app</code> on GitHub</p>") + ROW(CB("✅ Keep acme/app", "w:next")) + CANCEL,
    );
    await tap(100, "w:next");
    expect(screen()).toBe(BOT);
    await tap(100, "w:cancel");
    expect(screen()).toBe(["<p>✖ <b>Setup cancelled</b></p>", "<p>Nothing was created.</p>", ROW(CB("🚀 Start again", "w:new"), CB("📂 My workspaces", "m:list"))].join(""));
    // an old button of the finished setup
    await tap(100, "w:next:shared");
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
    await tap(100, "w:next:shared");
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

describe("the setup wizard's navigation: Back is the screen shown before, Keep goes on, the counter counts screens", () => {
  /** The buttons of the living screen: label and data. */
  const buttons = (chat = 100) => [...(screen(chat) ?? "").matchAll(/<tg-button type="callback_data"[^>]* data="([^"]+)">([^<]*)<\/tg-button>/g)].map((m) => ({ data: m[1], label: m[2] }));
  /** Presses the first button whose label matches. */
  const press = async (label: RegExp, chat = 100) => {
    const b = buttons(chat).find((x) => label.test(x.label));
    expect(b, `no button ${label} on ${screen(chat)}`).toBeDefined();
    await tap(chat, b?.data as string);
  };
  const step = (chat = 100) => /Step (\d+) of (\d+)/.exec(screen(chat))?.slice(1).map(Number) ?? [];
  /** Forward through the private-chat path, this bot, single branch; the screens in order. */
  async function forward(): Promise<string[]> {
    const seen = [screen()];
    await dm(100, "acme/app");
    seen.push(screen());
    await press(/^💬 Choose$/);
    seen.push(screen());
    await press(/^🌿 Choose$/);
    seen.push(screen());
    await press(/^▶ Next$/);
    seen.push(screen());
    return seen;
  }

  it("(a) Back from the screen after the options shows the options again, Next from there the same screen as before", async () => {
    await dm(100, "/setup");
    const [, , , options, where] = await forward();
    expect(where).toContain("Where should the tickets appear?");
    await press(/^◀ Back$/);
    expect(screen()).toBe(options);
    await press(/^▶ Next$/);
    expect(screen()).toBe(where);
  });

  it("(b) Back to the first screen, then Keep: the second screen, and every screen after it forward in order", async () => {
    await dm(100, "/setup");
    const seen = await forward();
    await press(/^💬 Choose$/);
    const token = screen();
    expect(token).toContain("Send me a GitHub token");
    for (let i = 0; i < 10 && buttons().some((b) => b.label === "◀ Back"); i++) await press(/^◀ Back$/);
    expect(screen()).toContain("Which repository is this workspace for?");
    await press(/Keep/);
    expect(screen()).toContain("Which bot should bring you the tickets?");
    await press(/Chosen/);
    expect(screen()).toContain("How should the agents bring in their code?");
    await press(/Chosen/);
    expect(screen()).toContain("What else should Flowee do?");
    await press(/^▶ Next$/);
    expect(screen()).toBe(seen[4].replace(">💬 Choose<", ">● Chosen<"));
    await press(/Chosen/);
    expect(step()).toEqual(/Step (\d+) of (\d+)/.exec(token)?.slice(1).map(Number));
  });

  it("(c) Step n of N: one number per screen, up by one forward, down by one back, N the screens of the path", async () => {
    await dm(100, "/setup");
    const seen = await forward();
    await press(/^💬 Choose$/);
    seen.push(screen());
    await dm(100, TOKEN);
    seen.push(screen());
    const steps = seen.map((h) => /Step (\d+) of (\d+)/.exec(h)?.slice(1).map(Number));
    expect(steps).toEqual(seen.map((_, i) => [i + 1, seen.length]));
    for (let k = seen.length - 1; k >= 1; k--) {
      await press(/^◀ Back$/);
      expect(step()).toEqual([k, seen.length]);
    }
    // a new bot adds the screen that creates it, a group the group's screen: N says so at once
    await press(/Keep/);
    await press(/^🤖 Choose$/);
    expect(step()).toEqual([3, seen.length + 1]);
    await press(/^◀ Back$/);
    await press(/^💬 Choose$|Chosen/);
    await press(/Chosen/);
    await press(/^▶ Next$/);
    expect(step()).toEqual([5, seen.length]);
    await press(/^👥 Choose$/);
    expect(step()).toEqual([6, seen.length + 1]);
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
        FACT("👥 Agents", "board, dev1, dev2, tester, owner", CB("👥 Agents", "m:ag:app")),
        FACT("🧩 Custom steps", "none", CB("✏️ Change", "m:edit:app:ext")),
        FACT("⚡ Instant updates", "off for app (not set up yet); the tracker is checked every minute", CB("⚡ Turn on", "m:hook:app")),
      ),
      TABLE(
        OPT("🗝 New project key", "Your agents get a new key, handed over as a file; the old one stops working at once.", CB("🗝 New key", "m:key:app")),
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
        ROW(CB("🚀 New workspace", "w:new"), CB("📥 Import", "m:import"), CB("📤 Export all", "m:exportall")),
      ].join(""),
    );
    await tap(100, "m:ws:app");
    edited(id, WS());
    await tap(100, "m:key:app");
    edited(
      id,
      [
        "<p>🗝 <b>New project key</b> · <code>app</code></p>",
        "<p><b>Replace the project key?</b></p>",
        "<p>Every agent using the old key stops working at once, until the new key is stored where it runs.</p>",
        ROW(CB("🗝 Make a new key", "m:key:app:yes"), CB("« Back", "m:ws:app")),
      ].join(""),
    );
    await tap(100, "m:key:app:yes");
    edited(id, ["<p>🗝 <b>New project key</b> · <code>app</code></p>", "<p>It is in the file below, <b>shown only this once</b>, with the line that stores it where your agents run. The old one no longer works.</p>", ROW(CB("« Back", "m:ws:app"))].join(""));
    expect(tg.of("answerCallbackQuery").at(-1)).toEqual({ callback_query_id: `q${uid}`, text: "🗝 New key below" });
    expect(tg.of("sendDocument").at(-1)?.caption).toBe("🔑 Project key: shown only this once.");
    const fresh = await handed([]);
    expect((await api(s.dev1, "/v1/whoami")).status).toBe(401);
    // the agents stay: the new key acts as them at once
    fresh.dev1 = `${fresh.key}|dev1`;
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

  it("the agents screen: who exists, its role, last seen, what it holds; pause and resume one, remove one and its ticket goes back to the queue", async () => {
    const s = await sharedSetup(100);
    app.add({ number: 1, state_label: "ready" });
    expect((await api(s.dev1, "/v1/next", {})).body.ticket).toMatchObject({ n: 1 });
    await dm(100, "/workspaces");
    const id = living(100)?.id as number;
    await tap(100, "m:ws:app");
    await tap(100, "m:ag:app");
    const html = screen();
    const seen = /seen (\d{4}-\d\d-\d\d \d\d:\d\d) UTC/.exec(html)?.[1];
    const row = (name: string, role: string, rest: string, ...buttons: string[]) => OPT(name, `${role} · ${rest}`, ...buttons);
    const agents = (dev1: string, more = "") =>
      [
        "<p>👥 <b>Agents</b> · <code>app</code></p>",
        "<p>Agents add themselves with the project key (<code>flowee.py agents add</code>).</p>",
        more,
        TABLE(
          row("board", "🧭 Board", "never seen · holds nothing", CB("⏸ Pause", "m:agp:app:board"), CB("➖ Remove", "m:agrm:app:board")),
          dev1,
          row("dev2", "🛠 Developer", "never seen · holds nothing", CB("⏸ Pause", "m:agp:app:dev2"), CB("➖ Remove", "m:agrm:app:dev2")),
          row("tester", "🧪 Tester", "never seen · holds nothing", CB("⏸ Pause", "m:agp:app:tester"), CB("➖ Remove", "m:agrm:app:tester")),
          row("owner", "👤 Owner", "never seen · holds nothing", CB("⏸ Pause", "m:agp:app:owner"), CB("➖ Remove", "m:agrm:app:owner")),
        ),
        ROW(CB("« Back", "m:ws:app")),
      ].join("");
    edited(id, agents(row("dev1", "🛠 Developer", `seen ${seen} UTC · holds #1`, CB("⏸ Pause", "m:agp:app:dev1"), CB("➖ Remove", "m:agrm:app:dev1"))));
    await tap(100, "m:agp:app:dev1");
    expect(tg.of("answerCallbackQuery").at(-1)?.text).toBe("⏸ Paused");
    expect(screen()).toContain(row("⏸ dev1", "🛠 Developer", `seen ${seen} UTC · holds #1`, CB("▶ Resume", "m:agp:app:dev1"), CB("➖ Remove", "m:agrm:app:dev1")));
    expect((await api(s.dev1, "/v1/whoami")).body.error).toBe("agent_paused");
    await tap(100, "m:agp:app:dev1");
    expect((await api(s.dev1, "/v1/whoami")).status).toBe(200);
    await tap(100, "m:agrm:app:dev1");
    edited(
      id,
      [
        "<p>➖ <b>Remove <code>dev1</code>?</b> · <code>app</code></p>",
        "<p>It stops working at once, and the tickets it holds go back to their queues; the other agents are not touched.</p>",
        ROW(CB("➖ Remove it", "m:agrm:app:dev1:yes"), CB("« Back", "m:ag:app")),
      ].join(""),
    );
    await tap(100, "m:agrm:app:dev1:yes");
    expect(tg.of("answerCallbackQuery").at(-1)?.text).toBe("➖ Agent removed");
    expect(screen()).toContain("<p>➖ <code>dev1</code> is removed; its tickets go back to their queues.</p>");
    expect(screen()).not.toContain("m:agrm:app:dev1");
    expect((await api(s.dev1, "/v1/whoami")).body.error).toBe("unknown_agent");
    expect((await api(s.board, "/v1/whoami")).body.instance).toBe("board");
    await runDurableObjectAlarm(env.WORKSPACE.get(env.WORKSPACE.idFromName("app")));
    expect(app.label(1)[0]).toBe("ready");
    expect((await api(s.dev2, "/v1/next", {})).body.ticket).toMatchObject({ n: 1 });
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

  it("editing one part opens that screen in the living message; done, it is saved and the workspace screen comes back", async () => {
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
        ROW(CB("✅ Keep acme/app", "w:next")),
        CANCEL,
      ].join(""),
    );
    await dm(100, "github.com/acme/app\ngithub.com/acme/lib");
    expect(screen()).toContain("<p>📂 <b><code>app</code></b> · ▶ running</p><p>✅ Saved.</p>");
    expect(screen()).toContain(FACT("📦 Repositories", "<code>acme/app</code>, <code>acme/lib</code>", CB("✏️ Change", "m:edit:app:repos")));
    expect((await admin("GET", "/admin/workspaces/app")).body.workspace.tracker.repos.map((r: string | { repo: string }) => (typeof r === "string" ? r : r.repo))).toEqual(["acme/app", "acme/lib"]);
    // the way of working: the branching, the options, then back to the workspace; Back walks the same screens
    await tap(100, "m:edit:app:flow");
    expect(screen()).toContain("<p><b>How should the agents bring in their code?</b></p>");
    expect(screen()).not.toContain("◀ Back");
    await tap(100, "w:next:feature");
    expect(screen()).toContain("<p><b>What else should Flowee do?</b></p>");
    await tap(100, "w:back");
    expect(screen()).toContain(CB("● Chosen", "w:next:feature"));
    await tap(100, "w:next:feature");
    await tap(100, "w:next");
    expect(screen()).toContain("<p>✅ Saved.</p>");
    expect((await admin("GET", "/admin/workspaces/app")).body.workspace.flow).toEqual({ preset: "pr-release" });
    // cancelled, nothing changes and the workspace screen comes back
    await tap(100, "m:edit:app:bind");
    await tap(100, "w:cancel");
    expect(screen()).toContain("<p>📂 <b><code>app</code></b> · ▶ running</p><p>Nothing changed.</p>");
  });


  it("an own bot: new token through replaceManagedBotToken, access settings", async () => {
    await dm(200, "/setup");
    await dm(200, "acme/widget");
    await tap(200, "w:next:own");
    await post("/telegram", { update_id: ++uid, managed_bot: { user: { id: 200 }, bot: { id: 777, is_bot: true, first_name: "W", username: "WBot" } } });
    await tap(200, "w:next:single");
    await tap(200, "w:next");
    await tap(200, "w:next:here");
    await dm(200, TOKEN);
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
    await tap(100, "w:next:shared");
    await tap(100, "w:next:single");
    await tap(100, "w:next");
    await tap(100, "w:next:group");
    // what Telegram makes the user send when the link t.me/<bot>?startgroup=app added the bot
    const group = (from: number, text: string, extra: Record<string, unknown> = {}) => post("/telegram", msg(from, text, { id: -100777, type: "supergroup", title: "Team" }, extra));
    await group(100, "/start@FloweeTestBot app");
    expect(tg.sent("sendRichMessage").at(-1)).toMatchObject({
      chat_id: "-100777",
      rich_message: { html: "<p>✅ <b>Tickets of <code>app</code> appear here</b></p><p>Your team works the tickets together: reply to a card to answer it, and the ticket records who answered.</p>" },
    });
    expect(screen()).toContain("<p><b>Send me a GitHub token for <code>acme/app</code></b></p>");
    await dm(100, TOKEN);
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
    expect(screen()).toContain(CB("● Chosen", "w:next:single"));
    await tap(100, "w:next:single");
    expect(screen()).toContain("<p><b>What else should Flowee do?</b></p>");
    await tap(100, "w:cancel");
    expect(screen()).toContain("<p>📂 <b><code>other</code></b> · ▶ running</p><p>Nothing changed.</p>");
  });
});

describe("export and import", () => {
  const PROMPT = ["<p>📥 <b>Import a configuration</b></p>", "<p>Send the <code>.json</code> file, or paste the configuration.</p>", ROW(CB("✖ Cancel", "m:noimport"))].join("");

  it("managers the creator names in the document manage the workspace too; the creator stays its creator", async () => {
    await sharedSetup(100);
    await tap(100, "m:exportall");
    const out = JSON.parse(await (tg.of("sendDocument").at(-1)?.document as File).text());
    await tap(100, "m:import");
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
    await tap(300, "w:confirm");
    const doc = (await admin("GET", "/admin/workspaces/app")).body;
    expect(doc.workspace.owners).toEqual([{ chat: "100" }]);
    await dm(100, "/workspaces");
    expect(screen(100)).toContain('data="m:ws:app"');
  });

  it("export -> edit -> import through the chat: only the missing secrets are asked", async () => {
    await sharedSetup(100);
    await tap(100, "m:exportall");
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
      CREDENTIAL("app-copy", "acme/lib", "", "Step 1 of 2", "<p>📥 The configuration is valid and will create <code>app-copy</code>. I ask only for what is missing, then you confirm.</p>").replace(NAV, CANCEL),
    );
    await dm(100, TOKEN);
    expect(screen()).toContain("<p><b>Create the workspace <code>app-copy</code>?</b></p>");
    await tap(100, "w:confirm");
    // the copy gets its own project key; agents are no part of a configuration, they create themselves again
    const s = await handed(["dev1"]);
    expect(Object.keys(s)).toEqual(["key", "dev1"]);
    const doc = (await admin("GET", "/admin/workspaces/app-copy")).body.workspace;
    expect(doc.agents).toEqual({ key: "W_APP_COPY_KEY" });
    expect(doc.texts).toEqual({ project: "Copy" });
    expect(doc.chat).toBeUndefined();
    expect((await api(s.dev1, "/w/app-copy/v1/whoami")).body.instance).toBe("dev1");
  });

  it("a pasted document with problems: one sentence each with its JSON path, in the living message; nothing created", async () => {
    await dm(100, "/start");
    await tap(100, "m:import");
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

  it("pasted JSON is imported only as the answer to 📥 Import", async () => {
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
    // an older workspace gets a project key over the API; its agents with their own secrets keep working
    const k = await admin("POST", "/admin/workspaces/auto/key", {});
    expect(k.body).toMatchObject({ ok: true, id: "auto", key: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect((await admin("GET", "/admin/workspaces/auto")).body.workspace.agents).toEqual({ key: "W_AUTO_KEY" });
    expect((await api(k.body.key, "/v1/agents", { role: "developer" })).body.agent).toMatchObject({ name: "dev1", role: "developer" });
    expect((await api(`${k.body.key}|dev1`, "/v1/whoami")).body).toEqual({ ok: true, instance: "dev1", role: "developer" });
    expect((await api("board-secret", "/v1/whoami")).body.instance).toBe("board");
    // a second one replaces it: the old key stops working at once
    const k2 = await admin("POST", "/admin/workspaces/auto/key", {});
    expect((await api(k.body.key, "/v1/roles")).status).toBe(401);
    expect((await api(k2.body.key, "/v1/roles")).status).toBe(200);
    expect((await admin("POST", "/admin/workspaces/nope/key", {})).status).toBe(404);
    expect((await admin("DELETE", "/admin/workspaces/auto")).body).toEqual({ ok: true, id: "auto", deleted: true });
  });
});

describe("the instance bot's profile", () => {
  it("/workspaces is in the menu only of someone who manages a workspace", async () => {
    const menus = (chat: string) => tg.of("setMyCommands").filter((c) => c.scope?.chat_id === chat).map((c) => c.commands.map((x: { command: string }) => x.command));
    await dm(200, "/start");
    expect(menus("200")).toEqual([]);
    await sharedSetup(100);
    await dm(100, "/workspaces");
    expect(menus("100").at(-1)).toEqual(["start", "todo", "postponed", "new", "setup", "workspaces"]);
    expect(menus("100").flat()).not.toContain("import");
  });

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
    expect(tg.of("setMyCommands")[0].commands.map((c: { command: string }) => c.command)).toEqual(["start", "setup"]);
    expect(tg.of("setWebhook")[0]).toMatchObject({ url: "https://flowee.test/telegram", allowed_updates: ["message", "callback_query", "managed_bot"] });
    expect(tg.of("setMyDescription")[0].description).not.toMatch(/Ann|owner's name/);
    tg.calls = [];
    const again = (await (await worker.fetch(new Request("https://flowee.test/setup"), menv())).json()) as Record<string, Record<string, string>>;
    expect(Object.values(again.instance).every((v) => v === "current")).toBe(true);
    expect(tg.calls).toEqual([]);
  });
});

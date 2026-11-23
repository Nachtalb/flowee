// A workspace over several repositories: tickets are alias#n in the API, the chat and the error texts, the queue
// interleaves repositories by number, commits and dependencies resolve in the ticket's repository, and each
// repository uses its own token and branch. One-repository workspaces keep plain numbers (the other suites).
import { beforeEach, describe, expect, it } from "vitest";
import { SLOT } from "../src/core/repos";
import type { FakeGitHub, FakeTelegram } from "./fake";
import { CARD_Q, call, claim, hook, inFlow, setup, wipe } from "./helpers";

let app: FakeGitHub;
let lib: FakeGitHub;
let tg: FakeTelegram;
beforeEach(async () => {
  ({ app, lib, tg } = setup());
  await wipe("multi");
});

const m = (who: string, cmd: string, body?: unknown) => call(who, cmd, body, undefined, "m");
const LIB = (n: number) => SLOT + n;

describe("several repositories", () => {
  it("the queue interleaves repositories by number, the first-listed first on a tie", async () => {
    lib.add({ number: 1, state_label: "ready" });
    app.add({ number: 1, state_label: "ready" });
    app.add({ number: 2, state_label: "ready" });
    lib.add({ number: 3, state_label: "ready" });
    expect((await m("dev1", "queue")).body.queue).toEqual(["app#1", "lib#1", "app#2", "lib#3"]);
    const r = await m("dev1", "next", {});
    expect(r.body.ticket).toMatchObject({ n: "app#1", state: "in development", resumed: false });
    expect(app.label(1)).toEqual(["in development"]);
    expect(lib.label(1)).toEqual(["ready"]);
  });

  it("tickets are alias#n in bodies, query strings and errors; a bare number is refused", async () => {
    lib.add({ number: 4, state_label: "ready", body: "## Acceptance\n- x\n\nDepends on: app#1, #2" });
    app.add({ number: 1, state_label: "ready" });
    lib.add({ number: 2, state: "closed" });
    const show = await m("dev1", "show?n=lib%234");
    expect(show.body).toMatchObject({ ok: true, n: "lib#4", state: "ready", depends_on: ["app#1", "lib#2"], blocked_by: ["app#1"] });
    expect((await m("dev1", "heartbeat", { n: 4 })).body).toEqual({
      ok: false,
      error: "bad_request",
      message: "n must be alias#number with an alias of app or lib.",
    });
    expect((await m("dev1", "heartbeat", { n: "lib#4" })).body.message).toBe("lib#4 is 'ready'; heartbeat needs 'needs triage', 'board review', 'in development' or 'testing'.");
    expect((await m("dev1", "handoff", { n: "lib#4", comment: "x" })).body.message).toBe("lib#4 is 'ready'; handoff needs 'in development'.");
    expect((await m("dev1", "show?n=lib%2399")).body).toMatchObject({ error: "not_found", message: "lib#99 does not exist or is a pull request." });
    expect((await m("dev1", "show?n=nope%231")).body.error).toBe("bad_request");
  });

  it("commits count in the ticket's own repository, as (#n) or (alias#n), on its branch", async () => {
    lib.add({ number: 1, state_label: "in development" });
    app.add({ number: 1, state_label: "in development" });
    await claim(LIB(1), "dev1", "developer", Date.now(), "multi");
    app.commit("feat: elsewhere (#1)");
    expect((await m("dev1", "handoff", { n: "lib#1", comment: "done" })).body).toEqual({
      ok: false,
      error: "no_commits",
      message: "No new commit on master ends with (#1) or (lib#1); push first.",
    });
    const a = lib.commit("feat: one (#1)");
    const b = lib.commit("fix: two (lib#1)");
    const r = await m("dev1", "handoff", { n: "lib#1", comment: "done" });
    expect(r.body).toEqual({ ok: true, state: "ready for testing", commits: [a, b] });
    expect(lib.last(1)).toBe(`Developer: done\n\nCommits: ${a} ${b}`);
    expect(app.label(1)).toEqual(["in development"]);
  });

  it("each repository uses its own token or the shared one; storage keys keep the repositories apart", async () => {
    app.add({ number: 5, state_label: "ready" });
    lib.add({ number: 5, state_label: "ready" });
    await m("dev1", "next", {});
    await m("dev2", "next", {});
    expect(await inFlow((f) => f.rows("SELECT n, instance FROM claims ORDER BY n"), "multi")).toEqual([
      { n: 5, instance: "dev1" },
      { n: LIB(5), instance: "dev2" },
    ]);
    expect(new Set(app.auth)).toEqual(new Set(["Bearer gh-test"]));
    expect(new Set(lib.auth)).toEqual(new Set(["Bearer gh-lib"]));
  });

  it("file names the repository; the default is the first one", async () => {
    expect((await m("board", "file", { title: "A", body: "b" })).body).toMatchObject({ ok: true, n: "app#1" });
    expect((await m("board", "file", { title: "B", body: "b", repo: "lib" })).body).toMatchObject({ ok: true, n: "lib#1" });
    expect((await m("board", "file", { title: "C", body: "b", repo: "web" })).body).toEqual({ ok: false, error: "bad_request", message: "repo must be one of app or lib." });
    expect(lib.issues.get(1)?.title).toBe("B");
  });

  it("the chat shows alias#n on cards and opens a typed alias#n", async () => {
    lib.add({ number: 2, state_label: "board review" });
    const r = await m("board", "escalate", { n: "lib#2", comment: CARD_Q.replace("For Nick", "For the owner") });
    expect(r.body).toEqual({ ok: true, state: "human review", telegram: "sent" });
    expect(tg.of("sendRichMessage").at(-1)?.rich_message.html).toContain(">lib#2</a>");
    tg.calls = [];
    const u = (text: string, id: number) => ({ update_id: id, message: { message_id: id, from: { id: 777 }, chat: { id: 777, type: "private" }, date: 1, text } });
    await hook(u("lib#2", 70001));
    expect(tg.of("sendRichMessage")[0].rich_message.html).toContain(">lib#2</a>");
    await hook(u("app#9", 70002));
    expect(tg.of("sendMessage").at(-1)?.text).toBe("app#9: Not in your inbox");
  });
});

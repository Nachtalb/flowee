import { beforeEach, describe, expect, it } from "vitest";
import options from "../flows/trunk.options.json";
import type { FakeGitHub, FakeTelegram } from "./fake";
import { CARD_Q, CARD_TEST, call, claim, inFlow, inObject, setup, wipe, type Who } from "./helpers";

const COMMANDS = Object.fromEntries(Object.entries(options.commands).filter(([, o]) => !(o as { read?: boolean }).read));

let gh: FakeGitHub;
let tg: FakeTelegram;
beforeEach(async () => {
  ({ gh, tg } = setup());
  await wipe();
});

const origin = (n: number) => inFlow((f) => f.rows<{ origin: string }>("SELECT origin FROM origins WHERE n = ?", n)[0]?.origin);
const claimOf = (n: number) => inFlow((f) => f.claim(n)?.instance);
const answerRow = (n: number, ts = Date.now()) =>
  inFlow((f) => {
    f.sql.exec("INSERT INTO answers (n, ts, text, via) VALUES (?, ?, 'yes', 'api')", n, ts);
  });

/** Puts a ticket into testing, claimed by the tester, with one commit `(#n)` on main. */
function testing(n = 1) {
  gh.add({ number: n, state_label: "testing" });
  const c = gh.commit(`feat: thing (#${n})`);
  return { c, done: claim(n, "tester", "tester") };
}

describe("auth", () => {
  const ALLOWED: Record<string, Who[]> = {
    file: ["board", "dev1", "dev2", "tester", "owner"],
    next: ["board", "dev1", "dev2", "tester"],
    heartbeat: ["board", "dev1", "dev2", "tester"],
    release: ["board", "dev1", "dev2", "tester"],
    handoff: ["dev1", "dev2"],
    pass: ["tester"],
    fail: ["tester"],
    stuck: ["dev1", "dev2", "tester"],
    triage: ["board"],
    spec: ["board"],
    sendback: ["board"],
    rework: ["board"],
    escalate: ["board"],
    approve: ["board"],
    drop: ["board"],
    postpone: ["board"],
    resume: ["board"],
    answer: ["owner"],
  };

  it("covers every command of the contract", () => {
    expect(Object.keys(ALLOWED).sort()).toEqual(Object.keys(COMMANDS).sort());
  });

  it("refuses unknown and missing secrets with 401", async () => {
    for (const r of [await call(null, "whoami"), await call("nobody" as Who, "whoami"), await call(null, "next", {})])
      expect(r).toEqual({ status: 401, body: { ok: false, error: "unauthorized", message: "Unknown or missing token." } });
  });

  it("maps each secret to its instance", async () => {
    const roles = { board: "board", dev1: "developer", dev2: "developer", tester: "tester", owner: "owner" };
    for (const [who, role] of Object.entries(roles))
      expect((await call(who as Who, "whoami")).body).toEqual({ ok: true, instance: who, role });
  });

  it("allows or refuses each role for each command as the contract says (the body cannot change the role)", async () => {
    gh.add({ number: 1, state_label: "postponed" });
    for (const [cmd, allowed] of Object.entries(ALLOWED))
      for (const who of ["board", "dev1", "dev2", "tester", "owner"] as Who[]) {
        const r = await call(who, cmd, { n: 999, role: "board", instance: "board" });
        if (allowed.includes(who)) expect([r.status, r.body.error], `${who} ${cmd}`).not.toEqual([403, "wrong_role"]);
        else expect(r, `${who} ${cmd}`).toMatchObject({ status: 403, body: { ok: false, error: "wrong_role" } });
      }
    expect(gh.writes).toEqual([]);
  });

  it("names the allowed roles in one sentence", async () => {
    expect((await call("dev1", "escalate", { n: 1, comment: CARD_Q })).body.message).toBe("Only the board may use escalate.");
  });
});

describe("file", () => {
  it("files into needs triage with the project status", async () => {
    const r = await call("tester", "file", { title: "Crash on start", body: "It crashes." });
    expect(r.body).toEqual({ ok: true, n: 1, url: "https://github.com/Nachtalb/livedu/issues/1" });
    expect(gh.label(1)).toEqual(["needs triage"]);
    expect(gh.status.get("I_1")).toBe("Todo");
  });
  it("checks title and body", async () => {
    expect((await call("board", "file", { title: "x".repeat(121), body: "b" })).body.error).toBe("bad_request");
    expect((await call("board", "file", { title: "", body: "b" })).body.error).toBe("bad_request");
    expect((await call("board", "file", { title: "t", body: " " })).status).toBe(400);
  });
});

describe("next", () => {
  it("developer: back to development first, then ready; skips open dependencies and two states", async () => {
    gh.add({ number: 1, state_label: "ready" });
    gh.add({ number: 2, state_label: "ready", body: "Depends on: #5" });
    gh.add({ number: 3, state_label: ["ready", "testing"] });
    gh.add({ number: 4, state_label: "back to development" });
    gh.add({ number: 5, state_label: "needs triage" });
    expect((await call("dev1", "queue")).body).toMatchObject({ role: "developer", queue: [4, 1], claim: null });
    const r = await call("dev1", "next", {});
    expect(r.body.ticket).toEqual({ n: 4, title: "Ticket 4", state: "in development", resumed: false });
    expect(gh.label(4)).toEqual(["in development"]);
    expect(gh.status.get("I_4")).toBe("In progress");
    expect(await claimOf(4)).toBe("dev1");
    // resumes its own claim
    expect((await call("dev1", "next", {})).body.ticket).toMatchObject({ n: 4, resumed: true });
    expect((await call("dev2", "next", {})).body.ticket).toMatchObject({ n: 1 });
    expect((await call("dev1", "queue")).body.claim).toMatchObject({ n: 4 });
  });

  it("a closed dependency does not block", async () => {
    gh.add({ number: 1, state: "closed" });
    gh.add({ number: 2, state_label: "ready", body: "Depends on: #1" });
    expect((await call("dev1", "next", {})).body.ticket.n).toBe(2);
  });

  it("tester takes ready for testing into testing", async () => {
    gh.add({ number: 1, state_label: "ready" });
    gh.add({ number: 2, state_label: "ready for testing" });
    expect((await call("tester", "next", {})).body.ticket).toMatchObject({ n: 2, state: "testing" });
    expect(gh.label(2)).toEqual(["testing"]);
  });

  it("board: board review oldest hand-over first, then needs triage lowest number (unlabelled counts); claim only", async () => {
    gh.add({ number: 1 });
    gh.add({ number: 2, state_label: "needs triage" });
    gh.add({ number: 3, state_label: "board review", updated_at: "2026-11-05T00:00:00Z" });
    gh.add({ number: 4, state_label: "board review", updated_at: "2026-11-03T00:00:00Z" });
    expect((await call("board", "queue")).body.queue).toEqual([4, 3, 1, 2]);
    const r = await call("board", "next", {});
    expect(r.body.ticket).toMatchObject({ n: 4, state: "board review", resumed: false });
    expect(gh.label(4)).toEqual(["board review"]);
    expect(await claimOf(4)).toBe("board");
    expect(gh.writes).toEqual([]);
  });

  it("returns null when nothing is there", async () => {
    expect((await call("dev1", "next", {})).body).toEqual({ ok: true, ticket: null });
  });

  it("concurrent: two developers claiming the same ticket, exactly one wins", async () => {
    gh.add({ number: 1, state_label: "ready" });
    for (let round = 0; round < 5; round++) {
      const rs = await Promise.all([call("dev1", "next", {}), call("dev2", "next", {})]);
      const got = rs.map((r) => r.body.ticket?.n ?? null);
      expect(got.filter((n) => n === 1 + round)).toHaveLength(1);
      expect(got.filter((n) => n === null)).toHaveLength(1);
      // give the ticket back for the next round
      await inFlow((f) => f.sql.exec("DELETE FROM claims"));
      gh.issues.get(1 + round)!.labels = [{ name: "done-test" }];
      gh.issues.get(1 + round)!.state = "closed";
      gh.add({ number: 2 + round, state_label: "ready" });
    }
  });

  it("concurrent: two commands on one ticket run one after the other", async () => {
    gh.add({ number: 1, state_label: "in development" });
    gh.commit("feat: x (#1)");
    await claim(1, "dev1", "developer");
    const rs = await Promise.all([call("dev1", "handoff", { n: 1, comment: "a" }), call("dev1", "handoff", { n: 1, comment: "b" })]);
    expect(rs.map((r) => r.body.error ?? r.body.state).sort()).toEqual(["ready for testing", "wrong_state"]);
    expect(gh.issues.get(1)!.comments).toHaveLength(1);
  });

  it("concurrent: two developers, two tickets, each gets a different one", async () => {
    gh.add({ number: 1, state_label: "ready" });
    gh.add({ number: 2, state_label: "ready" });
    const rs = await Promise.all([call("dev1", "next", {}), call("dev2", "next", {})]);
    expect(rs.map((r) => r.body.ticket.n).sort()).toEqual([1, 2]);
  });
});

describe("heartbeat", () => {
  it("touches the caller's claim and refuses others", async () => {
    gh.add({ number: 1, state_label: "in development" });
    await claim(1, "dev1", "developer", Date.now() - 1000);
    expect((await call("dev1", "heartbeat", { n: 1 })).body.touched).toMatch(/^20/);
    expect((await call("dev2", "heartbeat", { n: 1 })).body).toEqual({
      ok: false,
      error: "not_claimed",
      message: "#1 is not claimed by dev2.",
    });
    gh.add({ number: 2, state_label: "ready" });
    expect((await call("dev1", "heartbeat", { n: 2 })).body.error).toBe("wrong_state");
  });
});

describe("release", () => {
  it("board: unchanged, claim dropped, comment optional", async () => {
    gh.add({ number: 1, state_label: "needs triage" });
    await claim(1, "board", "board");
    expect((await call("board", "release", { n: 1 })).body).toEqual({ ok: true, state: "needs triage" });
    expect(await claimOf(1)).toBeUndefined();
    expect(gh.issues.get(1)!.comments).toEqual([]);
  });
  it("developer: ready without commits, back to development with commits; comment required", async () => {
    gh.add({ number: 1, state_label: "in development" });
    await claim(1, "dev1", "developer");
    expect((await call("dev1", "release", { n: 1 })).body.error).toBe("comment_required");
    expect((await call("dev1", "release", { n: 1, comment: "blocked" })).body.state).toBe("ready");
    expect(gh.last(1)).toBe("Developer: blocked");
    gh.add({ number: 2, state_label: "in development" });
    gh.commit("feat: part (#2)");
    await claim(2, "dev1", "developer");
    expect((await call("dev1", "release", { n: 2, comment: "half" })).body.state).toBe("back to development");
    expect(await claimOf(2)).toBeUndefined();
  });
  it("tester: back to ready for testing; not_claimed for others", async () => {
    gh.add({ number: 1, state_label: "testing" });
    await claim(1, "tester", "tester");
    expect((await call("dev1", "release", { n: 1, comment: "x" })).body.error).toBe("wrong_state");
    expect((await call("tester", "release", { n: 1, comment: "no device" })).body.state).toBe("ready for testing");
  });
});

describe("handoff", () => {
  it("needs a new (#N) commit on main and lists it", async () => {
    gh.add({ number: 1, state_label: "in development" });
    await claim(1, "dev1", "developer");
    gh.commit("feat: other (#11)");
    expect((await call("dev1", "handoff", { n: 1, comment: "done" })).body).toEqual({
      ok: false,
      error: "no_commits",
      message: "No new commit on main ends with (#1); push first.",
    });
    const a = gh.commit("feat: thing (#1)");
    const r = await call("dev1", "handoff", { n: 1, comment: "Developer: done" });
    expect(r.body).toEqual({ ok: true, state: "ready for testing", commits: [a] });
    expect(gh.last(1)).toBe(`Developer: done\n\nCommits: ${a}`);
    expect(await claimOf(1)).toBeUndefined();
    // a second round needs a commit no earlier handoff listed
    gh.issues.get(1)!.labels = [{ name: "in development" }];
    await claim(1, "dev2", "developer");
    expect((await call("dev2", "handoff", { n: 1, comment: "again" })).body.error).toBe("no_commits");
    const b = gh.commit("fix: thing (#1)");
    expect((await call("dev2", "handoff", { n: 1, comment: "again" })).body.commits).toEqual([b]);
  });
  it("refuses without the claim or in the wrong state", async () => {
    gh.add({ number: 1, state_label: "in development" });
    expect((await call("dev1", "handoff", { n: 1, comment: "x" })).body.error).toBe("not_claimed");
    gh.add({ number: 2, state_label: "ready" });
    expect((await call("dev1", "handoff", { n: 2, comment: "x" })).body).toMatchObject({
      error: "wrong_state",
      message: "#2 is 'ready'; handoff needs 'in development'.",
    });
  });
});

describe("pass / fail", () => {
  it("passes to closed with the tested-build trailer", async () => {
    const { c, done } = testing();
    await done;
    const r = await call("tester", "pass", { n: 1, comment: "All good", build: c, gates: { sha: c, ok: true } });
    expect(r.body).toEqual({ ok: true, state: "closed" });
    expect(gh.issues.get(1)).toMatchObject({ state: "closed", state_reason: "completed", labels: [] });
    expect(gh.last(1)).toBe(`Tester: All good\n\nTested build: ${c}, gates green at ${c}`);
    expect(gh.status.get("I_1")).toBe("Done");
  });
  it("refuses a bad build, wrong gates, a build off main or one lacking the ticket's commit", async () => {
    const { c, done } = testing();
    await done;
    const pass = (b: Record<string, unknown>) => call("tester", "pass", { n: 1, comment: "ok", build: c, gates: { sha: c, ok: true }, ...b });
    expect((await pass({ build: "abc" })).body).toEqual({
      ok: false,
      error: "bad_request",
      message: "build must be a 40-character commit sha.",
    });
    expect((await pass({ gates: { sha: "f".repeat(40), ok: true } })).body.error).toBe("gates_mismatch");
    expect((await pass({ gates: { sha: c, ok: false } })).body.error).toBe("gates_mismatch");
    const off = "e".repeat(40);
    expect((await pass({ build: off, gates: { sha: off, ok: true } })).body.error).toBe("not_in_build");
    const older = gh.main[0].sha;
    gh.main.unshift({ sha: "0".repeat(40), message: "init" });
    const base = gh.main[0].sha;
    expect(older).toBe(c);
    expect((await pass({ build: base, gates: { sha: base, ok: true } })).body).toEqual({
      ok: false,
      error: "not_in_build",
      message: `Build 0000000 lacks ${c.slice(0, 7)} (#1); pull and test again.`,
    });
    expect((await call("tester", "pass", { n: 1, build: c, gates: { sha: c, ok: true } })).body.error).toBe("comment_required");
    expect(gh.writes).toEqual([]);
  });
  it("owner_check needs a card and goes to board review with origin passed; sendback refuses it", async () => {
    const { c, done } = testing();
    await done;
    const base = { n: 1, build: c, gates: { sha: c, ok: true }, owner_check: true };
    expect((await call("tester", "pass", { ...base, comment: "### For Nick\nKind: test\nChanged: x" })).body).toEqual({
      ok: false,
      error: "bad_card",
      message: "The card has no Check: lines (needed for Kind: test).",
    });
    expect((await call("tester", "pass", { ...base, comment: CARD_TEST })).body.state).toBe("board review");
    expect(await origin(1)).toBe("passed");
    expect((await call("board", "sendback", { n: 1, comment: "x" })).body).toMatchObject({ error: "wrong_state" });
    expect((await call("board", "escalate", { n: 1, comment: CARD_TEST })).body.state).toBe("human review");
    expect(await origin(1)).toBeUndefined();
  });
  it("fail goes back to development; the build must be on main", async () => {
    const { c, done } = testing();
    await done;
    expect((await call("tester", "fail", { n: 1, comment: "seen x, expected y", build: "d".repeat(40) })).body.error).toBe(
      "not_in_build",
    );
    expect((await call("tester", "fail", { n: 1, comment: "seen x, expected y", build: c })).body.state).toBe("back to development");
    expect(gh.last(1)).toBe("Tester: seen x, expected y");
  });
});

describe("stuck / sendback", () => {
  it("developer stuck goes back to development on sendback", async () => {
    gh.add({ number: 1, state_label: "in development" });
    await claim(1, "dev1", "developer");
    expect((await call("dev1", "stuck", { n: 1, comment: "Which API?" })).body.state).toBe("board review");
    expect(await origin(1)).toBe("in development");
    expect(await claimOf(1)).toBeUndefined();
    expect((await call("board", "next", {})).body.ticket).toMatchObject({ n: 1, origin: { from: "in development", instance: "dev1" } });
    expect((await call("board", "sendback", { n: 1, comment: "Use v2." })).body.state).toBe("back to development");
    expect(await origin(1)).toBeUndefined();
    expect(await claimOf(1)).toBeUndefined();
    expect(gh.last(1)).toBe("Board: Use v2.");
  });
  it("tester stuck goes back to ready for testing", async () => {
    gh.add({ number: 1, state_label: "testing" });
    await claim(1, "tester", "tester");
    await call("tester", "stuck", { n: 1, comment: "No device" });
    expect((await call("board", "sendback", { n: 1, comment: "Use the emulator." })).body.state).toBe("ready for testing");
  });
  it("sendback without a recorded origin is refused", async () => {
    gh.add({ number: 1, state_label: "board review" });
    expect((await call("board", "sendback", { n: 1, comment: "x" })).body.error).toBe("wrong_state");
  });
});

describe("board commands", () => {
  it("triage needs an Acceptance section and no developer/tester claim", async () => {
    gh.add({ number: 1, state_label: "needs triage", body: "just words" });
    expect((await call("board", "triage", { n: 1, comment: "ok" })).body.error).toBe("bad_request");
    gh.add({ number: 2, state_label: "board review" });
    await claim(2, "dev1", "developer");
    expect((await call("board", "triage", { n: 2, comment: "ok" })).body).toEqual({
      ok: false,
      error: "claimed",
      message: "#2 is claimed by dev1.",
    });
    gh.add({ number: 3, state_label: "human review", assignees: [{ login: "Nachtalb" }] });
    expect((await call("board", "triage", { n: 3, comment: "specified" })).body.state).toBe("ready");
    expect(gh.issues.get(3)!.assignees).toEqual([]);
  });
  it("spec replaces body and title, keeps the state", async () => {
    gh.add({ number: 1, state_label: "ready" });
    expect((await call("board", "spec", { n: 1, body: "new body", title: "New" })).body.state).toBe("ready");
    expect(gh.issues.get(1)).toMatchObject({ body: "new body", title: "New", comments: [] });
    await call("board", "spec", { n: 1, body: "b2", comment: "why" });
    expect(gh.last(1)).toBe("Board: why");
    gh.add({ number: 2, state_label: "testing" });
    expect((await call("board", "spec", { n: 2, body: "x" })).body.error).toBe("wrong_state");
    expect((await call("board", "spec", { n: 1, body: "" })).body.error).toBe("bad_request");
  });
  it("rework: needs triage only when answered; not when the tester holds it", async () => {
    gh.add({ number: 1, state_label: "needs triage" });
    expect((await call("board", "rework", { n: 1, comment: "x" })).body.error).toBe("wrong_state");
    await answerRow(1);
    expect((await call("board", "rework", { n: 1, comment: "change x" })).body.state).toBe("back to development");
    gh.add({ number: 2, state_label: "ready for testing" });
    await claim(2, "tester", "tester");
    expect((await call("board", "rework", { n: 2, comment: "x" })).body.error).toBe("claimed");
  });
  it("an answer older than the ticket's entry into needs triage does not count", async () => {
    gh.add({ number: 1, state_label: "postponed" });
    await answerRow(1, Date.now() - 60_000);
    await call("board", "resume", { n: 1 });
    expect((await call("board", "approve", { n: 1 })).body.error).toBe("wrong_state");
  });
  it("escalate: card checked, human review, Nick assigned, card sent", async () => {
    gh.add({ number: 1, state_label: "ready" });
    expect((await call("board", "escalate", { n: 1, comment: "no card" })).body).toEqual({
      ok: false,
      error: "bad_card",
      message: "The comment has no ### For Nick card.",
    });
    expect((await call("board", "escalate", { n: 1, comment: "### For Nick\nKind: maybe\nQuestion: x" })).body.error).toBe("bad_card");
    const r = await call("board", "escalate", { n: 1, comment: CARD_Q });
    expect(r.body).toEqual({ ok: true, state: "human review", telegram: "sent" });
    expect(gh.issues.get(1)!.assignees).toEqual([{ login: "Nachtalb" }]);
    expect(gh.status.get("I_1")).toBe("Owner");
    const [m] = tg.of("sendRichMessage");
    expect(m.chat_id).toBe("713276361");
    expect(m.rich_message.html).toContain("Blue or green?");
    expect(m.rich_message.html).toContain('data="k">✅ OK');
    expect((await call("board", "queue")).body.inbox).toEqual([1]);
  });
  it("escalate with Telegram down answers queued; the cron sends it", async () => {
    gh.add({ number: 1, state_label: "board review" });
    tg.down = true;
    expect((await call("board", "escalate", { n: 1, comment: CARD_TEST })).body.telegram).toBe("queued");
    tg.down = false;
    tg.calls = [];
    await inFlow((f) => f.cron());
    expect(tg.of("sendRichMessage")[0].rich_message.html).toContain("Lessons load faster");
  });
  it("approve, drop, postpone, resume", async () => {
    gh.add({ number: 1, state_label: "human review", assignees: [{ login: "Nachtalb" }] });
    expect((await call("board", "approve", { n: 1 })).body.state).toBe("closed");
    expect(gh.issues.get(1)).toMatchObject({ state_reason: "completed", assignees: [] });
    gh.add({ number: 2, state_label: "ready" });
    expect((await call("board", "approve", { n: 2 })).body.error).toBe("wrong_state");
    expect((await call("board", "drop", { n: 2 })).body.error).toBe("comment_required");
    expect((await call("board", "drop", { n: 2, comment: "duplicate" })).body.state).toBe("closed");
    expect(gh.issues.get(2)!.state_reason).toBe("not_planned");
    gh.add({ number: 3, state_label: "human review" });
    expect((await call("board", "postpone", { n: 3 })).body.state).toBe("postponed");
    expect(gh.status.get("I_3")).toBe("On hold");
    expect((await call("board", "resume", { n: 3, comment: "now" })).body.state).toBe("needs triage");
    expect((await call("board", "resume", { n: 3 })).body.error).toBe("wrong_state");
    gh.add({ number: 4, state_label: "in development" });
    await claim(4, "dev1", "developer");
    expect((await call("board", "drop", { n: 4, comment: "x" })).body.error).toBe("wrong_state");
  });
  it("leaving board review drops the board's claim and the origin", async () => {
    gh.add({ number: 1, state_label: "in development" });
    await claim(1, "dev1", "developer");
    await call("dev1", "stuck", { n: 1, comment: "?" });
    await call("board", "next", {});
    await call("board", "spec", { n: 1, body: "b" });
    expect(await claimOf(1)).toBe("board");
    expect(await origin(1)).toBe("in development");
    await call("board", "rework", { n: 1, comment: "do y" });
    expect(await claimOf(1)).toBeUndefined();
    expect(await origin(1)).toBeUndefined();
  });
});

describe("answer", () => {
  it("from human review to needs triage, signed Nick:", async () => {
    gh.add({ number: 1, state_label: "human review", assignees: [{ login: "Nachtalb" }] });
    expect((await call("owner", "answer", { n: 1, text: "Board: blue" })).body).toEqual({ ok: true, state: "needs triage" });
    expect(gh.last(1)).toBe("Nick: blue");
    expect(gh.issues.get(1)!.assignees).toEqual([]);
    expect((await call("board", "show")).status).toBe(400);
    const s = await call("board", "show?n=1");
    expect(s.body.answers.map((a: { text: string }) => a.text)).toEqual(["blue"]);
    expect((await call("board", "approve", { n: 1 })).body.state).toBe("closed");
  });
  it("reopens a closed ticket; keeps other states", async () => {
    gh.add({ number: 1, state: "closed" });
    expect((await call("owner", "answer", { n: 1, text: "again" })).body.state).toBe("needs triage");
    expect(gh.issues.get(1)).toMatchObject({ state: "open", labels: [{ name: "needs triage" }] });
    gh.add({ number: 2, state_label: "ready" });
    expect((await call("owner", "answer", { n: 2, text: "note" })).body.state).toBe("ready");
    expect((await call("owner", "answer", { n: 2, text: " " })).body.error).toBe("comment_required");
  });
});

describe("refusals common to all", () => {
  it("404 for a missing ticket or a pull request, 409 for two states", async () => {
    gh.add({ number: 1, state_label: "ready", pull_request: {} });
    expect((await call("board", "show?n=1")).body).toEqual({
      ok: false,
      error: "not_found",
      message: "#1 does not exist or is a pull request.",
    });
    expect((await call("board", "approve", { n: 7 })).status).toBe(404);
    gh.add({ number: 2, state_label: ["ready", "testing"] });
    expect((await call("board", "approve", { n: 2 })).body).toEqual({
      ok: false,
      error: "two_states",
      message: "#2 has two state labels (ready, testing); fix it by hand.",
    });
  });
  it("400 for a missing n or a non-JSON body; 404 for an unknown command", async () => {
    expect((await call("board", "approve", {})).body.message).toBe("n must be a ticket number.");
    expect((await call("board", "nope", {})).status).toBe(404);
    const { SELF } = await import("cloudflare:test");
    const r = await SELF.fetch("https://flow.test/v1/next", { method: "POST", headers: { authorization: "Bearer s-dev1" }, body: "{" });
    expect(r.status).toBe(400);
  });
  it("show: dependencies, commits, claim", async () => {
    gh.add({ number: 1, state_label: "ready" });
    gh.add({ number: 2, state_label: "in development", body: "Depends on: #1, #3" });
    gh.add({ number: 3, state: "closed" });
    const c = gh.commit("feat: x (#2)");
    await claim(2, "dev2", "developer");
    expect((await call("tester", "show?n=2")).body).toMatchObject({
      n: 2,
      state: "in development",
      claim: { instance: "dev2" },
      depends_on: [1, 3],
      blocked_by: [1],
      commits: [c],
      answers: [],
    });
  });
});

describe("idempotency", () => {
  it("a repeated key returns the stored response without acting again; per caller", async () => {
    gh.add({ number: 1, state_label: "human review" });
    const a = await call("board", "approve", { n: 1, comment: "fine" }, "k1");
    const b = await call("board", "approve", { n: 1, comment: "fine" }, "k1");
    expect(b).toEqual(a);
    expect(gh.issues.get(1)!.comments).toHaveLength(1);
    expect((await call("owner", "answer", { n: 1, text: "hi" }, "k1")).body.state).toBe("needs triage");
  });
  it("a GitHub failure stores nothing, so the retry with the same key completes", async () => {
    gh.add({ number: 1, state_label: "human review" });
    gh.fail = (m, p) => (m === "PATCH" && p.endsWith("/issues/1") ? 502 : undefined);
    const r = await call("board", "postpone", { n: 1 }, "k2");
    expect(r).toEqual({ status: 502, body: { ok: false, error: "github", message: "GitHub answered 502 for the label change of #1." } });
    expect(gh.label(1)).toEqual(["human review"]);
    gh.fail = undefined;
    expect((await call("board", "postpone", { n: 1 }, "k2")).body.state).toBe("postponed");
  });
});

describe("signatures", () => {
  it("strips a signature the caller wrote and signs with the caller's role", async () => {
    gh.add({ number: 1, state_label: "in development" });
    await claim(1, "dev1", "developer");
    await call("dev1", "stuck", { n: 1, comment: "Tester: Board: why?" });
    expect(gh.last(1)).toBe("Developer: why?");
  });
});

describe("without GitHub token", () => {
  it("whoami works, GitHub commands answer 502 github", async () => {
    const original = await inObject((o) => {
      const t = (o.env as unknown as Record<string, unknown>).GITHUB_TOKEN;
      o.env = { ...o.env, GITHUB_TOKEN: undefined } as typeof o.env;
      o.reset();
      return t as string;
    });
    expect((await call("dev1", "whoami")).status).toBe(200);
    expect((await call("dev1", "next", {})).body).toEqual({
      ok: false,
      error: "github",
      message: "GitHub is not connected yet (the secret GITHUB_TOKEN is missing); nothing was changed.",
    });
    expect((await call("dev1", "queue")).status).toBe(502);
    await inObject((o) => {
      o.env = { ...o.env, GITHUB_TOKEN: original } as typeof o.env;
      o.reset();
    });
  });
});

describe("lease reaper (cron)", () => {
  it("returns expired developer/tester claims to the queue with a Board comment; drops board claims silently", async () => {
    const old = Date.now() - 4 * 3600e3;
    gh.add({ number: 1, state_label: "in development" });
    gh.add({ number: 2, state_label: "in development" });
    gh.commit("feat: a (#2)");
    gh.add({ number: 3, state_label: "testing" });
    gh.add({ number: 4, state_label: "board review" });
    gh.add({ number: 5, state_label: "in development" });
    await claim(1, "dev1", "developer", old);
    await claim(2, "dev2", "developer", old);
    await claim(3, "tester", "tester", old);
    await claim(4, "board", "board", old);
    await claim(5, "dev1", "developer");
    await inFlow((f) => f.cron());
    expect([1, 2, 3, 4, 5].map((n) => gh.label(n)[0])).toEqual([
      "ready",
      "back to development",
      "ready for testing",
      "board review",
      "in development",
    ]);
    expect(gh.last(1)).toBe("Board: The claim of dev1 expired after 3 h without a heartbeat; the ticket is back in the queue.");
    expect(gh.issues.get(4)!.comments).toEqual([]);
    expect(await claimOf(5)).toBe("dev1");
    expect(await inFlow((f) => f.rows("SELECT n FROM claims").length)).toBe(1);
  });
});

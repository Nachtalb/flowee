// Webhooks (docs/webhooks.md): verified deliveries, targeted work instead of listings, the mirror behind `queue`,
// the reconcile, the fallback to polling and back, registration, alarms. The fake GitHub counts every request.
import { beforeEach, describe, expect, it } from "vitest";
import { GitHub } from "../src/adapters/tracker-github";
import type { Delivery } from "../src/ports/hooks";
import { deliver, GH, installHooks } from "./fake-hooks";
import { call, type F, inFlow, inObject } from "./helpers";

let fx: ReturnType<typeof installHooks>;
let T = Date.UTC(2026, 10, 23, 7, 0, 30);
const MIN = 60e3;
const clock = { now: () => T, wake: async () => {} };
const run = <R>(fn: (f: F) => R | Promise<R>, ws = "hooks") =>
  inFlow((f) => {
    f.clock = clock;
    return fn(f);
  }, ws);
const secret = (ws = "hooks") => run((f) => f.events.secret(f.tracker.list[0]) as Promise<string>, ws);
const calls = () => fx.hk.auth.length;
const cron = (ws = "hooks") => run((f) => f.cron(), ws);
/** The alarm's pass: queued events and whatever else is due. */
const alarm = (ws = "hooks") => run((f) => f.cron(false), ws);
const status = (ws = "hooks") => run((f) => f.events.status(), ws);
const iso = (ms: number) => new Date(ms).toISOString();
/** Everything the bot sent, as text. */
const sent = () => fx.tg.calls.filter((c) => c.method.startsWith("send")).map((c) => JSON.stringify(c.params));

beforeEach(async () => {
  fx = installHooks();
  T = Date.UTC(2026, 10, 23, 7, 0, 30);
  for (const ws of ["hooks", "hooks2"])
    await inObject((o) => {
      for (const t of ["claims", "inbox", "messages", "meta", "mirror", "deliveries", "hook_events", "entered", "answers", "postponed"]) o.host.store.exec(`DELETE FROM ${t}`);
      o.host.reset();
    }, ws);
});

const d = (h: Record<string, string>, body: string): Delivery => ({ header: (n) => h[n.toLowerCase()] ?? null, body });

describe("GitHub deliveries", () => {
  const gh = new GitHub({ repo: "octocat/Hello-World", token: "t", tokenName: "T" });
  const SIG = "sha256=757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17";

  it("verifies the X-Hub-Signature-256 of GitHub's documented example; refuses a bad, missing or foreign one", async () => {
    const h = gh.hooks;
    expect(await h.verify(d({ "x-hub-signature-256": SIG }, "Hello, World!"), "It's a Secret to Everybody")).toBe(true);
    expect(await h.verify(d({ "x-hub-signature-256": SIG.replace(/7$/, "8") }, "Hello, World!"), "It's a Secret to Everybody")).toBe(false);
    expect(await h.verify(d({ "x-hub-signature-256": SIG }, "Hello, World?"), "It's a Secret to Everybody")).toBe(false);
    expect(await h.verify(d({ "x-hub-signature-256": SIG }, "Hello, World!"), "another secret")).toBe(false);
    expect(await h.verify(d({}, "Hello, World!"), "It's a Secret to Everybody")).toBe(false);
    expect(await h.verify(d({ "x-hub-signature-256": "sha1=7d38cdd689735b008b3c702edd92eea23791c5f6" }, "Hello, World!"), "It's a Secret to Everybody")).toBe(false);
    expect(h.id(d({ "x-github-delivery": "72d3162e-cc78-11e3-81ab-4c9367dc0958" }, ""))).toBe("72d3162e-cc78-11e3-81ab-4c9367dc0958");
  });

  it("reads every event Flowee uses into the tracker-agnostic form", () => {
    const R = "octocat/Hello-World";
    const p = (event: string, payload: unknown) => gh.hooks.parse(d({ "x-github-event": event }, JSON.stringify(payload)));
    const sha = "a".repeat(40);
    expect(p("issues", GH.issues(R, 1347))).toEqual([{ kind: "ticket", repo: R, n: 1347 }]);
    expect(p("issue_comment", GH.comment(R, 3))).toEqual([{ kind: "comment", repo: R, n: 3 }]);
    expect(p("issue_comment", GH.prComment(R, 3))).toEqual([]);
    expect(p("push", GH.push(R, "refs/heads/main", sha))).toEqual([{ kind: "push", repo: R, branch: "main", sha }]);
    expect(p("push", GH.push(R, "refs/tags/v1.2", "0".repeat(40)))).toEqual([{ kind: "tag", repo: R, tag: "v1.2", sha: null }]);
    expect(p("create", GH.create(R, "tested"))).toEqual([{ kind: "tag", repo: R, tag: "tested", sha: null }]);
    expect(p("delete", GH.create(R, "flowee/3", "branch"))).toEqual([{ kind: "push", repo: R, branch: "flowee/3", sha: null }]);
    expect(p("pull_request", GH.pull(R, 9, "opened"))).toEqual([{ kind: "pull", repo: R, number: 9, action: "opened", branch: "flowee/9", author: "octocat" }]);
    expect(p("pull_request", GH.pull(R, 9, "synchronize"))[0]).toMatchObject({ action: "updated" });
    expect(p("pull_request", GH.pull(R, 9, "closed", true))[0]).toMatchObject({ action: "merged" });
    expect(p("pull_request", GH.pull(R, 9, "closed"))[0]).toMatchObject({ action: "closed" });
    expect(p("pull_request", GH.pull(R, 9, "labeled"))).toEqual([]);
    expect(p("check_suite", GH.checkSuite(R, sha))).toEqual([{ kind: "checks", repo: R, sha }]);
    expect(p("status", GH.status(R, sha))).toEqual([{ kind: "checks", repo: R, sha }]);
    expect(p("status", GH.status(R, sha, "pending"))).toEqual([]);
    expect(p("release", GH.release(R, "v2.0"))).toEqual([{ kind: "release", repo: R, tag: "v2.0" }]);
    expect(p("ping", GH.ping(R))).toEqual([{ kind: "ping", repo: R }]);
    expect(p("star", { action: "created", repository: { full_name: R } })).toEqual([]);
    expect(gh.hooks.parse(d({ "x-github-event": "issues" }, "not json"))).toEqual([]);
  });
});

describe("registration", () => {
  it("auto: the first scheduled pass registers the hook through the API, the workspace runs on webhooks", async () => {
    fx.hk.add({ state_label: "ready" });
    await cron();
    expect(fx.hooks.hooks).toHaveLength(1);
    const h = fx.hooks.hooks[0];
    expect(h.config).toMatchObject({ url: "https://flow.test/hooks/hooks/hooks", content_type: "json" });
    expect(h.config.secret).toBe(await secret());
    expect(h.events).toEqual(expect.arrayContaining(["issues", "issue_comment", "push", "pull_request", "check_suite", "release"]));
    expect((await status()).repos[0]).toMatchObject({ mode: "webhook", via: "api", url: "https://flow.test/hooks/hooks/hooks" });
    const r = await call("board", "queue", undefined, undefined, "h");
    expect(r.body).toMatchObject({ ok: true, queue: [], source: "mirror" });
    // the API shows the same state
    const s = await call("board", "sync", undefined, undefined, "h");
    expect(s.body.sync.repos[0]).toMatchObject({ alias: "hooks", mode: "webhook" });
  });

  it("refused for lack of permission: polls as before, names the permission; the manual way turns webhooks on at the first ping", async () => {
    fx.hooks.allowed = false;
    await cron();
    const st = (await status()).repos[0];
    expect(st).toMatchObject({ mode: "poll", missing: expect.stringContaining('"Webhooks: Read and write"') });
    expect(st.reason).toContain("the token lacks");
    expect((await call("board", "queue", undefined, undefined, "h")).body.source).toBe("tracker");
    const before = calls();
    await cron();
    await cron();
    expect(calls() - before).toBe(2); // one listing per cron, as before webhooks
    const m = await run((f) => f.events.manual("hooks"));
    expect(m).toMatchObject({ url: "https://flow.test/hooks/hooks/hooks", where: expect.stringContaining("Settings → Webhooks"), permission: expect.stringContaining("Webhooks") });
    expect(m.secret).toMatch(/^[0-9a-f]{64}$/);
    expect((await deliver("hooks", "hooks", "ping", GH.ping("acme/hooks"), m.secret)).status).toBe(200);
    expect((await status()).repos[0]).toMatchObject({ mode: "webhook", via: "manual", lastDelivery: iso(T) });
    await alarm(); // rebuilds the mirror at once
    expect((await call("board", "queue", undefined, undefined, "h")).body.source).toBe("mirror");
  });

  it("sync.webhooks off on a webhook workspace removes the hook Flowee made; deleting the workspace's hooks unregisters", async () => {
    await cron();
    expect(fx.hooks.hooks).toHaveLength(1);
    await run((f) => f.events.disable(f.tracker.list[0]));
    expect(fx.hooks.hooks).toHaveLength(0);
    expect((await status()).repos[0].mode).toBe("poll");
  });
});

describe("inbound route", () => {
  it("401 with no detail for a wrong, missing or foreign signature and unknown hooks; a redelivery does nothing", async () => {
    await cron();
    const s = await secret();
    const body = GH.issues("acme/hooks", 1);
    expect(await deliver("hooks", "hooks", "issues", body, "wrong")).toMatchObject({ status: 401, text: "" });
    expect(await deliver("hooks", "hooks", "issues", body, s, { sig: null })).toMatchObject({ status: 401, text: "" });
    expect(await deliver("hooks", "nope", "issues", body, s)).toMatchObject({ status: 401, text: "" });
    expect(await deliver("nope", "hooks", "issues", body, s)).toMatchObject({ status: 401, text: "" });
    // another workspace's secret never opens this one
    await cron("hooks2");
    expect((await deliver("hooks", "hooks", "issues", body, await secret("hooks2"))).status).toBe(401);
    const ok = await deliver("hooks", "hooks", "issues", body, s);
    expect(ok).toMatchObject({ status: 200, text: "ok" });
    expect((await deliver("hooks", "hooks", "issues", body, s, { id: ok.id })).status).toBe(200);
    expect(await run((f) => f.rows("SELECT event FROM hook_events"))).toHaveLength(1);
    // an event about another repository than the hook's is ignored
    await deliver("hooks", "hooks", "issues", GH.issues("acme/hooks2", 1), s);
    expect(await run((f) => f.rows("SELECT event FROM hook_events"))).toHaveLength(1);
  });

  it("two workspaces: each delivery reaches only its own workspace's mirror", async () => {
    fx.hk.add({ state_label: "ready" });
    fx.hk2.add({ state_label: "ready" });
    await cron();
    await cron("hooks2");
    fx.hk2.issues.get(1)!.labels = [{ name: "human review" }];
    expect((await deliver("hooks2", "hooks2", "issues", GH.issues("acme/hooks2", 1), await secret("hooks2"))).status).toBe(200);
    await alarm("hooks2");
    await alarm();
    expect((await run((f) => f.events.mirrored(f.tracker.list[0]), "hooks2"))[0].labels).toEqual(["human review"]);
    expect((await run((f) => f.events.mirrored(f.tracker.list[0])))[0].labels).toEqual(["ready"]);
  });
});

/** A ticket changed on the tracker by someone else; `at` its update time. */
function change(n: number, labels: string[], at = T, open = true) {
  const i = fx.hk.issues.get(n) ?? fx.hk.add({ number: n });
  i.labels = labels.map((name) => ({ name }));
  i.state = open ? "open" : "closed";
  i.updated_at = iso(at);
}

describe("event-driven work", () => {
  it("a ticket event re-reads only that ticket: into the owner's inbox it sends the card; queue answers from the mirror", async () => {
    fx.hk.add({ state_label: "ready" });
    fx.hk.add({ state_label: "ready" });
    await cron(); // registers, lists once, seeds the inbox
    const s = await secret();
    const sent0 = sent().length;
    const before = calls();
    change(2, ["human review"]);
    fx.hk.issues.get(2)!.comments.push({ id: 9, body: "Board: please look.\n\n### For Ann\nKind: question\nQuestion: Blue or green?" });
    await deliver("hooks", "hooks", "issues", GH.issues("acme/hooks", 2), s);
    expect(calls() - before).toBe(0); // the response does not wait for the work
    await alarm();
    expect(fx.hk.auth.length - before).toBe(2); // GET issues/2 and its comments for the card; no listing
    expect(sent().length).toBeGreaterThan(sent0);
    expect(sent().at(-1)).toContain("Blue or green?");
    const q = await call("owner", "queue", undefined, undefined, "h");
    expect(q.body).toMatchObject({ inbox: [2], source: "mirror" });
    expect(calls() - before).toBe(2);
    // a comment event re-reads that ticket once more
    await deliver("hooks", "hooks", "issue_comment", GH.comment("acme/hooks", 1), s);
    await alarm();
    expect(calls() - before).toBe(3);
    // events Flowee has no work for cost nothing
    await deliver("hooks", "hooks", "push", GH.push("acme/hooks", "refs/heads/main", "b".repeat(40)), s);
    await deliver("hooks", "hooks", "check_suite", GH.checkSuite("acme/hooks", "b".repeat(40)), s);
    await deliver("hooks", "hooks", "pull_request", GH.pull("acme/hooks", 7, "opened"), s);
    await alarm();
    expect(calls() - before).toBe(3);
  });

  it("a command still reads the tracker: next claims what the tracker says even when the mirror is behind", async () => {
    fx.hk.add({ state_label: "ready" });
    await cron();
    change(1, ["board review"]); // no delivery: the mirror still says ready
    const q = await call("dev1", "queue", undefined, undefined, "h");
    expect(q.body).toMatchObject({ queue: [1], source: "mirror" });
    const n = await call("dev1", "next", {}, undefined, "h");
    expect(n.body).toMatchObject({ ok: true, ticket: null });
  });

  it("a healthy webhook workspace over an hour: no tracker call from the cron but the two reconciles, one per ticket event", async () => {
    for (let i = 0; i < 4; i++) fx.hk.add({ state_label: "ready" });
    const paths: string[] = [];
    const h0 = fx.hk.handle.bind(fx.hk);
    fx.hk.handle = (req: Request) => (paths.push(`${req.method} ${new URL(req.url).pathname}`), h0(req));
    await cron();
    const s = await secret();
    const start = calls();
    const perMinute: number[] = [];
    for (let m = 1; m <= 60; m++) {
      T += MIN;
      const c0 = calls();
      await cron();
      perMinute.push(calls() - c0);
      if (m % 12 === 0) {
        const c1 = calls();
        change(1 + (m % 4), ["board review"], T);
        await deliver("hooks", "hooks", "issues", GH.issues("acme/hooks", 1 + (m % 4)), s);
        await alarm();
        expect(calls() - c1, paths.slice(-3).join()).toBe(1);
      }
    }
    // the reconcile (a listing and the hook's status) at minutes 30 and 60, nothing in between
    expect(perMinute.map((x, i) => (x ? i + 1 : 0)).filter(Boolean)).toEqual([30, 60]);
    expect(perMinute.reduce((a, b) => a + b)).toBe(4);
    expect(calls() - start).toBe(4 + 5);
  });

  it("before webhooks (sync.webhooks off): the same hour lists the tracker on every cron", async () => {
    const before = fx.gh2.auth.length;
    for (let m = 1; m <= 60; m++) await inFlow((f) => f.cron(), "other");
    expect(fx.gh2.auth.length - before).toBe(60);
  });
});

/** A small deterministic random source (mulberry32). */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LABELS = ["needs triage", "ready", "back to development", "board review", "human review", "postponed", "in development", "testing", "ready for testing"];
const CALLERS = [
  { instance: "board", role: "board" },
  { instance: "dev1", role: "developer" },
  { instance: "tester", role: "tester" },
  { instance: "owner", role: "owner" },
];

/** queue from the mirror against queue computed from a fresh tracker listing, for every role. */
async function sameAsTracker() {
  await run(async (f) => {
    const issues = (await f.tracker.openIssues()).sort((a, b) => a.n - b.n);
    expect(f.events.mirrored(f.tracker.list[0])).toEqual(issues);
    for (const c of CALLERS) {
      const { source, ...q } = await f.queue(c);
      expect(source).toBe("mirror");
      const want = (await f.queueOf(c, issues)).map((i) => f.ref(i.n));
      expect(q.queue, c.role).toEqual(want);
      if (c.role === "owner") expect(q.inbox).toEqual(f.inbox(issues).map((i) => f.ref(i.n)).sort((a, b) => Number(a) - Number(b)));
    }
  });
}

describe("the mirror", () => {
  it("answers queue exactly as the tracker would after random event orders and redeliveries", async () => {
    const r = rng(7);
    for (let n = 1; n <= 5; n++) fx.hk.add({ state_label: LABELS[n] });
    await cron();
    const s = await secret();
    for (let round = 0; round < 25; round++) {
      const batch: { n: number; id?: string }[] = [];
      for (let k = 0; k < 1 + Math.floor(r() * 3); k++) {
        const n = 1 + Math.floor(r() * 7);
        const op = r();
        if (op < 0.15) change(n, LABELS.slice(0, 1 + Math.floor(r() * 2)), T, false);
        else if (op < 0.25) fx.hk.issues.get(n) && (fx.hk.issues.get(n)!.body = `Depends on: #${1 + Math.floor(r() * 7)}\n## Acceptance\n- x`);
        else change(n, [LABELS[Math.floor(r() * LABELS.length)]], T);
        batch.push({ n });
      }
      // deliveries in any order, some twice
      batch.sort(() => r() - 0.5);
      for (const b of batch) {
        const x = await deliver("hooks", "hooks", "issues", GH.issues("acme/hooks", b.n), s);
        if (r() < 0.3) await deliver("hooks", "hooks", "issues", GH.issues("acme/hooks", b.n), s, { id: x.id });
      }
      await alarm();
      await sameAsTracker();
      T += MIN;
    }
  });

  it("a missed delivery: the reconcile heals the mirror, falls back to polling and says so once; a delivery later turns webhooks back on", async () => {
    for (let n = 1; n <= 3; n++) fx.hk.add({ state_label: "ready" });
    await cron();
    const s = await secret();
    change(2, ["board review"], T); // its delivery is lost
    T += 10 * MIN;
    await cron();
    expect((await run((f) => f.events.mirrored(f.tracker.list[0])))[1].labels).toEqual(["ready"]);
    T += 21 * MIN; // the reconcile is due
    const notes = () => sent().filter((m) => m.includes("Instant updates"));
    await cron();
    await sameAsTrackerAnySource();
    expect((await status()).repos[0]).toMatchObject({ mode: "poll", reason: "changes on the tracker arrived without a delivery" });
    expect(notes()).toHaveLength(1);
    expect(notes()[0]).toContain("Instant updates for acme/hooks are off");
    // polled now: every cron lists, queue reads the tracker
    let before = calls();
    await cron();
    expect(calls() - before).toBe(1);
    expect((await call("board", "queue", undefined, undefined, "h")).body.source).toBe("tracker");
    await cron();
    expect(notes()).toHaveLength(1);
    // deliveries arrive again after the settling time
    T += 11 * MIN;
    expect((await deliver("hooks", "hooks", "issues", GH.issues("acme/hooks", 3), s)).status).toBe(200);
    await alarm();
    expect((await status()).repos[0].mode).toBe("webhook");
    expect(notes()).toHaveLength(2);
    expect(notes()[1]).toContain("are on again");
    before = calls();
    await cron();
    expect(calls() - before).toBe(0);
  });

  it("the tracker's own report of a failing hook falls back at the next reconcile", async () => {
    await cron();
    fx.hooks.hooks[0].last_response = { code: 502, status: "failed", message: "Bad Gateway" };
    T += 30 * MIN;
    await cron();
    expect((await status()).repos[0]).toMatchObject({ mode: "poll", reason: "the tracker reports the webhook failing (last delivery answered 502: Bad Gateway)" });
  });
});

async function sameAsTrackerAnySource() {
  await run(async (f) => expect(f.events.mirrored(f.tracker.list[0])).toEqual((await f.tracker.openIssues()).sort((a, b) => a.n - b.n)));
}

describe("alarms", () => {
  it("the alarm is due at the earliest lease expiry and the reaper runs then; otherwise at the next hour for the digest", async () => {
    fx.hk.add({ state_label: "in development" });
    await cron();
    const touched = T - 3 * 3600e3 + 10 * MIN;
    await run((f) => f.db.exec("INSERT INTO claims VALUES (1, 'dev1', 'developer', ?, ?)", touched, touched));
    const at = await run((f) => f.wakeAt());
    expect(at).toBe(touched + 3 * 3600e3 + 1000);
    T = at - 2000;
    await alarm();
    expect(await run((f) => f.rows("SELECT n FROM claims"))).toHaveLength(1);
    T = at;
    await alarm();
    expect(await run((f) => f.rows("SELECT n FROM claims"))).toHaveLength(0);
    expect(fx.hk.label(1)).toEqual(["ready"]);
    // nothing leased: the next hour (digest window), or the reconcile when sooner
    const next = await run((f) => f.wakeAt());
    expect(next).toBe(Math.min(Math.floor(T / 3600e3 + 1) * 3600e3, (await run((f) => f.events.state(f.tracker.list[0]).listed ?? 0)) + 30 * MIN));
  });

  it("queued events make the alarm due at once; something due that keeps failing is retried a minute later", async () => {
    await cron();
    await deliver("hooks", "hooks", "issues", GH.issues("acme/hooks", 1), await secret());
    expect(await run((f) => f.wakeAt())).toBe(T);
    await alarm();
    const old = T - 4 * 3600e3;
    await run((f) => f.db.exec("INSERT INTO claims VALUES (9, 'dev1', 'developer', ?, ?)", old, old));
    expect(await run((f) => f.wakeAt())).toBe(T + 60e3);
  });

  it("Flowee's own writes reach the mirror at once: a command's label is in queue before its delivery", async () => {
    fx.hk.add({ state_label: "needs triage" });
    await cron();
    expect((await call("board", "next", {}, undefined, "h")).body.ticket).toMatchObject({ n: 1 });
    expect((await call("board", "triage", { n: 1, comment: "specified" }, undefined, "h")).body.state).toBe("ready");
    const before = calls();
    expect((await call("dev1", "queue", undefined, undefined, "h")).body).toMatchObject({ queue: [1], source: "mirror" });
    expect(calls()).toBe(before);
    // the delivery that follows changes nothing but the update time
    await deliver("hooks", "hooks", "issues", GH.issues("acme/hooks", 1), await secret());
    await alarm();
    await sameAsTrackerAnySource();
  });
});

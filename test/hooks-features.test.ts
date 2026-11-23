// Webhook events doing the code features' work for the one ticket or repository they name, without the
// listings the cron makes: a release releasing a held card, a dependency pull request becoming a ticket, a push to
// main moving the tested tag. The events are queued as a verified delivery queues them (test/hooks.test.ts covers
// the verification); the workspaces poll otherwise (sync.webhooks off), so the cron is the comparison.
import { beforeEach, describe, expect, it } from "vitest";
import type { TrackerEvent } from "../src/ports/hooks";
import type { FakeGitHub } from "./fake";
import { FakeCode } from "./fake-code";
import { CARD_TEST, call, inFlow, setup, wipe } from "./helpers";

let any: FakeGitHub;
let dev: FakeGitHub;
let code: FakeCode;
let devCode: FakeCode;
let paths: string[];

const log = (gh: FakeGitHub) => {
  const h = gh.handle.bind(gh);
  gh.handle = (req: Request) => (paths.push(`${req.method} ${new URL(req.url).pathname}`), h(req));
};

beforeEach(async () => {
  const fx = setup();
  any = fx.viewer;
  dev = fx.deps;
  code = new FakeCode(any);
  devCode = new FakeCode(dev);
  paths = [];
  log(any);
  log(dev);
  await wipe("viewer");
  await wipe("deps");
});

/** The events as a delivery queues them, then the alarm's pass over the queue only. */
const events = (ws: string, ...evs: TrackerEvent[]) =>
  inFlow(async (f) => {
    for (const e of evs) f.db.exec("INSERT INTO hook_events (slot, event) VALUES (?, ?)", f.tracker.list[0].slot, JSON.stringify(e));
    await f.events.drain();
  }, ws);
const listings = (repo: string) => paths.filter((p) => p === `GET /repos/${repo}/issues` || p === `GET /repos/${repo}/pulls`).length;

describe("code features on events", () => {
  it("a release event releases the held card: the ticket reaches the owner with the version, no listing", async () => {
    any.add({ number: 3, state_label: "awaiting release" });
    const sha = any.commit("feat: thing (#3)");
    any.issues.get(3)!.comments.push({ id: 1, body: `Board: ${CARD_TEST}` });
    await inFlow((f) => f.cron(), "viewer"); // lists once: the mirror knows #3
    expect(any.label(3)).toContain("awaiting release");
    code.publish("2.0.0", sha);
    const before = listings("acme/viewer");
    await events("viewer", { kind: "release", repo: "acme/viewer", tag: "v2.0.0" });
    expect(any.label(3)).toContain("human review");
    expect(listings("acme/viewer")).toBe(before);
    const q = await call("owner", "queue", undefined, undefined, "p");
    expect(q.body.inbox).toEqual([3]);
  });

  it("a pull request opened by a dependency author becomes its ticket from the one pull request read", async () => {
    devCode.push("dependabot/npm/x-2");
    devCode.pr("dependabot/npm/x-2", "Bump x from 1 to 2", "dependabot[bot]");
    devCode.pr("someone/else", "Not a bump", "ann");
    await inFlow((f) => f.events.fetch(f.tracker.list[0]), "deps"); // the mirror as registration leaves it
    const before = listings("acme/deps");
    await events(
      "deps",
      { kind: "pull", repo: "acme/deps", number: 1001, action: "opened", branch: "dependabot/npm/x-2", author: "dependabot[bot]" },
      { kind: "pull", repo: "acme/deps", number: 1002, action: "opened", branch: "someone/else", author: "ann" },
    );
    expect([...dev.issues.values()].map((i) => i.title)).toEqual(["deps: Bump x from 1 to 2 (PR #1001)"]);
    expect(listings("acme/deps")).toBe(before);
    // the redelivered or reopened event files nothing twice
    await events("deps", { kind: "pull", repo: "acme/deps", number: 1001, action: "opened", branch: "dependabot/npm/x-2", author: "dependabot[bot]" });
    expect(dev.issues.size).toBe(1);
  });

  it("a push to main and a ticket leaving its untested state move the tested tag", async () => {
    any.add({ number: 1, state: "closed" });
    any.add({ number: 2, state_label: "in development" });
    const a = any.commit("feat: a (#1)");
    const b = any.commit("feat: b (#2)");
    for (const s of [a, b]) code.green(s);
    await inFlow((f) => f.cron(), "viewer");
    expect(code.tags.get("tested")).toBe(a);
    await events("viewer", { kind: "push", repo: "acme/viewer", branch: "main", sha: b });
    expect(code.tags.get("tested")).toBe(a);
    any.issues.get(2)!.state = "closed";
    const before = listings("acme/viewer");
    await events("viewer", { kind: "ticket", repo: "acme/viewer", n: 2 });
    expect(code.tags.get("tested")).toBe(b);
    expect(listings("acme/viewer")).toBe(before);
  });
});

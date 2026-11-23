// A workspace mixing a GitHub and a GitLab repository: each ticket goes through its own repository's tracker, with
// that tracker's token, in the trunk flow and in the pr-release flow (merge request, pipeline, release on GitLab).
import { describe, expect, it } from "vitest";
import { SLOT } from "../src/core/repos";
import { FakeCode } from "./fake-code";
import { call, claim, inFlow, setup, wipe } from "./helpers";

const CARD = "Works.\n\n### For the owner\nKind: test\nChanged: the service answers faster\nCheck:\n- open the status page";

describe("a workspace with a GitHub and a GitLab repository", () => {
  const x = (who: string, cmd: string, body?: unknown) => call(who, cmd, body, undefined, "x");

  it("trunk: both repositories queue together; the GitLab ticket is claimed, handed off and passed on GitLab", async () => {
    const { mixweb, glmix } = setup();
    await wipe("mixed");
    mixweb.add({ number: 1, state_label: "ready" });
    glmix.add({ iid: 1, state_label: "ready", title: "API thing" });
    glmix.add({ iid: 2, state_label: "ready", issue_type: "task" });
    expect((await x("dev1", "queue")).body.queue).toEqual(["web#1", "api#1"]);

    const w = (await x("dev1", "next", {})).body.ticket;
    expect(w).toMatchObject({ n: "web#1", state: "in development" });
    const ws = mixweb.commit("feat: web (#1)");
    expect((await x("dev1", "handoff", { n: "web#1", comment: "done" })).body).toEqual({ ok: true, state: "ready for testing", commits: [ws] });

    expect((await x("dev1", "next", {})).body.ticket).toMatchObject({ n: "api#1", state: "in development" });
    expect(glmix.label(1)).toEqual(["in development"]);
    expect(glmix.issues.get(1)?.assignees).toEqual([]);
    expect((await x("dev1", "handoff", { n: "api#1", comment: "done" })).body.message).toBe("No new commit on main ends with (#1) or (api#1); push first.");
    const a = glmix.commit("feat: api (api#1)");
    expect((await x("dev1", "handoff", { n: "api#1", comment: "done" })).body).toEqual({ ok: true, state: "ready for testing", commits: [a] });
    expect(glmix.last(1)).toBe(`Developer: done\n\nCommits: ${a}`);

    await x("tester", "next", {});
    expect((await x("tester", "pass", { n: "web#1", comment: "ok", build: ws, gates: { sha: ws, ok: true } })).body.state).toBe("closed");
    expect((await x("tester", "next", {})).body.ticket.n).toBe("api#1");
    const lacking = (await x("tester", "pass", { n: "api#1", comment: "ok", build: ws, gates: { sha: ws, ok: true } })).body;
    expect(lacking.error).toBe("not_in_build");
    expect((await x("tester", "pass", { n: "api#1", comment: "All good", build: a, gates: { sha: a, ok: true } })).body).toEqual({ ok: true, state: "closed" });
    expect(glmix.issues.get(1)).toMatchObject({ state: "closed", labels: [] });
    expect(glmix.last(1)).toBe(`Tester: All good\n\nTested build: ${a}, gates green at ${a}`);
    expect(mixweb.issues.get(1)?.state).toBe("closed");

    expect(new Set(glmix.auth)).toEqual(new Set(["Bearer gl-test"]));
    expect(new Set(mixweb.auth)).toEqual(new Set(["Bearer gh-test"]));
    // slots: a GitHub repository by its path (as always), the GitLab one by type, host and path
    expect(await inFlow((f) => f.tracker.list.map((r) => [r.alias, r.slot, r.key ?? r.repo]), "mixed")).toEqual([
      ["web", 0, "acme/mixweb"],
      ["api", 1, "gitlab:gitlab.com/acme/backend/api"],
    ]);
  });

  const y = (who: string, cmd: string, body?: unknown) => call(who, cmd, body, undefined, "y");

  it("pr-release: svc#1 gets a merge request, waits for its pipeline, merges on pass, waits for its GitLab release", async () => {
    const { relweb, glrel, tg } = setup();
    await wipe("mixrel");
    const webCode = new FakeCode(relweb);
    relweb.commit("feat: web base");
    glrel.commit("feat: svc base");
    glrel.add({ iid: 1, state_label: "ready", title: "Faster service", description: "## Acceptance\n- fast" });
    relweb.add({ number: 1, state_label: "ready" });
    expect((await y("dev1", "queue")).body.queue).toEqual(["web#1", "svc#1"]);
    await claim(SLOT + 1, "dev1", "developer", Date.now(), "mixrel");
    glrel.issues.get(1)!.labels = ["in development"];

    expect((await y("dev1", "show?n=svc%231")).body).toMatchObject({ n: "svc#1", branch: "flowee/1", pull: null });
    expect((await y("dev1", "pr", { n: "svc#1" })).body.error).toBe("no_branch");
    const head = glrel.push("flowee/1", { "src/fast.ts": "A:+export const fast = true" });
    expect((await y("dev1", "pr", { n: "svc#1" })).body).toEqual({ ok: true, pull: { number: 1, url: "https://gitlab.com/acme/backend/svc/-/merge_requests/1", branch: "flowee/1" } });
    expect(glrel.mrs[0]).toMatchObject({ title: "Faster service (#1)", description: "Closes #1", target_branch: "main" });
    expect(webCode.pulls).toEqual([]);
    expect((await y("dev1", "handoff", { n: "svc#1", comment: "Done." })).body.error).toBe("checks_pending");
    glrel.pipeline(head, "running", ["build", "running"]);
    expect((await y("dev1", "handoff", { n: "svc#1", comment: "Done." })).body.message).toBe(`Checks of ${head.slice(0, 7)} are not done yet: build (in progress); wait and try again.`);
    glrel.pipeline(head, "failed", ["build", "failed"]);
    expect((await y("dev1", "handoff", { n: "svc#1", comment: "Done." })).body.error).toBe("checks_failed");
    glrel.green(head);
    expect((await y("dev1", "handoff", { n: "svc#1", comment: "Done." })).body.state).toBe("ready for testing");
    expect((await y("dev1", "show?n=svc%231")).body.pull).toMatchObject({ number: 1, state: "open", head, checks: "green" });

    expect((await y("tester", "next", {})).body.ticket).toMatchObject({ n: "svc#1", state: "testing" });
    const passed = (await y("tester", "pass", { n: "svc#1", comment: CARD, build: head, gates: { sha: head, ok: true }, owner_check: true })).body;
    expect(passed).toMatchObject({ state: "board review", merged: glrel.main.at(-1)!.sha });
    expect(glrel.main.at(-1)!.message).toBe("Faster service (#1)");
    expect(glrel.merged[0].body).toEqual({ sha: head, merge_commit_message: "Faster service (#1)" });
    expect(glrel.branches.has("flowee/1")).toBe(false);
    expect(relweb.main.map((c) => c.message)).toEqual(["feat: web base"]);

    expect((await y("board", "escalate", { n: "svc#1", comment: CARD })).body.state).toBe("awaiting release");
    webCode.publish("web-9.9.9", relweb.main.at(-1)!.sha);
    await inFlow((f) => f.cron(), "mixrel");
    expect(glrel.label(1)).toEqual(["awaiting release"]);
    glrel.publish("svc-1.0.0", glrel.main.at(-1)!.sha);
    await inFlow((f) => f.cron(), "mixrel");
    expect(glrel.label(1)).toEqual(["human review"]);
    expect(JSON.stringify(tg.of("sendRichMessage"))).toContain("📦 In svc-1.0.0 or later");
    expect(relweb.label(1)).toEqual(["ready"]);
  });
});

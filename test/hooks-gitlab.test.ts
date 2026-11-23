// GitLab webhooks: X-Gitlab-Token, the event shapes from GitLab's webhook docs (test/fixtures/gitlab-hooks.json,
// names neutralised), registration through the project hooks API, a ticket event re-read once.
import { beforeEach, describe, expect, it } from "vitest";
import { GitLab } from "../src/adapters/tracker-gitlab";
import type { Delivery } from "../src/ports/hooks";
import fixtures from "./fixtures/gitlab-hooks.json";
import { deliverGl, installHooks } from "./fake-hooks";
import { call, type F, inFlow, inObject } from "./helpers";

let fx: ReturnType<typeof installHooks>;
const T = Date.UTC(2026, 10, 23, 7, 0, 30);
const clock = { now: () => T, wake: async () => {} };
const run = <R>(fn: (f: F) => R | Promise<R>) =>
  inFlow((f) => {
    f.clock = clock;
    return fn(f);
  }, "hooksgl");
const FX = fixtures as Record<string, Record<string, any>>;
const at = (event: string, repo: string) => ({ ...FX[event], project: { ...FX[event].project, path_with_namespace: repo } });
const d = (h: Record<string, string>, body: string): Delivery => ({ header: (n) => h[n.toLowerCase()] ?? null, body });

beforeEach(async () => {
  fx = installHooks();
  await inObject((o) => {
    for (const t of ["meta", "mirror", "deliveries", "hook_events", "inbox"]) o.store.exec(`DELETE FROM ${t}`);
    o.reset();
  }, "hooksgl");
});

describe("GitLab deliveries", () => {
  const gl = new GitLab({ repo: "gitlab-org/gitlab-test", token: "t", tokenName: "T" });

  it("verifies X-Gitlab-Token in constant time; the delivery id is the Idempotency-Key", async () => {
    expect(await gl.hooks.verify(d({ "x-gitlab-token": "my-secret-token" }, "{}"), "my-secret-token")).toBe(true);
    expect(await gl.hooks.verify(d({ "x-gitlab-token": "my-secret-tokem" }, "{}"), "my-secret-token")).toBe(false);
    expect(await gl.hooks.verify(d({}, "{}"), "my-secret-token")).toBe(false);
    expect(await gl.hooks.verify(d({ "x-gitlab-token": "" }, "{}"), "")).toBe(false);
    expect(gl.hooks.id(d({ "idempotency-key": "f5e5f430-f57b-4e6e-9fac-d9128cd7232f" }, ""))).toBe("f5e5f430-f57b-4e6e-9fac-d9128cd7232f");
    expect(gl.hooks.id(d({ "x-gitlab-event-uuid": "13792a34-cac6-4fda-95a8-c58e00a3954e" }, ""))).toBe("13792a34-cac6-4fda-95a8-c58e00a3954e");
  });

  it("reads GitLab's documented payloads into the tracker-agnostic events", () => {
    const p = (event: string, payload: unknown) => gl.hooks.parse(d({ "x-gitlab-event": event }, JSON.stringify(payload)));
    const path = (e: string) => FX[e].project.path_with_namespace as string;
    expect(p("Issue Hook", FX["Issue Hook"])).toEqual([{ kind: "ticket", repo: path("Issue Hook"), n: 23 }]);
    expect(p("Note Hook", FX["Note Hook"])).toEqual([{ kind: "comment", repo: path("Note Hook"), n: 17 }]);
    expect(p("Push Hook", FX["Push Hook"])).toEqual([{ kind: "push", repo: path("Push Hook"), branch: "master", sha: "da1560886d4f094c3e6c9ef40349f7d38b5d27d7" }]);
    expect(p("Tag Push Hook", FX["Tag Push Hook"])).toEqual([{ kind: "tag", repo: path("Tag Push Hook"), tag: "v1.0.0", sha: "82b3d5ae55f7080f1e6022629cdb57bfae7cccc7" }]);
    expect(p("Merge Request Hook", FX["Merge Request Hook"])).toEqual([
      { kind: "pull", repo: path("Merge Request Hook"), number: 16, action: "opened", branch: "feature/booking-validation", author: "developer" },
    ]);
    expect(p("Merge Request Hook", { ...FX["Merge Request Hook"], object_attributes: { ...FX["Merge Request Hook"].object_attributes, action: "merge" } })[0]).toMatchObject({ action: "merged" });
    expect(p("Pipeline Hook", FX["Pipeline Hook"])).toEqual([{ kind: "checks", repo: path("Pipeline Hook"), sha: "bcbb5ec396a2c0f828686f14fac9b80b780504f2" }]);
    expect(p("Job Hook", FX["Job Hook"])).toEqual([]); // created, not finished
    expect(p("Job Hook", { ...FX["Job Hook"], build_status: "success" })).toEqual([{ kind: "checks", repo: path("Job Hook"), sha: FX["Job Hook"].sha }]);
    expect(p("Release Hook", FX["Release Hook"])).toEqual([{ kind: "release", repo: path("Release Hook"), tag: "v1.1" }]);
    expect(p("Wiki Page Hook", { project: { path_with_namespace: "x/y" } })).toEqual([]);
  });
});

describe("a GitLab workspace", () => {
  it("registers its project hook through the API, takes signed deliveries, re-reads only the ticket named", async () => {
    fx.glhk.add({ state_label: "ready" });
    fx.glhk.add({ state_label: "ready" });
    await run((f) => f.cron());
    expect(fx.glHooks.hooks).toHaveLength(1);
    const h = fx.glHooks.hooks[0];
    const secret = await run((f) => f.events.secret(f.tracker.list[0]) as Promise<string>);
    expect(h).toMatchObject({ url: "https://flow.test/hooks/hooksgl/hooks", token: secret, issues_events: true, note_events: true, push_events: true, merge_requests_events: true, pipeline_events: true, releases_events: true });
    expect((await run((f) => f.events.status())).repos[0]).toMatchObject({ mode: "webhook", via: "api" });
    const before = fx.glhk.auth.length;
    fx.glhk.issues.get(2)!.labels = ["board review"];
    const ev = { ...at("Issue Hook", "acme/backend/hooks"), object_attributes: { ...FX["Issue Hook"].object_attributes, iid: 2 } };
    expect((await deliverGl("hooksgl", "hooks", "Issue Hook", ev, "wrong")).status).toBe(401);
    expect((await deliverGl("hooksgl", "hooks", "Issue Hook", ev, null)).status).toBe(401);
    const ok = await deliverGl("hooksgl", "hooks", "Issue Hook", ev, secret);
    expect(ok.status).toBe(200);
    expect((await deliverGl("hooksgl", "hooks", "Issue Hook", ev, secret, ok.id)).status).toBe(200); // GitLab's retry
    await run((f) => f.cron(false));
    expect(fx.glhk.auth.length - before).toBe(1);
    const q = await call("board", "queue", undefined, undefined, "g");
    expect(q.body).toMatchObject({ queue: [2], source: "mirror" });
    expect(fx.glhk.auth.length - before).toBe(1);
  });

  it("without the Maintainer role: polls and names what the token needs", async () => {
    fx.glHooks.allowed = false;
    await run((f) => f.cron());
    expect((await run((f) => f.events.status())).repos[0]).toMatchObject({ mode: "poll", missing: "the Maintainer role on the project and a token with the api scope" });
  });

  it("a hook GitLab disabled after failures falls back at the next reconcile", async () => {
    await run((f) => f.cron());
    fx.glHooks.hooks[0].alert_status = "disabled";
    await inFlow((f) => {
      f.clock = { now: () => T + 30 * 60e3, wake: async () => {} };
      return f.cron();
    }, "hooksgl");
    expect((await run((f) => f.events.status())).repos[0]).toMatchObject({ mode: "poll", reason: "the tracker reports the webhook failing (GitLab disabled the hook after repeated failures)" });
  });
});

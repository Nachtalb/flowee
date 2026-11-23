// The workspace document: schema committed and in step with the TypeScript types, one-sentence problems with
// their JSON path, export/import round trips, secrets only ever by name.
import { describe, expect, it } from "vitest";
import committed from "../schema/workspace.schema.json";
import committedInstance from "../schema/instance.schema.json";
import type { WorkspaceDoc } from "../src/config/document";
import { missingSecrets, StaticRegistry } from "../src/config/registry";
import { INSTANCE, problems, repoList, SCHEMA, validate } from "../src/config/schema";
import { plain } from "../src/ports/chat";
import { plan } from "../scripts/deploy";
import workspaces from "./workspaces.json";

type Complete<T> = T extends (infer U)[] ? Complete<U>[] : T extends object ? { [K in keyof T]-?: Complete<T[K]> } : T;

/** Every field of the types set: the compiler refuses this when a type gains a field the example lacks. */
const FULL: Complete<Omit<WorkspaceDoc, "flow">> & { flow: { preset: string } } = {
  flowee: 1,
  id: "full",
  name: "Full",
  flow: { preset: "pr-release" },
  features: {
    pullRequests: { branch: "t/{n}", checks: ["build"], method: "squash", merger: "developer", deleteBranch: false },
    releases: { source: "tag", tag: "stable", testedTag: "tested", checks: ["build"], skip: ["docs"], hold: true, versionLine: false },
    samples: { root: "Samples/", notNeededLabel: "no sample" },
    uiReview: { paths: ["ui/**"], addedFiles: ["views/**"], addedLines: ["@Composable"], ignore: ["test/**"] },
    dependencyTickets: { authors: ["dependabot[bot]"], labels: ["deps"] },
    untrustedReports: { label: "feedback", role: "board" },
  },
  tracker: {
    type: "github",
    repos: ["acme/app", { repo: "acme/tools/lib", alias: "lib", token: "GL", mainBranch: "master", type: "gitlab", api: "https://gitlab.acme.example/api/v4" }],
    mainBranch: "main", api: "https://ghe.example/api/v3", token: "GH", project: { owner: "acme", number: 1 } },
  roles: [
    { instance: "board", role: "board", secret: "T_BOARD" },
    { instance: "owner", role: "owner", secret: "T_OWNER" },
  ],
  owners: [{ name: "Ann", tracker: "ann", chat: "42" }],
  chat: { type: "telegram", token: "BOT", webhookSecret: "HOOK", username: "AcmeBot", chatId: "-100", topicId: 7, publicUrl: "https://x.example", managed: true },
  files: { url: "https://files.example/", token: "FILES", expire: "30d" },
  texts: { owner: "Ann", cardHeading: "For Ann", botName: "Acme", project: "acme", welcome: "w", about: "a", shortAbout: "s", filedBody: "f", untitled: "u" },
  schedule: { timezone: "Europe/Zurich", digestFrom: 8, digestTo: 11 },
  sync: { webhooks: "auto", reconcileMinutes: 30, pollMinutes: 1 },
  profile: { photo: "https://x.example/p.png" },
};

const paths = (o: unknown, p = "$"): string[] =>
  Array.isArray(o) ? paths(o[0], `${p}[]`) : o && typeof o === "object" ? Object.entries(o).flatMap(([k, v]) => [`${p}.${k}`, ...(k === "flow" ? [] : paths(v, `${p}.${k}`))]) : [];
const schemaPaths = (s: Record<string, any>, p = "$"): string[] =>
  s.type === "array"
    ? schemaPaths(s.items, `${p}[]`)
    : s.properties
      ? Object.entries(s.properties as Record<string, any>).flatMap(([k, v]) => [`${p}.${k}`, ...(k === "flow" ? [] : schemaPaths(v.oneOf ? v.oneOf[0] : v, `${p}.${k}`))])
      : [];

const secrets = (names: Record<string, string>) => ({ get: (n: string) => names[n] });
const shop = workspaces.workspaces[0] as unknown as WorkspaceDoc;

describe("the schema", () => {
  it("is committed as generated (bun run schema)", () => {
    expect(committed).toEqual(SCHEMA);
    expect(committedInstance).toEqual(INSTANCE);
  });

  it("has exactly the fields of the TypeScript types", () => {
    expect(validate(FULL)).toEqual([]);
    expect(schemaPaths(SCHEMA).sort()).toEqual(paths(FULL).sort());
  });

  it("accepts the test workspaces", () => {
    for (const w of workspaces.workspaces) expect(validate(w)).toEqual([]);
  });

  it("reports each problem as one sentence with its JSON path", () => {
    const bad = JSON.parse(JSON.stringify(FULL));
    bad.flowee = 2;
    expect(validate(bad)).toEqual(["$.flowee: must be 1."]);
    bad.flowee = 1;
    bad.id = "Not An Id";
    bad.tracker.repos = [];
    delete bad.tracker.token;
    bad.roles[0].role = 5;
    bad.color = "blue";
    bad.flow = { preset: "kanban" };
    bad.schedule.digestTo = 30;
    expect(validate(bad).sort()).toEqual(
      [
        "$.id: must match ^[a-z0-9][a-z0-9-]{0,62}$.",
        "$.tracker.repos: must have at least 1 item(s).",
        "$.tracker.token: is required.",
        "$.roles[0].role: must be a string.",
        "$.color: is not a known field.",
        '$.flow.preset: must be one of "trunk", "pr-release".',
        "$.schedule.digestTo: must be at most 24.",
      ].sort(),
    );
  });

  it("checks what the schema cannot: roles of the flow, unique instances, combinations", () => {
    const bad = JSON.parse(JSON.stringify(FULL));
    bad.roles.push({ instance: "board", role: "qa", secret: "T_X" });
    bad.roles = bad.roles.filter((r: { role: string }) => r.role !== "owner");
    delete bad.owners[0].chat;
    bad.schedule = { timezone: "Mars/Olympus", digestFrom: 12, digestTo: 9 };
    delete bad.chat.publicUrl;
    expect(validate(bad)).toEqual([
      "$.roles[1].role: 'qa' is no role of the flow (board, developer, tester, owner, sampler).",
      "$.roles[1].instance: 'board' is used twice.",
      "$.roles: no instance has the owner role 'owner', so the owner cannot answer through the API.",
      "$.owners: with a chat, at least one owner needs a chat user id.",
      "$.profile: the profile is set with the webhook, so it needs $.chat.publicUrl.",
      "$.schedule: digestFrom must be before digestTo.",
      "$.schedule.timezone: 'Mars/Olympus' is no IANA time zone.",
    ]);
  });

  it("names each repository's tracker: kind, path form, own token, a board only with GitHub, unique per tracker", () => {
    const d = (repos: unknown[], extra: Record<string, unknown> = {}) => ({ ...JSON.parse(JSON.stringify(FULL)), tracker: { repos, token: "GH", ...extra } });
    expect(validate(d(["acme/app", { repo: "grp/sub/deep/lib", type: "gitlab", token: "GL" }]))).toEqual([]);
    expect(validate(d(["grp/sub/lib"], { type: "gitlab" }))).toEqual([]);
    expect(validate(d(["grp/sub/lib"]))).toEqual(["$.tracker.repos[0]: 'grp/sub/lib' is no GitHub repository (owner/name)."]);
    expect(validate(d(["acme/app", { repo: "grp/lib", type: "gitlab" }]))).toEqual([
      "$.tracker.repos[1].token: a repository on GitLab while tracker.type is 'github' needs its own token.",
    ]);
    expect(validate(d([{ repo: "acme/app", type: "bitbucket" }]))).toEqual(['$.tracker.repos[0].type: must be one of "github", "gitlab".']);
    expect(validate(d(["grp/lib"], { type: "gitlab", project: { owner: "acme", number: 1 } }))).toEqual([
      "$.tracker.project: a GitHub project board needs at least one GitHub repository.",
    ]);
    // the same path on two trackers is two repositories; twice on one tracker is refused
    expect(validate(d(["acme/app", { repo: "acme/app", alias: "gl", type: "gitlab", token: "GL" }]))).toEqual([]);
    expect(validate(d(["acme/app", { repo: "acme/app", alias: "gl" }]))).toEqual(["$.tracker.repos[1]: 'acme/app' is listed twice."]);
    expect(repoList(d([{ repo: "grp/sub/lib", type: "gitlab", token: "GL" }], { api: "https://ghe.example/api/v3" }) as WorkspaceDoc)[0]).toMatchObject({
      alias: "lib",
      type: "gitlab",
      api: "https://gitlab.com/api/v4",
      key: "gitlab:gitlab.com/grp/sub/lib",
    });
  });

  it("validates an inline statechart with the engine's own loader", () => {
    const d = JSON.parse(JSON.stringify(FULL));
    d.flow = { chart: { id: "x", initial: "a", states: { a: { meta: { label: "a" }, on: { go: "b" } } } }, options: { roles: {}, commands: {} } };
    const [e] = validate(d);
    expect(e).toMatch(/^\$\.flow: Exactly one state must have meta\.closed .* State 'a', event 'go': the target 'b' does not exist\./);
  });
});

describe("export and import", () => {
  it("round-trips a workspace and the whole instance unchanged, secrets only by name", () => {
    const r = new StaticRegistry(secrets({}), workspaces);
    const once = r.export("shop");
    r.import(once);
    expect(r.export("shop")).toEqual(once);
    expect(once).toEqual(shop);
    const all = r.exportAll();
    expect(all).toEqual(workspaces);
    const r2 = new StaticRegistry(secrets({}), all);
    expect(r2.exportAll()).toEqual(all);
    expect(JSON.stringify(all)).not.toMatch(/gh-test|hook-test|999:tg|paste-test/);
  });

  it("an invalid import changes nothing and says why", () => {
    const r = new StaticRegistry(secrets({}), workspaces);
    const bad = { ...shop, roles: [] };
    expect(() => r.import(bad)).toThrow("$.roles: must have at least 1 item(s).");
    expect(r.export("shop")).toEqual(shop);
    const clash = { ...(workspaces.workspaces[1] as unknown as WorkspaceDoc), id: "third" };
    expect(() => r.import(clash)).toThrow("another workspace is bound to the same chat and topic");
    expect(r.list().map((w) => w.id)).toEqual(["shop", "other", "multi", "viewer", "deps", "suite", "hooks", "hooks2", "mixed", "mixrel", "hooksgl", "relmain", "branchy"]);
    expect(() => r.importAll({ flowee: 1, workspaces: [shop, shop] })).toThrow("$.workspaces[1].id: 'shop' is used twice.");
    expect(r.list()).toHaveLength(workspaces.workspaces.length);
  });

  it("an import needs no secret to validate and names the missing ones", () => {
    const r = new StaticRegistry(secrets({}));
    expect(r.import(shop).id).toBe("shop");
    expect(missingSecrets(shop, secrets({ GITHUB_TOKEN: "x", TOKEN_BOARD: "y" }))).toEqual([
      "TOKEN_DEV1",
      "TOKEN_DEV2",
      "TOKEN_TESTER",
      "TOKEN_OWNER",
      "TELEGRAM_BOT_TOKEN",
      "TG_WEBHOOK_SECRET",
      "PASTE_TOKEN",
    ]);
  });

  it("finds a workspace by token digest and by chat binding (a topic binds only that topic)", () => {
    const r = new StaticRegistry(secrets({ TOKEN_DEV1: "AB12" }), workspaces);
    expect(r.byDigest("ab12")).toMatchObject({ instance: "dev1", role: "developer", doc: { id: "shop" } });
    expect(r.byChat({ chat: "555" })?.id).toBe("other");
    const t = { ...shop, id: "topic", tracker: { ...shop.tracker, repos: ["acme/topic"] }, chat: { ...shop.chat, chatId: "-100", topicId: 3 } } as WorkspaceDoc;
    r.import(t);
    expect(r.byChat({ chat: "-100", topic: 3 })?.id).toBe("topic");
    expect(r.byChat({ chat: "-100", topic: 4 })).toBeUndefined();
  });

  it("refuses a repository that is already in another workspace", () => {
    const r = new StaticRegistry(secrets({}), workspaces);
    const { chat: _c, files: _f, profile: _p, ...rest } = shop;
    const again = { ...rest, id: "again" } as WorkspaceDoc;
    expect(() => r.import(again)).toThrow(`$.workspaces[${workspaces.workspaces.length}].tracker.repos[0]: '${shop.tracker.repos[0]}' is already in workspace '${shop.id}'; a repository belongs to one workspace only.`);
    expect(r.get("again")).toBeUndefined();
  });
});

describe("plain chat fallback", () => {
  it("turns a rich view into text and a keyboard", () => {
    const v = plain([
      { html: "<p><b>2 open</b></p>" },
      { table: { head: ["#"], rows: [{ cells: ["7", "Test", "1 h", "A &amp; B"], buttons: [{ label: "Open", data: "o:7:1" }] }] } },
      { buttons: [{ label: "« Back", data: "b" }] },
    ]);
    expect(v).toEqual({
      text: "2 open\n7 · Test · 1 h · A & B",
      buttons: [[{ label: "Open · 7", data: "o:7:1" }], [{ label: "« Back", data: "b" }]],
    });
  });
});

describe("bun run validate", () => {
  it("checks a workspace document or an instance document with the Worker's validator", () => {
    expect(problems(shop)).toEqual([]);
    expect(problems(workspaces)).toEqual([]);
    expect(problems({ ...shop, roles: [] })).toEqual(["$.roles: must have at least 1 item(s)."]);
    expect(problems({ flowee: 1, workspaces: [shop, shop] })).toEqual(["$.workspaces[1].id: 'shop' is used twice.", "$.workspaces[1].chat: another workspace is bound to the same chat and topic."]);
  });
});

describe("bun run deploy", () => {
  const inst = { bot: { token: "BOT", webhookSecret: "HOOK" }, publicUrl: "https://flowee.example.workers.dev", owner: "1" };
  it("managed with an instance section, the local document as a secret on stdin, /setup on its public URL", () => {
    expect(plan(JSON.stringify({ flowee: 1, workspaces: [], instance: inst }), true)).toEqual({
      mode: "managed",
      url: "https://flowee.example.workers.dev",
      args: ["bunx", "wrangler", "deploy", "--var", "FLOWEE_MODE:managed", "--secrets-file", "/dev/stdin"],
    });
  });
  it("standalone without one, the committed document bundled; an invalid document is not deployed", () => {
    expect(plan(JSON.stringify(workspaces), false)).toEqual({
      mode: "standalone",
      url: workspaces.workspaces.find((w) => (w.chat as { publicUrl?: string } | undefined)?.publicUrl)?.chat?.publicUrl,
      args: ["bunx", "wrangler", "deploy", "--var", "FLOWEE_MODE:standalone"],
    });
    expect(plan("{", true)).toMatchObject({ problems: [expect.stringMatching(/^\$: is not JSON/)] });
    expect(plan(JSON.stringify({ flowee: 1, workspaces: [], instance: { ...inst, owner: 1 } }), true)).toMatchObject({ problems: [expect.stringContaining("$.instance.owner")] });
  });
});

// The managed mode's setup and menu in the terminal: a person of the instance's `tui` sets up a workspace (no chat:
// its inbox is the terminal), gets the agents' secrets as a file, adds a person with a key of their own, exports and
// imports, all through the same wizard and menu as on Telegram.
import { env, runInDurableObject } from "cloudflare:test";
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Instance } from "../src/runtime/cloudflare/worker";
import type { FakeGitHub } from "./fake";
import { setup } from "./helpers";
import { Scripted } from "./tui-client";

const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const CFG = {
  flowee: 1,
  instance: {
    bot: { token: "TELEGRAM_BOT_TOKEN", webhookSecret: "TG_WEBHOOK_SECRET", username: "FloweeTestBot" },
    publicUrl: "https://flowee.test",
    owner: "100",
    tui: { people: [{ id: "mia", name: "Mia", role: "manager", key: digest("tui-mia") }, { id: "joe", name: "Joe", key: digest("tui-joe") }] },
  },
  workspaces: [],
};
const menv = () => ({ ...env, FLOWEE_MODE: "managed", FLOWEE_CONFIG: JSON.stringify(CFG), FLOWEE_ADMIN_TOKEN: "admin-test" }) as typeof env;
const fetcher = async (req: Request) => worker.fetch(req, menv());
const TOKEN = `github_pat_${"a".repeat(40)}`;
let app: FakeGitHub;

beforeEach(async () => {
  ({ app } = setup());
  await runInDurableObject(env.INSTANCE.get(env.INSTANCE.idFromName("instance")), (o: Instance) => {
    for (const t of ["vault", "sessions", "updates", "kv"]) o.host.store.exec(`DELETE FROM ${t}`);
    o.host.store.exec("DROP TABLE IF EXISTS workspaces");
    for (const r of o.host.store.rows<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'p_%'")) o.host.store.exec(`DROP TABLE ${r.name}`);
    Object.assign(o.host, { reg: undefined, plain: undefined });
  });
});

/** Presses the button whose label matches, on the screen in focus. */
async function tap(c: Scripted, label: string | RegExp) {
  const r = await c.press(label);
  expect(r.status).toBe(200);
}

async function create(c: Scripted) {
  await c.sync({ text: { text: "/start" } });
  expect(c.screen()).toContain("Set up a workspace");
  await tap(c, /Set up a workspace/);
  expect(c.screen()).toMatch(/Step 1 of 3/);
  await c.sync({ text: { text: "https://github.com/acme/app" } });
  expect(c.screen()).toContain("Single branch");
  await tap(c, /Choose|Single branch/);
  if (c.screen().includes("Versioning")) await tap(c, "▶ Next");
  expect(c.screen()).toContain("token");
  await c.sync({ text: { text: TOKEN } });
  // the token was read and removed: no trace of it in the conversation
  expect(JSON.stringify(c.c.messages)).not.toContain(TOKEN);
  expect(c.screen()).toMatch(/Last check/);
  await tap(c, /Create/);
}

describe("setup and management in the terminal", () => {
  it("the instance's people get the setup seat; a manager sets up a terminal workspace and gets the project key as a file", async () => {
    const mia = new Scripted("tui-mia", "@instance", "x", fetcher);
    const me = await mia.me();
    expect(me.body.workspaces.map((w: { id: string }) => w.id)).toEqual(["@instance"]);
    await create(mia);
    const secrets = mia.c.files.find((f) => f.file?.name.endsWith("-key.txt"));
    expect(secrets?.file?.data).toContain("# Flowee workspace app:");
    expect(secrets?.file?.data).toMatch(/[0-9a-f]{64}/);
    const doc = (await (await fetcher(new Request("https://flow.test/admin/workspaces/app", { headers: { authorization: "Bearer admin-test" } }))).json()) as any;
    expect(doc.workspace.chat).toBeUndefined();
    expect(doc.workspace.tui.people).toEqual([{ id: "mia", name: "Mia", role: "manager", key: digest("tui-mia") }]);
    // her key now opens the new workspace too
    expect((await mia.me()).body.workspaces.map((w: { id: string }) => w.id)).toEqual(["app", "@instance"]);
    // a member of the instance may not create one
    const joe = new Scripted("tui-joe", "@instance", "x", fetcher);
    await joe.sync({ text: { text: "/setup" } });
    expect(joe.screen()).toContain("Only the people this instance allows");
  });

  it("People: a manager adds a person (the key handed over as a file) and removes one; export and import", async () => {
    const mia = new Scripted("tui-mia", "@instance", "x", fetcher);
    await create(mia);
    await mia.sync({ text: { text: "/workspaces" } });
    await tap(mia, "Open");
    expect(mia.screen()).toContain("Terminal people");
    await tap(mia, "👥 People");
    expect(mia.screen()).toContain("Who can use this workspace");
    await tap(mia, "➕ Member");
    const keyFile = mia.c.files.find((f) => f.file?.name === "flowee-app-person-2.key");
    const key = keyFile?.file?.data.trim() as string;
    expect(key).toMatch(/^fwk_/);
    const pat = new Scripted(key, "app", "person-2", fetcher);
    expect((await pat.me()).body.workspaces.map((w: { id: string }) => w.id)).toEqual(["app"]);
    const at = mia.c.focus()?.id;
    await mia.sync({ press: { data: "m:pplrm:app:person-2", message: at } });
    expect(mia.screen()).toContain("Remove person-2?");
    await tap(mia, "➖ Remove");
    expect(mia.screen()).toContain("person-2 was removed");
    expect((await pat.me()).status).toBe(401);
    // export: the configuration as a file; import: the file sent back
    await tap(mia, "« Back");
    await tap(mia, "📤 Export");
    const exp = mia.c.files.find((f) => f.file?.name === "app.flowee.json");
    expect(JSON.parse(exp?.file?.data as string).id).toBe("app");
    const changed = { ...JSON.parse(exp?.file?.data as string), name: "App renamed" };
    await mia.sync({ file: { name: "app.flowee.json", data: btoa(JSON.stringify(changed)) } });
    expect(mia.screen()).toMatch(/Change|Last check|app/);
  });

  it("the admin API adds and removes a person; the key is answered once", async () => {
    const mia = new Scripted("tui-mia", "@instance", "x", fetcher);
    await create(mia);
    const add = await fetcher(new Request("https://flow.test/admin/workspaces/app/people", { method: "POST", headers: { authorization: "Bearer admin-test" }, body: JSON.stringify({ id: "zoe", name: "Zoe" }) }));
    const r = (await add.json()) as any;
    expect([add.status, r.person]).toEqual([200, "zoe"]);
    const zoe = new Scripted(r.key, "app", "zoe", fetcher);
    expect((await zoe.me()).body.workspaces).toEqual([{ id: "app", name: "app", paused: false, person: { id: "zoe", name: "Zoe", role: "member" } }]);
    const del = await fetcher(new Request("https://flow.test/admin/workspaces/app/people/zoe", { method: "DELETE", headers: { authorization: "Bearer admin-test" } }));
    expect(del.status).toBe(200);
    expect((await zoe.me()).status).toBe(401);
  });
});

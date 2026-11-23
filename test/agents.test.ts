// One project key per workspace: the roles the flow offers (an extension's too), agents created, renamed, paused and
// removed through the API, acting as an agent with the key and its name; strict mode (an own secret per agent);
// keys never cross workspaces; documents with per-agent secrets keep working.
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { FakeGitHub } from "./fake";
import { call, inFlow, setup, wipe } from "./helpers";

let keyed: FakeGitHub;
let keyed2: FakeGitHub;
beforeEach(async () => {
  ({ keyed, keyed2 } = setup());
  for (const w of ["keyed", "keyed2", "strict"]) await wipe(w);
});

/** A call with `token` (bare /v1/, the router finds the workspace), acting as `agent` when given. */
async function as(token: string, agent: string | null, method: string, path: string, body?: unknown, ws?: string) {
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  if (agent) headers["x-flowee-agent"] = agent;
  const res = await SELF.fetch(`https://flow.test${ws ? `/w/${ws}` : ""}/v1/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}
const KEY = "key-keyed";
const key = (method: string, path: string, body?: unknown) => as(KEY, null, method, path, body);

describe("GET /v1/roles", () => {
  it("lists the flow's roles with what each may do, the states it claims and whether several make sense; an extension's role too", async () => {
    const r = await key("GET", "roles");
    expect(r.status).toBe(200);
    const by = Object.fromEntries((r.body.roles as any[]).map((x) => [x.name, x]));
    expect(Object.keys(by)).toEqual(["board", "developer", "tester", "owner", "sampler"]);
    expect(by.developer).toMatchObject({ description: "Builds what a ready ticket asks for and hands it to testing.", several: true, claims: ["ready", "back to development"] });
    expect(by.developer.commands).toEqual(expect.arrayContaining(["next", "handoff", "release", "stuck"]));
    expect(by.board.several).toBe(false);
    expect(by.owner).toMatchObject({ several: false, claims: [], commands: expect.arrayContaining(["answer"]) });
    expect(by.sampler).toMatchObject({ several: true, claims: ["needs samples"], commands: expect.arrayContaining(["found", "unobtainable"]) });
  });
});

describe("agents with the project key", () => {
  it("creates agents (names generated like dev2), lists, renames, pauses, resumes and removes them; refusals are one sentence", async () => {
    expect((await key("POST", "agents", { role: "developer" })).body.agent).toMatchObject({ name: "dev1", role: "developer", source: "api", paused: false, holds: [] });
    expect((await key("POST", "agents", { role: "developer" })).body.agent.name).toBe("dev2");
    expect((await key("POST", "agents", { role: "board" })).body.agent.name).toBe("board");
    expect((await key("POST", "agents", { role: "sampler", name: "finder" })).body.agent).toMatchObject({ name: "finder", role: "sampler" });
    expect(await key("POST", "agents", { role: "qa" })).toEqual({ status: 400, body: { ok: false, error: "unknown_role", message: "'qa' is no role of this workspace's flow (board, developer, tester, owner, sampler)." } });
    expect((await key("POST", "agents", { role: "tester", name: "dev1" })).body).toMatchObject({ error: "name_taken", message: "The name 'dev1' is taken; choose another or leave the name out." });
    expect((await key("POST", "agents", { role: "tester", name: "Dev 3" })).status).toBe(400);
    const list = await key("GET", "agents");
    expect(list.body.secrets).toBe("project");
    expect(list.body.agents.map((a: any) => a.name)).toEqual(["dev1", "dev2", "board", "finder"]);
    expect((await key("PATCH", "agents/dev2", { name: "dev3" })).body.agent.name).toBe("dev3");
    expect((await key("PATCH", "agents/dev3", { paused: true })).body.agent.paused).toBe(true);
    expect((await as(KEY, "dev3", "POST", "next", {})).body).toMatchObject({ error: "agent_paused", message: "dev3 is paused; resume it with `flowee.py agents resume dev3`." });
    expect((await key("PATCH", "agents/dev3", { paused: false })).body.agent.paused).toBe(false);
    expect((await key("DELETE", "agents/dev3")).body).toEqual({ ok: true, removed: "dev3", released: [] });
    expect((await key("DELETE", "agents/dev3")).body.error).toBe("unknown_agent");
    expect((await key("GET", "agents")).body.agents.map((a: any) => a.name)).toEqual(["dev1", "board", "finder"]);
  });

  it("acts as an agent with the key and the agent's name; the role comes from the agent's record; an unknown name names agents add", async () => {
    await key("POST", "agents", { role: "developer" });
    keyed.add({ number: 1, state_label: "ready" });
    const r = await as(KEY, "dev1", "POST", "next", {});
    expect(r.body.ticket).toMatchObject({ n: 1, state: "in development" });
    expect((await as(KEY, "dev1", "GET", "whoami")).body).toEqual({ ok: true, instance: "dev1", role: "developer" });
    expect(await as(KEY, "dev9", "POST", "next", {})).toEqual({
      status: 403,
      body: { ok: false, error: "unknown_agent", message: "There is no agent 'dev9'; create it with `flowee.py agents add <role> dev9` (`flowee.py roles` lists the roles)." },
    });
    expect((await as(KEY, null, "POST", "next", {})).body.error).toBe("no_agent");
    expect((await as(KEY, null, "GET", "whoami")).body).toEqual({ ok: true, key: "project", secrets: "project" });
    const a = (await key("GET", "agents/dev1")).body.agent;
    expect(a.holds).toEqual([1]);
    expect(a.seen).toMatch(/^\d{4}-/);
    // a board agent may file, a developer may not escalate: the record's role decides
    expect((await as(KEY, "dev1", "POST", "escalate", { n: 1, comment: "x" })).body.error).toBe("wrong_role");
  });

  it("an agent that is removed releases its claims through the expiry path; another agent then gets the ticket", async () => {
    await key("POST", "agents", { role: "developer" });
    await key("POST", "agents", { role: "developer" });
    keyed.add({ number: 1, state_label: "ready" });
    expect((await as(KEY, "dev1", "POST", "next", {})).body.ticket.n).toBe(1);
    expect((await as(KEY, "dev2", "POST", "next", {})).body.ticket).toBeNull();
    expect((await key("DELETE", "agents/dev1")).body).toEqual({ ok: true, removed: "dev1", released: [1] });
    await inFlow((f) => f.cron(), "keyed");
    expect(keyed.label(1)[0]).toBe("ready");
    expect(keyed.last(1)).toBe("Board: The claim of dev1 expired after 3 h without a heartbeat; the ticket is back in the queue.");
    expect((await as(KEY, "dev2", "POST", "next", {})).body.ticket).toMatchObject({ n: 1, state: "in development" });
  });

  it("a renamed agent keeps its claims", async () => {
    await key("POST", "agents", { role: "developer" });
    keyed.add({ number: 1, state_label: "ready" });
    await as(KEY, "dev1", "POST", "next", {});
    await key("PATCH", "agents/dev1", { name: "ada" });
    expect((await as(KEY, "ada", "POST", "next", {})).body.ticket).toMatchObject({ n: 1, resumed: true });
  });

  it("only the project key changes agents; an agent's own secret reads them", async () => {
    expect((await as("k2-board", null, "POST", "agents", { role: "developer" }, "keyed2")).body.error).toBe("project_key");
    expect((await as("k2-board", null, "GET", "agents", undefined, "keyed2")).body.agents).toEqual([{ name: "board", role: "board", source: "document", paused: false, holds: [] }]);
  });

  it("an idempotency key repeats the answer of POST /v1/agents without creating a second agent", async () => {
    const h = { authorization: `Bearer ${KEY}`, "content-type": "application/json", "idempotency-key": "same" };
    const post = () => SELF.fetch("https://flow.test/v1/agents", { method: "POST", headers: h, body: JSON.stringify({ role: "tester" }) }).then((r) => r.json() as Promise<any>);
    expect((await post()).agent.name).toBe("tester");
    expect((await post()).agent.name).toBe("tester");
    expect((await key("GET", "agents")).body.agents).toHaveLength(1);
  });
});

describe("keys and workspaces", () => {
  it("two workspaces' keys never cross: each key finds its own workspace, and a /w/<other>/ path refuses it", async () => {
    await key("POST", "agents", { role: "developer" });
    await as("key-keyed2", null, "POST", "agents", { role: "developer", name: "zed" });
    expect((await key("GET", "agents")).body.agents.map((a: any) => a.name)).toEqual(["dev1"]);
    expect((await as("key-keyed2", null, "GET", "agents")).body.agents.map((a: any) => a.name)).toEqual(["board", "zed"]);
    expect((await as(KEY, null, "GET", "agents", undefined, "keyed2")).status).toBe(401);
    expect((await as(KEY, "zed", "POST", "next", {}, "keyed2")).status).toBe(401);
    expect((await as("key-keyed2", "dev1", "POST", "next", {})).body.error).toBe("unknown_agent");
    expect((await as("nope", null, "GET", "roles")).status).toBe(401);
  });

  it("back-compat: a document's agents with their own secrets work unchanged, also beside a project key", async () => {
    expect((await call("dev1", "whoami")).body).toEqual({ ok: true, instance: "dev1", role: "developer" });
    keyed2.add({ number: 1, state_label: "needs triage" });
    expect((await as("k2-board", null, "POST", "next", {})).body.ticket).toMatchObject({ n: 1 });
    // the key may act as a document's agent too, by its name
    expect((await as("key-keyed2", "board", "GET", "whoami")).body).toEqual({ ok: true, instance: "board", role: "board" });
    expect((await as("key-keyed2", null, "DELETE", "agents/board")).body).toMatchObject({ error: "named_agent", message: "'board' is named in the workspace document; remove it there." });
    // a workspace without a project key has no agents' management: its own agents read, nobody creates
    expect((await call("board", "agents")).body.agents.map((a: any) => a.name)).toEqual(["board", "dev1", "dev2", "tester", "owner"]);
  });
});

describe("strict mode (agents.secrets: per-agent)", () => {
  it("POST /v1/agents answers the agent's own secret once; the agent signs in with it; the project key cannot act as an agent", async () => {
    const r = await as("key-strict", null, "POST", "agents", { role: "developer" });
    expect(r.body.agent.name).toBe("dev1");
    expect(r.body.secret).toMatch(/^[0-9a-f]{64}$/);
    expect((await as("key-strict", null, "GET", "agents")).body).toMatchObject({ secrets: "per-agent", agents: [{ name: "dev1" }] });
    expect(JSON.stringify((await as("key-strict", null, "GET", "agents")).body)).not.toContain(r.body.secret);
    expect((await as(r.body.secret, null, "GET", "whoami", undefined, "strict")).body).toEqual({ ok: true, instance: "dev1", role: "developer" });
    expect(await as("key-strict", "dev1", "POST", "next", {})).toEqual({
      status: 403,
      body: { ok: false, error: "per_agent", message: "This workspace gives every agent its own secret; the project key only manages agents (flowee.py agents)." },
    });
    await as("key-strict", null, "DELETE", "agents/dev1");
    expect((await as(r.body.secret, null, "GET", "whoami", undefined, "strict")).status).toBe(401);
  });
});

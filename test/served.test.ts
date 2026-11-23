// The instance serves its own material: every served file equals its repository source, with its content type,
// caching headers and ETag; nothing of the repository's skills or docs is missing; the bundle holds exactly the
// expected files; every link in served markdown resolves to a served path; no secret or deployment value is served;
// the root document for an agent (standalone, managed, markdown, HTML); POST /validate.
import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { deploymentValues, SECRET_PATTERNS } from "../scripts/bundle";
import type { Manifest } from "../src/adapters/served";
import { VALIDATE_MAX, VALIDATE_PER_MINUTE } from "../src/adapters/served";
import worker from "../src/index";
import workspaces from "./workspaces.json";

const raw = import.meta.glob(["../skills/**/*", "../docs/**/*", "../client/flowee.py", "../schema/*.json", "../flows/*.json", "../LICENSE", "../assets/*.svg"], {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;
const sources = new Map(Object.entries(raw).map(([p, t]) => [p.replace(/^\.\.\//, ""), t]));
const GENERATED = ["skills/index.md", "docs/index.md"];
const TYPE: Record<string, string> = { md: "text/markdown; charset=utf-8", py: "text/plain; charset=utf-8", json: "application/json; charset=utf-8", svg: "image/svg+xml" };
const typeOf = (p: string) => (p === "LICENSE" ? "text/plain; charset=utf-8" : TYPE[p.split(".").at(-1) ?? ""]);
const get = (p: string, headers: Record<string, string> = {}) => SELF.fetch(`https://flowee.test${p}`, { headers });
const manifest = async () => (await (await get("/manifest.json")).json()) as Manifest;

const INSTANCE = {
  flowee: 1,
  workspaces: [],
  instance: { bot: { token: "BOT_TOKEN", webhookSecret: "BOT_HOOK", username: "flowee_test_bot" }, publicUrl: "https://flowee.test", owner: "100" },
};
const menv = () => ({ ...env, FLOWEE_MODE: "managed", FLOWEE_CONFIG: JSON.stringify(INSTANCE), FLOWEE_ADMIN_TOKEN: "admin-test" }) as typeof env;
const mget = (p: string, headers: Record<string, string> = {}) => worker.fetch(new Request(`https://flowee.test${p}`, { headers }), menv());

async function untar(gz: ArrayBuffer): Promise<Map<string, string>> {
  const b = new Uint8Array(await new Response(new Response(gz).body?.pipeThrough(new DecompressionStream("gzip"))).arrayBuffer());
  const out = new Map<string, string>();
  const dec = new TextDecoder();
  for (let at = 0; at + 512 <= b.length; ) {
    const name = dec.decode(b.subarray(at, at + 100)).replace(/\0.*$/s, "");
    if (!name) break;
    const size = parseInt(dec.decode(b.subarray(at + 124, at + 136)), 8);
    out.set(name, dec.decode(b.subarray(at + 512, at + 512 + size)));
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

describe("served material", () => {
  it("sees the repository's skills and docs", () => {
    expect([...sources.keys()].filter((p) => p.startsWith("skills/") && p.endsWith("/SKILL.md")).length).toBe(3);
    expect(sources.has("docs/agents/developer.md")).toBe(true);
  });

  it("serves every source file unchanged, with its content type, a short max-age and an ETag that answers 304", async () => {
    for (const [p, t] of sources) {
      const r = await get(`/${p}`);
      expect(r.status, p).toBe(200);
      expect(r.headers.get("content-type"), p).toBe(typeOf(p));
      expect(r.headers.get("cache-control"), p).toBe("public, max-age=60, must-revalidate");
      expect(await r.text(), p).toBe(t);
      const etag = r.headers.get("etag");
      expect(etag, p).toMatch(/^(W\/)?"[^"]+"$/);
      const again = await get(`/${p}`, { "if-none-match": etag ?? "" });
      expect(again.status, p).toBe(304);
      expect(await again.text()).toBe("");
    }
  });

  it("serves exactly the repository's files, the indexes and the bundle; none shadows an API route", async () => {
    const m = await manifest();
    expect(m.files).toEqual([...sources.keys(), ...GENERATED, "bundle.tar.gz"].sort());
    for (const p of m.files) expect(p, p).not.toMatch(/^(v1|w|admin|hooks|telegram|setup|validate|version)(\/|$)/);
    expect(m.client.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(m.client.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("indexes list every skill, reference and doc with one line each, also without the trailing slash", async () => {
    const skills = await (await get("/skills/")).text();
    for (const p of [...sources.keys()].filter((p) => p.startsWith("skills/") && p.endsWith(".md"))) expect(skills, p).toContain(`](${p.slice(7)})`);
    expect(skills).toContain("- [flowee-install](flowee-install/SKILL.md): Use when setting Flowee up.");
    const docs = await (await get("/docs/")).text();
    for (const p of [...sources.keys()].filter((p) => p.startsWith("docs/") && p.endsWith(".md"))) expect(docs, p).toContain(`](${p.slice(5)})`);
    expect((await get("/docs/agents/")).headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(await (await get("/docs/agents/")).text()).toBe(sources.get("docs/agents/README.md"));
    const r = await SELF.fetch("https://flowee.test/skills", { redirect: "manual" });
    expect([r.status, r.headers.get("location")]).toEqual([301, "/skills/"]);
  });

  it("a missing file is 404, a write is 405, and none of it needs a token", async () => {
    expect((await get("/docs/nope.md")).status).toBe(404);
    expect((await SELF.fetch("https://flowee.test/docs/api.md", { method: "PUT", body: "x" })).status).toBe(405);
    expect((await get("/client/flowee.py", { authorization: "Bearer wrong" })).status).toBe(200);
  });

  it("the bundle holds exactly skills, docs, client, schema, flows and the licence, each equal to its source", async () => {
    const r = await get("/bundle.tar.gz");
    expect(r.headers.get("content-type")).toBe("application/gzip");
    expect(r.headers.get("content-disposition")).toContain("flowee.tar.gz");
    const files = await untar(await r.arrayBuffer());
    const want = [...sources.keys(), ...GENERATED].filter((p) => !p.startsWith("assets/")).map((p) => `flowee/${p}`).sort();
    expect([...files.keys()].sort()).toEqual(want);
    expect((await manifest()).bundle).toEqual(want);
    for (const [p, t] of sources) if (!p.startsWith("assets/")) expect(files.get(`flowee/${p}`), p).toBe(t);
  });

  it("no served file holds a secret-looking value, a test secret or a value of the test workspaces' documents", async () => {
    const m = await manifest();
    const banned = [
      ...Object.entries(env)
        .filter(([k, v]) => typeof v === "string" && v.length >= 6 && !["FLOWEE_MODE", "FLOWEE_CONFIG"].includes(k))
        .map(([, v]) => v as string),
      "admin-test",
      // the fixtures' chat and user ids (their repositories and bot names are the neutral examples the docs use too)
      ...deploymentValues(workspaces).filter((v) => /^-?\d{4,}$/.test(v)),
    ];
    expect(banned.length).toBeGreaterThan(10);
    for (const p of m.files.filter((p) => p !== "bundle.tar.gz")) {
      const t = await (await get(`/${p}`)).text();
      for (const re of SECRET_PATTERNS) expect(re.test(t), `${p} matches ${re}`).toBe(false);
      for (const v of banned) expect(t.includes(v), `${p} contains '${v}'`).toBe(false);
    }
  });

  it("every link in served markdown (and in the root document) resolves to a served path", async () => {
    const m = await manifest();
    const routes = new Set(["/", "/llms.txt", "/index.md", "/validate", "/version", "/skills/", "/docs/", "/docs/agents/", "/manifest.json", ...m.files.map((p) => `/${p}`)]);
    const pages: [string, string][] = [];
    for (const p of m.files.filter((p) => p.endsWith(".md"))) pages.push([`/${p}`, await (await get(`/${p}`)).text()]);
    for (const p of ["/skills/", "/docs/", "/"]) pages.push([p, await (await get(p)).text()]);
    let n = 0;
    for (const [at, md] of pages) {
      const prose = md.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
      const links = [...prose.matchAll(/\]\(([^)\s]+)\)/g)].map((x) => x[1]);
      for (const x of prose.matchAll(/https:\/\/flowee\.test[^\s)<>`,"]*[^\s)<>`,".:;]/g)) links.push(x[0]);
      for (const l of links) {
        const u = new URL(l, `https://flowee.test${at}`);
        if (u.origin !== "https://flowee.test") continue;
        n++;
        if (u.pathname.includes("<")) continue;
        expect(routes.has(decodeURIComponent(u.pathname)), `${at} links to ${l}`).toBe(true);
      }
    }
    expect(n).toBeGreaterThan(20);
  });
});

describe("the root document", () => {
  it("standalone: markdown for agents and curl at /, /llms.txt and /index.md, with this instance's facts", async () => {
    const r = await get("/", { accept: "*/*" });
    expect(r.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    expect(r.headers.get("vary")).toBe("accept");
    const md = await r.text();
    expect(await (await get("/llms.txt")).text()).toBe(md);
    expect(await (await get("/index.md")).text()).toBe(md);
    const m = await manifest();
    expect(md).toMatch(/^# Flowee: set it up from this URL\n/);
    expect(md).toContain("- Base URL: https://flowee.test\n");
    expect(md).toContain(`- Version: ${m.flowee} (commit ${m.commit})\n`);
    expect(md).toContain("- Mode: standalone\n");
    expect(md).toContain("- Trackers: GitHub, GitLab\n");
    expect(md).toContain("- Chat backends: Telegram\n");
    expect(md).toContain("- New workspaces by the user: no:");
    expect(md).toContain("1. Get the material: `curl -fsSL https://flowee.test/bundle.tar.gz | tar -xz`");
    expect(md).toContain("ALL IN ONE MESSAGE");
    for (const q of ["Which repository", "feature branch", "Versioning", "optional parts", "tickets appear", "own bot", "agents per role", "clones and secrets", "how often"])
      expect(md, q).toContain(q);
    expect(md).toContain("hand the validated document to its operator");
    expect(md).toMatch(/\n7\. Never: print, log or echo a secret/);
    const etag = r.headers.get("etag") ?? "";
    expect((await get("/", { "if-none-match": etag })).status).toBe(304);
  });

  it("managed: the instance bot, who may create workspaces and how, the chat and the admin API", async () => {
    const md = await (await mget("/")).text();
    expect(md).toContain("- Mode: managed\n");
    expect(md).toContain("- Chat bot: @flowee_test_bot\n");
    expect(md).toContain("- New workspaces by the user: yes, for the instance owner (up to 5 each): in a private chat with @flowee_test_bot, `/setup` starts the wizard");
    expect(md).toContain("the user sends the `.json` file to @flowee_test_bot");
    expect(md).toContain("PUT https://flowee.test/admin/workspaces/<id>");
    expect(md).toContain("press **🤖 Create the bot**");
    expect(md).not.toContain("100");
  });

  it("a browser gets the same content as a small HTML page with the logo, links and nothing from elsewhere", async () => {
    const r = await get("/", { accept: "text/html,application/xhtml+xml" });
    expect(r.headers.get("content-type")).toBe("text/html; charset=utf-8");
    const html = await r.text();
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<img src="/assets/logo.svg"');
    expect(html).toContain('<a href="https://flowee.test/skills/flowee-install/SKILL.md">');
    expect(html).toContain("<h1>Flowee: set it up from this URL</h1>");
    expect(html).toContain("<ol>");
    expect(html).toContain("<code>trunk</code>");
    expect([...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((x) => x[1]).filter((u) => !u.startsWith("/") && !u.startsWith("https://flowee.test"))).toEqual([]);
    expect(html).not.toMatch(/<script|<link rel="stylesheet"/);
  });

  it("GET /version names the server and the client it serves", async () => {
    const v = (await (await get("/version")).json()) as { ok: boolean; flowee: string; commit: string; client: { version: string; sha256: string } };
    const m = await manifest();
    expect(v).toEqual({ ok: true, flowee: m.flowee, commit: m.commit, client: m.client });
  });
});

describe("POST /validate", () => {
  const post = (body: string, ip = "198.51.100.1", e = env) =>
    worker.fetch(new Request("https://flowee.test/validate", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body }), e);
  const ws = workspaces.workspaces[0];

  it("a valid workspace or instance document: ok, its kind and ids", async () => {
    let r = await post(JSON.stringify(ws));
    expect([r.status, await r.json()]).toEqual([200, { ok: true, kind: "workspace", ids: [ws.id] }]);
    r = await post(JSON.stringify(workspaces), "198.51.100.2");
    expect(await r.json()).toEqual({ ok: true, kind: "instance", ids: workspaces.workspaces.map((w) => w.id) });
  });

  it("an invalid one: each problem one sentence starting with its JSON path; not JSON; too large; GET", async () => {
    let r = await post(JSON.stringify({ ...ws, roles: "x" }));
    const b = (await r.json()) as { ok: boolean; error: string; problems: string[] };
    expect([r.status, b.ok, b.error]).toEqual([400, false, "bad_config"]);
    expect(b.problems.length).toBeGreaterThan(0);
    for (const p of b.problems) expect(p).toMatch(/^\$[^ ]*: .+\.$/);
    r = await post("{nope");
    expect((((await r.json()) as { problems: string[] }).problems)[0]).toMatch(/^\$: is not JSON \(/);
    r = await post(JSON.stringify({ pad: "x".repeat(VALIDATE_MAX) }));
    expect([r.status, ((await r.json()) as { error: string }).error]).toEqual([413, "too_large"]);
    expect((await get("/validate")).status).toBe(405);
  });

  it("is limited per address", async () => {
    const codes: number[] = [];
    for (let i = 0; i <= VALIDATE_PER_MINUTE; i++) codes.push((await post(JSON.stringify(ws), "203.0.113.9")).status);
    expect(codes.slice(0, VALIDATE_PER_MINUTE).every((c) => c === 200)).toBe(true);
    expect(codes.at(-1)).toBe(429);
    expect((await post(JSON.stringify(ws), "203.0.113.10")).status).toBe(200);
  });

  it("touches no state: a managed instance's workspaces are the same before and after", async () => {
    const list = async () => (await worker.fetch(new Request("https://flowee.test/admin/workspaces", { headers: { authorization: "Bearer admin-test" } }), menv())).text();
    const before = await list();
    const r = await post(JSON.stringify({ ...ws, id: "brand-new" }), "198.51.100.7", menv());
    expect(((await r.json()) as { ids: string[] }).ids).toEqual(["brand-new"]);
    expect(await list()).toBe(before);
    expect(before).not.toContain("brand-new");
  });
});

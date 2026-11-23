// The terminal doorbell on the bun runtime: Bun.serve upgrades the socket the router authorised, and a change in the
// workspace rings it (test/tui.test.ts walks the protocol itself on both runtimes).
import { afterAll, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Env } from "../../src/adapters/instance";
import { App } from "../../src/runtime/bun/app";
import { bindings } from "../bindings";
import { install } from "../fake";
import workspaces from "../workspaces.json";

const local = globalThis.fetch;
const dir = mkdtempSync(join(tmpdir(), "flowee-tui-test-"));
// Flowee without a messenger: one terminal-only workspace, no bot token anywhere
const { TELEGRAM_BOT_TOKEN: _t, TG_WEBHOOK_SECRET: _s, ...noBot } = bindings;
const desk = workspaces.workspaces.find((w) => w.id === "desk");
const app = new App({ ...noBot, FLOWEE_CONFIG: JSON.stringify({ flowee: 1, workspaces: [desk] }) } as Env & Record<string, unknown>, { data: dir, port: 0, host: "127.0.0.1", debug: false }, () => {});
afterAll(async () => {
  await app.stop();
  rmSync(dir, { recursive: true, force: true });
});

it("without any messenger: a socket of the terminal protocol is upgraded by Bun.serve and rung on every change", async () => {
  const { desk } = install();
  await app.start();
  expect(app.pollers.size).toBe(0);
  const base = `127.0.0.1:${app.port}`;
  // without the key: refused before any upgrade
  expect((await local(`http://${base}/tui/v1/w/desk/socket`, { headers: { upgrade: "websocket" } })).status).toBe(401);
  const ws = new WebSocket(`ws://${base}/tui/v1/w/desk/socket`, { headers: { authorization: "Bearer tui-ann" } } as unknown as string[]);
  await new Promise((ok, no) => {
    ws.addEventListener("open", ok);
    ws.addEventListener("error", no);
  });
  const rung = new Promise<string>((ok) => ws.addEventListener("message", (e) => ok(String(e.data))));
  desk.add({ number: 1, state_label: "board review" });
  const res = await local(`http://${base}/v1/escalate`, {
    method: "POST",
    headers: { authorization: "Bearer t-board", "content-type": "application/json" },
    body: JSON.stringify({ n: 1, comment: "### For Ann\nKind: question\nQuestion: Blue or green?" }),
  });
  expect(res.status).toBe(200);
  expect(JSON.parse(await rung).seq).toBeGreaterThan(0);
  ws.close();
});

// The terminal client's App against the real server (both runtimes): keys in, frames out through sync, the screen
// read back from a headless Screen. tui_demo.py walks the same in a pseudo-terminal with the compiled client.
import { SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { TuiSync } from "../src/ports/tui";
import { App, type Sys } from "../tui/app";
import { parseInput } from "../tui/input";
import { Screen } from "../tui/screen";
import { CARD_Q, CARD_TEST, call, setup, wipe } from "./helpers";

let f: ReturnType<typeof setup>;
beforeEach(async () => {
  f = setup();
  await wipe("desk");
});

const saved: [string, string][] = [];
const sys: Sys = {
  save: (name, data) => (saved.push([name, data]), `/home/ann/.config/flowee-tui/files/${name}`),
  read: (path) => ({ name: path.split("/").pop() as string, data: btoa("bytes"), size: 5 }),
  list: () => [{ name: "shot.png", dir: false }, { name: "docs", dir: true }],
  cwd: "/home/ann",
  home: "/home/ann",
  open: (url) => `Opened ${url}`,
  copy: () => {},
  now: () => Date.now(),
};

async function client(key = "tui-ann") {
  const me = (await (await SELF.fetch("https://flow.test/tui/v1/me", { headers: { authorization: `Bearer ${key}` } })).json()) as { workspaces: App["seats"] };
  const app = new App(sys, "test");
  app.seats = me.workspaces;
  app.ws = "desk";
  const sync = async () => {
    for (let i = 0; i < 5; i++) {
      const frames = app.take("desk");
      const r = await SELF.fetch("https://flow.test/tui/v1/w/desk/sync", {
        method: "POST",
        headers: { authorization: `Bearer ${key}` },
        body: JSON.stringify({ after: app.conv.seq, send: frames }),
      });
      app.synced("desk", (await r.json()) as TuiSync);
      if (!(app.outbox.get("desk")?.length ?? 0)) return;
    }
  };
  const keys = async (s: string) => {
    for (const e of parseInput(s).events) app.input(e);
    await sync();
  };
  const screen = (w = 100, h = 30) => {
    const sc = new Screen(w, h);
    app.draw(sc);
    return sc;
  };
  return { app, sync, keys, screen };
}

const escalate = async (n: number, card: string) => {
  f.desk.add({ number: n, state_label: "board review" });
  expect((await call("board", "escalate", { n, comment: card }, undefined, "t")).status).toBe(200);
};

describe("the terminal client", () => {
  it("starts on the first card, answers it from the editor, moves on with n; no screen size overflows", async () => {
    await escalate(1, CARD_Q);
    await escalate(2, CARD_TEST);
    const c = await client();
    await c.sync();
    await c.sync();
    let s = c.screen().text();
    expect(s).toContain("Card #1");
    expect(s).toContain("Blue or green? I recommend blue.");
    expect(s).toMatch(/ t  ➕ New ticket .* n  ▶ Next/);
    expect(s).toContain("2 open");
    await c.keys("a");
    await c.keys("Green.");
    expect(c.screen().text()).toContain("Green.");
    await c.keys("\x13");
    expect(c.screen().text()).toContain("Ann: Green. ✍");
    await c.keys("n");
    s = c.screen().text();
    expect(s).toContain("Card #2");
    expect(f.desk.issues.get(1)?.comments.at(-1)?.body).toBe("Ann: Green.");
    for (const [w, h] of [[80, 24], [140, 40], [60, 20]]) expect(c.screen(w, h).overflow, `${w}x${h}`).toBe(0);
  });

  it("a file from the picker answers the card with the draft as its caption", async () => {
    await escalate(1, CARD_TEST);
    const c = await client();
    await c.sync();
    await c.sync();
    await c.keys("a");
    await c.keys("Works on my phone.");
    await c.keys("\x0f");
    expect(c.screen().text()).toContain("Attach a file");
    await c.keys("shot\r");
    await c.keys("n");
    expect(f.desk.issues.get(1)?.comments.at(-1)?.body).toBe("Ann: Works on my phone.\n\n![shot.png](https://paste.example/shot.png)");
  });

  it("the help lists every key; o answers OK; the inbox pane opens an item with Enter", async () => {
    await escalate(1, CARD_Q);
    await escalate(2, CARD_Q);
    const c = await client();
    await c.sync();
    await c.sync();
    await c.keys("?");
    const help = c.screen(100, 40).text();
    for (const k of ["Ctrl+S", "Ctrl+O", "Shift+Tab", "PgUp", "Mouse"]) expect(help).toContain(k);
    await c.keys("\x1b");
    await c.keys("\x1b[Z");
    await c.keys("\x1b[B\r");
    expect(c.screen().text()).toContain("Card #2");
    await c.keys("o");
    expect(f.desk.issues.get(2)?.comments.at(-1)?.body).toBe("Ann: OK");
    expect(c.app.status?.text).toBe("✅ #2 OK");
  });
});

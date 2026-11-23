// Rendering parity: every view the chat-agnostic code makes (the blocks of src/envoy/render.ts, and every screen the
// envoy, the setup wizard and the menu showed in the terminal walks) drawn by the terminal client into a headless
// screen at 80x24 and 140x40: nothing runs over its pane, no button label is cut, every button is reachable by
// keyboard. The screens are snapshots (test/__snapshots__/tui-parity.test.ts.snap).
import { env, runInDurableObject } from "cloudflare:test";
import { createHash } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import type { Content, Item } from "../src/envoy/render";
import { btn, card, details, facts, heading, list, nav, newBar, okRow, option, options, panel, paragraphs, postponed, question, results, row, text, warning } from "../src/envoy/render";
import type { View } from "../src/ports/chat";
import type { Instance } from "../src/runtime/cloudflare/worker";
import worker from "../src/index";
import { App, hotkey, type Sys } from "../tui/app";
import { buttonText, layout } from "../tui/html";
import { parseInput } from "../tui/input";
import { Screen, width } from "../tui/screen";
import { call, CARD_Q, CARD_TEST, setup, wipe } from "./helpers";
import { Scripted, setUp } from "./tui-client";

const NOW = Date.UTC(2026, 10, 23, 9, 0);
const sys: Sys = { save: (n) => `/tmp/${n}`, read: () => ({ name: "f", data: "", size: 0 }), list: () => [], cwd: "/", home: "/", open: (u) => u, copy: () => {}, now: () => NOW };

const item = (n: number, content: Content, title = `Ticket ${n} with a title long enough to wrap in a narrow pane`, extra: Partial<Item> = {}): Item => ({
  n,
  cid: n * 10,
  title,
  url: `https://github.com/acme/shop/issues/${n}`,
  content,
  since: NOW - n * 7 * 60e3,
  status: "open",
  ...extra,
});
const Q = item(1, { kind: "question", question: "Blue or green? I recommend blue.\n- one\n- two `x`" } as Content);
const T = item(2, { kind: "test", changed: "Lessons load faster", check: "- open a lesson\n- it shows at once\n```sh\nflowee test --slow-network --repeat 3\n```", version: "v1.4.0" } as Content);
const D = item(3, { kind: "decision", question: "Ship now or after the redesign?" } as Content);
const S = item(4, { kind: "sample", samples: "`a.pdf`, `b.docx`", question: "Where are real samples?" } as Content);
const X = item(5, { kind: "excerpt", text: "Tester: something odd happened" });
const N = item(6, { kind: "none" }, "Old ticket", { postponed: true });

/** The views of src/envoy/render.ts, built directly. */
const BLOCKS: [string, View][] = [
  ["card question folded", [{ html: card(Q, null, false, NOW) }, ...okRow()]],
  ["card test open", [{ html: card(T, null, true, NOW) }]],
  ["card decision answered", [{ html: card(D, NOW - 60e3, true, NOW) }]],
  ["card sample", [{ html: card(S, null, true, NOW) }]],
  ["card excerpt", [{ html: card(X, null, true, NOW) }]],
  ["card none", [{ html: card(N, null, true, NOW) }]],
  ["bar with a card", nav(1, 3)],
  ["bar empty inbox", nav(undefined, 0)],
  ["bar new ticket", newBar()],
  ["list two pages", list([Q, T, D, S, X], "5 open · 2 answered today", 0, 2, NOW)],
  ["list empty", list([], "0 open · 0 answered today", 0, 1, NOW)],
  ["postponed", postponed([N], 1, 0, 1, NOW)],
  ["results", results([{ item: Q, snippet: "… <b>Blue</b> or green" }, { item: D }], 2, "blue", 0, 1, NOW)],
  ["results none", results([], 0, "zebra", 0, 1, NOW)],
  ["panel", panel([Q, T, D], 1, 2, NOW)],
  ["todo", [...paragraphs("☀️ <b>Good morning: 3 open</b>"), facts([["❓ #1 Blue or green"], ["🧪 #2 Lessons"]]), row(btn("▶ Start", "n"))]],
  ["notice", paragraphs("⚡ Instant updates are off for acme/shop: Flowee polls every minute.")],
  [
    "choices and toggles",
    [
      heading("🆕", "New workspace", "Step 2 of 4"),
      question("How should the agents work?"),
      options(option("🌿 Single branch", "The agents commit straight to the main branch.", btn("● Chosen", "w:a")), option("🔀 Feature branches", "One branch and one pull request per ticket.", btn("Choose", "w:b"))),
      details("What is the difference?", "<p>Help most readers skip.</p>"),
      warning("That is not a repository link."),
      row(btn("◀ Back", "w:back"), btn("▶ Next", "w:next"), btn("✖ Cancel", "w:cancel")),
    ],
  ],
];

const walked: [string, View][] = [];

beforeAll(async () => {
  const f = setup();
  // the envoy in the terminal: cards, the bar, the list, postponed, search, a new ticket
  await wipe("desk");
  f.desk.add({ number: 1, state_label: "board review" });
  f.desk.add({ number: 2, state_label: "board review" });
  await call("board", "escalate", { n: 1, comment: CARD_Q }, undefined, "t");
  await call("board", "escalate", { n: 2, comment: CARD_TEST }, undefined, "t");
  const c = new Scripted("tui-ann", "desk");
  await c.sync({ text: { text: "/start" } });
  for (const t of ["/todo", "/postponed", "/search blue", "/stats"]) await c.sync({ text: { text: t } });
  await c.press("📋 List").catch(() => undefined);
  await c.press("« Back").catch(() => undefined);
  await c.sync({ text: { text: "/new" } });
  await c.type("Dark mode please");
  await c.press("📨 File ticket");
  // the wizard and the menu in the terminal (managed mode)
  const digest = createHash("sha256").update("tui-mia").digest("hex");
  const cfg = { flowee: 1, instance: { bot: { token: "TELEGRAM_BOT_TOKEN", webhookSecret: "TG_WEBHOOK_SECRET" }, publicUrl: "https://flowee.test", owner: "100", tui: { people: [{ id: "mia", name: "Mia", role: "manager", key: digest }] } }, workspaces: [] };
  const fetcher = async (req: Request) => worker.fetch(req, { ...env, FLOWEE_MODE: "managed", FLOWEE_CONFIG: JSON.stringify(cfg), FLOWEE_ADMIN_TOKEN: "admin-test" } as typeof env);
  await runInDurableObject(env.INSTANCE.get(env.INSTANCE.idFromName("instance")), (o: Instance) => {
    for (const t of ["vault", "sessions", "updates", "kv"]) o.host.store.exec(`DELETE FROM ${t}`);
    o.host.store.exec("DROP TABLE IF EXISTS workspaces");
    for (const r of o.host.store.rows<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'p_%'")) o.host.store.exec(`DROP TABLE ${r.name}`);
    Object.assign(o.host, { reg: undefined, plain: undefined });
  });
  const m = new Scripted("tui-mia", "@instance", "x", fetcher);
  await setUp(m, "https://github.com/acme/app", "Feature branches");
  await setUp(m, "https://github.com/acme/widget", "Single branch");
  await m.sync({ text: { text: "/workspaces" } });
  await m.pressRow("app");
  for (const [label, back] of [["👥 People", "« Back"], ["➕ Add", "« Back"], ["➖ Remove", "« Back"], ["🔑 New secret", "« Back"], ["🗑 Delete", "« Back"]] as const) {
    await m.press(label).catch(() => undefined);
    await m.press(back).catch(() => undefined);
  }
  await m.sync({ text: { text: "/import" } });
  await m.sync({ text: { text: "/export" } });
  const seen = new Map<string, View>();
  for (const v of [...c.seen, ...m.seen]) seen.set(JSON.stringify(v), v);
  [...seen.values()].forEach((v, i) => walked.push([`walk ${String(i + 1).padStart(2, "0")}`, v]));
}, 60_000);

/** The view as the only message of a conversation, drawn by the client at w×h; the keys it takes. */
function draw(view: View, w: number, h: number) {
  const app = new App(sys, "parity");
  app.seats = [{ id: "x", name: "Shop", paused: false, person: { id: "ann", name: "Ann", role: "manager" } }];
  app.ws = "x";
  app.synced("x", { seq: 1, events: [{ seq: 1, op: "put", msg: { id: 1, at: NOW, view } }] });
  const m = app.conv.get(1);
  const where = app.conv.focus() === m ? "pane" : app.conv.bar() === m ? "bar" : "notices";
  const alsoBar = where === "pane" && app.conv.bar() === m;
  if (where === "notices") app.input({ type: "key", name: "!", ch: "!" });
  const sc = new Screen(w, h);
  app.draw(sc);
  return { app, sc, where, alsoBar };
}

describe("every view in the terminal", () => {
  it("walks produced the screens of the envoy, the wizard and the menu", () => {
    const all = walked.map(([, v]) => JSON.stringify(v)).join("\n");
    for (const s of ["Question:", "📋 List", "New workspace", "Step 1 of", "Last check", "Your workspaces", "Who can use this workspace", "New agent secret", "Import"]) expect(all, s).toContain(s);
  });

  for (const [w, h] of [[80, 24], [140, 40]] as const)
    it(`${w}x${h}: no overflow, no cut button, every button reachable`, () => {
      for (const [name, view] of [...BLOCKS, ...walked]) {
        const { app, sc, where, alsoBar } = draw(view, w, h);
        expect(sc.overflow, `${name}: overflow`).toBe(0);
        expect(sc.text(), name).toMatchSnapshot(`${name} ${w}x${h}`);
        const text = sc.text();
        if (where === "bar" || alsoBar) {
          // the bar: each button whole, each with its key or a click
          for (const b of view.flatMap((x) => ("buttons" in x ? x.buttons : []))) {
            expect(text, `${name}: ${b.label}`).toContain(b.label);
            if (b.data) expect(hotkey(b), `${name}: ${b.label} has a key`).toBeTruthy();
          }
          if (!alsoBar) continue;
        }
        if (where !== "pane") continue;
        // the main pane: the layout at its inner width, then the keys reach every target
        const inner = w >= 100 ? w - Math.max(34, Math.min(56, Math.floor(w * 0.36))) - 4 : w - 4;
        // a list in the bar: its button rows are on the action bar (above), its rows' buttons in the pane
        const laid = layout(alsoBar ? view.filter((b) => !("buttons" in b)) : view, inner);
        for (const l of laid.lines) expect(l.reduce((a, s) => a + width(s.t), 0), `${name}: line width`).toBeLessThanOrEqual(inner);
        for (const t of laid.targets)
          if (t.kind === "button") {
            const line = laid.lines[t.line].map((s) => s.t).join("");
            expect([...line].join("").includes(buttonText(t.button)), `${name}: ${t.button.label} whole`).toBe(true);
          }
        const picked = new Set<number>();
        for (let i = 0; i < laid.targets.length * 3 + laid.lines.length + 5; i++) {
          for (const e of parseInput("\x1b[B").events) app.input(e);
          app.draw(new Screen(w, h));
          const p = (app as unknown as { picks: Map<number, number> }).picks.get(1);
          if (p !== undefined) picked.add(p);
        }
        expect(picked.size, `${name}: reachable targets`).toBe(laid.targets.length);
      }
    });
});

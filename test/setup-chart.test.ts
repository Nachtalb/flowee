// The setup wizard's statechart (src/wizard/setup.json): loadable by xstate, every screen reachable with a way back
// and a way to cancel, every button an event its screen handles; and random walks over every choice through the
// Wizard itself (a fake chat and host): Back then the same press is the same screen, forward visits each screen of
// the path once, the step counter counts screens, Back reaches the first screen in step-1 presses. Old sessions resume.
import { createMachine, initialTransition, transition } from "xstate";
import { describe, expect, it } from "vitest";
import { refName } from "../src/core/chart";
import type { Block, Chat, ChatRef, View } from "../src/ports/chat";
import { ACTIONS, GUARDS, mermaid, SETUP, STATES, transitions } from "../src/wizard/chart";
import { fromDoc, type Input, type Session, Wizard, type WizardHost } from "../src/wizard/wizard";
import docs from "../docs/managed.md?raw";

const TOKEN = `github_pat_${"a".repeat(40)}`;
const WIDE = `github_pat_wide${"b".repeat(30)}`;

/** A wizard on a fake chat and host; `last` is the view on screen. */
function harness(o: { ownBots?: boolean; terminal?: boolean } = {}) {
  const sessions = new Map<string, Session>();
  let id = 0;
  const shown: { view?: View } = {};
  const chat = {
    view: async (_: ChatRef, v: View) => {
      if (!(v.length === 1 && "html" in v[0])) shown.view = v;
      return ++id;
    },
    editView: async (_: ChatRef, _id: number, v: View) => {
      shown.view = v;
    },
    remove: async () => {},
    sendFile: async () => ++id,
  } as unknown as Chat;
  const lives = new Map<string, number>();
  const host: WizardHost = {
    flow: () => ({ roles: ["board", "developer", "tester", "owner"], ownerRole: "owner", features: ["pullRequests", "releases", "uiReview", "dependencyTickets", "userFeedback"] }),
    refusal: () => null,
    freeId: (x) => x,
    parseRepo: (r) => {
      const m = /^(?:https:\/\/)?(github|gitlab)\.com\/([\w-]+\/[\w-]+)$/.exec(r);
      return m ? { kind: m[1] as "github" | "gitlab", repo: m[2] } : undefined;
    },
    tokenHelp: () => () => ({ permissions: ["Issues: read and write"], url: "https://example.test/token" }),
    trackerName: (k) => (k === "gitlab" ? "GitLab" : "GitHub"),
    ownBots: o.ownBots ?? true,
    terminal: o.terminal,
    botUsername: "FloweeBot",
    seal: async (v) => v,
    checkRepos: async () => [],
    wider: async (t) => (t === WIDE ? ["acme/other"] : []),
    extensionProblems: () => [],
    repoTaken: () => undefined,
    adoptBot: async () => {},
    commit: async (s) => ({ id: s.draft.id as string, secrets: {}, doc: {} as never }),
    load: (u) => structuredClone(sessions.get(u)),
    draftOf: (d) => fromDoc(d),
    save: (s) => void sessions.set(s.user, structuredClone(s)),
    drop: (u) => void sessions.delete(u),
    publicUrl: "https://flowee.test",
    live: (u) => lives.get(u),
    setLive: (u, i) => void lives.set(u, i),
  };
  const w = new Wizard(chat, host, () => 1_000_000);
  const at = { chat: "7" };
  const send = (i: Input) => w.input("7", at, i);
  return {
    w,
    host,
    sessions,
    start: () => w.start("7", at),
    send,
    press: (data: string) => send({ kind: "press", data: `w:${data}` }),
    type: (text: string) => send({ kind: "text", text, message: 1 }),
    state: () => sessions.get("7")?.state,
    view: () => shown.view as View,
  };
}

type H = ReturnType<typeof harness>;
const buttons = (v: View) => v.flatMap((b: Block) => ("buttons" in b ? b.buttons : "table" in b ? b.table.rows.flatMap((r) => r.buttons ?? []) : []));
const html = (v: View) => JSON.stringify(v);
const stepOf = (v: View) => /Step (\d+) of (\d+)/.exec(html(v))?.slice(1).map(Number);
const hasBack = (v: View) => buttons(v).some((b) => b.data === "w:back");

/** A seeded random number generator (mulberry32). */
function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The presses (and typed or chat inputs) that move forward from the screen on display. */
function forwards(h: H): (() => Promise<unknown>)[] {
  const s = h.state();
  const data = buttons(h.view()).map((b) => b.data?.slice(2) ?? "");
  const go = (d: string) => () => h.press(d);
  switch (s) {
    case "repos":
      return [() => h.type("github.com/acme/app"), () => h.type("https://gitlab.com/acme/api"), ...(data.includes("next") ? [go("next")] : [])];
    case "token":
      return [() => h.type(TOKEN), () => h.type(WIDE), ...(data.includes("next") ? [go("next")] : [])];
    case "botCreate":
      return data.includes("next") ? [go("next")] : [() => h.send({ kind: "managed", botId: "77", username: "OwnBot", name: "Own" })];
    case "group":
      return data.includes("next") ? [go("next")] : [() => h.send({ kind: "bound", chat: "-100", topic: 3, label: "one topic of “Team”" })];
    default:
      return data.filter((d) => /^(next|confirm)\b/.test(d)).map(go);
  }
}

/** Detours that come back to the screen they left: a values or custom-steps screen, applied or left with Back. */
function detours(h: H, r: () => number): (() => Promise<unknown>)[] {
  if (h.state() !== "options") return [];
  const data = buttons(h.view()).map((b) => b.data?.slice(2) ?? "");
  return data
    .filter((d) => /^(configure|extensions|switch)\b/.test(d))
    .map((d) => async () => {
      await h.press(d);
      if (d.startsWith("switch")) return;
      const extra = buttons(h.view()).map((b) => b.data?.slice(2) ?? "").filter((x) => /^(set|tog|flag)\b/.test(x));
      if (extra.length) await h.press(extra[Math.floor(r() * extra.length)]);
      await h.press(r() < 0.5 ? "apply" : "back");
      if (h.state() !== "options") await h.press("back");
    });
}

/** Every event a button on screen raises is one the chart handles in that state. */
function handled(h: H) {
  const s = h.state() as string;
  for (const b of buttons(h.view())) {
    if (!b.data?.startsWith("w:")) continue;
    const ev = b.data.slice(2).split(":")[0];
    if (ev === "resume" || ev === "new" || ev === "restart") continue;
    expect(transitions(s, ev).length, `${s}: the button ${b.label} (${ev})`).toBeGreaterThan(0);
  }
}

describe("the setup chart", () => {
  it("is a statechart xstate loads and runs", () => {
    const yes = Object.fromEntries(GUARDS.map((g) => [g, () => false]));
    const m = createMachine(SETUP as never).provide({ guards: yes as never, actions: Object.fromEntries(ACTIONS.map((a) => [a, () => {}])) as never });
    expect(Object.keys(m.states)).toEqual(STATES);
    let [s] = initialTransition(m);
    for (const [ev, to] of [
      ["next", "bot"],
      ["next", "branching"],
      ["next", "options"],
      ["next", "where"],
      ["next", "token"],
      ["next", "summary"],
      ["confirm", "done"],
    ]) {
      [s] = transition(m, s, { type: ev });
      expect(s.value, ev).toBe(to);
    }
    [s] = transition(m, initialTransition(m)[0], { type: "cancel" });
    expect(s.value).toBe("cancelled");
  });

  it("every state reachable, every screen with a way back and a way to cancel, only known guards and actions", () => {
    const reach = new Set([SETUP.initial]);
    const all = [...Object.values(SETUP.states).flatMap((n) => Object.values(n.on ?? {})), ...Object.values(SETUP.on)].flat();
    for (const t of all) if (typeof t === "object" && t.target) reach.add(t.target.replace(/^\./, ""));
    expect(STATES.filter((s) => !reach.has(s))).toEqual([]);
    for (const s of STATES) {
      if (SETUP.states[s].type === "final") continue;
      expect(transitions(s, "back").some((t) => [t.actions].flat().includes("back")), s).toBe(true);
      expect(transitions(s, "cancel")[0]?.target, s).toBe(".cancelled");
      expect(transitions(s, "expire")[0]?.target, s).toBe(".expired");
    }
    for (const t of all) {
      if (typeof t !== "object") continue;
      if (t.guard) expect(GUARDS as readonly string[]).toContain(refName(t.guard));
      for (const a of [t.actions ?? []].flat()) expect(ACTIONS as readonly string[]).toContain(refName(a));
    }
  });

  it("docs/managed.md shows the chart as generated (bun scripts/setup-chart.ts)", () => {
    expect(docs).toContain(`\`\`\`mermaid\n${mermaid()}\`\`\``);
  });
});

describe("random walks over the setup", () => {
  const WALKS = 300;

  it(`${WALKS} seeded walks: Back then the same press is the same screen; forward visits each screen once; steps count; Back reaches the first screen in step-1 presses`, async () => {
    let checked = 0;
    for (let seed = 1; seed <= WALKS; seed++) {
      const r = rng(seed);
      const h = harness({ ownBots: seed % 5 !== 0, terminal: seed % 7 === 0 });
      await h.start();
      const visited: string[] = [];
      let last: number[] | undefined;
      for (let n = 0; n < 40 && h.state() !== "summary"; n++) {
        handled(h);
        const here = h.state() as string;
        const step = stepOf(h.view());
        // the counter: up by one from the screen before
        if (last && step) expect(step[0], `seed ${seed}: ${here}`).toBe(last[0] + 1);
        if (step) expect(step[0], `seed ${seed}`).toBe(visited.length + 1);
        visited.push(here);
        // repeated Back reaches the first screen in exactly step-1 presses, the counter down by one each; then forward again
        if (step && r() < 0.15) {
          const trail: string[] = [];
          for (let k = step[0] - 1; k >= 1; k--) {
            trail.push(html(h.view()));
            await h.press("back");
            expect(stepOf(h.view())?.[0], `seed ${seed}: back to ${k}`).toBe(k);
          }
          expect(hasBack(h.view()), `seed ${seed}: the first screen has no Back`).toBe(false);
          // forward again by what each screen keeps: Keep, Next, or the chosen row
          for (let k = 1; k < step[0]; k++) {
            const again = buttons(h.view()).find((b) => b.data === "w:next" || (b.label === "● Chosen" && b.data?.startsWith("w:next")));
            expect(again, `seed ${seed}: nothing kept on ${h.state()}`).toBeDefined();
            await h.press(again?.data?.slice(2) as string);
            expect(html(h.view()), `seed ${seed}: forward again`).toBe(trail.at(-k));
          }
          expect(h.state(), `seed ${seed}`).toBe(here);
        }
        for (const d of detours(h, r)) if (r() < 0.2) await d();
        if (h.state() !== here) throw new Error(`seed ${seed}: a detour left ${here} on ${h.state()}`);
        const moves = forwards(h);
        expect(moves.length, `seed ${seed}: no way forward on ${here}`).toBeGreaterThan(0);
        const move = moves[Math.floor(r() * moves.length)];
        await move();
        if (h.state() === here) continue;
        // Back, then the same press: the identical screen
        const there = html(h.view());
        const at = h.state();
        await h.press("back");
        expect(h.state(), `seed ${seed}: back from ${at}`).toBe(here);
        await move();
        expect(h.state(), `seed ${seed}`).toBe(at);
        expect(html(h.view()), `seed ${seed}: ${here} -> ${at} after back`).toBe(there);
        last = step;
        checked++;
      }
      expect(h.state(), `seed ${seed}: ${visited.join(" > ")}`).toBe("summary");
      visited.push("summary");
      // each screen of the path once, the last one the summary with N = its step
      expect(new Set(visited).size, `seed ${seed}: ${visited.join(" > ")}`).toBe(visited.length);
      expect(stepOf(h.view()), `seed ${seed}`).toEqual([visited.length, visited.length]);
      await h.press("confirm");
      expect(h.sessions.size).toBe(0);
    }
    expect(checked).toBeGreaterThan(WALKS * 4);
    console.info(`${WALKS} walks: ${checked} forward presses each undone by Back and pressed again`);
  });
});

describe("sessions stored before the chart", () => {
  it("resume at their screen with the screens before them behind Back", async () => {
    const h = harness();
    await h.start();
    await h.type("github.com/acme/app");
    await h.press("next:shared");
    await h.press("next:feature");
    const s = h.sessions.get("7") as Session & Record<string, unknown>;
    const old = { user: s.user, at: s.at, draft: s.draft, ts: s.ts, step: "flow", sub: "options", back: ["repos", "bot"], plan: ["repos", "bot", "flow", "bind", "credential"] };
    h.sessions.set("7", old as unknown as Session);
    await h.press("resume");
    expect(h.state()).toBe("options");
    expect(stepOf(h.view())).toEqual([4, 7]);
    await h.press("back");
    expect(h.state()).toBe("branching");
    await h.press("next");
    await h.press("next");
    expect(h.state()).toBe("where");
    // a step that no longer exists (the former agents step), or a values screen of an option
    h.sessions.set("7", { ...old, step: "agents", sub: undefined } as unknown as Session);
    await h.press("resume");
    expect(h.state()).toBe("summary");
    h.sessions.set("7", { ...old, sub: "input", input: "releases" } as unknown as Session);
    await h.press("apply");
    expect(h.state()).toBe("options");
    h.sessions.set("7", { ...old, step: "credential", single: true, sub: undefined } as unknown as Session);
    await h.press("resume");
    expect([h.state(), hasBack(h.view())]).toEqual(["token", false]);
  });
});

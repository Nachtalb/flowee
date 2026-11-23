// A scripted terminal client (docs/tui-protocol.md) for the suites: it keeps the conversation as the real client
// does (tui/state.ts applies the same events) and presses buttons by label.
import { SELF } from "cloudflare:test";
import type { View } from "../src/ports/chat";
import type { TuiFrame, TuiSync } from "../src/ports/tui";
import { Conversation } from "../tui/state";

let frames = 0;

export class Scripted {
  c = new Conversation();
  toasts: string[] = [];
  /** Every view the conversation showed, in order (the parity test renders them all). */
  seen: View[] = [];
  constructor(
    public key: string,
    public ws: string,
    public person = "ann",
    /** The instance's fetch (the managed mode passes its own environment). */
    public fetcher: (req: Request) => Promise<Response> = (req) => SELF.fetch(req),
  ) {}

  private async post(path: string, body?: unknown) {
    const res = await this.fetcher(
      new Request(`https://flow.test/tui/v1/${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${this.key}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  }

  me() {
    return this.post("me");
  }

  /** Sends frames (none: just catches up) and applies the answer. */
  async sync(...send: Omit<TuiFrame, "id">[]) {
    const r = await this.post(`${this.ws === "@instance" ? "instance" : `w/${this.ws}`}/sync`, { after: this.c.seq, send: send.map((f) => ({ id: `f${++frames}`, ...f })) });
    if (r.status === 200) {
      const s = r.body as unknown as TuiSync;
      for (const e of s.events) if (e.op === "put" && e.msg.view) this.seen.push(e.msg.view);
      if (s.reset) for (const m of s.reset.messages) if (m.view) this.seen.push(m.view);
      this.toasts.push(...this.c.apply(s, this.person));
    }
    return r;
  }

  /** The newest message with a button of this label, and the button. */
  find(label: string | RegExp) {
    for (const m of [...this.c.messages].reverse())
      for (const b of this.c.buttons(m)) if (typeof label === "string" ? b.label === label : label.test(b.label)) return { m, b };
    return undefined;
  }

  async press(label: string | RegExp) {
    const hit = this.find(label);
    if (!hit?.b.data) throw new Error(`no button ${label} on screen`);
    return this.sync({ press: { data: hit.b.data, message: hit.m.id } });
  }

  /** Presses the first button of the table row (on the screen in focus) whose text has `text`. */
  async pressRow(text: string) {
    const f = this.c.focus();
    for (const b of f?.view ?? []) if ("table" in b) for (const r of b.table.rows) if (r.cells.join(" ").includes(text) && r.buttons?.[0]?.data) return this.sync({ press: { data: r.buttons[0].data, message: f?.id } });
    throw new Error(`no row with ${text} on screen`);
  }

  /** Text as the answer to the card being worked on (or a command like /todo). */
  type(text: string) {
    const card = this.c.replyTarget();
    return this.sync({ text: { text, ...(card ? { replyTo: card.id } : {}) } });
  }

  /** The screen in focus as plain text (tests read it). */
  screen() {
    return (this.c.focus()?.view ?? []).map((b) => ("html" in b ? b.html : "buttons" in b ? b.buttons.map((x) => `[${x.label}]`).join(" ") : b.table.rows.map((r) => `${r.cells.join(" | ")} ${(r.buttons ?? []).map((x) => `[${x.label}]`).join(" ")}`).join("\n"))).join("\n").replace(/<[^>]+>/g, "");
  }

  file(name: string, bytes: string, caption?: string) {
    const card = this.c.replyTarget();
    return this.sync({ file: { name, data: btoa(bytes), ...(caption ? { caption } : {}), ...(card ? { replyTo: card.id } : {}) } });
  }
}

export const TOKEN = `github_pat_${"a".repeat(40)}`;

/** The setup wizard walked in the terminal to its end: one repository, single branch or feature branches. */
export async function setUp(c: Scripted, repo = "https://github.com/acme/app", branching: "Single branch" | "Feature branches" = "Single branch") {
  await c.sync({ text: { text: "/start" } });
  await c.press(/Set up a workspace/);
  await c.sync({ text: { text: repo } });
  await c.pressRow(branching);
  if (c.screen().includes("Versioning")) await c.press("▶ Next");
  await c.sync({ text: { text: TOKEN } });
  if (/Agents|agents/.test(c.screen()) && !/Last check/.test(c.screen())) await c.press("▶ Next");
  await c.press(/Create/);
}

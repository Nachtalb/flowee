// A scripted terminal client (docs/tui-protocol.md) for the suites: it keeps the conversation as the real client
// does (tui/state.ts applies the same events) and presses buttons by label.
import { SELF } from "cloudflare:test";
import type { TuiFrame, TuiSync } from "../src/ports/tui";
import { Conversation } from "../tui/state";

let frames = 0;

export class Scripted {
  c = new Conversation();
  toasts: string[] = [];
  constructor(
    public key: string,
    public ws: string,
    public person = "ann",
  ) {}

  private async post(path: string, body?: unknown) {
    const res = await SELF.fetch(`https://flow.test/tui/v1/${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${this.key}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  }

  me() {
    return this.post("me");
  }

  /** Sends frames (none: just catches up) and applies the answer. */
  async sync(...send: Omit<TuiFrame, "id">[]) {
    const r = await this.post(`w/${this.ws}/sync`, { after: this.c.seq, send: send.map((f) => ({ id: `f${++frames}`, ...f })) });
    if (r.status === 200) this.toasts.push(...this.c.apply(r.body as unknown as TuiSync, this.person));
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

  /** Text as the answer to the card being worked on (or a command like /todo). */
  type(text: string) {
    const card = this.c.replyTarget();
    return this.sync({ text: { text, ...(card ? { replyTo: card.id } : {}) } });
  }

  file(name: string, bytes: string, caption?: string) {
    const card = this.c.replyTarget();
    return this.sync({ file: { name, data: btoa(bytes), ...(caption ? { caption } : {}), ...(card ? { replyTo: card.id } : {}) } });
  }
}

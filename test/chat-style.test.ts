// The guard of docs/chat-style.md over the source: plain messages and reply keyboards only where the document
// lists them, screens built from the shared blocks only. test/managed.test.ts guards the same at run time (every
// call the wizard and the menu make to the fake Telegram).
import { describe, expect, it } from "vitest";

const files = import.meta.glob("../src/**/*.ts", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
const where = (re: RegExp) =>
  Object.entries(files)
    .filter(([, src]) => re.test(src))
    .map(([p]) => p.replace("../src/", ""))
    .sort();

describe("chat style guard", () => {
  it("no plain messages at all: the Chat port has no text/editText, every notice of the envoy is a rich message", () => {
    expect(where(/\b(?:chat|tg)\.(?:text|editText)\(/)).toEqual([]);
    expect(files["../src/ports/chat.ts"]).not.toMatch(/\btext\(to: ChatRef|editText\(/);
  });

  it("only the Telegram adapter names sendMessage, a reply keyboard or ReplyKeyboardRemove", () => {
    expect(where(/sendMessage|request_managed_bot|remove_keyboard|request_chat|"keyboard"|\bkeyboard: \[/)).toEqual(["adapters/chat-telegram.ts"]);
  });

  it("a reply keyboard is asked for in one place: the bot step of the wizard", () => {
    expect(where(/\{ keyboard: /)).toEqual(["wizard/wizard.ts"]);
    expect((files["../src/wizard/wizard.ts"].match(/\{ keyboard: /g) ?? []).length).toBe(1);
  });

  it("the Telegram adapter renders every view richly, never with plain()", () => {
    expect(files["../src/adapters/chat-telegram.ts"]).not.toMatch(/\bplain\(/);
  });

  it("the wizard and the menu build screens from the shared blocks, not their own markup", () => {
    for (const f of ["wizard/wizard.ts", "wizard/manage.ts"]) {
      const src = files[`../src/${f}`];
      // the secrets as a message where files are refused are the one raw block (preformatted text)
      expect(src.match(/\{ html: /g) ?? [], f).toEqual(f === "wizard/wizard.ts" ? ["{ html: "] : []);
      expect(src, f).not.toMatch(/<p>|<tg-button/);
    }
  });

  it("no screen shows a list: lists exist only where a ticket's own text has one (md() in the envoy's render)", () => {
    // the plain fallback of ports/chat.ts turns a ticket's list into lines for chats without rich messages; the
    // served material (adapters/served.ts) is a web page for a browser, not a chat screen
    expect(where(/<ul>|<ol>|<li>/).filter((f) => f !== "adapters/served.ts")).toEqual(["envoy/render.ts", "ports/chat.ts"]);
    const render = files["../src/envoy/render.ts"];
    expect(render.match(/<ul>|<li>/g)?.length).toBe(2);
    expect(render.slice(render.indexOf("function lines("), render.indexOf("function inline("))).toMatch(/<ul>/);
    expect(where(/\bbullets\(/)).toEqual([]);
  });

  it("choices are table rows built by option(): the wizard and the menu never put described choices in a button row", () => {
    for (const f of ["wizard/wizard.ts", "wizard/manage.ts"]) expect(files[`../src/${f}`], f).toMatch(/\boptions\(/);
  });

  it("the instance never writes a screen itself", () => {
    expect(files["../src/adapters/instance-host.ts"]).not.toMatch(/<p>|<b>|\{ html: /);
  });
});

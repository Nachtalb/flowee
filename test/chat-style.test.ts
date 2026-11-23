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
  it("plain messages (the Chat port's text/editText) are sent only by the envoy, for the notices docs/envoy.md lists", () => {
    expect(where(/\b(?:chat|tg)\.(?:text|editText)\(/)).toEqual(["envoy/envoy.ts"]);
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

  it("the instance never writes a screen itself", () => {
    expect(files["../src/adapters/instance-host.ts"]).not.toMatch(/<p>|<b>|\{ html: /);
  });
});

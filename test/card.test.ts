import { describe, expect, it } from "vitest";
import { parseCard as parse } from "../src/core/card";

const parseCard = (b: string) => parse(b, "For Ann");

describe("parseCard", () => {
  it("reads the fields, continuation lines and stops at headings and Worker trailers", () => {
    const c = parseCard(
      "Tester: ok\r\n\r\n## For Ann\r\nKind: Test (UI)\r\nChanged: lessons\r\n  load faster\r\nCheck:\r\n- open a lesson\r\n\r\n- it shows\r\nTested build: abc\r\n",
    );
    expect(c).toEqual({ kind: "test", changed: "lessons\nload faster", check: "- open a lesson\n- it shows", question: undefined });
    expect(parseCard("#### For Ann\nKind: decision\nQuestion: A or B?\n### Notes\nCheck: x").check).toBeUndefined();
  });
  it("refuses with a message naming what is missing", () => {
    const msg = (b: string) => {
      try {
        parseCard(b);
      } catch (e) {
        return (e as Error).message;
      }
    };
    expect(msg("no card")).toBe("The comment has no ### For Ann card.");
    expect(msg("# For Ann\nKind: test")).toBe("The comment has no ### For Ann card.");
    expect(msg("### For Ann\nKind: bribe\nQuestion: x")).toBe("The card's Kind: must be test, question or decision.");
    expect(msg("### For Ann\nkind: question\nQuestion: x")).toBe("The card's Kind: must be test, question or decision.");
    expect(msg("### For Ann\nKind: test\nCheck: x")).toBe("The card has no Changed: line (needed for Kind: test).");
    expect(msg("### For Ann\nKind: test\nChanged: x\nCheck:")).toBe("The card has no Check: lines (needed for Kind: test).");
    expect(msg("### For Ann\nKind: decision\nChanged: x")).toBe("The card has no Question: (needed for Kind: decision).");
  });
});

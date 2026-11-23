// The envoy's parts of the features: the 📎 Sample card with its file names, the release line under test cards,
// parsing Kind: sample only where the samples feature is on (reference envoy, render.rs and bot.rs).
import { describe, expect, it } from "vitest";
import { parseCard } from "../src/core/card";
import { Fail } from "../src/core/errors";
import { handover } from "../src/envoy/envoy";
import { card, type Item, kind } from "../src/envoy/render";

const NOW = Date.parse("2026-11-13T09:00:00Z");
const mk = (content: Item["content"]): Item => ({ n: 7, label: "#7", cid: 3, title: "QOI", url: "https://x/issues/7", content, since: NOW, status: "open" }) as Item;
const SAMPLE = "Sampler: tried.\n\n### For Ann\nKind: sample\nSamples: a.qoi, `b.qoi`\nCheck:\n- export one from the QOI tool, drop it in Samples/Images";

describe("feature cards", () => {
  it("a sample card: 📎 Sample, its file names as code, Check", () => {
    const c = parseCard(SAMPLE, "For Ann", true);
    expect(c).toEqual({ kind: "sample", samples: "a.qoi, `b.qoi`", check: "- export one from the QOI tool, drop it in Samples/Images" });
    const it = mk(c);
    expect(kind(it)).toEqual(["📎", "Sample"]);
    expect(card(it, null, true, NOW)).toContain("<p><b>Samples:</b> <code>a.qoi</code>, <code>b.qoi</code></p><p><b>Check:</b></p>");
  });

  it("Kind: sample and the file-name rule only with the samples feature", () => {
    const refusal = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        return (e as Fail).message;
      }
    };
    expect(refusal(() => parseCard(SAMPLE, "For Ann"))).toBe("The card's Kind: must be test, question or decision.");
    expect(refusal(() => parseCard("### For Ann\nKind: bribe", "For Ann", true))).toBe("The card's Kind: must be test, question, decision or sample.");
    expect(refusal(() => parseCard("### For Ann\nKind: sample\nCheck: x", "For Ann", true))).toBe("The card has no Samples: line (needed for Kind: sample).");
    expect(refusal(() => parseCard("### For Ann\nKind: test\nChanged: opens `Samples/a.qoi`\nCheck: x", "For Ann", true))).toBe(
      "The owner copies file names straight from the card: `Samples/a.qoi` is a path; give the file name only.",
    );
    expect(refusal(() => parseCard("### For Ann\nKind: test\nChanged: opens `a.qoi (32×32)`\nCheck: x", "For Ann", true))).toBe(
      "The owner copies file names straight from the card: only the file name goes in `a.qoi (32×32)`, the note after it outside.",
    );
    expect(parseCard("### For Ann\nKind: test\nChanged: opens `Samples/a.qoi`\nCheck: x", "For Ann").kind).toBe("test");
    expect(handover([{ id: 1, body: SAMPLE }], ["Sampler"], "For Ann", true).content.kind).toBe("sample");
    expect(handover([{ id: 1, body: SAMPLE }], ["Sampler"], "For Ann").content.kind).toBe("excerpt");
  });

  it("a test card with a release says 📦 In <version> or later under it", () => {
    const c = card(mk({ kind: "test", changed: "x", check: "y", version: "1.4.0" }), null, false, NOW);
    expect(c.endsWith("</details><p>📦 In 1.4.0 or later</p>")).toBe(true);
    expect(card(mk({ kind: "test", changed: "x", check: "y" }), null, false, NOW)).not.toContain("📦");
  });
});

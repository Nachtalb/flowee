// The docs list every guard, action and configuration field there is.
import { describe, expect, it } from "vitest";
import config from "../docs/configuration.md?raw";
import flows from "../docs/flows.md?raw";
import { ACTIONS } from "../src/core/actions";
import { GUARDS } from "../src/core/guards";
import { SCHEMA } from "../src/config/schema";

const fields = (s: Record<string, any>, p = ""): string[] =>
  s.type === "array"
    ? fields(s.items, `${p}[]`)
    : s.properties
      ? Object.entries(s.properties as Record<string, any>).flatMap(([k, v]) => [`${p}${p ? "." : ""}${k}`, ...(k === "flow" || k === "features" ? [] : fields(v, `${p}${p ? "." : ""}${k}`))])
      : [];

describe("docs", () => {
  it("docs/flows.md describes every guard and action", () => {
    for (const n of [...Object.keys(GUARDS), ...Object.keys(ACTIONS)]) expect(flows, n).toContain(`| \`${n}\` |`);
  });

  it("docs/configuration.md describes every field of the schema", () => {
    for (const f of fields(SCHEMA)) expect(config, f).toContain(`| \`${f}\` |`);
  });
});

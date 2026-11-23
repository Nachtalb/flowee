// The docs and the agent skills list every guard, action and configuration field there is; the skills' examples
// validate.
import { describe, expect, it } from "vitest";
import config from "../docs/configuration.md?raw";
import flows from "../docs/flows.md?raw";
import { ACTIONS } from "../src/core/actions";
import { GUARDS } from "../src/core/guards";
import { FEATURES_SCHEMA } from "../src/config/features";
import { INSTANCE, problems, SCHEMA } from "../src/config/schema";

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

  it("docs/configuration.md describes every feature switch and its options", () => {
    for (const [k, v] of Object.entries(FEATURES_SCHEMA.properties as Record<string, any>)) {
      expect(config, k).toContain(`| \`features.${k}\` |`);
      for (const o of Object.keys(v.oneOf[0].properties)) expect(config, `${k}.${o}`).toContain(`| \`features.${k}.${o}\` |`);
    }
  });

  it("docs/configuration.md describes every field of the schema", () => {
    for (const f of fields(SCHEMA)) expect(config, f).toContain(`| \`${f}\` |`);
  });

  const skills = import.meta.glob("../skills/**/*.md", { query: "?raw", import: "default", eager: true }) as Record<string, string>;
  const configure = Object.entries(skills)
    .filter(([p]) => p.includes("/flowee-configure/"))
    .map(([, t]) => t)
    .join("\n");

  it("the flowee-configure skill names every field of both schemas, every feature option, guard and action", () => {
    expect(configure.length).toBeGreaterThan(1000);
    for (const f of [...fields(SCHEMA), ...fields(INSTANCE)]) expect(configure, f).toContain(`\`${f}\``);
    for (const [k, v] of Object.entries(FEATURES_SCHEMA.properties as Record<string, any>))
      for (const o of Object.keys(v.oneOf[0].properties)) expect(configure, `${k}.${o}`).toContain(`\`features.${k}.${o}\``);
    for (const n of [...Object.keys(GUARDS), ...Object.keys(ACTIONS)]) expect(configure, n).toContain(`| \`${n}\` |`);
  });

  it("every complete document in the skills validates", () => {
    const docs = Object.values(skills).flatMap((t) => [...t.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]));
    const complete = docs.flatMap((d) => {
      try {
        const x = JSON.parse(d);
        return x?.flowee === 1 ? [x] : [];
      } catch {
        return [];
      }
    });
    expect(complete.length).toBeGreaterThanOrEqual(6);
    for (const d of complete) expect(problems(d), JSON.stringify(d).slice(0, 80)).toEqual([]);
  });

  it("every skill has a name and a short 'Use when' description", () => {
    for (const [p, t] of Object.entries(skills).filter(([p]) => p.endsWith("/SKILL.md"))) {
      const name = p.split("/").at(-2);
      expect(t, p).toMatch(new RegExp(`^---\\nname: ${name}\\n`));
      const d = /^description: "?(.*?)"?$/m.exec(t)?.[1] ?? "";
      expect(d.length, p).toBeLessThanOrEqual(60);
      expect(d, p).toMatch(/^Use when .+\. .+\.$/);
    }
  });
});

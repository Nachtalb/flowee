// `bun run flow <workspace.json> --merged`: the workspace's chart with its extensions merged and its switches applied,
// as XState JSON for Stately (`--options`: the merged options instead); without --merged the base chart. Exit 1 with
// one problem per line when the document does not validate, 2 when the file is no JSON.
import { readFileSync } from "node:fs";
import { FLOW, flowOf } from "../src/config/presets";
import { validate } from "../src/config/schema";
import type { WorkspaceDoc } from "../src/config/document";

export function merged(doc: WorkspaceDoc, options = false) {
  const f = flowOf(doc);
  return options ? f.options : f.chart;
}

if ((import.meta as { main?: boolean }).main) {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  if (!args.includes("--merged")) {
    console.log(JSON.stringify(args.includes("--options") ? FLOW.options : FLOW.chart, null, 2));
    process.exit(0);
  }
  if (!file) {
    console.error("usage: bun run flow <workspace.json> --merged [--options]");
    process.exit(2);
  }
  let doc: WorkspaceDoc;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    console.error(`${file}: is not JSON (${e instanceof Error ? e.message : e}).`);
    process.exit(2);
  }
  const problems = validate(doc);
  if (problems.length) {
    for (const p of problems) console.error(p);
    process.exit(1);
  }
  console.log(JSON.stringify(merged(doc, args.includes("--options")), null, 2));
}

// bun run validate <file>…: checks workspace or instance documents with the Worker's own validator.
// Prints `ok <file>: <ids>` or one problem per line; exit 0 all valid, 1 a problem, 2 usage or unreadable.
import { problems } from "../src/config/schema";

declare const Bun: { file(path: string): { text(): Promise<string> } };
declare const process: { argv: string[]; exit(code: number): never };

const files = process.argv.slice(2);
if (!files.length) {
  console.error("usage: bun run validate <workspace-or-instance.json>…");
  process.exit(2);
}
let status = 0;
for (const f of files) {
  let doc: unknown;
  try {
    doc = JSON.parse(await Bun.file(f).text());
  } catch (e) {
    console.error(`${f}: cannot read it as JSON (${(e as Error).message}).`);
    process.exit(2);
  }
  const errs = problems(doc);
  const d = doc as { id?: string; workspaces?: { id?: string }[] };
  if (errs.length) {
    status = 1;
    for (const e of errs) console.log(`${f}: ${e}`);
  } else console.log(`ok ${f}: ${(d.workspaces ?? [d]).map((w) => w.id).join(", ") || "no workspaces"}`);
}
process.exit(status);

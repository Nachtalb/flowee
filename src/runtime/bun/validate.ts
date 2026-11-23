// `flowee validate <file>…` (the executable and the image) and `bun run validate`: documents through the Worker's
// own validator, without a running instance. Exit 0 all valid, 1 a problem, 2 usage or a file that is no JSON.
import { readFileSync } from "node:fs";
import { problems } from "../../config/schema";

/** Prints `ok <file>: <ids>` per valid file, `<file>: <problem>` per problem; returns the exit status. */
export function validate(files: string[], out: (line: string) => void, err: (line: string) => void): number {
  if (!files.length) {
    err("usage: flowee validate <workspace-or-instance.json>…");
    return 2;
  }
  let status = 0;
  for (const f of files) {
    let doc: unknown;
    try {
      doc = JSON.parse(readFileSync(f, "utf8"));
    } catch (e) {
      err(`${f}: cannot read it as JSON (${(e as Error).message}).`);
      return 2;
    }
    const errs = problems(doc);
    const d = doc as { id?: string; workspaces?: { id?: string }[] };
    if (errs.length) {
      status = 1;
      for (const e of errs) out(`${f}: ${e}`);
    } else out(`ok ${f}: ${(d.workspaces ?? [d]).map((w) => w.id).join(", ") || "no workspaces"}`);
  }
  return status;
}

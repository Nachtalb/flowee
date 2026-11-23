// bun run deploy: validates the configuration, deploys the Worker and applies the bot's profile and webhook
// (GET /setup). The configuration is flowee.config.local.json when it exists (git-ignored: this deployment's own,
// uploaded as the FLOWEE_CONFIG secret with the version), else the committed flowee.config.json. The mode follows
// the document: managed when it has an `instance` section.
import { problems, webhookOnly } from "../src/config/schema";

declare const Bun: {
  file(path: string): { exists(): Promise<boolean>; text(): Promise<string> };
  spawnSync(cmd: string[], o?: { stdin?: Uint8Array | "inherit"; stdout?: "inherit"; stderr?: "inherit" }): { exitCode: number };
};
declare const process: { env: Record<string, string | undefined>; exit(code: number): never };

export const LOCAL = "flowee.config.local.json";

type Doc = { instance?: { publicUrl?: string }; chat?: { publicUrl?: string }; workspaces?: { chat?: { publicUrl?: string } }[] };

/** What a deploy of this document does, or why it cannot. */
export function plan(text: string, local: boolean): { problems: string[] } | { mode: "standalone" | "managed"; url?: string; args: string[] } {
  let doc: Doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    return { problems: [`$: is not JSON (${(e as Error).message}).`] };
  }
  const errs = [...problems(doc), ...webhookOnly(doc)];
  if (errs.length) return { problems: errs };
  const mode = doc.instance ? "managed" : "standalone";
  const url = doc.instance?.publicUrl ?? [doc, ...(doc.workspaces ?? [])].find((w) => w.chat?.publicUrl)?.chat?.publicUrl;
  // the local document travels as a secret on stdin, never as a file or an argument
  const args = ["bunx", "wrangler", "deploy", "--var", `FLOWEE_MODE:${mode}`, ...(local ? ["--secrets-file", "/dev/stdin"] : [])];
  return { mode, url, args };
}

if ((import.meta as { main?: boolean }).main) {
  if (Bun.spawnSync(["test", "-e", `${process.env.HOME}/.wrangler`]).exitCode === 0) {
    console.error("~/.wrangler exists and hides the wrangler login in ~/.config/.wrangler: move it aside, then deploy again.");
    process.exit(2);
  }
  const local = await Bun.file(LOCAL).exists();
  const file = local ? LOCAL : "flowee.config.json";
  const text = await Bun.file(file).text();
  const p = plan(text, local);
  if ("problems" in p) {
    for (const e of p.problems) console.error(`${file}: ${e}`);
    process.exit(1);
  }
  console.log(`deploying ${file} in the ${p.mode} mode`);
  const r = Bun.spawnSync(p.args, { stdin: local ? new TextEncoder().encode(JSON.stringify({ FLOWEE_CONFIG: text })) : "inherit", stdout: "inherit", stderr: "inherit" });
  if (r.exitCode) process.exit(r.exitCode);
  if (!p.url) {
    console.log("No publicUrl in the document: no bot profile or webhook to apply.");
    process.exit(0);
  }
  const res = await fetch(`${p.url}/setup`, { headers: { "user-agent": "flowee-deploy" } }).catch((e: Error) => new Response(e.message, { status: 599 }));
  console.log(`GET ${p.url}/setup: ${res.status} ${await res.text()}`);
  process.exit(res.ok ? 0 : 1);
}

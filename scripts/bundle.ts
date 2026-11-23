// bun scripts/bundle.ts: builds served/ (git-ignored), the Worker's static assets: the repository's own INSTALL.md,
// skills, docs, client, schema, flow presets, licence and logo at their repository paths, plus generated indexes, manifest.json and
// bundle.tar.gz. wrangler runs it before `dev` and `deploy` ([build] in wrangler.toml), `bun run test` before vitest.
// Refuses to build when a file looks like it holds a secret or a value of this deployment's document.
declare const Bun: {
  Glob: new (p: string) => { scanSync(o: { cwd: string; onlyFiles?: boolean }): Iterable<string> };
  file(path: string): { exists(): Promise<boolean>; text(): Promise<string>; bytes(): Promise<Uint8Array> };
  write(path: string, data: string | Uint8Array): Promise<number>;
  gzipSync(data: Uint8Array, o?: { level?: number }): Uint8Array;
  spawnSync(cmd: string[], o?: { cwd?: string }): { exitCode: number; stdout: Uint8Array };
};
declare const process: { exit(code: number): never };

/** What is served, as globs over the repository; the served path is the repository path. */
export const SOURCES = ["INSTALL.md", "skills/**/*", "docs/**/*", "client/flowee.py", "schema/*.json", "flows/*.json", "LICENSE", "assets/*.svg"];
/** The bundle's files: everything served but the logo, under `flowee/`. */
export const IN_BUNDLE = (p: string) => !p.startsWith("assets/");
export const OUT = "served";
/** Paths the Worker answers itself; a served file must never shadow them. */
const RESERVED = /^(v1|w|admin|hooks|telegram|tui|setup|validate|version|llms\.txt|index\.md|bundle\.tar\.gz|manifest\.json)(\/|$)/;

/** Secret-looking values; a served file matching one stops the build. */
export const SECRET_PATTERNS = [
  /gh[pousr]_[A-Za-z0-9]{30,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /glpat-[A-Za-z0-9_-]{20,}/,
  /\b\d{8,10}:AA[A-Za-z0-9_-]{30,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b[0-9a-f]{64}\b/,
];

const text = (b: Uint8Array) => new TextDecoder().decode(b);
const git = (...a: string[]) => {
  const r = Bun.spawnSync(["git", ...a]);
  return r.exitCode ? "" : text(r.stdout).trim();
};

/** Values of a deployment document that must never be public: chat and user ids, URLs, bot names, repositories. */
export function deploymentValues(doc: unknown): string[] {
  const out: string[] = [];
  const walk = (v: unknown, key = "") => {
    if (Array.isArray(v)) return v.forEach((x) => walk(x, key));
    if (v && typeof v === "object") return Object.entries(v).forEach(([k, x]) => walk(x, k));
    const s = String(v);
    if (["chatId", "topicId", "owner", "creators", "chat", "publicUrl", "username", "repo", "url", "api"].includes(key) && s.length >= 4 && s !== "Nachtalb/flowee")
      out.push(s);
  };
  walk(doc);
  return [...new Set(out)];
}

/** One ustar entry per file, mtime 0 and fixed owner, so the same files give the same archive. */
export function tar(files: [string, Uint8Array][]): Uint8Array {
  const parts: Uint8Array[] = [];
  const enc = new TextEncoder();
  for (const [name, data] of files) {
    const h = new Uint8Array(512);
    const put = (s: string, at: number) => h.set(enc.encode(s), at);
    if (enc.encode(name).length > 100) throw new Error(`${name}: longer than 100 bytes`);
    put(name, 0);
    put("0000644\0", 100);
    put("0000000\0", 108);
    put("0000000\0", 116);
    put(`${data.length.toString(8).padStart(11, "0")}\0`, 124);
    put("00000000000\0", 136);
    put("        ", 148);
    put("0", 156);
    put("ustar\0" + "00", 257);
    put("root", 265);
    put("root", 297);
    put(`${h.reduce((a, b) => a + b, 0).toString(8).padStart(6, "0")}\0 `, 148);
    parts.push(h, data, new Uint8Array((512 - (data.length % 512)) % 512));
  }
  parts.push(new Uint8Array(1024));
  const all = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
  let at = 0;
  for (const p of parts) all.set(p, (at += p.length) - p.length);
  return all;
}

const title = (t: string) => /^# (.+)$/m.exec(t)?.[1] ?? "";
const describe = (t: string) => /^description: "?(.*?)"?$/m.exec(t)?.[1] ?? "";

/** The generated markdown indexes of skills/ and docs/: one line per file. */
export function indexes(files: Map<string, string>): Record<string, string> {
  const list = (pre: string) => [...files.keys()].filter((p) => p.startsWith(pre) && p.endsWith(".md")).sort();
  const skills = [...new Set(list("skills/").map((p) => p.split("/")[1]))];
  const s = ["# Flowee skills", "", "Copy each directory into your agent's skills directory (or read them in place).", ""];
  for (const k of skills) {
    s.push(`- [${k}](${k}/SKILL.md): ${describe(files.get(`skills/${k}/SKILL.md`) ?? "")}`);
    for (const r of list(`skills/${k}/references/`)) s.push(`  - [${r.slice(`skills/${k}/`.length)}](${r.slice("skills/".length)}): ${title(files.get(r) ?? "")}`);
  }
  const d = ["# Flowee docs", ""];
  for (const p of list("docs/")) d.push(`- [${p.slice(5)}](${p.slice(5)}): ${title(files.get(p) ?? "")}`);
  return { "skills/index.md": `${s.join("\n")}\n`, "docs/index.md": `${d.join("\n")}\n` };
}

if ((import.meta as { main?: boolean }).main) {
  const pkg = JSON.parse(await Bun.file("package.json").text()) as { version: string };
  const paths = [...new Set(SOURCES.flatMap((g) => [...new Bun.Glob(g).scanSync({ cwd: ".", onlyFiles: true })]))].sort();
  const bytes = new Map<string, Uint8Array>();
  for (const p of paths) bytes.set(p, await Bun.file(p).bytes());
  const files = new Map([...bytes].map(([p, b]) => [p, text(b)]));
  const local = (await Bun.file("flowee.config.local.json").exists()) ? JSON.parse(await Bun.file("flowee.config.local.json").text()) : null;
  const banned = deploymentValues(local);
  const bad: string[] = [];
  for (const [p, t] of files) {
    if (RESERVED.test(p)) bad.push(`${p}: shadows a route of the Worker.`);
    for (const re of SECRET_PATTERNS) if (re.test(t)) bad.push(`${p}: matches ${re} (a secret?).`);
    for (const v of banned) if (t.includes(v)) bad.push(`${p}: contains a value of flowee.config.local.json.`);
  }
  const gen = indexes(files);
  for (const p of Object.keys(gen)) if (files.has(p)) bad.push(`${p}: is generated; rename the repository file.`);
  if (bad.length) {
    for (const b of bad) console.error(b);
    process.exit(1);
  }
  for (const [p, t] of Object.entries(gen)) bytes.set(p, new TextEncoder().encode(t));
  Bun.spawnSync(["rm", "-rf", OUT]);
  for (const [p, b] of bytes) await Bun.write(`${OUT}/${p}`, b);
  const bundled = [...bytes].filter(([p]) => IN_BUNDLE(p)).sort(([a], [b]) => (a < b ? -1 : 1));
  const gz = Bun.gzipSync(tar(bundled.map(([p, b]) => [`flowee/${p}`, b])), { level: 9 });
  await Bun.write(`${OUT}/bundle.tar.gz`, gz);
  const sha = async (b: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", b))].map((x) => x.toString(16).padStart(2, "0")).join("");
  const client = files.get("client/flowee.py") ?? "";
  const commit = git("rev-parse", "--short=12", "HEAD") + (git("status", "--porcelain") ? "-dirty" : "");
  const manifest = {
    flowee: pkg.version,
    commit: commit || "unknown",
    client: { version: /^VERSION = "([^"]+)"/m.exec(client)?.[1] ?? "", sha256: await sha(bytes.get("client/flowee.py") ?? new Uint8Array()) },
    files: [...bytes.keys(), "bundle.tar.gz"].sort(),
    bundle: bundled.map(([p]) => `flowee/${p}`),
  };
  await Bun.write(`${OUT}/manifest.json`, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`${OUT}/: ${manifest.files.length} files, bundle ${gz.length} bytes, commit ${manifest.commit}`);
}

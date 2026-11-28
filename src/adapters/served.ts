// The instance's public material, outside every Durable Object: the static assets scripts/bundle.ts builds from the
// repository (skills, docs, client, schema, presets, the bundle) with this Worker's headers, the root document for an
// agent told "use this URL to set Flowee up" (markdown; a browser gets the landing page, site/), and POST /validate.
import committed from "../../flowee.config.json";
import pkg from "../../package.json";
import { problems } from "../config/schema";
import { PRESETS } from "../config/presets";
import { TRACKER_KINDS } from "../config/trackers";
import { CHAT_KINDS } from "../config/chats";
import { hex, sha256 } from "../core/text";

export interface ServedEnv {
  ASSETS?: { fetch(req: Request | string): Promise<Response> };
  FLOWEE_MODE?: string;
  FLOWEE_CONFIG?: string;
  /** `bun` in the self-hosted runtime (src/runtime/bun), unset on Cloudflare. */
  FLOWEE_RUNTIME?: string;
  /** The self-hosted runtime's public URL (behind a reverse proxy); none: polling. */
  FLOWEE_PUBLIC_URL?: string;
}

export interface Manifest {
  flowee: string;
  commit: string;
  client: { version: string; sha256: string };
  files: string[];
  bundle: string[];
}

const MD = "text/markdown; charset=utf-8";
const TYPES: Record<string, string> = {
  md: MD,
  txt: MD,
  py: "text/plain; charset=utf-8",
  json: "application/json; charset=utf-8",
  svg: "image/svg+xml",
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  gz: "application/gzip",
};
const CACHE = "public, max-age=60, must-revalidate";
const MATERIAL = /^\/(skills|docs|client|schema|flows|assets|site)\/|^\/(INSTALL\.md|LICENSE|bundle\.tar\.gz|manifest\.json)$/;
const INDEXES: Record<string, string> = {
  "/skills": "/skills/index.md",
  "/skills/": "/skills/index.md",
  "/docs": "/docs/index.md",
  "/docs/": "/docs/index.md",
  "/docs/agents": "/docs/agents/README.md",
  "/docs/agents/": "/docs/agents/README.md",
};
/** The largest document /validate reads; the biggest inline flow is far below it. */
export const VALIDATE_MAX = 256 * 1024;
/** Validations per address and minute, counted per isolate. */
export const VALIDATE_PER_MINUTE = 30;

const headers = (type: string, extra: Record<string, string> = {}) => ({
  "content-type": type,
  "cache-control": CACHE,
  "x-content-type-options": "nosniff",
  "access-control-allow-origin": "*",
  ...extra,
});
const problem = (status: number, error: string, message: string, extra: object = {}) =>
  new Response(JSON.stringify({ ok: false, error, message, ...extra }), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

let manifestCache: Manifest | null = null;
export async function manifest(env: ServedEnv): Promise<Manifest | null> {
  if (manifestCache || !env.ASSETS) return manifestCache;
  const r = await env.ASSETS.fetch("https://assets.local/manifest.json");
  if (r.ok) manifestCache = (await r.json()) as Manifest;
  return manifestCache;
}

async function asset(req: Request, env: ServedEnv, path: string): Promise<Response> {
  if (!env.ASSETS) return problem(404, "not_found", "This build serves no material (no assets).");
  const h: Record<string, string> = {};
  const inm = req.headers.get("if-none-match");
  if (inm) h["if-none-match"] = inm;
  const r = await env.ASSETS.fetch(new Request(`https://assets.local${path}`, { headers: h }));
  if (r.status !== 200 && r.status !== 304) return problem(404, "not_found", `Nothing is served at ${path}; the list is ${new URL(req.url).origin}/manifest.json.`);
  const ext = /\.([a-z]+)$/.exec(path)?.[1] ?? "txt";
  const type = path === "/LICENSE" ? "text/plain; charset=utf-8" : (TYPES[ext] ?? "application/octet-stream");
  const extra: Record<string, string> = { etag: r.headers.get("etag") ?? "" };
  if (path === "/bundle.tar.gz") extra["content-disposition"] = 'attachment; filename="flowee.tar.gz"';
  return new Response(r.status === 304 || req.method === "HEAD" ? null : r.body, { status: r.status, headers: headers(type, extra) });
}

/** A generated text with an ETag of its content; 304 when the client has it. */
async function text(req: Request, body: string, type: string, extra: Record<string, string> = {}) {
  const etag = `"${hex(await sha256(body)).slice(0, 32)}"`;
  const h = headers(type, { etag, ...extra });
  if (req.headers.get("if-none-match")?.split(/,\s*/).includes(etag)) return new Response(null, { status: 304, headers: h });
  return new Response(req.method === "HEAD" ? null : body, { headers: h });
}

type Doc = {
  instance?: { bot?: { username?: string }; creators?: string[]; limits?: { workspacesPerUser?: number }; transport?: string };
  workspaces?: { chat?: { username?: string; transport?: string } }[];
  chat?: { username?: string; transport?: string };
};

/** This instance's facts: never a secret, an id or a chat; only what an agent needs to choose its path. */
export async function facts(env: ServedEnv, base: string) {
  const mode = env.FLOWEE_MODE === "managed" ? "managed" : "standalone";
  let doc: Doc = {};
  try {
    doc = JSON.parse(env.FLOWEE_CONFIG ?? JSON.stringify(committed)) as Doc;
  } catch {}
  const ws = doc.workspaces ?? (doc.chat ? [doc] : []);
  const bot = (mode === "managed" ? doc.instance?.bot?.username : ws.find((w) => w.chat?.username)?.chat?.username) ?? null;
  const m = await manifest(env);
  const selfHosted = env.FLOWEE_RUNTIME === "bun";
  const transport = (mode === "managed" ? doc.instance?.transport : ws.find((w) => w.chat)?.chat?.transport) ?? "webhook";
  return {
    base,
    mode,
    runtime: selfHosted ? "self-hosted" : "cloudflare",
    transport,
    publicUrl: !selfHosted || !!env.FLOWEE_PUBLIC_URL,
    version: m?.flowee ?? pkg.version,
    commit: m?.commit ?? "unknown",
    bot: bot?.replace(/^@/, "") ?? null,
    trackers: Object.values(TRACKER_KINDS).map((k) => k.name),
    chats: Object.values(CHAT_KINDS).map((k) => k.name),
    presets: Object.keys(PRESETS),
    flows: (m?.files ?? []).filter((p) => p.startsWith("flows/")),
    creators: mode === "managed" ? (doc.instance?.creators?.length ?? 0) : 0,
    perUser: doc.instance?.limits?.workspacesPerUser ?? 5,
  };
}

/** The root document: for an agent that was only told to use this URL to set Flowee up for a project. */
export function rootDoc(f: Awaited<ReturnType<typeof facts>>): string {
  const u = (p: string) => `${f.base}${p}`;
  const bot = f.bot ? `@${f.bot}` : null;
  const create =
    f.mode === "managed"
      ? `yes, for the instance owner${f.creators ? " and the users its operator listed as creators" : ""} (up to ${f.perUser} each): in a private chat with ${bot ?? "the instance bot"}, \`/setup\` starts the wizard, or send the workspace document as a \`.json\` file (or tap 📥 Import under \`/workspaces\`, then paste it). Anyone else is refused by the bot. With the operator's admin token: \`PUT ${u("/admin/workspaces/<id>")}\`.`
      : `no: this instance serves only the workspaces its operator configured. A new workspace is added to the operator's document and the instance restarted or deployed again (${u("/INSTALL.md")}, variants 2 to 4).`;
  const submit =
    f.mode === "managed"
      ? [
          `   - In the chat (the usual way): the user sends the \`.json\` file to ${bot ?? "the instance bot"} in a private chat (or taps 📥 Import under \`/workspaces\`, then pastes it). The bot lists what it will create, asks only for what is missing and then sends the project key ONCE as a file with a ready \`.flowee.toml\`.`,
          `   - Over HTTP, only when the user gave you the instance's admin token: \`PUT ${u("/admin/workspaces/<id>")}\` with the document, then \`PUT ${u("/admin/workspaces/<id>/secrets")}\` and \`POST ${u("/admin/workspaces/<id>/key")}\` (the project key, answered once; ${u("/docs/api.md")}, "Configuration API").`,
          "   - What only the user can do: create the tracker token (fine-grained, limited to the repositories, the permissions in " +
            `${u("/skills/flowee-install/references/project-setup.md")}) and paste it when the bot asks; press **🤖 Create the bot** when the workspace gets its own bot; add the bot to the group (and enable topics) when the tickets go to a group; answer the cards.`,
        ]
      : [
          `   - This instance is standalone: hand the validated document to its operator, who adds it to the instance's document, stores the secrets it names and restarts or deploys it (${u("/INSTALL.md")}).`,
          `   - What only the user can do: create the tracker token (the permissions in ${u("/skills/flowee-install/references/project-setup.md")}), create a bot with BotFather if the instance has none, add the bot to the group when the tickets go to a group, answer the cards.`,
        ];
  return [
    "# Flowee: set it up from this URL",
    "",
    "You were told to use this URL to set Flowee up for a project. This document is written for you, the agent: follow the procedure literally, in order.",
    "",
    "Flowee is a ticket flow for teams of AI agents (board, developers, testers) over an issue tracker. Agents change tickets only through its HTTP API with a small client, `flowee.py`, and the flow decides who works on what next. The human owner answers the agents' questions in a chat, where the inbox comes to them as cards.",
    "",
    "## This instance",
    "",
    `- Base URL: ${f.base}`,
    `- Version: ${f.version} (commit ${f.commit})`,
    `- Mode: ${f.mode}`,
    `- Runs on: ${f.runtime === "self-hosted" ? "a self-hosted Flowee process" : "Cloudflare Workers"}; chat updates by ${f.transport}${f.publicUrl ? "" : "; no public URL, so tracker changes are polled"}`,
    `- Chat bot: ${bot ?? "none configured"}`,
    `- Trackers: ${f.trackers.join(", ")}`,
    `- Chat backends: ${f.chats.join(", ")}`,
    `- Flow presets: ${f.presets.join(", ")}`,
    `- New workspaces by the user: ${create}`,
    "",
    "## What is served here",
    "",
    `- The installation procedure, for you to follow: ${u("/INSTALL.md")} (every way to use Flowee: this or another hosted instance through its bot, self-hosted with the published image ghcr.io/nachtalb/flowee under Docker, Podman or wslc, one executable, an own Cloudflare deployment; the one round of questions to ask; the steps before the first start)`,
    `- Skills: ${u("/skills/")} (flowee-install, flowee-configure, flowee-use)`,
    `- Docs: ${u("/docs/")}; agent role templates: ${u("/docs/agents/")}`,
    `- Client: ${u("/client/flowee.py")}; JSON Schema: ${u("/schema/workspace.schema.json")}; the flow: ${f.flows.map((p) => u(`/${p}`)).join(", ") || "none"}`,
    `- Everything above in one download: ${u("/bundle.tar.gz")} (unpacks to \`flowee/\`); the file list with hashes: ${u("/manifest.json")}`,
    `- Validation: \`POST ${u("/validate")}\` with a document; no authentication, nothing is stored`,
    "",
    "## The procedure",
    "",
    `1. Get the material: \`curl -fsSL ${u("/bundle.tar.gz")} | tar -xz\`. Copy the three directories under \`flowee/skills/\` into your skills directory (wherever your agent runner keeps skills), or read them in place. Then read ${u("/INSTALL.md")} and follow it: it is the procedure. When the user is to use THIS instance, the steps below are its variant 1 with this instance's addresses filled in; when they want an instance of their own, follow its variant 2, 3 or 4 instead (that instance then serves its own root document).`,
    "2. Ask the user these questions, ALL IN ONE MESSAGE (not one by one), each with its default, so they can answer \"defaults\" to any of them:",
    "   - Which repository or repositories (`owner/name`, GitHub or GitLab, self-hosted API URL if any)? Why: one workspace covers a project; a repository belongs to one workspace per instance. Default: this directory's `git remote get-url origin`.",
    "   - Commits straight to the main branch, or a feature branch and pull request per ticket? Why: it picks the flow preset (`trunk` or `pr-release`). Default: main branch (`trunk`).",
    "   - Versioning: are releases made, and how (tags, a version file, a tested tag)? Why: the `releases` feature. Default: no releases.",
    `   - Which optional parts: pull request checks, releases, UI review, dependency tickets, user feedback (triaged automatically or by a human first) (${u("/skills/flowee-configure/references/features.md")})? Why: each adds states and a token permission. Default: none; webhooks on. Custom states (a security review, sample files: \`builtin:samples\`) are added with extensions merged into the chart (${u("/docs/flows.md")}, "Extending the flow"; the base chart is ${u("/flows/flow.json")}).`,
    "   - Telegram, terminal, or both? Why: the owner's inbox is a Telegram chat (`chat`), the terminal interface `flowee-tui` (`tui`: no messenger needed, people sign in with a personal key), or both showing the same cards. Default: Telegram.",
    "   - With Telegram: where should the tickets appear: a private chat with the bot, a group, or a topic in a group? Why: `chat` and who sees the cards. Default: a private chat with the owner. With the terminal: who signs in (each person runs `flowee-tui --new-key` and gives you the digest it prints)? Default: the owner alone.",
    `   - The instance's bot (${bot ?? "none here"}) or the workspace's own bot? Why: an own bot carries the project's name and photo. Default: the instance's bot.`,
    "   - Who is the owner (tracker login, chat user id)? Why: only the owner's answers count. Default: the user you are talking to.",
    "   - The project's checks before every commit (typecheck, lint, tests)? Why: `flowee.py commit` refuses without green gates. Default: the project's own typecheck and test commands.",
    "   - Where on this machine do the agents' clones and the project key live? Why: one clone per agent, the key outside the repository. Default: clones next to this one as `<project>-<agent>`, the key in `~/.secrets/flowee/<workspace>/key` (mode 600).",
    `   - Who starts the agents' runs and how often (cron, a CI schedule, an agent runner's jobs)? Why: agents are scheduled runs, not processes (${u("/docs/agents/README.md")}). Default: every 5 minutes with the cheap pre-check, staggered, the board more often.`,
    `3. Write the workspace document following ${u("/skills/flowee-configure/SKILL.md")}. Validate it here: \`curl -fsS -H 'content-type: application/json' --data @workspace.json ${u("/validate")}\` must answer \`{"ok": true, ...}\`; otherwise fix every line of \`problems\` and validate again. Show the document to the user before submitting it.`,
    "4. Submit it:",
    ...submit,
    `5. The project side (${u("/skills/flowee-install/references/project-setup.md")}): \`curl -fsSL ${u("/client/flowee.py")} -o scripts/flowee.py\`; write \`.flowee.toml\` (url \`${f.base}\`, the workspace id, \`key_file\`, the gates); store the project key from the bot's key file with mode 600 as that file says, then delete the file; copy \`flowee/docs/agents/\` into the project as the agents' instructions and fill in the placeholders; make one clone per agent; set up the scheduled runs as \`docs/agents/README.md\` says.`,
    `6. The agents: read the roles this workspace's flow offers with \`python3 scripts/flowee.py roles\` (what each does, the states it claims, whether several make sense; an extension's roles included), then create the agents you run, one per clone: \`python3 scripts/flowee.py agents add <role> <name>\` (e.g. \`agents add developer dev1\`). It is idempotent: put the same line at the start of each agent's scheduled run (${u("/docs/agents/README.md")}, "Creating the agents"). \`python3 scripts/flowee.py agents\` lists them.`,
    "7. Verify, and report what the commands printed:",
    `   - \`python3 scripts/flowee.py version\` prints the client's and this server's version (${f.version}) and no update hint.`,
    "   - In each clone: `FLOWEE_AS=<agent> python3 scripts/flowee.py whoami` prints `{\"instance\": \"<agent>\", \"role\": \"<role>\"}`; `queue` prints `{\"role\": ..., \"queue\": [...], \"claim\": null}`.",
    "   - The owner sends `/start` to the bot: the bar (`✨ Inbox empty`) or the first card appears.",
    `   - More checks: ${u("/skills/flowee-install/references/verify.md")}.`,
    "8. Never: print, log or echo a secret (the project key included); commit a secret or put one in the workspace document (it names secrets, it never holds them); push test commits to a real remote or let a test reach a real tracker or chat; give the service a broad personal token when a fine-grained one limited to the repositories works; message the user's chat yourself to test it.",
    "",
  ].join("\n");
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

let pageCache: string | null = null;
/** The landing page for a browser: site/index.html with this instance's facts; null when the build serves none. */
async function landing(env: ServedEnv, f: Awaited<ReturnType<typeof facts>>): Promise<string | null> {
  if (!pageCache && env.ASSETS) {
    const r = await env.ASSETS.fetch("https://assets.local/site/index.html");
    if (r.ok) pageCache = await r.text();
  }
  return pageCache && fill(pageCache, f);
}

/** `<!--if k-->…<!--end k-->` kept when k holds, `{{k}}` replaced by the escaped fact. */
function fill(page: string, f: Awaited<ReturnType<typeof facts>>): string {
  const on: Record<string, boolean> = { bot: !!f.bot, nobot: !f.bot, managed: f.mode === "managed", standalone: f.mode !== "managed" };
  const v: Record<string, string> = {
    base: f.base,
    version: f.version,
    commit: f.commit,
    mode: f.mode,
    runtime: f.runtime === "self-hosted" ? "a self-hosted Flowee process" : "Cloudflare Workers",
    bot: f.bot ?? "",
    trackers: f.trackers.join(", "),
    chats: f.chats.join(", "),
    agentClass: f.bot ? "secondary" : "primary",
  };
  let out = page;
  // innermost first, so blocks nest
  for (let prev = ""; prev !== out; ) (prev = out), (out = out.replace(/<!--if (\w+)-->((?:(?!<!--if )[\s\S])*?)<!--end \1-->/g, (_, k: string, s: string) => (on[k] ? s : "")));
  return out.replace(/\{\{(\w+)\}\}/g, (_, k: string) => esc(v[k] ?? ""));
}

const hits = new Map<string, { n: number; at: number }>();
function limited(who: string, now = Date.now()) {
  if (hits.size > 10_000) hits.clear();
  const h = hits.get(who);
  if (!h || now - h.at >= 60_000) {
    hits.set(who, { n: 1, at: now });
    return false;
  }
  return ++h.n > VALIDATE_PER_MINUTE;
}

async function validateRoute(req: Request): Promise<Response> {
  if (req.method !== "POST") return problem(405, "method_not_allowed", "POST a workspace or instance document (JSON) to /validate.");
  if (limited(req.headers.get("cf-connecting-ip") ?? "local")) return problem(429, "rate_limited", `At most ${VALIDATE_PER_MINUTE} validations a minute per address; try again in a minute.`);
  const len = Number(req.headers.get("content-length") ?? 0);
  if (len > VALIDATE_MAX) return problem(413, "too_large", `The document is larger than ${VALIDATE_MAX} bytes.`);
  const raw = await req.arrayBuffer();
  if (raw.byteLength > VALIDATE_MAX) return problem(413, "too_large", `The document is larger than ${VALIDATE_MAX} bytes.`);
  let doc: unknown;
  try {
    doc = JSON.parse(new TextDecoder().decode(raw));
  } catch (e) {
    return problem(400, "bad_config", "The document is not JSON.", { problems: [`$: is not JSON (${(e as Error).message}).`] });
  }
  const errs = problems(doc);
  if (errs.length) return problem(400, "bad_config", `The document has ${errs.length} problem${errs.length > 1 ? "s" : ""}.`, { problems: errs });
  const d = doc as { id?: string; workspaces?: { id?: string }[] };
  const kind = Array.isArray(d.workspaces) ? "instance" : "workspace";
  return new Response(JSON.stringify({ ok: true, kind, ids: (d.workspaces ?? [d]).map((w) => w.id) }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

/** The public material's routes, or null for every other path. */
export async function served(req: Request, env: ServedEnv): Promise<Response | null> {
  const url = new URL(req.url);
  const p = url.pathname;
  if (p === "/validate") return validateRoute(req);
  const root = p === "/" || p === "/llms.txt" || p === "/index.md";
  if (!root && p !== "/version" && !INDEXES[p] && !MATERIAL.test(p)) return null;
  if (req.method !== "GET" && req.method !== "HEAD") return problem(405, "method_not_allowed", `${p} is read-only: use GET.`);
  if (p === "/skills" || p === "/docs" || p === "/docs/agents") return new Response(null, { status: 301, headers: { location: `${p}/` } });
  if (INDEXES[p]) return asset(req, env, INDEXES[p]);
  if (p === "/version") {
    const m = await manifest(env);
    return new Response(JSON.stringify({ ok: true, flowee: m?.flowee ?? pkg.version, commit: m?.commit ?? "unknown", client: m?.client ?? null }), {
      headers: { "content-type": "application/json", "cache-control": "no-cache" },
    });
  }
  if (!root) return asset(req, env, p.replace(/\/+/g, "/"));
  const f = await facts(env, url.origin);
  const page = p === "/" && /text\/html/.test(req.headers.get("accept") ?? "") ? await landing(env, f) : null;
  return page ? text(req, page, "text/html; charset=utf-8", { vary: "accept" }) : text(req, rootDoc(f), MD, p === "/" ? { vary: "accept" } : {});
}

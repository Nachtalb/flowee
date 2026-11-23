// The JSON Schema of a workspace document (committed as schema/workspace.schema.json by `bun run schema`) and a
// validator of the schema subset it uses. Every problem is one sentence starting with its JSON path.
import { loadFlow } from "../core/chart";
import { ACTIONS } from "../core/actions";
import { GUARDS } from "../core/guards";
import type { InstanceDoc, WorkspaceDoc } from "./document";
import { FEATURES_SCHEMA, featureProblems } from "./features";
import { flowOf, PRESETS, rawFlow } from "./presets";
import { TRACKER_KINDS, TRACKER_TYPES, type TrackerKind } from "./trackers";

type S = Record<string, unknown>;
const str = (description: string, extra: S = {}): S => ({ type: "string", minLength: 1, description, ...extra });
const secret = (what: string) => str(`Name of the secret holding ${what} (never the value).`, { pattern: "^[A-Z][A-Z0-9_]*$" });
const obj = (properties: S, required: string[], description: string): S => ({ type: "object", description, additionalProperties: false, required, properties });

const TEXTS = {
  owner: str("The owner's name: comment signature (`Owner:`) and filing note.", { default: "Owner" }),
  cardHeading: str("Heading of the owner card in a comment (`### For the owner`).", { default: "For the owner" }),
  botName: str("The bot's display name.", { default: "Flowee Envoy" }),
  project: str("The project's name in the welcome and profile texts.", { default: "the workspace id" }),
  welcome: str("The welcome message (Telegram HTML)."),
  about: str("The bot description."),
  shortAbout: str("The bot short description."),
  filedBody: str("First line of a ticket the owner files from the chat."),
  untitled: str("Title of a ticket filed with an empty first line."),
};

const REPO = str("The repository's path: owner/name (GitLab: group/subgroup/project).", { pattern: "^[\\w.-]+(?:/[\\w.-]+)+$" });
const KIND = (description: string, d?: string): S => ({ enum: TRACKER_TYPES, ...(d ? { default: d } : {}), description });
export const ALIAS = "^[a-z0-9][a-z0-9-]{0,31}$";

export const SCHEMA: S = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://github.com/Nachtalb/flowee/schema/workspace.schema.json",
  title: "Flowee workspace",
  ...obj(
    {
      flowee: { const: 1, description: "Schema version of this document." },
      id: str("Workspace id: lowercase letters, digits and dashes; part of the API URL /w/<id>/v1/.", { pattern: "^[a-z0-9][a-z0-9-]{0,62}$" }),
      name: str("Display name."),
      flow: {
        description: "A preset by name, or an inline XState statechart with its options.",
        oneOf: [
          obj({ preset: { enum: Object.keys(PRESETS), description: "A preset in flows/." } }, ["preset"], "A flow preset."),
          obj(
            {
              chart: { type: "object", description: "XState v5 statechart JSON (see docs/flows.md)." },
              options: { type: "object", description: "Flow options (see docs/flows.md)." },
            },
            ["chart", "options"],
            "An inline flow.",
          ),
        ],
      },
      features: FEATURES_SCHEMA,
      tracker: obj(
        {
          type: KIND("The tracker of every repository that names none.", "github"),
          repos: {
            type: "array",
            minItems: 1,
            description: "The repositories; with several, a ticket is alias#n.",
            items: {
              description: "A repository path, or an object with an alias, its own token, branch or tracker.",
              oneOf: [
                REPO,
                obj(
                  {
                    repo: REPO,
                    alias: str("Short name in ticket references (alias#n); default: the repository's name, lowercased.", { pattern: ALIAS }),
                    token: secret("this repository's tracker token (default: tracker.token)"),
                    mainBranch: str("This repository's branch commits land on (default: tracker.mainBranch)."),
                    type: KIND("This repository's tracker (default: tracker.type); another than tracker.type needs its own token."),
                    api: str("This repository's tracker API base URL (default: tracker.api for tracker.type, else the type's public API).", { pattern: "^https?://" }),
                  },
                  ["repo"],
                  "A repository with options.",
                ),
              ],
            },
          },
          mainBranch: str("The branch commits land on.", { default: "main" }),
          api: str("The API base URL of tracker.type (GitHub Enterprise, self-managed GitLab, a local stand-in).", { pattern: "^https?://" }),
          token: secret("the tracker token"),
          project: obj(
            { owner: str("User login owning the project."), number: { type: "integer", minimum: 1, description: "Project number." } },
            ["owner", "number"],
            "A GitHub Projects (v2) board whose Status follows the state.",
          ),
        },
        ["repos", "token"],
        "The issue tracker that keeps the record.",
      ),
      roles: {
        type: "array",
        minItems: 1,
        description: "The agents (and the owner) that call the API, one secret each.",
        items: obj(
          {
            instance: str("Instance name (claims belong to it), e.g. dev1.", { pattern: "^[a-z0-9][a-z0-9-]*$" }),
            role: str("A role of the flow."),
            secret: secret("the SHA-256 hex of this instance's API secret"),
          },
          ["instance", "role", "secret"],
          "One role instance.",
        ),
      },
      owners: {
        type: "array",
        minItems: 1,
        description: "The humans in the loop.",
        items: obj(
          { name: str("Name."), tracker: str("Tracker login (assigned in the inbox state)."), chat: str("Chat user id.", { pattern: "^-?\\d+$" }) },
          [],
          "One owner.",
        ),
      },
      chat: obj(
        {
          type: { enum: ["telegram"], description: "The chat adapter." },
          token: secret("the bot token"),
          webhookSecret: secret("the webhook's secret token"),
          username: str("The bot's username (for /cmd@bot)."),
          chatId: str("The bound chat.", { pattern: "^-?\\d+$" }),
          topicId: { type: "integer", minimum: 1, description: "A forum topic in the chat." },
          publicUrl: str("The instance's public base URL (webhook and profile are set from it).", { pattern: "^https://" }),
          managed: { type: "boolean", description: "The workspace's own bot, created and managed through the instance's bot (managed mode)." },
        },
        ["type", "token", "webhookSecret", "chatId"],
        "The owner's chat (the envoy).",
      ),
      files: obj(
        { url: str("Upload endpoint (rustypaste compatible).", { pattern: "^https?://" }), token: secret("the upload token"), expire: str("Expiry header value.", { default: "90d" }) },
        ["url", "token"],
        "Where files the owner sends are stored.",
      ),
      texts: obj(TEXTS, [], "Texts the envoy and the flow show."),
      schedule: obj(
        {
          timezone: str("IANA time zone of the digest and 'answered today'.", { default: "UTC" }),
          digestFrom: { type: "integer", minimum: 0, maximum: 23, default: 9, description: "First hour of the morning digest." },
          digestTo: { type: "integer", minimum: 1, maximum: 24, default: 12, description: "The digest is sent before this hour." },
        },
        [],
        "Times.",
      ),
      profile: obj({ photo: str("URL of the bot's profile photo (PNG).", { pattern: "^https://" }) }, [], "The bot's profile."),
    },
    ["flowee", "id", "flow", "tracker", "roles", "owners"],
    "A Flowee workspace: one flow over a repository, its roles, owners and chat.",
  ),
};

export const INSTANCE: S = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://github.com/Nachtalb/flowee/schema/instance.schema.json",
  title: "Flowee instance",
  ...obj(
    {
      flowee: { const: 1, description: "Schema version of this document." },
      workspaces: { type: "array", description: "The workspaces (see workspace.schema.json).", items: { type: "object" } },
      instance: obj(
        {
          bot: obj(
            { token: secret("the instance bot's token"), webhookSecret: secret("the instance bot's webhook secret"), username: str("The bot's username.") },
            ["token", "webhookSecret"],
            "The instance's bot.",
          ),
          publicUrl: str("The Worker's public base URL.", { pattern: "^https://" }),
          owner: str("The instance owner's chat user id.", { pattern: "^\\d+$" }),
          creators: { type: "array", description: "Chat user ids that may create workspaces (default: the owner).", items: str("Chat user id.", { pattern: "^\\d+$" }) },
          limits: obj({ workspacesPerUser: { type: "integer", minimum: 1, default: 5, description: "Workspaces one user may own." } }, [], "Limits."),
          profile: obj(
            {
              name: str("The bot's name.", { default: "Flowee" }),
              description: str("The bot's description."),
              shortDescription: str("The bot's short description."),
              photo: str("URL of a PNG profile photo (default: the bundled one).", { pattern: "^https://" }),
            },
            [],
            "The instance bot's profile.",
          ),
          trackerApi: str("Tracker API base URL for new workspaces.", { pattern: "^https?://" }),
        },
        ["bot", "publicUrl", "owner"],
        "The instance itself (managed mode).",
      ),
    },
    ["flowee", "workspaces"],
    "A Flowee instance: its workspaces and, for the managed mode, the instance's bot and owner.",
  ),
};

const kind = (v: unknown) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);

/** Problems of `v` against the schema subset (type, const, enum, pattern, ranges, items, properties, oneOf). */
export function check(schema: S, v: unknown, path = "$"): string[] {
  if ("const" in schema && v !== schema.const) return [`${path}: must be ${JSON.stringify(schema.const)}.`];
  if (schema.enum && !(schema.enum as unknown[]).includes(v)) return [`${path}: must be one of ${(schema.enum as unknown[]).map((x) => JSON.stringify(x)).join(", ")}.`];
  if (schema.oneOf) {
    const runs = (schema.oneOf as S[]).map((s) => check(s, v, path));
    const ok = runs.filter((r) => !r.length).length;
    if (ok === 1) return [];
    if (ok > 1) return [`${path}: matches more than one form.`];
    // the closest form: one of the value's own type first, then the fewest problems
    const off = (i: number) => {
      const t = (schema.oneOf as S[])[i].type;
      return Number(!!t && t !== kind(v) && !(t === "number" && kind(v) === "integer"));
    };
    return runs.map((r, i) => ({ r, o: off(i) })).sort((a, b) => a.o - b.o || a.r.length - b.r.length)[0].r;
  }
  const t = schema.type as string | undefined;
  const k = kind(v);
  if (t && !(k === t || (t === "number" && k === "integer"))) return [`${path}: must be ${t === "integer" ? "an integer" : t === "array" || t === "object" ? `an ${t}` : `a ${t}`}.`];
  const out: string[] = [];
  if (t === "string") {
    const s = v as string;
    if (schema.minLength && s.length < (schema.minLength as number)) out.push(`${path}: must not be empty.`);
    else if (schema.pattern && !new RegExp(schema.pattern as string).test(s)) out.push(`${path}: must match ${schema.pattern}.`);
  }
  if (t === "integer" || t === "number") {
    if (schema.minimum !== undefined && (v as number) < (schema.minimum as number)) out.push(`${path}: must be at least ${schema.minimum}.`);
    if (schema.maximum !== undefined && (v as number) > (schema.maximum as number)) out.push(`${path}: must be at most ${schema.maximum}.`);
  }
  if (t === "array") {
    const a = v as unknown[];
    if (schema.minItems && a.length < (schema.minItems as number)) out.push(`${path}: must have at least ${schema.minItems} item(s).`);
    if (schema.maxItems && a.length > (schema.maxItems as number)) out.push(`${path}: must have at most ${schema.maxItems} item(s).`);
    a.forEach((x, i) => out.push(...check(schema.items as S, x, `${path}[${i}]`)));
  }
  if (t === "object") {
    const o = v as Record<string, unknown>;
    const props = (schema.properties ?? {}) as Record<string, S>;
    for (const r of (schema.required as string[]) ?? []) if (!(r in o)) out.push(`${path}.${r}: is required.`);
    for (const [key, val] of Object.entries(o)) {
      if (props[key]) out.push(...check(props[key], val, `${path}.${key}`));
      else if (schema.additionalProperties === false) out.push(`${path}.${key}: is not a known field.`);
      else if (typeof schema.additionalProperties === "object") out.push(...check(schema.additionalProperties as S, val, `${path}.${key}`));
    }
  }
  return out;
}

/** Every problem of a workspace document, schema first, then the cross-field rules. Empty when valid. */
export function validate(doc: unknown): string[] {
  const errs = check(SCHEMA, doc);
  if (errs.length) return errs;
  const d = doc as WorkspaceDoc;
  const flow = flowOf(d);
  try {
    loadFlow(flow.chart, flow.options, Object.keys(GUARDS), Object.keys(ACTIONS));
  } catch (e) {
    return [`$.flow: ${(e as Error).message}`];
  }
  errs.push(...featureProblems(d, rawFlow(d)));
  const repos = repoList(d);
  repos.forEach((r, i) => {
    const k = TRACKER_KINDS[r.type];
    if (!k.repo.test(r.repo)) errs.push(`$.tracker.repos[${i}]: '${r.repo}' is no ${k.name} repository (${k.repoForm}).`);
    if (r.type !== trackerType(d) && !(typeof d.tracker.repos[i] === "object" && (d.tracker.repos[i] as { token?: string }).token))
      errs.push(`$.tracker.repos[${i}].token: a repository on ${k.name} while tracker.type is '${trackerType(d)}' needs its own token.`);
    if (!new RegExp(ALIAS).test(r.alias)) errs.push(`$.tracker.repos[${i}]: the alias '${r.alias}' made from the name is not usable; give an alias.`);
    if (repos.findIndex((x) => x.alias === r.alias) < i) errs.push(`$.tracker.repos[${i}].alias: '${r.alias}' is used twice.`);
    if (repos.findIndex((x) => x.key.toLowerCase() === r.key.toLowerCase()) < i) errs.push(`$.tracker.repos[${i}]: '${r.repo}' is listed twice.`);
  });
  if (d.tracker.project && !repos.some((r) => r.type === "github")) errs.push("$.tracker.project: a GitHub project board needs at least one GitHub repository.");
  const roles = Object.keys(flow.options.roles);
  const seen = new Set<string>();
  d.roles.forEach((r, i) => {
    if (!roles.includes(r.role)) errs.push(`$.roles[${i}].role: '${r.role}' is no role of the flow (${roles.join(", ")}).`);
    if (seen.has(r.instance)) errs.push(`$.roles[${i}].instance: '${r.instance}' is used twice.`);
    seen.add(r.instance);
  });
  if (!d.roles.some((r) => r.role === flow.options.ownerRole))
    errs.push(`$.roles: no instance has the owner role '${flow.options.ownerRole}', so the owner cannot answer through the API.`);
  if (d.chat && !d.owners.some((o) => o.chat)) errs.push("$.owners: with a chat, at least one owner needs a chat user id.");
  if (d.files && !d.chat) errs.push("$.files: files come from the chat, so they need $.chat.");
  if (d.profile && !d.chat?.publicUrl) errs.push("$.profile: the profile is set with the webhook, so it needs $.chat.publicUrl.");
  const sc = d.schedule;
  if (sc && (sc.digestFrom ?? 9) >= (sc.digestTo ?? 12)) errs.push("$.schedule: digestFrom must be before digestTo.");
  if (sc?.timezone) {
    try {
      new Intl.DateTimeFormat("en", { timeZone: sc.timezone });
    } catch {
      errs.push(`$.schedule.timezone: '${sc.timezone}' is no IANA time zone.`);
    }
  }
  return errs;
}

/** A repository already in another workspace (claims and tickets would clash): one sentence per repository. */
export function repoClashes(others: WorkspaceDoc[], doc: WorkspaceDoc): string[] {
  const owner = new Map(others.filter((w) => w.id !== doc.id).flatMap((w) => repoList(w).map((r) => [r.key.toLowerCase(), w.id] as const)));
  return repoList(doc).flatMap((r, j) => {
    const w = owner.get(r.key.toLowerCase());
    return w ? [`$.tracker.repos[${j}]: '${r.repo}' is already in workspace '${w}'; a repository belongs to one workspace only.`] : [];
  });
}

/** Every problem of an instance document (all workspaces); ids, chat bindings and repositories must be unique. */
export function validateInstance(doc: unknown): string[] {
  const d = doc as InstanceDoc;
  if (kind(d) !== "object" || d.flowee !== 1 || !Array.isArray(d.workspaces)) return ["$: must be {\"flowee\": 1, \"workspaces\": [...]}."];
  const top = check(INSTANCE, d);
  if (top.length) return top;
  const errs = d.workspaces.flatMap((w, i) => validate(w).map((e) => e.replace(/^\$/, `$.workspaces[${i}]`)));
  const ids = new Set<string>();
  const chats = new Set<string>();
  d.workspaces.forEach((w, i) => {
    if (ids.has(w.id)) errs.push(`$.workspaces[${i}].id: '${w.id}' is used twice.`);
    ids.add(w.id);
    const c = w.chat && `${w.chat.chatId}/${w.chat.topicId ?? ""}`;
    if (c && chats.has(c)) errs.push(`$.workspaces[${i}].chat: another workspace is bound to the same chat and topic.`);
    if (c) chats.add(c);
  });
  if (errs.length) return errs;
  d.workspaces.forEach((w, i) => errs.push(...repoClashes(d.workspaces.slice(0, i), w).map((e) => e.replace(/^\$/, `$.workspaces[${i}]`))));
  return errs;
}

const host = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export const trackerType = (d: WorkspaceDoc): TrackerKind => d.tracker.type ?? "github";

/**
 * The repositories of a document with their alias, token, branch and tracker resolved. `key` names a repository
 * across trackers: its path on GitHub (as it always was: ticket slots are stored by it), `<type>:<host>/<path>`
 * on any other tracker.
 */
export function repoList(d: WorkspaceDoc) {
  return d.tracker.repos.map((x) => {
    const r = typeof x === "string" ? { repo: x } : x;
    const type = r.type ?? trackerType(d);
    const api = r.api ?? (type === trackerType(d) ? d.tracker.api : undefined) ?? TRACKER_KINDS[type].api;
    return {
      repo: r.repo,
      alias: r.alias ?? (r.repo.split("/").at(-1) ?? "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+/, "").slice(0, 32),
      token: r.token ?? d.tracker.token,
      branch: r.mainBranch ?? d.tracker.mainBranch ?? "main",
      type,
      api,
      key: type === "github" ? r.repo : `${type}:${host(api)}/${r.repo}`,
    };
  });
}

/** Secret names a document references. */
export function secretNames(d: WorkspaceDoc): string[] {
  return [...new Set([d.tracker.token, ...repoList(d).map((r) => r.token), ...d.roles.map((r) => r.secret), ...(d.chat ? [d.chat.token, d.chat.webhookSecret] : []), ...(d.files ? [d.files.token] : [])])];
}

/** Problems of a workspace document or of an instance document (`{"flowee": 1, "workspaces": [...]}`). */
export function problems(doc: unknown): string[] {
  return kind(doc) === "object" && "workspaces" in (doc as object) ? validateInstance(doc) : validate(doc);
}

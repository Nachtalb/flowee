// The instance: its mode and its workspaces. Standalone serves exactly the workspaces configured at deploy, with
// one bot; nothing creates, changes or deletes a workspace at run time. Managed keeps them in the Instance
// Durable Object (instance-durable-object.ts), made in the chat or imported, each with its own or the shared bot.
import committed from "../../flowee.config.json";
import { Fail } from "../core/errors";
import { StaticRegistry, type WorkspaceRegistry } from "../config/registry";
import { validateInstance } from "../config/schema";
import type { InstanceDoc } from "../config/document";
import type { Instance } from "./instance-durable-object";
import type { Workspace } from "./store-durable-object";
import { envSecrets } from "./store-durable-object";

export interface Env {
  WORKSPACE: DurableObjectNamespace<Workspace>;
  INSTANCE: DurableObjectNamespace<Instance>;
  /** Managed mode: the key that seals secrets entered in the chat. */
  FLOWEE_KEY?: string;
  /** Managed mode: the bearer token of the /admin configuration API. */
  FLOWEE_ADMIN_TOKEN?: string;
  VERSION?: { id: string };
  /** `standalone` (default) or `managed`. */
  FLOWEE_MODE?: string;
  /** The instance's configuration document (JSON); else flowee.config.json next to wrangler.toml. */
  FLOWEE_CONFIG?: string;
  /** The static assets scripts/bundle.ts builds (served/): skills, docs, client, schema, presets, the bundle. */
  ASSETS?: Fetcher;
}

const cache = new Map<string, WorkspaceRegistry>();

export function mode(env: Env): "standalone" | "managed" {
  const m = env.FLOWEE_MODE ?? "standalone";
  if (m !== "standalone" && m !== "managed") throw new Fail(501, "unsupported", `FLOWEE_MODE '${m}' is not available; use standalone or managed.`);
  return m;
}

/** The managed instance's configuration document (validated once per configuration). */
export function instanceDoc(env: Env): InstanceDoc {
  const text = env.FLOWEE_CONFIG ?? JSON.stringify(committed);
  let d = docs.get(text);
  if (!d) {
    try {
      d = JSON.parse(text) as InstanceDoc;
    } catch {
      throw new Fail(500, "bad_config", "FLOWEE_CONFIG is not JSON.");
    }
    const errs = validateInstance(d);
    if (errs.length) throw new Fail(500, "bad_config", errs.join(" "));
    if (!d.instance) throw new Fail(500, "bad_config", "$.instance: is required in the managed mode.");
    if (!env.FLOWEE_KEY) throw new Fail(500, "bad_config", "The managed mode needs the secret FLOWEE_KEY.");
    docs.set(text, d);
  }
  return d;
}
const docs = new Map<string, InstanceDoc>();

/** The registry of the configured workspaces (parsed once per configuration). Throws on an invalid configuration. */
export function registry(env: Env): WorkspaceRegistry {
  if (mode(env) !== "standalone") throw new Fail(501, "unsupported", "The managed mode keeps its workspaces in the Instance object.");
  const text = env.FLOWEE_CONFIG ?? JSON.stringify(committed);
  let r = cache.get(text);
  if (!r) {
    let doc: unknown;
    try {
      doc = JSON.parse(text);
    } catch {
      throw new Fail(500, "bad_config", "FLOWEE_CONFIG is not JSON.");
    }
    r = new StaticRegistry(envSecrets(env), doc);
    const bots = new Set(r.list().flatMap((w) => (w.chat ? [`${w.chat.token}/${w.chat.webhookSecret}`] : [])));
    if (bots.size > 1) throw new Fail(500, "bad_config", "A standalone instance runs one bot: every workspace's chat must name the same token and webhookSecret.");
    cache.set(text, r);
  }
  return r;
}

/** The one bot's secrets (token name, webhook secret name), when any workspace has a chat. */
export function bot(env: Env) {
  const c = registry(env)
    .list()
    .find((w) => w.chat)?.chat;
  return c && { token: c.token, webhookSecret: c.webhookSecret };
}

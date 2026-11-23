// The instance: its mode and its workspaces. Standalone (the only mode of this version) serves exactly the
// workspaces configured at deploy, with one bot; nothing creates, changes or deletes a workspace at run time.
import committed from "../../flowee.config.json";
import { Fail } from "../core/errors";
import { StaticRegistry, type WorkspaceRegistry } from "../config/registry";
import type { Workspace } from "./store-durable-object";
import { envSecrets } from "./store-durable-object";

export interface Env {
  WORKSPACE: DurableObjectNamespace<Workspace>;
  VERSION?: { id: string };
  /** `standalone` (default) or `managed` (later versions). */
  FLOWEE_MODE?: string;
  /** The instance's configuration document (JSON); else flowee.config.json next to wrangler.toml. */
  FLOWEE_CONFIG?: string;
}

const cache = new Map<string, WorkspaceRegistry>();

export function mode(env: Env): "standalone" {
  const m = env.FLOWEE_MODE ?? "standalone";
  if (m !== "standalone") throw new Fail(501, "unsupported", `FLOWEE_MODE '${m}' is not available in this version; use standalone.`);
  return m;
}

/** The registry of the configured workspaces (parsed once per configuration). Throws on an invalid configuration. */
export function registry(env: Env): WorkspaceRegistry {
  mode(env);
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

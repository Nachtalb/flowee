// The bun runtime's configuration: the same documents as the Worker (standalone, or managed with the wizard) from a
// file or a variable, every other setting and secret from the environment, `NAME_FILE` for a secret in a file
// (Docker secrets), and FLOWEE_KEY kept in the data directory when not given.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import pkg from "../../../package.json";
import type { Env } from "../../adapters/instance";
import { randomSecret } from "../../adapters/vault";
import { problems } from "../../config/schema";
import { hex, sha256 } from "../../core/text";

export interface Options {
  /** The data directory: one SQLite file per workspace, the instance's, flowee.sqlite (lock, alarms, offsets), flowee.key. */
  data: string;
  port: number;
  host: string;
  /** The public base URL a reverse proxy gives this process; none: Telegram by polling, trackers polled. */
  publicUrl?: string;
  assets?: string;
  debug: boolean;
  telegramApi?: string;
}

type Chat = { publicUrl?: string; transport?: string };
type Doc = { chat?: Chat; workspaces?: { chat?: Chat }[]; instance?: { publicUrl?: string; transport?: string } };

/** The variables with every `NAME_FILE` read into `NAME` (a value given directly wins). */
export function readEnv(raw: Record<string, string | undefined>): { vars: Record<string, string>; problems: string[] } {
  const vars: Record<string, string> = {};
  const errs: string[] = [];
  for (const [k, v] of Object.entries(raw)) if (v !== undefined) vars[k] = v;
  for (const [k, v] of Object.entries(vars)) {
    if (!k.endsWith("_FILE") || k.length <= 5 || vars[k.slice(0, -5)]) continue;
    try {
      vars[k.slice(0, -5)] = readFileSync(v, "utf8").replace(/\r?\n$/, "");
    } catch {
      errs.push(`${k}: cannot read ${v}.`);
    }
  }
  return { vars, problems: errs };
}

/**
 * The document as this runtime serves it: a public URL from FLOWEE_PUBLIC_URL fills the chats that name none (an
 * https one only: Telegram needs it for a webhook); a chat without `transport` polls when it has no public URL.
 */
export function normalise(doc: Doc, publicUrl?: string): Doc {
  const https = publicUrl?.startsWith("https://") ? publicUrl : undefined;
  const fill = (c?: Chat) => {
    if (!c) return;
    if (https && !c.publicUrl) c.publicUrl = https;
    c.transport ??= c.publicUrl ? "webhook" : "polling";
  };
  fill(doc.chat);
  for (const w of doc.workspaces ?? []) fill(w.chat);
  if (doc.instance && https && !doc.instance.publicUrl) doc.instance.publicUrl = https;
  return doc;
}

export interface Loaded {
  env: Env & Record<string, string | object | undefined>;
  options: Options;
  problems: string[];
  notes: string[];
}

export async function load(raw: Record<string, string | undefined>, cwd = "."): Promise<Loaded> {
  const { vars, problems: errs } = readEnv(raw);
  const notes: string[] = [];
  const options: Options = {
    data: resolve(cwd, vars.FLOWEE_DATA ?? "data"),
    port: Number(vars.FLOWEE_PORT ?? vars.PORT ?? 8787),
    host: vars.FLOWEE_HOST ?? "0.0.0.0",
    publicUrl: vars.FLOWEE_PUBLIC_URL?.replace(/\/+$/, "") || undefined,
    assets: vars.FLOWEE_ASSETS ?? (existsSync(join(cwd, "served", "manifest.json")) ? resolve(cwd, "served") : undefined),
    debug: (vars.FLOWEE_LOG ?? "info") === "debug",
    telegramApi: vars.FLOWEE_TELEGRAM_API,
  };
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) errs.push(`FLOWEE_PORT: '${vars.FLOWEE_PORT}' is no port.`);
  if (options.publicUrl && !/^https?:\/\//.test(options.publicUrl)) errs.push("FLOWEE_PUBLIC_URL: must start with https:// (or http:// behind a proxy that terminates TLS for the trackers only).");
  let text = vars.FLOWEE_CONFIG;
  const file = join(cwd, "flowee.config.json");
  if (text === undefined && existsSync(file)) text = readFileSync(file, "utf8");
  let doc: Doc = { workspaces: [] } as Doc;
  try {
    doc = JSON.parse(text ?? '{"flowee":1,"workspaces":[]}');
    errs.push(...problems(doc));
  } catch (e) {
    errs.push(`FLOWEE_CONFIG: is not JSON (${(e as Error).message}).`);
  }
  const mode = vars.FLOWEE_MODE ?? (doc.instance ? "managed" : "standalone");
  const served = JSON.stringify(normalise(doc, options.publicUrl));
  mkdirSync(options.data, { recursive: true });
  let key = vars.FLOWEE_KEY;
  if (!key) {
    const at = join(options.data, "flowee.key");
    if (!existsSync(at)) {
      writeFileSync(at, `${randomSecret()}\n`, { mode: 0o600, flag: "wx" });
      notes.push(`FLOWEE_KEY was not given: generated ${at}. It seals the secrets stored in this directory; losing it loses them. Back it up, or set FLOWEE_KEY.`);
    }
    key = readFileSync(at, "utf8").trim();
  }
  const version = `${pkg.version}-${hex(await sha256(served)).slice(0, 12)}`;
  return { env: { ...vars, FLOWEE_MODE: mode, FLOWEE_CONFIG: served, FLOWEE_KEY: key, VERSION: { id: version } }, options, problems: errs, notes };
}

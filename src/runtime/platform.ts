// The runtime boundary: what a platform gives the shared code. A runtime (src/runtime/cloudflare: Workers and Durable
// Objects; src/runtime/bun: one process with SQLite files) serves HTTP into `route()` (router.ts), gives every
// workspace and the managed instance a host (adapters/workspace-host.ts, adapters/instance-host.ts) built on a
// `Room`, runs each workspace's `alarm()` when its room's wake-up is due and calls `tick()` every minute.
import type { InstanceDoc, TuiPersonDoc, WorkspaceDoc } from "../config/document";
import type { Env } from "../adapters/instance";
import type { SyncStatus } from "../core/events";
import type { AgentRow } from "../core/agents";
import type { Store } from "../ports/store";

/** One workspace's (or the instance's) durable home: its store, its one wake-up time, wiping it. */
export interface Room {
  store: Store;
  /** Runs the host's `alarm()` at `at` (epoch ms) unless a wake-up is already due sooner. */
  wake(at: number): Promise<void>;
  /** Deletes everything stored (the host migrates again). */
  clear(): Promise<void>;
  /** WebSockets of the terminal protocol (docs/tui-protocol.md); a runtime without them leaves terminals polling. */
  sockets?: Sockets;
}

/** The terminals' doorbell: sockets this room accepted under a tag, each rung with a short text. */
export interface Sockets {
  /** The answer to a WebSocket upgrade request the router authorised: the runtime keeps the socket under `tag`. */
  accept(tag: string): Response;
  /** Sends `text` to every socket under `tag`; closed ones are skipped. */
  ring(tag: string, text: string): void;
}

/** A workspace host as the router and the instance reach it (a Durable Object stub, or the host itself). */
export interface WorkspaceApi {
  fetch(req: Request): Promise<Response>;
  configure(doc: WorkspaceDoc, sealed: Record<string, string>, publicUrl?: string): Promise<void>;
  syncStatus(): Promise<SyncStatus>;
  manualHook(alias: string): Promise<{ url: string; secret: string; where: string; permission: string }>;
  wipe(): Promise<void>;
  agents(change?: { name: string; remove?: boolean; paused?: boolean }): Promise<AgentRow[]>;
}


export type Routed = { forward?: string; status?: number };

/** The managed instance's host as the router reaches it. */
export interface InstanceApi {
  mainUpdate(doc: InstanceDoc, update: unknown): Promise<Routed>;
  /** `secret` is the update's webhook secret token; `true` when the runtime fetched the update itself (polling). */
  ownUpdate(doc: InstanceDoc, id: string, secret: string | true, update: unknown): Promise<Routed>;
  resolve(doc: InstanceDoc, q: { digest?: string; id?: string }): Promise<{ id: string; paused: boolean } | null>;
  active(doc: InstanceDoc): Promise<string[]>;
  /** The instance's own terminal seat (setup and management) for a key digest. */
  tuiSeat(doc: InstanceDoc, digest: string): Promise<{ name: string; role: "manager" | "member" } | null>;
  /** The instance's terminal conversation: a sync (JSON in and out), and `/tui/socket` (the person in the router's header). */
  tuiSync(doc: InstanceDoc, who: { digest: string; name: string }, body: string): Promise<string>;
  fetch(req: Request): Promise<Response>;
  /** The terminal people with this key digest, one per workspace (paused workspaces included, marked). */
  people(doc: InstanceDoc, digest: string): Promise<{ id: string; name?: string; paused: boolean; person: TuiPersonDoc }[]>;
  admin(doc: InstanceDoc, method: string, path: string, body: unknown): Promise<{ status: number; json: string }>;
  setup(doc: InstanceDoc): Promise<Record<string, string>>;
  /** The bots whose updates a polling runtime fetches (the instance's "main" and workspace ids), with their tokens. */
  bots(doc: InstanceDoc): Promise<{ id: string; token: string }[]>;
}

export interface Platform {
  /** Configuration variables and secrets by name. */
  env: Env;
  workspace(id: string): WorkspaceApi;
  instance(): InstanceApi;
}

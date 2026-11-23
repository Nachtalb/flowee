// The runtime boundary: what a platform gives the shared code. A runtime (src/runtime/cloudflare: Workers and Durable
// Objects; src/runtime/bun: one process with SQLite files) serves HTTP into `route()` (router.ts), gives every
// workspace and the managed instance a host (adapters/workspace-host.ts, adapters/instance-host.ts) built on a
// `Room`, runs each workspace's `alarm()` when its room's wake-up is due and calls `tick()` every minute.
import type { InstanceDoc, WorkspaceDoc } from "../config/document";
import type { Env } from "../adapters/instance";
import type { SyncStatus } from "../core/events";
import type { Store } from "../ports/store";

/** One workspace's (or the instance's) durable home: its store, its one wake-up time, wiping it. */
export interface Room {
  store: Store;
  /** Runs the host's `alarm()` at `at` (epoch ms) unless a wake-up is already due sooner. */
  wake(at: number): Promise<void>;
  /** Deletes everything stored (the host migrates again). */
  clear(): Promise<void>;
}

/** A workspace host as the router and the instance reach it (a Durable Object stub, or the host itself). */
export interface WorkspaceApi {
  fetch(req: Request): Promise<Response>;
  configure(doc: WorkspaceDoc, sealed: Record<string, string>, publicUrl?: string): Promise<void>;
  syncStatus(): Promise<SyncStatus>;
  manualHook(alias: string): Promise<{ url: string; secret: string; where: string; permission: string }>;
  wipe(): Promise<void>;
}

export type Routed = { forward?: string; status?: number };

/** The managed instance's host as the router reaches it. */
export interface InstanceApi {
  mainUpdate(doc: InstanceDoc, update: unknown): Promise<Routed>;
  ownUpdate(doc: InstanceDoc, id: string, secret: string, update: unknown): Promise<Routed>;
  resolve(doc: InstanceDoc, q: { digest?: string; id?: string }): Promise<{ id: string; paused: boolean } | null>;
  active(doc: InstanceDoc): Promise<string[]>;
  admin(doc: InstanceDoc, method: string, path: string, body: unknown): Promise<{ status: number; json: string }>;
  setup(doc: InstanceDoc): Promise<Record<string, string>>;
}

export interface Platform {
  /** Configuration variables and secrets by name. */
  env: Env;
  workspace(id: string): WorkspaceApi;
  instance(): InstanceApi;
}

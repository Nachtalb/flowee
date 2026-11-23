// The tracker's webhooks as an optional Tracker capability (`tracker.hooks`): verifying and reading deliveries,
// and registering the hook through the tracker's API. Events are hints that something changed, never the record:
// whatever acts on one re-reads the tracker first (docs/webhooks.md).

/** A tracker change in the tracker-agnostic form; `repo` is the repository's path as the delivery names it. */
export type TrackerEvent =
  | { kind: "ticket"; repo: string; n: number }
  | { kind: "comment"; repo: string; n: number }
  | { kind: "push"; repo: string; branch: string; sha: string | null }
  | { kind: "pull"; repo: string; number: number; action: "opened" | "updated" | "merged" | "closed"; branch: string; author: string }
  | { kind: "checks"; repo: string; sha: string }
  | { kind: "release"; repo: string; tag: string }
  | { kind: "tag"; repo: string; tag: string; sha: string | null }
  | { kind: "ping"; repo: string };

/** One inbound delivery: its headers and its raw body (signatures are over the exact bytes). */
export interface Delivery {
  header(name: string): string | null;
  body: string;
}

export interface HookStatus {
  id: string;
  /** False when the tracker reports the hook failing or disabled. */
  ok: boolean;
  /** What the tracker reports when it is not ok. */
  detail?: string;
}

export interface Hooks {
  /** True when the delivery carries the secret's proof (a signature or the token), compared in constant time. */
  verify(d: Delivery, secret: string): Promise<boolean>;
  /** The delivery's id (the same on a redelivery), or null when the tracker sends none. */
  id(d: Delivery): string | null;
  /** The events of a verified delivery; unknown kinds give none. */
  parse(d: Delivery): TrackerEvent[];
  /** Creates the hook for `url` (or updates the one already there); 403 forbidden when the token may not. */
  register(url: string, secret: string): Promise<HookStatus>;
  unregister(url: string): Promise<void>;
  /** The hook for `url` as the tracker reports it, null when there is none. */
  status(url: string): Promise<HookStatus | null>;
  /** What the token needs to register the hook, in words for the owner. */
  permission: string;
  /** Where the owner adds a hook by hand, in words. */
  manual: string;
}

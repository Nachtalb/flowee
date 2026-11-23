// The tracker adapters by kind: the one place `build()` (and the wizard host) choose an adapter. A new tracker is
// its adapter file, its kind in src/config/trackers.ts and its entry here.
import type { TrackerKind } from "../config/trackers";
import type { RepoReference, Tracker } from "../ports/tracker";
import { GitHub, githubRepo } from "./tracker-github";
import { GitLab, gitlabRepo } from "./tracker-gitlab";

export interface TrackerConfig {
  /** The repository's path. */
  repo: string;
  api?: string;
  /** The token's value, undefined when the secret is missing. */
  token: string | undefined;
  /** The token's secret name, for the message when it is missing. */
  tokenName: string;
  /** A GitHub Projects (v2) board (GitHub only). */
  project?: { owner: string; number: number };
}

export interface TrackerAdapter {
  make(c: TrackerConfig): Tracker & { probe(): Promise<number> };
  /** Reads a pasted repository reference (link, path, git remote) for this kind and API. */
  parseRepo(api?: string): RepoReference;
}

export const TRACKERS: Record<TrackerKind, TrackerAdapter> = {
  github: { make: (c) => new GitHub(c), parseRepo: githubRepo },
  gitlab: { make: ({ project: _, ...c }) => new GitLab(c), parseRepo: gitlabRepo },
};

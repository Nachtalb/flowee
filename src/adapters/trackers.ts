// The tracker adapters by kind: the one place `build()` (and the wizard host) choose an adapter. A new tracker is
// its adapter file, its kind in src/config/trackers.ts and its entry here.
import { TRACKER_KINDS, type TrackerKind } from "../config/trackers";
import type { RepoReference, TokenHelp, Tracker } from "../ports/tracker";
import { GitHub, githubRepo, githubToken } from "./tracker-github";
import { GitLab, gitlabRepo, gitlabToken } from "./tracker-gitlab";

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
  /** GitLab: the label of a ticket closed as not planned. */
  notPlannedLabel?: string;
}

export interface TrackerAdapter {
  make(c: TrackerConfig): Tracker & { probe(): Promise<number> };
  /** Reads a pasted repository reference (link, path, git remote) for this kind and API. */
  parseRepo(api?: string): RepoReference;
  /** The token's minimal permissions per feature and a link to the token form. */
  tokenHelp(api?: string): TokenHelp;
}

export const TRACKERS: Record<TrackerKind, TrackerAdapter> = {
  github: { make: (c) => new GitHub(c), parseRepo: githubRepo, tokenHelp: githubToken },
  gitlab: { make: ({ project: _, ...c }) => new GitLab(c), parseRepo: gitlabRepo, tokenHelp: gitlabToken },
};

/** A pasted repository with the tracker it lives on. */
export interface Recognised {
  kind: TrackerKind;
  /** The API base URL when it is not the kind's default (GitHub Enterprise, a self-managed GitLab). */
  api?: string;
  repo: string;
  /** The tracker's name for messages. */
  name: string;
}

/**
 * Which tracker a pasted link or path names: GitHub (github.com, or the Enterprise host of `githubApi`; a bare
 * `owner/name` too), gitlab.com, or a self-managed GitLab, recognised by a host starting with `gitlab.` or GitLab's
 * own `/-/` routes in the link, whose API is then `https://<host>/api/v4` (the token check proves it).
 */
export function recognise(githubApi?: string): (raw: string) => Recognised | undefined {
  const gh = githubRepo(githubApi);
  const gl = gitlabRepo();
  const name = (kind: TrackerKind) => TRACKER_KINDS[kind].name;
  return (raw) => {
    const g = gh(raw);
    if (g) return { kind: "github", ...(githubApi ? { api: githubApi } : {}), repo: g, name: name("github") };
    const l = gl(raw);
    if (l) return { kind: "gitlab", repo: l, name: name("gitlab") };
    const host = /^(?:(?:https?|git):\/\/|(?:ssh:\/\/)?git@)?([^/:\s]+\.[^/:\s]+)[/:]/i.exec(raw.trim().replace(/^<+/, ""))?.[1]?.toLowerCase();
    if (!host || !(/^gitlab\./.test(host) || raw.includes("/-/"))) return undefined;
    const api = `https://${host}/api/v4`;
    const r = gitlabRepo(api)(raw);
    return r ? { kind: "gitlab", api, repo: r, name: name("gitlab") } : undefined;
  };
}

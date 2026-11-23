// The issue tracker the flow keeps its record in. The base interface is what every flow needs; the optional
// capabilities below are what richer flows (branches, pull requests, CI, releases) use. An adapter that cannot
// offer one leaves it undefined, and `capability()` turns that into a clear 501 refusal.
import { Fail } from "../core/errors";

/**
 * What a user pastes for a repository (a link, `owner/name`, a git remote) as `owner/name`; undefined when it names
 * none of the tracker's repositories. The adapter knows its link shapes and hosts.
 */
export type RepoReference = (ref: string) => string | undefined;

/** How to get a token for these repositories with the switched-on features: the permissions, and a link that opens the form. */
export type TokenHelp = (repos: string[], name: string, features: string[]) => { permissions: string[]; url?: string };

export interface Issue {
  n: number;
  title: string;
  body: string | null;
  open: boolean;
  labels: string[];
  assignees: string[];
  createdAt: string;
  updatedAt: string;
  url: string;
  /** The tracker's own id of the issue (GitHub: node id), for the board. */
  ref: string;
}

export interface IssuePatch {
  labels?: string[];
  assignees?: string[];
  /** false closes (with `reason`), true reopens. */
  open?: boolean;
  reason?: "completed" | "not_planned";
  title?: string;
  body?: string;
}

export interface Comment {
  id: number;
  body: string;
  createdAt?: string;
}

export interface Commit {
  sha: string;
  /** The first line of the message. */
  subject: string;
}

export interface Tracker {
  /** One issue; 404 not_found when missing or not an issue (e.g. a pull request). */
  issue(n: number): Promise<Issue>;
  openIssues(): Promise<Issue[]>;
  create(title: string, body: string, labels: string[]): Promise<Issue>;
  /** `what` names the write in the 502 message when the tracker refuses it. */
  update(n: number, patch: IssuePatch, what: string): Promise<void>;
  /** Posts a comment; its id. */
  comment(n: number, body: string): Promise<number>;
  comments(n: number): Promise<Comment[]>;
  /** Commits on `branch` since an ISO time, oldest first. */
  commits(branch: string, since: string): Promise<Commit[]>;
  /** True when `head` contains `base` (base is an ancestor of, or equal to, head). */
  contains(base: string, head: string): Promise<boolean>;

  board?: Board;
  branches?: Branches;
  pulls?: PullRequests;
  checks?: Checks;
  releases?: Releases;
  tags?: Tags;
}

/** A project board column per state (GitHub Projects v2 "Status"). */
export interface Board {
  setStatus(issue: Issue, status: string): Promise<void>;
}

export interface Change {
  /** A added, M modified, D deleted, R renamed. */
  status: "A" | "M" | "D" | "R";
  path: string;
  /** The lines the change adds (without the leading +). */
  added: string[];
}

/** Reading the repository's code: branch heads, files, the files a commit changed. */
export interface Branches {
  /** The head sha of a branch, or null when it does not exist. */
  head(name: string): Promise<string | null>;
  /** Whether a file or directory exists at `path` on `ref`. */
  exists(ref: string, path: string): Promise<boolean>;
  /** The files a commit changed, with their added lines. */
  changes(sha: string): Promise<Change[]>;
  remove(name: string): Promise<void>;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  url: string;
  head: string;
  headSha: string;
  base: string;
  state: "open" | "closed" | "merged";
  /** The commit the merge made on the base branch. */
  mergeSha: string | null;
  author: string;
}

export interface PullRequests {
  /** The newest pull request from `branch` (open ones first), or null. */
  forBranch(branch: string): Promise<PullRequest | null>;
  /** One pull request; 404 not_found when missing. */
  get(number: number): Promise<PullRequest>;
  /** The open pull requests. */
  open(): Promise<PullRequest[]>;
  create(head: string, base: string, title: string, body: string): Promise<PullRequest>;
  update(number: number, patch: { title?: string; body?: string }): Promise<void>;
  /** Merges; the merge commit's sha. 409 not_mergeable when the tracker refuses. */
  merge(number: number, method: "merge" | "squash" | "rebase", subject?: string): Promise<string>;
  /** Every file the pull request changes against its base, over all its commits. */
  files(number: number): Promise<Change[]>;
}

export interface CheckRun {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required" | "stale" | null;
}

export interface Checks {
  /** Check runs and commit statuses of a commit, one entry per name (the newest). */
  forCommit(sha: string): Promise<CheckRun[]>;
}

export interface Release {
  tag: string;
  /** The release's name (the version shown on cards). */
  name: string;
  /** The commit the release was built from, when its notes name it (`build from <sha>`). */
  sha: string | null;
  body: string;
  url: string;
  publishedAt: string;
}

export interface Releases {
  /** The latest published release, or null. */
  latest(): Promise<Release | null>;
}

export interface Tags {
  /** The commit a tag points at, or null when it does not exist. */
  get(name: string): Promise<string | null>;
  /** Creates or moves a tag (the `tested` tag of feature releases moves forward over main). */
  move(name: string, sha: string): Promise<void>;
}

export type Capability = "board" | "branches" | "pulls" | "checks" | "releases" | "tags";

const NAMES: Record<Capability, string> = {
  board: "a project board",
  branches: "reading branches and files",
  pulls: "pull requests",
  checks: "check runs",
  releases: "releases",
  tags: "tags",
};

export function capability<K extends Capability>(t: Tracker, k: K): NonNullable<Tracker[K]> {
  const c = t[k];
  if (!c) throw new Fail(501, "unsupported", `The tracker does not support ${NAMES[k]}.`);
  return c as NonNullable<Tracker[K]>;
}

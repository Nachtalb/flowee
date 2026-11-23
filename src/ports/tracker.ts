// The issue tracker the flow keeps its record in. The base interface is what every flow needs; the optional
// capabilities below are what richer flows (branches, pull requests, CI, releases) use. An adapter that cannot
// offer one leaves it undefined, and `capability()` turns that into a clear 501 refusal.
import { Fail } from "../core/errors";

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

export interface Branches {
  /** The head sha of a branch, or null when it does not exist. */
  head(name: string): Promise<string | null>;
}

export interface PullRequest {
  number: number;
  title: string;
  url: string;
  head: string;
  headSha: string;
  base: string;
  state: "open" | "closed" | "merged";
  /** Issue numbers the pull request says it closes. */
  closes: number[];
}

export interface PullRequests {
  /** Pull requests that reference the issue (open ones first). */
  forIssue(n: number): Promise<PullRequest[]>;
  get(number: number): Promise<PullRequest>;
  merge(number: number, method: "merge" | "squash" | "rebase"): Promise<string>;
}

export interface CheckRun {
  name: string;
  status: "queued" | "in_progress" | "completed";
  conclusion: "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required" | null;
}

export interface Checks {
  forCommit(sha: string): Promise<CheckRun[]>;
}

export interface Release {
  tag: string;
  /** The commit the release was built from, when the tracker or its notes name it. */
  sha: string | null;
  body: string;
  url: string;
  publishedAt: string;
}

export interface Releases {
  latest(): Promise<Release | null>;
}

export interface Tags {
  get(name: string): Promise<string | null>;
  /** Creates or moves a tag (AnyFile's `tested` tag moves forward over main). */
  move(name: string, sha: string): Promise<void>;
}

export type Capability = "board" | "branches" | "pulls" | "checks" | "releases" | "tags";

const NAMES: Record<Capability, string> = {
  board: "a project board",
  branches: "branches",
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

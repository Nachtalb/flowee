// The tracker kinds a repository can name, with what the validator needs of each: its default API, what it calls a
// repository path and the optional capabilities its adapter offers. The adapters themselves are registered by the
// same keys in src/adapters/trackers.ts (the compiler demands an entry there for every kind here).
import type { Capability } from "../ports/tracker";

export interface TrackerKindInfo {
  /** Shown in messages. */
  name: string;
  /** The API base URL when a document names none. */
  api: string;
  /** A repository path of this kind (`owner/name`; GitLab: `group/subgroup/project` of any depth). */
  repo: RegExp;
  /** How `repo` is written in messages. */
  repoForm: string;
  capabilities: Capability[];
}

export const TRACKER_KINDS = {
  github: {
    name: "GitHub",
    api: "https://api.github.com",
    repo: /^[\w.-]+\/[\w.-]+$/,
    repoForm: "owner/name",
    capabilities: ["board", "branches", "pulls", "checks", "releases", "tags"],
  },
  gitlab: {
    name: "GitLab",
    api: "https://gitlab.com/api/v4",
    repo: /^[\w.-]+(?:\/[\w.-]+)+$/,
    repoForm: "group/project (subgroups allowed)",
    capabilities: ["branches", "pulls", "checks", "releases", "tags"],
  },
} satisfies Record<string, TrackerKindInfo>;

export type TrackerKind = keyof typeof TRACKER_KINDS;

export const TRACKER_TYPES = Object.keys(TRACKER_KINDS) as TrackerKind[];

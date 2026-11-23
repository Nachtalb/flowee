// A workspace's whole configuration as one versioned JSON document. Secrets are never part of it: fields named
// `secret`/`token`/`webhookSecret` hold the NAME of a secret supplied to the instance separately.
import type { Chart, FlowOptions } from "../core/chart";
import type { FeaturesDoc } from "../core/features";
import type { Texts } from "../core/settings";
import type { TrackerKind } from "./trackers";

export const VERSION = 1;

export type FlowRef = { preset: string } | { chart: Chart; options: FlowOptions };

/**
 * One repository: its path (`owner/name`; GitLab `group/subgroup/project`), or with an alias (the `app` of
 * `app#12`), its own token, branch, or tracker (`type`, `api`) when it lives on another one than `tracker.type`.
 */
export type RepoDoc = string | { repo: string; alias?: string; token?: string; mainBranch?: string; type?: TrackerKind; api?: string };

export interface WorkspaceDoc {
  flowee: 1;
  id: string;
  name?: string;
  flow: FlowRef;
  /** Feature switches of the flow; phase 1 knows none, presets of later versions read them. */
  features?: FeaturesDoc;
  tracker: {
    /** The tracker of every repository that names none; default `github`. */
    type?: TrackerKind;
    /** The repositories; tickets are `alias#n` when there are several. */
    repos: RepoDoc[];
    mainBranch?: string;
    /** The API base URL of `type` (GitHub Enterprise, self-managed GitLab, a local stand-in); default its public one. */
    api?: string;
    /** Secret name of the tracker token (shared by every repository without its own). */
    token: string;
    /** A GitHub Projects (v2) board whose Status follows the state; needs a classic token with `project`. */
    project?: { owner: string; number: number };
    /** GitLab stores no close reason: a ticket closed as not planned gets this label (default `not planned`). */
    notPlannedLabel?: string;
    /** Days a new tracker token lives, asked for by the token link (default 366, GitHub's longest; `none`: no expiry). */
    tokenDays?: number | "none";
  };
  roles: { instance: string; role: string; secret: string }[];
  owners: { name?: string; tracker?: string; chat?: string }[];
  chat?: {
    type: "telegram";
    /** Secret names of the bot token and of the webhook's secret token. */
    token: string;
    webhookSecret: string;
    username?: string;
    chatId: string;
    topicId?: number;
    /** The instance's public base URL: the bot's webhook and profile are set from here. */
    publicUrl?: string;
    /** The workspace's own bot, created and managed through the instance's bot (managed mode). */
    managed?: boolean;
    /** How the bot's updates arrive; polling only in the self-hosted runtime (docs/self-hosting.md). */
    transport?: "webhook" | "polling";
    /** In a group or topic: only these chat user ids work the tickets; default every member. */
    members?: string[];
  };
  /** The terminal interface (docs/tui.md): who signs in with `flowee-tui`; with `chat` too, both show the same inbox. */
  tui?: { people: TuiPersonDoc[] };
  /** Chat user ids who manage the workspace besides the one who set it up (managed mode). */
  managers?: string[];
  files?: { url: string; token: string; expire?: string };
  texts?: Partial<Texts>;
  schedule?: { timezone?: string; digestFrom?: number; digestTo?: number };
  profile?: { photo?: string };
  /** How Flowee learns of tracker changes: webhooks, a slow reconcile, polling as the fallback (docs/webhooks.md). */
  sync?: { webhooks?: "auto" | "off" | "required"; reconcileMinutes?: number; pollMinutes?: number };
}

/** One person of the terminal interface: a personal key, kept here only as its SHA-256 hex digest. */
export interface TuiPersonDoc {
  id: string;
  name?: string;
  /** `member` answers the inbox; `manager` also manages the workspace (managed mode). Default `member`. */
  role?: "manager" | "member";
  /** The SHA-256 hex digest of the person's key (`flowee-tui --new-key` prints it); never the key. */
  key: string;
}

export interface InstanceDoc {
  flowee: 1;
  workspaces: WorkspaceDoc[];
  /** The instance itself (managed mode): its bot, owner, who may create workspaces. */
  instance?: InstanceConfig;
}

export interface InstanceConfig {
  /** Secret names of the instance bot's token and webhook secret. */
  bot: { token: string; webhookSecret: string; username?: string };
  /** The Worker's public base URL; webhooks are set from it. */
  publicUrl: string;
  /** The instance owner's chat user id. */
  owner: string;
  /** Chat user ids that may create workspaces; default the owner only. */
  creators?: string[];
  limits?: { workspacesPerUser?: number };
  /** The instance bot's profile; a workspace's own bot takes its profile from its workspace. */
  profile?: { name?: string; description?: string; shortDescription?: string; photo?: string };
  /** The tracker API base URL for workspaces made in the wizard (default https://api.github.com). */
  trackerApi?: string;
  /** Days a new tracker token lives, for workspaces whose document names none (default 366). */
  tokenDays?: number | "none";
  /** How the bots' updates arrive; polling only in the self-hosted runtime. */
  transport?: "webhook" | "polling";
  /** People who set up and manage workspaces in the terminal (flowee-tui): `manager` may create workspaces. */
  tui?: { people: TuiPersonDoc[] };
}

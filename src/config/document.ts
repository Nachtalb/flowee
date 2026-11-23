// A workspace's whole configuration as one versioned JSON document. Secrets are never part of it: fields named
// `secret`/`token`/`webhookSecret` hold the NAME of a secret supplied to the instance separately.
import type { Chart, FlowOptions } from "../core/chart";
import type { Texts } from "../core/settings";

export const VERSION = 1;

export type FlowRef = { preset: string } | { chart: Chart; options: FlowOptions };

/** One repository: `owner/name`, or with an alias (the `app` of `app#12`), its own token or branch. */
export type RepoDoc = string | { repo: string; alias?: string; token?: string; mainBranch?: string };

export interface WorkspaceDoc {
  flowee: 1;
  id: string;
  name?: string;
  flow: FlowRef;
  /** Feature switches of the flow; phase 1 knows none, presets of later versions read them. */
  features?: Record<string, boolean>;
  tracker: {
    type: "github";
    /** The repositories; tickets are `alias#n` when there are several. */
    repos: RepoDoc[];
    mainBranch?: string;
    /** The API base URL (GitHub Enterprise, a local stand-in); default https://api.github.com. */
    api?: string;
    /** Secret name of the tracker token (shared by every repository without its own). */
    token: string;
    /** A GitHub Projects (v2) board whose Status follows the state; needs a classic token with `project`. */
    project?: { owner: string; number: number };
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
  };
  files?: { url: string; token: string; expire?: string };
  texts?: Partial<Texts>;
  schedule?: { timezone?: string; digestFrom?: number; digestTo?: number };
  profile?: { photo?: string };
}

export interface InstanceDoc {
  flowee: 1;
  workspaces: WorkspaceDoc[];
}

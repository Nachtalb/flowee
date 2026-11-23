// The chat backends a workspace can have, as src/config/trackers.ts names the tracker kinds: what the validator and
// the docs need of each. The adapters are registered by the same keys in src/adapters/chats.ts (the compiler demands
// an entry there for every kind here). A workspace has one or both: Telegram (`chat`) and the terminal (`tui`) show
// the same conversation when both are configured (docs/adapters.md, "Chat backends").
import type { WorkspaceDoc } from "./document";

export interface ChatKindInfo {
  /** Shown in messages. */
  name: string;
  /** The workspace document's section that configures it. */
  section: "chat" | "tui";
  /** Needs a messenger account (a bot token); the terminal needs nothing but the instance. */
  messenger: boolean;
}

export const CHAT_KINDS = {
  telegram: { name: "Telegram", section: "chat", messenger: true },
  tui: { name: "Terminal", section: "tui", messenger: false },
} satisfies Record<string, ChatKindInfo>;

export type ChatKind = keyof typeof CHAT_KINDS;

export const CHAT_TYPES = Object.keys(CHAT_KINDS) as ChatKind[];

/** The chat backends a document configures, in registry order. */
export const chatKinds = (d: Pick<WorkspaceDoc, "chat" | "tui">): ChatKind[] => CHAT_TYPES.filter((k) => !!d[CHAT_KINDS[k].section]);

/** The conversation a terminal-only workspace's envoy is bound to: a team inbox with more than one person. */
export const tuiChat = (people: number) => (people > 1 ? "-tui" : "tui");

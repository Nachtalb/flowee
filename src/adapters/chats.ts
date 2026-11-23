// The chat adapters by kind: the one place `build()` chooses the workspace's chat. A new chat backend is its adapter
// file, its kind in src/config/chats.ts and its entry here (docs/adapters.md, "Chat backends").
import { CHAT_KINDS, type ChatKind, chatKinds } from "../config/chats";
import type { WorkspaceDoc } from "../config/document";
import type { Chat, ChatRef } from "../ports/chat";
import type { Secrets } from "../ports/secrets";
import type { Store } from "../ports/store";
import { Telegram } from "./chat-telegram";
import { Tee, Terminal } from "./chat-tui";

export interface ChatConfig {
  doc: WorkspaceDoc;
  secrets: Secrets;
  store: Store;
  /** The conversation the envoy is bound to. */
  at: ChatRef;
  /** Rings the connected terminals with the newest sequence number. */
  ring?: (seq: number) => void;
}

export const CHATS: Record<ChatKind, { make(c: ChatConfig): Chat }> = {
  telegram: { make: ({ doc, secrets }) => new Telegram(secrets.get(doc.chat?.token ?? ""), doc.chat?.token ?? "chat.token") },
  tui: { make: ({ store, at, ring }) => new Terminal(store, at, ring) },
};

/** The workspace's chat: one backend, or Telegram shown in the terminals too; the terminal side for the protocol. */
export function chatOf(c: ChatConfig): { chat?: Chat; terminal?: Terminal } {
  const kinds = chatKinds(c.doc);
  const made = kinds.map((k) => CHATS[k].make(c));
  if (made.length < 2) return { chat: made[0], terminal: made[0] instanceof Terminal ? made[0] : undefined };
  const term = made.find((m) => m instanceof Terminal) as Terminal;
  return { chat: new Tee(made.find((m) => m !== term) as Chat, term), terminal: term };
}

export { CHAT_KINDS };

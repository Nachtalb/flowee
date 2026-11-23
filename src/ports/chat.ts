// The chat the owner works in. Views are rich (a small HTML subset, button rows, a table with a button per row);
// a backend without rich messages renders them with `plain()` and a keyboard. docs/adapters.md lists what a new
// chat adapter must implement; docs/chat-style.md how every screen looks and when a message is edited or sent.

export interface ChatRef {
  chat: string;
  /** A forum topic (Telegram message_thread_id) inside the chat. */
  topic?: number;
}

/** A button: `data` is pressed back to the bot, `url` opens a link, `copy` copies a text; none: a disabled label. */
export interface Button {
  label: string;
  data?: string;
  url?: string;
  copy?: string;
  style?: "primary";
}

/** A row: its cells, then its own buttons in the same row (none: a row of facts). */
export interface TableRow {
  cells: string[];
  buttons?: Button[];
}

export interface Table {
  /** Column names; none for a table of choices or facts. */
  head?: string[];
  rows: TableRow[];
}

/** `html` uses p, b, i, a, code, pre, details, summary only (lists only inside a ticket's own text, docs/chat-style.md). */
export type Block = { html: string } | { buttons: Button[] } | { table: Table };
export type View = Block[];

export interface ViewOptions {
  /** Ask for a reply (Telegram ForceReply) with this placeholder. */
  forceReply?: string;
  /** Sent as a reply to this message; sent anyway when it is gone. */
  replyTo?: number;
  /** The one reply-keyboard request a chat offers nowhere else (docs/chat-style.md, "Exceptions"). */
  keyboard?: ChatRequest;
  /** Takes a reply keyboard away again. */
  removeKeyboard?: boolean;
  /** Without a notification sound (the digest, sync notices). */
  quiet?: boolean;
}

export interface FileRef {
  id: string;
  name: string;
  image: boolean;
  size: number;
}

export type Content = { text: string } | { caption: string; files: FileRef[] } | "voice" | "unsupported";

/** Who sent an update: the display name and the @username, when the chat gives them. */
export interface Sender {
  name?: string;
  username?: string;
}

export interface ChatMessage extends Sender {
  kind: "message";
  update: number;
  at: ChatRef;
  from: string;
  id: number;
  text?: string;
  /** The message it replies to, and whether that one is the bot's. */
  replyTo?: { id: number; fromBot: boolean };
  album?: string;
  content: Content;
  /** A private chat or a group. */
  chatKind?: "private" | "group";
  /** The group's title. */
  chatTitle?: string;
  /** A service message (Telegram: the note that a managed bot was created), not something the user wrote. */
  service?: boolean;
}

export interface ChatPress extends Sender {
  kind: "press";
  update: number;
  at?: ChatRef;
  from: string;
  query: string;
  data: string;
  /** The message whose button was pressed. */
  message?: number;
}

/** A bot the user created to be managed by this bot (Telegram: the `managed_bot` update). */
export interface ChatManagedBot {
  kind: "managed";
  update: number;
  from: string;
  bot: { id: string; username?: string; name?: string };
}

export type ChatEvent = ChatMessage | ChatPress | ChatManagedBot;

/** A reply-keyboard request the user answers in the chat app: create a bot this bot then manages. */
export type ChatRequest = { kind: "managedBot"; label: string; name: string; username: string };

/** Where a command list applies. */
export type CommandScope = "default" | "private" | "groups" | ChatRef;

/** Bot-wide settings (Telegram setMySettings); docs/telegram.md says why each value. */
export interface BotSettings {
  /** Read every message in groups (privacy mode off). */
  readAllGroupMessages: boolean;
  canJoinGroups: boolean;
  /** Topics in private chats with the bot, shown in a sidebar. */
  topicsInPrivate: boolean;
  inline: boolean;
  /** May create and manage other bots (the instance's bot only). */
  manageBots: boolean;
}

export interface Command {
  command: string;
  description: string;
}

export interface Profile {
  name: string;
  description: string;
  shortDescription: string;
  commands: Command[];
}

export interface Chat {
  /** Turns a raw update into an event; null for anything the envoy does not handle. */
  parse(update: unknown): ChatEvent | null;
  view(to: ChatRef, view: View, o?: ViewOptions): Promise<number>;
  editView(to: ChatRef, id: number, view: View): Promise<void>;
  remove(to: ChatRef, id: number): Promise<void>;
  dropButtons(to: ChatRef, id: number): Promise<void>;
  react(to: ChatRef, id: number, emoji: string): Promise<void>;
  /** Answers a button press, with a toast when `text` is given. */
  answer(query: string, text?: string): Promise<void>;
  /** The command menu, for one chat or (no `to`) as the default. */
  setCommands(commands: Command[], to?: ChatRef): Promise<void>;
  /** The command menu for a scope (all private chats, all groups, one chat). */
  setScopedCommands?(commands: Command[], scope: CommandScope): Promise<void>;
  setSettings?(settings: BotSettings): Promise<void>;
  sendFile?(to: ChatRef, name: string, data: string, caption?: string): Promise<number>;
  download(file: FileRef): Promise<ArrayBuffer>;
  /** Profile items, each applied only when `changed(item, value)` says so. */
  setName(name: string): Promise<void>;
  setDescription(text: string): Promise<void>;
  setShortDescription(text: string): Promise<void>;
  setPhoto(png: ArrayBuffer): Promise<void>;
  setWebhook(url: string, secret: string): Promise<void>;
  webhookUrl(): Promise<string>;
}

/**
 * The living-message rule: a screen replaces the previous one by editing message `id`; a new message is sent only
 * when there is none or the chat refuses the edit (too old, deleted, another kind of message). Returns the id
 * showing the view now; the caller removes `id` when it differs.
 */
export async function live(chat: Chat, to: ChatRef, id: number | undefined, view: View): Promise<number> {
  if (id !== undefined)
    try {
      await chat.editView(to, id, view);
      return id;
    } catch {}
  return chat.view(to, view);
}

const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

/** A view as plain text plus keyboard rows, for chats without rich messages. */
export function plain(view: View): { text: string; buttons: Button[][] } {
  const lines: string[] = [];
  const buttons: Button[][] = [];
  for (const b of view) {
    if ("html" in b)
      lines.push(
        decode(
          b.html
            .replace(/<li>/g, "• ")
            .replace(/<\/(p|li|pre|summary|tr)>/g, "\n")
            .replace(/<[^>]+>/g, ""),
        ).trim(),
      );
    else if ("buttons" in b) buttons.push(b.buttons);
    else {
      for (const r of b.table.rows) {
        lines.push(decode(r.cells.join(" · ").replace(/<[^>]+>/g, "")));
        if (r.buttons?.length) buttons.push(r.buttons.map((x) => ({ ...x, label: `${x.label} · ${decode(r.cells[0].replace(/<[^>]+>/g, ""))}` })));
      }
    }
  }
  return { text: lines.filter(Boolean).join("\n"), buttons };
}

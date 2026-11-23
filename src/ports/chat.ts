// The chat the owner works in. Views are rich (a small HTML subset, button rows, a table with a button per row);
// a backend without rich messages renders them with `plain()` and a keyboard. docs/adapters.md lists what a new
// chat adapter must implement.

export interface ChatRef {
  chat: string;
  /** A forum topic (Telegram message_thread_id) inside the chat. */
  topic?: number;
}

/** A button; without `data` it is a disabled label (a page counter). */
export interface Button {
  label: string;
  data?: string;
  style?: "primary";
}

export interface Table {
  head: string[];
  rows: { cells: string[]; button: Button }[];
}

/** `html` uses p, b, i, a, code, pre, ul, li, details, summary only. */
export type Block = { html: string } | { buttons: Button[] } | { table: Table };
export type View = Block[];

export interface ViewOptions {
  /** Ask for a reply (Telegram ForceReply) with this placeholder. */
  forceReply?: string;
  /** Sent as a reply to this message; sent anyway when it is gone. */
  replyTo?: number;
}

export interface TextOptions {
  /** The text is HTML (b, i, a, code) and links get no preview. */
  html?: boolean;
  quiet?: boolean;
  buttons?: Button[][];
  replyTo?: number;
  /** No link preview for a plain text. */
  noPreview?: boolean;
}

export interface FileRef {
  id: string;
  name: string;
  image: boolean;
  size: number;
}

export type Content = { text: string } | { caption: string; files: FileRef[] } | "voice" | "unsupported";

export interface ChatMessage {
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
}

export interface ChatPress {
  kind: "press";
  update: number;
  at?: ChatRef;
  from: string;
  query: string;
  data: string;
  /** The message whose button was pressed. */
  message?: number;
}

export type ChatEvent = ChatMessage | ChatPress;

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
  text(to: ChatRef, text: string, o?: TextOptions): Promise<number>;
  editText(to: ChatRef, id: number, text: string): Promise<void>;
  remove(to: ChatRef, id: number): Promise<void>;
  dropButtons(to: ChatRef, id: number): Promise<void>;
  react(to: ChatRef, id: number, emoji: string): Promise<void>;
  /** Answers a button press, with a toast when `text` is given. */
  answer(query: string, text?: string): Promise<void>;
  /** The command menu, for one chat or (no `to`) as the default. */
  setCommands(commands: Command[], to?: ChatRef): Promise<void>;
  download(file: FileRef): Promise<ArrayBuffer>;
  /** Profile items, each applied only when `changed(item, value)` says so. */
  setName(name: string): Promise<void>;
  setDescription(text: string): Promise<void>;
  setShortDescription(text: string): Promise<void>;
  setPhoto(png: ArrayBuffer): Promise<void>;
  setWebhook(url: string, secret: string): Promise<void>;
  webhookUrl(): Promise<string>;
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
        lines.push(decode(r.cells.join(" · ")));
        buttons.push([{ ...r.button, label: `${r.button.label} #${r.cells[0]}` }]);
      }
    }
  }
  return { text: lines.filter(Boolean).join("\n"), buttons };
}

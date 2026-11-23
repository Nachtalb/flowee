// The terminal client protocol's messages (docs/tui-protocol.md), shared by the server side (src/adapters/chat-tui.ts)
// and the client (tui/). A view is the Chat port's `View`: the same blocks every chat backend renders.
import type { Command, View } from "./chat";

/** What a terminal sends: one action, with an id of its own so a retried request is handled once. */
export interface TuiFrame {
  id: string;
  press?: { data: string; message?: number };
  text?: { text: string; replyTo?: number };
  file?: { name: string; data: string; caption?: string; replyTo?: number };
}

/** The signed-in person, as the router resolved the key. */
export interface TuiPerson {
  id: string;
  name: string;
  role: "manager" | "member";
}

/** One message of the conversation: the bot's view, or (with `said`) what a person typed. */
export interface TuiMessage {
  id: number;
  at: number;
  view?: View;
  /** Typing here answers this message (the card being worked on); the text is the input's placeholder. */
  reply?: string;
  replyTo?: number;
  quiet?: boolean;
  /** A file to keep (the project key, an export): saved by the client, never shown. */
  file?: { name: string; data: string; caption?: string };
  /** A person's own message: their name and words (files as their names). */
  by?: string;
  said?: string;
  reaction?: string;
}

export type TuiEvent = { seq: number } & (
  | { op: "put"; msg: TuiMessage }
  | { op: "del"; id: number }
  | { op: "toast"; text: string; to?: string }
  | { op: "menu"; commands: Command[] }
  | { op: "panel"; view: View }
);

export interface TuiSync {
  seq: number;
  events: TuiEvent[];
  /** The log no longer reaches back to `after`: the whole conversation instead of the events. */
  reset?: { messages: TuiMessage[]; menu: Command[]; panel?: View };
}


/** One workspace a key opens (`GET /tui/v1/me`). */
export interface TuiSeat {
  id: string;
  name: string;
  paused: boolean;
  person: TuiPerson;
}

// What a workspace's runtime needs, resolved from its configuration document (src/config).
import type { ChatRef } from "../ports/chat";
import type { Flow } from "./chart";

export interface Texts {
  /** The owner's name: signature (`Owner:`) and filing note. */
  owner: string;
  /** The heading of the owner card (`### For the owner`). */
  cardHeading: string;
  botName: string;
  /** The project's name in the welcome and profile texts. */
  project: string;
  welcome: string;
  about: string;
  shortAbout: string;
  /** The first line of a ticket filed from the chat. */
  filedBody: string;
  /** The title of a ticket filed with an empty first line. */
  untitled: string;
}

export interface Instance {
  instance: string;
  role: string;
  /** Name of the secret holding the SHA-256 hex of the instance's API secret. */
  secret: string;
}

export interface Settings {
  id: string;
  flow: Flow;
  mainBranch: string;
  /** The owner's tracker login (assigned in the inbox state). */
  ownerLogin?: string;
  /** Chat user ids of the owners. */
  owners: string[];
  instances: Instance[];
  texts: Texts;
  chat?: ChatRef & { username?: string };
  /** IANA time zone of the digest and "answered today". */
  timezone: string;
  digest: { from: number; to: number };
  /** The webhook base URL and the secret name for its token (the bot profile is set from here when given). */
  webhook?: { url: string; secret: string };
  profile?: { photo?: string };
}

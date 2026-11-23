// Bots the instance's bot creates and manages for workspaces (Telegram: managed bots). Optional: a chat without
// it offers only the instance's own bot in the wizard.
export interface BotAccess {
  restricted: boolean;
  /** User ids besides the bot's owner. */
  users: string[];
}

export interface Bots {
  /** The managed bot's token. */
  token(botId: string): Promise<string>;
  /** Revokes the token and returns a new one. */
  replaceToken(botId: string): Promise<string>;
  access(botId: string): Promise<BotAccess>;
  setAccess(botId: string, access: BotAccess): Promise<void>;
}

// The Chat port over the Telegram Bot API: rich views as sendRichMessage HTML with tg-button rows, updates from
// the webhook. The managed-bot methods are in `TelegramBots`; only the managed mode's wizard uses them.
import { Fail } from "../core/errors";
import type { BotAccess, Bots } from "../ports/bots";
import type {
  Block,
  BotSettings,
  Button,
  Chat,
  ChatEvent,
  ChatRef,
  ChatRequest,
  Command,
  CommandScope,
  Content,
  FileRef,
  TextOptions,
  View,
  ViewOptions,
} from "../ports/chat";

type User = { id: number };
type Msg = {
  message_id: number;
  message_thread_id?: number;
  chat: { id: number; type?: string };
  from?: User;
  is_topic_message?: boolean;
  chat_shared?: { chat_id: number };
  text?: string;
  caption?: string;
  reply_to_message?: { message_id: number; from?: User };
  media_group_id?: string;
  [k: string]: unknown;
};
type Query = { id: string; from: User; data?: string; message?: { message_id: number; message_thread_id?: number; chat: { id: number } } };

const button = (b: Button) =>
  b.data === undefined
    ? `<tg-button type="disabled">${b.label}</tg-button>`
    : `<tg-button type="callback_data"${b.style ? ` style="${b.style}"` : ""} data="${b.data}">${b.label}</tg-button>`;

function block(b: Block): string {
  if ("html" in b) return b.html;
  if ("buttons" in b) return `<tg-button-row align="center">${b.buttons.map(button).join("")}</tg-button-row>`;
  let s = `<table bordered striped compact><tr>${b.table.head.map((h) => `<th>${h}</th>`).join("")}</tr>`;
  for (const r of b.table.rows) s += `<tr>${r.cells.map((c) => `<td>${c}</td>`).join("")}<td>${button(r.button)}</td></tr>`;
  return `${s}</table>`;
}

/** A view as the HTML of a Telegram rich message. */
export const richHtml = (v: View) => v.map(block).join("");

const safeName = (name: string) => name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+|\.+$/g, "") || "file";

export function classify(m: Msg): Content {
  if (typeof m.text === "string") return { text: m.text };
  if (m.voice || m.video_note || m.audio) return "voice";
  const caption = m.caption ?? "";
  type F = { file_id: string; file_size?: number; file_name?: string; mime_type?: string; width?: number; height?: number };
  let file: FileRef | undefined;
  if (Array.isArray(m.photo) && m.photo.length) {
    const p = (m.photo as F[]).reduce((a, b) => ((b.width ?? 0) * (b.height ?? 0) > (a.width ?? 0) * (a.height ?? 0) ? b : a));
    file = { id: p.file_id, name: `screenshot-${m.message_id}.jpg`, image: true, size: p.file_size ?? 0 };
  } else if (m.document) {
    const d = m.document as F;
    file = { id: d.file_id, name: safeName(d.file_name ?? "file"), image: !!d.mime_type?.startsWith("image/"), size: d.file_size ?? 0 };
  } else if (m.video) {
    const v = m.video as F;
    file = { id: v.file_id, name: safeName(v.file_name ?? `video-${m.message_id}.mp4`), image: false, size: v.file_size ?? 0 };
  }
  return file ? { caption, files: [file] } : "unsupported";
}

const ref = (chat: { id: number }, topic?: number): ChatRef => (topic ? { chat: String(chat.id), topic } : { chat: String(chat.id) });

export class Telegram implements Chat {
  constructor(
    private token: string | undefined,
    private tokenName: string,
  ) {}

  private get botId() {
    return Number((this.token ?? "").split(":")[0]);
  }

  async call<R = { message_id: number }>(method: string, params: Record<string, unknown> | FormData): Promise<R> {
    if (!this.token) throw new Fail(502, "telegram", `Telegram is not connected (the secret ${this.tokenName} is missing).`);
    const form = params instanceof FormData;
    const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
      method: "POST",
      headers: form ? {} : { "content-type": "application/json" },
      body: form ? params : JSON.stringify(params),
    });
    const d = await res.json<{ ok: boolean; result: R; description?: string }>().catch(() => null);
    if (d?.ok) return d.result;
    // the same content again is fine
    if (d?.description?.includes("message is not modified")) return null as R;
    throw new Fail(502, "telegram", `Telegram refused ${method}: ${d?.description ?? res.status}.`);
  }

  private to = (at: ChatRef) => ({ chat_id: at.chat, ...(at.topic ? { message_thread_id: at.topic } : {}) });

  parse(update: unknown): ChatEvent | null {
    const u = update as { update_id?: unknown; message?: Msg; callback_query?: Query; managed_bot?: { user: User; bot: { id: number; username?: string; first_name?: string } } };
    if (typeof u?.update_id !== "number") return null;
    if (u.managed_bot?.bot)
      return {
        kind: "managed",
        update: u.update_id,
        from: String(u.managed_bot.user?.id),
        bot: { id: String(u.managed_bot.bot.id), username: u.managed_bot.bot.username, name: u.managed_bot.bot.first_name },
      };
    const q = u.callback_query;
    if (q)
      return {
        kind: "press",
        update: u.update_id,
        from: String(q.from?.id),
        query: q.id,
        data: q.data ?? "",
        ...(q.message ? { message: q.message.message_id, at: ref(q.message.chat, q.message.message_thread_id) } : {}),
      };
    const m = u.message;
    if (!m?.chat) return null;
    const r = m.reply_to_message;
    return {
      kind: "message",
      update: u.update_id,
      // a reply in a group without topics carries a thread id too; only a topic message names its topic
      at: ref(m.chat, m.chat.type === "private" || m.is_topic_message ? m.message_thread_id : undefined),
      from: String(m.from?.id),
      id: m.message_id,
      chatKind: m.chat.type === "private" ? "private" : "group",
      ...(m.chat_shared ? { shared: String(m.chat_shared.chat_id) } : {}),
      ...(typeof m.text === "string" ? { text: m.text } : {}),
      ...(r ? { replyTo: { id: r.message_id, fromBot: r.from?.id === this.botId } } : {}),
      ...(m.media_group_id ? { album: m.media_group_id } : {}),
      content: classify(m),
    };
  }

  /** The chat an update belongs to, for routing it to its workspace. */
  route(update: unknown): ChatRef | undefined {
    const e = this.parse(update);
    return e && "at" in e ? e.at : undefined;
  }

  async view(at: ChatRef, view: View, o: ViewOptions = {}): Promise<number> {
    const extra: Record<string, unknown> = {};
    if (o.forceReply) extra.reply_markup = { force_reply: true, input_field_placeholder: o.forceReply };
    if (o.replyTo) extra.reply_parameters = { message_id: o.replyTo, allow_sending_without_reply: true };
    return (await this.call("sendRichMessage", { ...this.to(at), rich_message: { html: richHtml(view) }, ...extra })).message_id;
  }

  async editView(at: ChatRef, id: number, view: View) {
    await this.call("editMessageText", { chat_id: at.chat, message_id: id, rich_message: { html: richHtml(view) } });
  }

  async text(at: ChatRef, text: string, o: TextOptions = {}): Promise<number> {
    const p: Record<string, unknown> = { ...this.to(at), text };
    if (o.html) Object.assign(p, { parse_mode: "HTML", link_preview_options: { is_disabled: true }, disable_notification: !!o.quiet });
    else if (o.noPreview) p.link_preview_options = { is_disabled: true };
    if (o.buttons) p.reply_markup = { inline_keyboard: o.buttons.map((r) => r.map((b) => ({ text: b.label, callback_data: b.data }))) };
    if (o.replyTo) p.reply_parameters = { message_id: o.replyTo };
    return (await this.call("sendMessage", p)).message_id;
  }

  async editText(at: ChatRef, id: number, text: string) {
    await this.call("editMessageText", { chat_id: at.chat, message_id: id, text });
  }

  async remove(at: ChatRef, id: number) {
    await this.call("deleteMessage", { chat_id: at.chat, message_id: id });
  }

  async dropButtons(at: ChatRef, id: number) {
    await this.call("editMessageReplyMarkup", { chat_id: at.chat, message_id: id, reply_markup: { inline_keyboard: [] } });
  }

  async react(at: ChatRef, id: number, emoji: string) {
    await this.call("setMessageReaction", { chat_id: at.chat, message_id: id, reaction: [{ type: "emoji", emoji }] });
  }

  async answer(query: string, text?: string) {
    await this.call("answerCallbackQuery", { callback_query_id: query, ...(text ? { text } : {}) });
  }

  async setCommands(commands: Command[], at?: ChatRef) {
    await this.call("setMyCommands", at ? { commands, scope: { type: "chat", chat_id: at.chat } } : { commands });
  }

  async download(file: FileRef): Promise<ArrayBuffer> {
    const { file_path } = await this.call<{ file_path: string }>("getFile", { file_id: file.id });
    // never let an error carry the download URL: it holds the bot token
    const dl = await fetch(`https://api.telegram.org/file/bot${this.token}/${file_path}`).catch(() => null);
    if (!dl?.ok) throw new Error(`download failed: ${dl?.status ?? "no answer"}`);
    return dl.arrayBuffer();
  }

  async setName(name: string) {
    await this.call("setMyName", { name });
  }
  async setDescription(description: string) {
    await this.call("setMyDescription", { description });
  }
  async setShortDescription(short_description: string) {
    await this.call("setMyShortDescription", { short_description });
  }
  async setPhoto(png: ArrayBuffer) {
    await this.call("removeMyProfilePhoto", {}).catch(() => {}); // every upload adds one; keep a single photo
    const form = new FormData();
    form.append("photo", JSON.stringify({ type: "static", photo: "attach://f" }));
    form.append("f", new Blob([png], { type: "image/png" }), "profile.png");
    await this.call("setMyProfilePhoto", form);
  }
  async setScopedCommands(commands: Command[], scope: CommandScope) {
    const s =
      scope === "default"
        ? { type: "default" }
        : scope === "private"
          ? { type: "all_private_chats" }
          : scope === "groups"
            ? { type: "all_group_chats" }
            : { type: "chat", chat_id: scope.chat };
    await this.call("setMyCommands", { commands, scope: s });
  }
  async setSettings(s: BotSettings) {
    await this.call("setMySettings", {
      can_read_all_group_messages: s.readAllGroupMessages,
      can_join_groups: s.canJoinGroups,
      has_topics_enabled: s.topicsInPrivate,
      has_topic_sidebar: s.topicsInPrivate,
      supports_inline_queries: s.inline,
      can_manage_bots: s.manageBots,
      callback_query_mode: "default",
    });
  }
  async request(at: ChatRef, html: string, r: ChatRequest): Promise<number> {
    const button =
      r.kind === "managedBot"
        ? { text: r.label, request_managed_bot: { request_id: 1, suggested_name: r.name, suggested_username: r.username } }
        : { text: r.label, request_chat: { request_id: 2, chat_is_channel: false, ...(r.forum === undefined ? {} : { chat_is_forum: r.forum }), bot_is_member: true } };
    const p = { ...this.to(at), text: html, parse_mode: "HTML", reply_markup: { keyboard: [[button]], resize_keyboard: true, one_time_keyboard: true } };
    return (await this.call("sendMessage", p)).message_id;
  }
  async dropKeyboard(at: ChatRef, text: string): Promise<number> {
    return (await this.call("sendMessage", { ...this.to(at), text, reply_markup: { remove_keyboard: true } })).message_id;
  }
  async sendFile(at: ChatRef, name: string, data: string, caption?: string): Promise<number> {
    const form = new FormData();
    for (const [k, v] of Object.entries(this.to(at))) form.append(k, String(v));
    if (caption) form.append("caption", caption);
    form.append("document", new Blob([data], { type: "application/json" }), name);
    return (await this.call("sendDocument", form)).message_id;
  }
  async setWebhook(url: string, secret: string) {
    await this.call("setWebhook", { url, secret_token: secret, allowed_updates: ["message", "callback_query"] });
  }
  async webhookUrl() {
    return (await this.call<{ url: string }>("getWebhookInfo", {})).url;
  }
}

/** Managed bots over the Bot API, called with the instance bot's token. */
export class TelegramBots implements Bots {
  constructor(private tg: Telegram) {}
  token(botId: string) {
    return this.tg.call<string>("getManagedBotToken", { user_id: Number(botId) });
  }
  replaceToken(botId: string) {
    return this.tg.call<string>("replaceManagedBotToken", { user_id: Number(botId) });
  }
  async access(botId: string): Promise<BotAccess> {
    const a = await this.tg.call<{ is_access_restricted: boolean; added_users?: { id: number }[] }>("getManagedBotAccessSettings", { user_id: Number(botId) });
    return { restricted: a.is_access_restricted, users: (a.added_users ?? []).map((u) => String(u.id)) };
  }
  async setAccess(botId: string, a: BotAccess) {
    await this.tg.call("setManagedBotAccessSettings", {
      user_id: Number(botId),
      is_access_restricted: a.restricted,
      ...(a.restricted ? { added_user_ids: a.users.map(Number) } : {}),
    });
  }
}

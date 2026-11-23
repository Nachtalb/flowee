# Telegram: profiles, settings, groups and topics

What Flowee sets on its bots and why. Each item is applied on `GET /setup` (the deploy calls it) and when the
configuration changes, and only when its value changed (a SHA-256 of the value is kept per item), so redeploys
stay inside Telegram's limits on profile changes.

## Which bot takes its profile from where

- **The instance bot** (managed mode): from `instance.profile` (docs/configuration.md), else Flowee's texts and
  the bundled photo (`src/adapters/photo.ts`). It serves the wizard and every workspace that chose "this bot", so
  its profile never names one workspace.
- **A workspace's own bot**: from its workspace (`texts.botName`, `texts.about`, `texts.shortAbout`,
  `profile.photo`), exactly as the standalone bot.
- **The standalone bot**: from the workspace with `chat.publicUrl`.

Descriptions say what the bot is for, never who it is for.

## Commands per scope

| Bot | Scope | Commands |
|---|---|---|
| instance bot | all private chats | `start` what Flowee does, `setup`, `workspaces`, `import`, `export` |
| a workspace's bot (own or standalone) | default | the envoy's `start`, `todo`, `postponed`, `new` (docs/parity.md row 1) |
| any bot serving a workspace | the bound chat (`chat` scope) | the envoy's commands with their counts (row 2) |

Telegram has no command scope for one forum topic: in a group bound by one topic, the counts menu shows in the
whole group; typed commands are only answered inside the bound topic.

## setMySettings

| Setting | Instance bot | Own bot | Why |
|---|---|---|---|
| `can_read_all_group_messages` | `false` | `false` | Privacy mode on. The envoy only needs commands and replies to its own messages, which bots receive in privacy mode; it never reads the rest of a group. |
| `can_join_groups` | `true` | `true` | Workspaces may be bound to a group or one topic of it. |
| `has_topics_enabled`, `has_topic_sidebar` | `false` | `false` | Private chats with the bot stay one plain chat: the envoy's bar and cards are one stream, and a topic per workspace in a private chat would split replies from cards. |
| `supports_inline_queries` | `false` | `false` | Flowee has no inline mode. |
| `can_manage_bots` | `true` | `false` | Only the instance bot creates and manages workspace bots. |
| `callback_query_mode` | `default` | `default` | Buttons always arrive with their message, which the envoy edits in place. |

The standalone bot's settings are left as its owner made them in BotFather.

## Webhooks

The instance bot: `<publicUrl>/telegram` with `instance.bot.webhookSecret`, updates `message`, `callback_query`,
`managed_bot`. An own bot: `<publicUrl>/telegram/w/<workspace>` with its own random secret (sealed), set by the
wizard right after the bot is created (so `/bind` in a group reaches it), again after a token replacement and on
every `/setup` where it changed. Updates are routed by the path (which bot) and then by chat and topic.

## Groups and topics

- A workspace is bound to a private chat, a group, or one topic of a forum group (`chat.chatId` + `chat.topicId`).
  Everything it sends carries the topic (`message_thread_id`); only updates from that chat and topic count.
- Who may answer: the workspace's owners (`owners[].chat`), by user id. Everyone else in the group is ignored
  silently: no reply, no reaction, their button presses unanswered, so a shared group stays quiet.
- With privacy mode on, the bot sees in a group only commands and replies to its messages. Answering in a group
  therefore means replying to a card (as the ForceReply prompt asks); the private-chat habit of typing under the
  current card without replying is not seen by the bot there. Everything else of docs/parity.md works the same.
- In a group without topics, Telegram also sets a thread id on replies; Flowee reads a topic only from messages
  marked as topic messages, so such replies still belong to the whole-group binding.

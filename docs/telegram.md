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
| a workspace's bot (own or standalone) | default | the envoy's `start`, `todo`, `postponed`, `new` (docs/envoy.md row 1) |
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

How the live Bot API answers (checked against the instance bot with `getMe`, which returns `BotFullInfo`): all
seven parameters are accepted together in one call and read back as sent. `has_topics_enabled: true` also turns on
`allows_users_to_create_topics`, `false` turns it off again. `has_topic_sidebar: true` is answered `ok` but stays
`false` while `has_topics_enabled` is off. `callback_query_mode` takes `default`, `auto` and `inline` (anything else:
`400 unsupported callback query mode specified`) and is not part of `BotFullInfo`, so it cannot be read back.

No default administrator rights are requested (`setMyDefaultAdministratorRights`): in a group the bot only sends,
edits and deletes its own messages and reads commands and replies, none of which needs a right; the one message
it deletes that is not its own (the GitHub token) is in the private chat.

## Reply keyboards: only to create a bot

Every screen of the wizard and the menu is a rich message with its buttons in the body (`<tg-button>`:
`callback_data`, `url`, `copy_text`). A rich message button (`RichMessageButton`) can be a URL, callback data, a
Web App, a login URL, an inline query switch or a copy button; it cannot ask the user to create a bot or pick a
chat. Those two are `KeyboardButton` fields only:

> `request_managed_bot` | KeyboardButtonRequestManagedBot | Optional. If specified, pressing the button will ask the
> user to create and share a bot that will be managed by the current bot. … Available in private chats only.

> `request_chat` | KeyboardButtonRequestChat | Optional. If specified, pressing the button will open a list of
> suitable chats. … Available in private chats only.

- **Create the bot** (wizard step 2, a new bot of its own) has no inline alternative, so it is the one reply
  keyboard: while that step is on screen a helper rich message under it carries the keyboard (`resize_keyboard`,
  `one_time_keyboard`), and the screen says what to press. The moment the step is done or left (the bot arrives,
  ◀ Back, ✖ Cancel), a message with `ReplyKeyboardRemove` takes the keyboard away and both it and the helper are
  deleted.
- **Pick a group** needs no keyboard: the URL button `t.me/<bot>?startgroup=<code>` opens Telegram's group picker,
  adds the bot and makes the user send `/start <code>` there, which binds the group like `/bind <code>`.

Checked against the live Bot API with a chat that does not exist (Telegram validates `reply_markup` before it looks
the chat up, but parses rich HTML after): the keyboard with `request_managed_bot` and `remove_keyboard` on
`sendRichMessage` pass validation (`chat not found`), malformed ones are refused (`Field "request_id" must be a
valid Number`). The rich HTML itself cannot be checked that way.

## Webhooks

The instance bot: `<publicUrl>/telegram` with `instance.bot.webhookSecret`, updates `message`, `callback_query`,
`managed_bot`. An own bot: `<publicUrl>/telegram/w/<workspace>` with its own random secret (sealed), set by the
wizard right after the bot is created (so `/bind` in a group reaches it), again after a token replacement and on
every `/setup` where it changed. Updates are routed by the path (which bot) and then by chat and topic.

## Groups and topics

- A workspace is bound to a private chat, a group, or one topic of a forum group (`chat.chatId` + `chat.topicId`).
  Everything it sends carries the topic (`message_thread_id`); only updates from that chat and topic count.
- **A group or topic is a team.** Every member there works the inbox: presses the buttons, answers by replying to a
  card, sends files. Telegram delivers an update from that chat and topic, and that makes its sender a member;
  `chat.members` (user ids) narrows it to those people, the owners (`owners[].chat`) always count. Anyone else, and
  every other chat or topic, is ignored silently. Each answer on the ticket is signed with who gave it
  (`texts.memberSign`, default `{who}`: `Bea Berg (@bea):`); the first answer to a card wins, and a second person is
  told in one sentence who answered (docs/envoy.md, "Teams"). In a private chat the owner's signature stays.
- **Managing is not the team's**: configuration, secrets, pause, delete and export stay with the one who set the
  workspace up and the `managers` the document names (docs/managed.md).
- **Privacy mode stays on** (`can_read_all_group_messages: false`): with it the bot receives in a group exactly what
  a team needs, the commands addressed to it, replies to its own messages (a card, the bar, a filing note; a file
  sent as a reply too) and the button presses; nothing a team requires needs the rest of the group's talk, and the
  bot never sees it. Answering in a group therefore means replying to a card (as the ForceReply prompt asks), and
  each reply is a whole answer: the private chat's drafts typed under the current card do not exist there.
- **The confirmation in a group stays a normal message**, not an ephemeral one: Bot API 10.5 lets a bot send an
  ephemeral message only within 15 seconds of a callback query or an incoming ephemeral message, or at any time
  as a chat administrator. The binding is a `/start <code>` or `/bind <code>` message (neither), and Flowee asks
  for no administrator rights; the note is also meant for the whole team (`✅ Tickets of <id> appear here`).
- In a group without topics, Telegram also sets a thread id on replies; Flowee reads a topic only from messages
  marked as topic messages, so such replies still belong to the whole-group binding.

# The managed mode: setup wizard, management, import

`FLOWEE_MODE=managed` turns one Worker into an instance that many people can set up workspaces on, in the chat.
Everything runs in the Worker: the Instance Durable Object keeps the workspaces (a stored `WorkspaceRegistry`),
their sealed secrets, the wizard sessions and the bots made for workspaces; each workspace keeps its own
Durable Object as in the standalone mode. The code is chat-agnostic (`src/wizard/`: steps, prompts, choices,
validation) and reaches the chat through the `Chat` port; the Telegram adapter maps views to messages and buttons.

## The wizard (`/setup`, or `/start` → 🚀 Set up a workspace, in a private chat with the instance bot)

The whole setup is one message that each step edits (docs/chat-style.md): the heading `🆕 New workspace · Step k of
n`, the step's question in bold, one line of help, the choices as buttons. A typed answer (a repository, the token) is
deleted right after it is read, and the result shows in the same message, a mistake as one `⚠️` sentence under the
question.

| Step | Asks | Notes |
|---|---|---|
| 1 Repository | "Which GitHub repository is this workspace for?": the link as pasted, or `owner/name`; several at once | `https://github.com/o/n/issues/3`, `github.com/o/n`, `git@github.com:o/n.git`, `<…>` all work (the tracker adapter reads them, an Enterprise host too). The workspace id comes from the first repository's name (unique: `-2`, `-3`). With several, tickets are `alias#n`, the alias being the repository's name. Back offers ✅ Keep. |
| 2 Bot | 💬 This bot or 🤖 A new bot | A new bot: its own name, picture and commands. 🤖 Create the bot is the one reply keyboard (`KeyboardButtonRequestManagedBot`, name and username suggested from the repository; docs/telegram.md); the `managed_bot` update hands the bot over: its token is fetched (`getManagedBotToken`), sealed, its webhook set to `<publicUrl>/telegram/w/<id>` with its own secret; the keyboard and its helper message go, and so does Telegram's note about the new bot. |
| 3 Way of working | 🌳 Simple (`trunk`) or 🧰 Simple with extras (`pr-release`), then the extras that preset offers as ✅/⬜ toggles with one line each | A preset without extras goes on with one tap. Presets: `src/config/presets.ts`. |
| 4 Where tickets appear | 💬 Here, in this chat (own bot: 💬 In my private chat, with ↗ Open @bot); 👥 In a group | The group screen: 👥 Choose a group (the link `t.me/<bot>?startgroup=<id>`: Telegram adds the bot and sends `/start <id>` in the group, which binds it) or, for one topic of a forum group, 📋 Copy `/bind <id>` and send it inside the topic. Only the user running the setup can bind; the group gets `✅ Tickets of <id> appear here`. |
| 5 GitHub token | The token as a message | 🔑 Create a token opens GitHub's form with the permissions filled in (`githubToken` in the GitHub adapter; the permissions are listed folded). The message is deleted at once (if Telegram refuses, the screen asks the user to delete it); the token is checked against every repository (`GET /repos/<repo>` → 200), sealed, never shown again or exported. |
| 6 Agents | − / + per role of the flow, one agent of each to start | The owner role instance is always added; roles that need an extra (the sampler) only with it. |
| Last check | ✅ Create the workspace | Creates the workspace, sets the own bot's profile, settings and webhook, then the screen says `✅ Workspace ready` and the agents' secrets come **once** as a file (a new message: it must stay) with a ready `.flowee.toml`; only their SHA-256 is stored. |

Every step has ◀ Back and ✖ Cancel. An unfinished setup is kept: `/setup` again offers ▶ Continue or 🆕 Start
over; after a day without an answer it expires (the next touch says so; nothing was created). Who may create
workspaces: `instance.creators` (default: the instance owner), at most `instance.limits.workspacesPerUser` each.

## Management (`/workspaces`)

The same living message: `📂 Your workspaces` as a table with an `Open` button per workspace; a workspace's screen
lists what it is and edits in place into each sub-screen, with a toast for done actions. Only the workspaces the
user owns. Per workspace: show; ✏️ edit the repositories, the way of working, where tickets appear, the GitHub
token or the agents (the same wizard steps under `✏️ Change <id>`, then ✅ Save the changes); 🔑 a new secret for one agent (the old
one stops at once; the new one is shown once); 📤 export; own bot: ♻️ a new token (`replaceManagedBotToken`,
webhook set again) and 🔐 access (`get/setManagedBotAccessSettings`: only me / everyone); ⏸ pause / ▶ resume
(paused: the API answers `503 paused`, chat updates and the cron rest); 🗑 delete (confirmed; the
configuration, secrets and stored state go, the repositories stay).

## Export and import

- `/export`: all the user's workspaces as `flowee.json` (an instance document); 📤 in the menu: one workspace.
  Never a secret: documents name secret slots only.
- Import: send a `.json` file to the instance bot, or send `/import` (or 📥 Import) and paste the JSON as the next
  message (pasted JSON without that is not taken for a document; the pasted message is deleted after reading). The
  document is validated with the same validator as everywhere; every problem is one line starting with its JSON
  path (`$.tracker.repos: must have at least 1 item(s).`), in the living message. A valid one is summarised at the
  top of the first screen (`create x` / `replace x`; an id owned by someone else is refused), then the wizard asks
  **only what is missing**: the own bot when the
  document says `chat.managed` and none exists, and the GitHub token unless the workspace being replaced already
  has one (a document without `chat` stays API-only). Agents' secrets
  are generated for every agent without one and handed over once. An instance document with several workspaces
  is set up one after the other.
- This is the path for "an agent writes the configuration, the user submits it": the agent writes the document
  (schema/workspace.schema.json, docs/configuration.md), the user sends it to the bot and answers one or two
  prompts.
- The configuration API does the same for automation (docs/api.md, "Configuration API").

## Routing

| Arrives on | Goes to |
|---|---|
| `/telegram` (instance bot, its secret) | `managed_bot` updates, `w:`/`m:` buttons, private-chat commands `/setup` `/workspaces` `/import` `/export`, `.json` files, a document pasted after `/import`, text for an open wizard step, `/bind <code>` or `/start <code>` in a group: the wizard. Anything else from a chat (and topic) bound to a workspace served by the instance bot: that workspace's envoy. Else, in a private chat: the introduction. |
| `/telegram/w/<id>` (an own bot, its own secret) | `/bind <code>` or `/start <code>` of a setup waiting for it; else the workspace `<id>`. A wrong secret: 403. |
| `/v1/…` with a token, `/w/<id>/v1/…` | the workspace whose agent the token is (stored registry); paused: 503. |
| `/w/<id>/config` with an agent token of that workspace | its document (no secrets). |
| `/admin/…` with `FLOWEE_ADMIN_TOKEN` | the configuration API. |

The envoy itself is unchanged: it serves only the owners' messages from its bound chat and topic.

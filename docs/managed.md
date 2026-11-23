# The managed mode: setup wizard, management, import

`FLOWEE_MODE=managed` turns one Worker into an instance that many people can set up workspaces on, in the chat.
Everything runs in the Worker: the Instance Durable Object keeps the workspaces (a stored `WorkspaceRegistry`),
their sealed secrets, the wizard sessions and the bots made for workspaces; each workspace keeps its own
Durable Object as in the standalone mode. The code is chat-agnostic (`src/wizard/`: steps, prompts, choices,
validation) and reaches the chat through the `Chat` port; the Telegram adapter maps views to messages and buttons.

## The wizard (`/setup`, or `/start` → 🚀 Set up a workspace, in a private chat with the instance bot)

| Step | Asks | Notes |
|---|---|---|
| 1 Bot | 🤖 Own bot or 💬 This bot | Own: a new bot just for the workspace (its own name, photo, commands). |
| 2 Repositories | `owner/name`, one or several | The workspace id comes from the first repository's name (unique: `-2`, `-3`). With several, tickets are `alias#n`, the alias being the repository's name. |
| Own bot | 🤖 Create the bot (`KeyboardButtonRequestManagedBot`, name and username suggested from the repository) | The `managed_bot` update hands the bot over: its token is fetched (`getManagedBotToken`), sealed, and its webhook set to `<publicUrl>/telegram/w/<id>` with its own secret. |
| 3 Flow | The presets found in `flows/` (`src/config/presets.ts`), then the feature switches the preset's options list, as toggles | |
| 4 Where | 💬 This private chat; or a group: add the bot, send `/bind <id>` in the group (inside a topic to bind only that topic); the instance bot also offers 👥 Pick a group (`KeyboardButtonRequestChat`) | Only the user running the setup can bind. The binding stores chat id + topic id; everything the workspace sends goes there. |
| 5 GitHub token | The token as a message | The message is deleted at once (the prompt says so); the token is checked against every repository (`GET /repos/<repo>` → 200), sealed, never shown again or exported. The prompt lists the minimal permissions, plus those of the switched-on features. |
| 6 Agents | Count per role of the flow with − / + | The owner role instance is always added. |
| Summary | ✅ Create | Creates the workspace, sets the own bot's profile, settings and webhook, then sends the agents' secrets **once** as a file with a ready `.flowee.toml`; only their SHA-256 is stored. |

Every step has ◀ Back and ✖ Cancel. An unfinished setup is kept: `/setup` again offers ▶ Resume or 🆕 Start
over; after a day without an answer it expires (the next touch says so; nothing was created). Who may create
workspaces: `instance.creators` (default: the instance owner), at most `instance.limits.workspacesPerUser` each.

## Management (`/workspaces`)

Only the workspaces the user owns. Per workspace: show; ✏️ edit the repositories, the flow, the chat, the GitHub
token or the agents (the same wizard steps, then the summary to confirm); 🔑 a new secret for one agent (the old
one stops at once; the new one is shown once); 📤 export; own bot: ♻️ a new token (`replaceManagedBotToken`,
webhook set again) and 🔐 access (`get/setManagedBotAccessSettings`: only me / everyone); ⏸ pause / ▶ resume
(paused: the API answers `503 paused`, chat updates and the cron rest); 🗑 delete (confirmed; the
configuration, secrets and stored state go, the repositories stay).

## Export and import

- `/export`: all the user's workspaces as `flowee.json` (an instance document); 📤 in the menu: one workspace.
  Never a secret: documents name secret slots only.
- Import: send a `.json` file to the instance bot, or send `/import` and paste the JSON as the next message (pasted
  JSON without `/import` before it is not taken for a document). The
  document is validated with the same validator as everywhere; every problem is one line starting with its JSON
  path (`$.tracker.repos: must have at least 1 item(s).`). A valid one is summarised (`create x` / `replace x`;
  an id owned by someone else is refused), then the wizard asks **only what is missing**: the own bot when the
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
| `/telegram` (instance bot, its secret) | `managed_bot` updates, `w:`/`m:` buttons, private-chat commands `/setup` `/workspaces` `/import` `/export`, `.json` files, a document pasted after `/import`, text for an open wizard step, `/bind <code>` in a group: the wizard. Anything else from a chat (and topic) bound to a workspace served by the instance bot: that workspace's envoy. Else, in a private chat: the introduction. |
| `/telegram/w/<id>` (an own bot, its own secret) | `/bind <code>` of a setup waiting for it; else the workspace `<id>`. A wrong secret: 403. |
| `/v1/…` with a token, `/w/<id>/v1/…` | the workspace whose agent the token is (stored registry); paused: 503. |
| `/w/<id>/config` with an agent token of that workspace | its document (no secrets). |
| `/admin/…` with `FLOWEE_ADMIN_TOKEN` | the configuration API. |

The envoy itself is unchanged: it serves only the owners' messages from its bound chat and topic.

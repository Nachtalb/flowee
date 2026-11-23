# The managed mode: setup wizard, management, import

`FLOWEE_MODE=managed` turns one Worker into an instance that many people can set up workspaces on, in the chat.
Everything runs in the Worker: the Instance Durable Object keeps the workspaces (a stored `WorkspaceRegistry`),
their sealed secrets, the wizard sessions and the bots made for workspaces; each workspace keeps its own
Durable Object as in the standalone mode. The code is chat-agnostic (`src/wizard/`: steps, prompts, choices,
validation) and reaches the chat through the `Chat` port; the Telegram adapter maps views to messages and buttons.

## The wizard (`/setup`, or `/start` → 🚀 Set up a workspace, in a private chat with the instance bot)

The whole setup is one message that each step edits (docs/chat-style.md): the heading `🆕 New workspace · Step k of
n`, the step's question in bold, one line of help, the choices as table rows: each row an option's name, its one-line
description and its own button; Back, Next and Cancel in the bottom row. A typed answer (a repository, the token) is
deleted right after it is read, and the result shows in the same message, a mistake as one `⚠️` sentence under the
question.

| Step | Asks | Notes |
|---|---|---|
| 1 Repository | "Which repository is this workspace for?": the link as pasted from GitHub or GitLab, or `owner/name`; several at once | `https://github.com/o/n/issues/3`, `github.com/o/n`, `git@github.com:o/n.git`, `<…>`, `https://gitlab.com/g/sub/p/-/issues/3` all work: the tracker registry (`recognise()` in `src/adapters/trackers.ts`, each kind's `parseRepo`) reads them, an Enterprise host too; a self-managed GitLab is recognised by a host starting with `gitlab.` or GitLab's `/-/` routes, its API taken as `https://<host>/api/v4`. The screens say which tracker it recognised (`Now: … on GitLab`, the summary). One tracker per paste: a workspace on several trackers is written as a configuration and imported (docs/configuration.md). The workspace id comes from the first repository's name (unique: `-2`, `-3`). With several, tickets are `alias#n`, the alias being the repository's name. Back offers ✅ Keep. |
| 2 Bot | Rows: 💬 This bot · 🤖 A new bot, each with its Choose button | A new bot: its own name, picture and commands. 🤖 Create the bot is the one reply keyboard (`KeyboardButtonRequestManagedBot`, name and username suggested from the repository; docs/telegram.md); the `managed_bot` update hands the bot over: its token is fetched (`getManagedBotToken`), sealed, its webhook set to `<publicUrl>/telegram/w/<id>` with its own secret; the keyboard and its helper message go, and so does Telegram's note about the new bot. |
| 3 Way of working | First the branching, exactly one row: 🌿 Single branch · 🔀 Feature branches. Then the toggles, each a row with its state, name, description and Switch on/off button: Versioning, and under **More options** Samples, UI review, Dependency updates, Outside reports | Versioning and the options stay as set when the branching changes. UI review is refused in one sentence unless the configuration names its paths. The document gets `flow.preset` `trunk` (Single branch) or `pr-release` (Feature branches) and every switch in `features` (docs/flow-features.md). |
| 4 Where tickets appear | Rows: 💬 Here (own bot: 💬 In my private chat, with ↗ Open in the same row); 👥 In a group | The group screen, two rows: 👥 A whole group with 👥 Choose a group (the link `t.me/<bot>?startgroup=<id>`: Telegram adds the bot and sends `/start <id>` in the group, which binds it) and 🧵 One topic of a forum group with 📋 Copy (`/bind <id>`, sent inside the topic). Only the user running the setup can bind; the group gets `✅ Tickets of <id> appear here`. |
| 5 Tracker token | The token as a message | 🔑 Create a token opens the tracker's form with what its link can fill in (the registry's `tokenHelp`; a one-column table of permissions). GitHub: name, description, resource owner (`target_name`), the permissions and the expiry (`expires_in`, `tracker.tokenDays`, default 366); its link cannot preselect repositories, so a highlighted 👉 row says to choose Only select repositories and pick them. GitLab, one project: its project access token page (no prefill: a 👉 row names the token, role, scope and expiry) with a prefilled personal token (name, description, scope) as the other row; several projects: the personal token. After the probe, the token's reach is listed (`reach()`: GitHub `/user/repos`, GitLab `/projects?membership=true`); when it sees other repositories the screen says so in one sentence and offers ✅ Use it anyway or 🔑 Make a narrower one. The message is deleted at once (if Telegram refuses, the screen asks the user to delete it); the token is checked against every repository with that tracker's adapter (`probe()` → 200), sealed, never shown again or exported. |
| 6 Agent identities | "Each agent signs in with its own secret, so Flowee knows who holds which ticket. Start with these; you can add or remove agents any time." A row per role of the flow: name, what it does, − count + in the same row; one agent of each to start | Not capacity planning: an instance (`dev1`) is an identity, which a claim, its lease and `next` resuming one's own ticket hang on. The owner role instance is always added; roles an extension or option adds only with it. |
| Last check | What it will be as a two-column table, then ✅ Create the workspace | Creates the workspace, sets the own bot's profile, settings and webhook, then the screen says `✅ Workspace ready` with "These are your agents' sign-in secrets for flowee.py … then delete the file.", and the agents' secrets come **once** as a file (a new message: it must stay) that explains itself: per agent a block storing its secret with mode 600 (`install -m 600 /dev/stdin`, nothing in a command's arguments), then the `.flowee.toml` for the repository (docs/agents/README.md, "The secrets file"). Under the file: 🗑 Delete this file from the chat and ❓ How do I use these?; only the secrets' SHA-256 is stored. |

Every step has ◀ Back and ✖ Cancel. An unfinished setup is kept: `/setup` again offers ▶ Continue or 🆕 Start
over; after a day without an answer it expires (the next touch says so; nothing was created). Who may create
workspaces: `instance.creators` (default: the instance owner), at most `instance.limits.workspacesPerUser` each.

## Management (`/workspaces`)

The same living message: `📂 Your workspaces` as a table with an `Open` button per workspace; a workspace's screen
shows what it is as a two-column table with ✏️ Change in the row of each editable part, then its actions as rows
(name, what it does, its button), and edits in place into each sub-screen, with a toast for done actions. Only the workspaces the
user set up or is a manager of (`managers` in the document); anyone else pressing a menu button is told `Only the
people who manage <id> can change it; ask the one who set it up.` The team in a bound group works the tickets but
never manages the workspace. Per workspace: show; ✏️ edit the repositories, the way of working, where tickets appear, the GitHub
token (the same wizard steps under `✏️ Change <id>`, then ✅ Save the changes); ➕ add an agent (pick its role: one
new identity, `dev2`, `tester2`, its secret shown once, the others untouched); ➖ remove an agent (confirmed: its
secret stops at once, the tickets it holds go back to the queue as for a lapsed lease, the others untouched); 🔑 a
new secret for one agent (the old one stops at once; the new one is shown once); 📤 export; own bot: ♻️ a new token (`replaceManagedBotToken`,
webhook set again) and 🔐 access (`get/setManagedBotAccessSettings`: only me / everyone); ⏸ pause / ▶ resume
(paused: the API answers `503 paused`, chat updates and the cron rest, tracker webhooks are acknowledged and
ignored); ⚡ instant updates: the screen says `⚡ Instant updates: on`, or `off for <alias> (<reason>)` with **⚡ Turn
on instant updates**, which names the token permission Flowee lacks to register the tracker's webhook itself and
offers the webhook's address and a new secret (shown once) to paste into the tracker by hand (docs/webhooks.md);
🗑 delete (confirmed; the configuration, secrets, stored state and the webhooks Flowee registered go, the
repositories stay).

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

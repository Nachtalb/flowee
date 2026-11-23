---
name: flowee-install
description: "Use when setting Flowee up. Deploy, secrets, clones, verify."
---

# Flowee: install and set up

Set up a Flowee instance (a Cloudflare Worker) and a project that uses it. Two modes; pick with the user first:

| Mode | When | Who configures |
|---|---|---|
| **standalone** (the document has no `instance`) | one team, fixed workspaces | you: the workspace document is deployed with the Worker |
| **managed** (the document has an `instance` section) | several people or projects set up workspaces themselves | you deploy once; each user runs the setup wizard in the chat |

The deployment's document is `flowee.config.local.json` (git-ignored: owner ids, chat ids and URLs never reach the
public repository). `bun run deploy` validates it, sets `FLOWEE_MODE` from it, uploads it as the `FLOWEE_CONFIG`
secret with the version and calls `<publicUrl>/setup`. Never edit `wrangler.toml` or `flowee.config.json` for one
deployment.

The workspace document itself: skill `flowee-configure`. Agents' daily use: skill `flowee-use`. The exact
verification commands and what they print: `references/verify.md`. Project repository, role clones, secrets files
and scheduled runs: `references/project-setup.md`.

## Rules

- **Never print a secret.** Pipe values straight into `wrangler secret put NAME` (from a password manager, a file,
  or `openssl rand -hex 32`); never echo them, never pass them as arguments, never write them into the repository.
- **Ask before deploying to the user's account**; check `bunx wrangler whoami` first.
- **Validate before deploy**: `bun run validate flowee.config.local.json` must print `ok` (`bun run deploy` checks it
  again and refuses an invalid one).
- **Verify each step** with the commands in `references/verify.md`; report what they printed, not what should
  happen.
- **Tests never touch a real remote.** `bun run test` and `test/e2e/wire.py` use fakes and a local stand-in GitHub.

## Standalone

1. `git clone https://github.com/Nachtalb/flowee && cd flowee && bun install`; `bun run typecheck && bun run test`.
2. Write the workspace document (skill `flowee-configure`) as `flowee.config.local.json`:
   `{"flowee": 1, "workspaces": [<doc>]}`. `bun run validate flowee.config.local.json`.
3. Telegram: create the bot with BotFather; note its username for `chat.username`. The owner's chat id: the user
   sends the bot a message and reads `getUpdates`, or uses a known id. Before using a token, `getMe` must name the
   expected bot, and `getWebhookInfo` must show no webhook (else the bot is in use elsewhere: stop and ask).
4. GitHub token: fine-grained, limited to the workspace's repositories, with the permissions of
   `references/project-setup.md` ("Token permissions"). A `tracker.project` board needs a classic `repo` + `project` token
   instead (a fine-grained token cannot write a user-owned project): put that trade-off to the user.
5. Secrets: every name the document references, each value on stdin (the first `secret put` creates the Worker;
   wrangler answers its "create a new Worker?" question with yes when stdin is not a terminal).
   - tracker and bot tokens: `wrangler secret put <NAME>` with the value on stdin;
   - `chat.webhookSecret`: a random string (`openssl rand -hex 32 | bunx wrangler secret put TG_WEBHOOK_SECRET`);
   - each agent: generate a secret, give it to the agent's secrets file, and store only its SHA-256:
     `printf %s "$S" | sha256sum | cut -d' ' -f1 | bunx wrangler secret put ACME_DEV1`.
6. `bun run deploy`: it prints `GET <url>/setup: 200 {...}` with each profile step `set` or `current` and exits
   non-zero when the deploy or `/setup` failed. `chat.publicUrl` must be the Worker's URL
   (`https://<worker>.<subdomain>.workers.dev`; wrangler prints it).
7. Verify (`references/verify.md`), then set up the project repository and the agents (`references/project-setup.md`).

## Managed

1. As standalone step 1.
2. The instance document (`flowee-configure`, example 6) as `flowee.config.local.json`: `instance.bot` (secret names
   of the token and webhook secret, `username`), `publicUrl`, `owner` (the user's Telegram id), `creators`, limits;
   `"workspaces": []`. The workers.dev subdomain: wrangler prints the URL on the first deploy; set `publicUrl` before
   it (`GET /accounts/<id>/workers/subdomain`) or deploy again after correcting it.
3. Secrets, each on stdin, never printed or on a command line: the instance bot's token and webhook secret (random),
   `FLOWEE_KEY` (random; seals every secret entered in the chat), `FLOWEE_ADMIN_TOKEN` (random; the configuration
   API). Keep `FLOWEE_KEY` and the admin token where the operator finds them again (a password manager, or files of
   mode 600 in a 700 directory): a lost `FLOWEE_KEY` makes every stored secret unreadable. `wrangler secret list`
   then names the four (plus `FLOWEE_CONFIG` after the deploy).
4. `bun run deploy`. The instance entry of the printed `/setup` result has `name`, `description`,
   `short_description`, `commands`, `settings`, `photo`, `webhook`. `settings` also turns on bot management
   (`can_manage_bots`), so BotFather needs no step. Read the result back with `getMe`, `getMyCommands` (scope
   `all_private_chats`) and `getWebhookInfo` (`references/verify.md`).
5. Check the configuration API (`references/verify.md`, "Managed"): the workspace list empty, a wrong token 401.
6. Hand over to the user: in a private chat with the bot, `/setup` (or send a document an agent wrote). The wizard
   asks for the bot, repositories, flow, chat, GitHub token (the message is deleted at once) and agent counts, and
   sends the agents' secrets once with a ready `.flowee.toml`. That part is the user's; you do not see the secrets.
   Do not message the user's chat yourself to test it.
7. Automation instead of the chat: `PUT /admin/workspaces/<id>` and `PUT /admin/workspaces/<id>/secrets` with
   `Authorization: Bearer <FLOWEE_ADMIN_TOKEN>` (`references/verify.md`).

## Pitfalls found while building it

- A stray `~/.wrangler/` (left by test runs) takes precedence over `~/.config/.wrangler/` and hides the wrangler
  login: wrangler then asks for `CLOUDFLARE_API_TOKEN`. `ls -d ~/.wrangler` before deploying; remove it.
- Python's default `Python-urllib` User-Agent gets `403 error code: 1010` from Cloudflare even on `*.workers.dev`.
  `flowee.py` sends `flowee/<version>`; any other client must send its own User-Agent too.
- Changing `FLOWEE_KEY` makes every secret stored through the chat unreadable; every workspace then needs its
  tokens again. Keep the key in a password manager.
- A fine-grained GitHub token cannot write a user-owned Project (v2). Without `tracker.project` the labels are the
  state and the narrow token suffices.
- `roles[].secret` holds the SHA-256 hex of the agent's secret, never the secret: a raw secret there means no agent
  can authenticate (`401 unauthorized`).
- One repository belongs to one workspace per instance; a second workspace naming it is refused.
- In a group, the bot runs in privacy mode: the owner answers by replying to a card.
- A changed document takes effect only with a new `bun run deploy` (standalone: the workspaces; managed: the instance
  section). A plain `wrangler deploy` uses the `FLOWEE_MODE` of `wrangler.toml` (standalone) and skips `/setup`.
- `setMySettings` as the live API answers it (docs/telegram.md): `has_topic_sidebar` only sticks while
  `has_topics_enabled` is on; `callback_query_mode` is not readable back.

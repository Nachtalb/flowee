---
name: flowee-install
description: "Use when setting Flowee up. Deploy, secrets, clones, verify."
---

# Flowee: install and set up

Set up a Flowee instance (a Cloudflare Worker) and a project that uses it. Two modes; pick with the user first:

| Mode | When | Who configures |
|---|---|---|
| **standalone** (`FLOWEE_MODE = "standalone"`, the default) | one team, fixed workspaces | you: the workspace document is deployed with the Worker |
| **managed** (`FLOWEE_MODE = "managed"`) | several people or projects set up workspaces themselves | you deploy once; each user runs the setup wizard in the chat |

The workspace document itself: skill `flowee-configure`. Agents' daily use: skill `flowee-use`. The exact
verification commands and what they print: `references/verify.md`. Project repository, role clones, secrets files
and scheduled runs: `references/project-setup.md`.

## Rules

- **Never print a secret.** Pipe values straight into `wrangler secret put NAME` (from a password manager, a file,
  or `openssl rand -hex 32`); never echo them, never pass them as arguments, never write them into the repository.
- **Ask before deploying to the user's account**; check `bunx wrangler whoami` first.
- **Validate before deploy**: `bun run validate flowee.config.json` must print `ok`.
- **Verify each step** with the commands in `references/verify.md`; report what they printed, not what should
  happen.
- **Tests never touch a real remote.** `bun run test` and `test/e2e/wire.py` use fakes and a local stand-in GitHub.

## Standalone

1. `git clone https://github.com/Nachtalb/flowee && cd flowee && bun install`; `bun run typecheck && bun run test`.
2. Write the workspace document (skill `flowee-configure`) as `flowee.config.json`:
   `{"flowee": 1, "workspaces": [<doc>]}`. Or keep it out of the repository and store it as the `FLOWEE_CONFIG`
   secret (it wins over the file). `bun run validate flowee.config.json`.
3. Telegram: create the bot with BotFather; note its username for `chat.username`. The owner's chat id: the user
   sends the bot a message and reads `getUpdates`, or uses a known id.
4. GitHub token: fine-grained, limited to the workspace's repositories, with the permissions of
   `references/project-setup.md` ("Token permissions"). A `tracker.project` board needs a classic `repo` + `project` token
   instead (a fine-grained token cannot write a user-owned project): put that trade-off to the user.
5. Secrets: every name the document references.
   - tracker and bot tokens: `wrangler secret put <NAME>` with the value on stdin;
   - `chat.webhookSecret`: a random string (`openssl rand -hex 32 | bunx wrangler secret put TG_WEBHOOK_SECRET`);
   - each agent: generate a secret, give it to the agent's secrets file, and store only its SHA-256:
     `printf %s "$S" | sha256sum | cut -d' ' -f1 | bunx wrangler secret put ACME_DEV1`.
6. `bunx wrangler deploy`, then `curl -fsS https://<worker>/setup`: the bot sets its profile, commands and webhook
   (each only when changed). `chat.publicUrl` must be the Worker's URL.
7. Verify (`references/verify.md`), then set up the project repository and the agents (`references/project-setup.md`).

## Managed

1. As standalone step 1. In `wrangler.toml`: `FLOWEE_MODE = "managed"`.
2. The instance document (`flowee-configure`, example 6): the instance bot, `publicUrl`, `owner` (the user's
   Telegram id), `creators`, limits. Enable bot management for the instance bot in BotFather if workspaces should
   get their own bots.
3. Secrets: the instance bot's token and webhook secret, `FLOWEE_KEY` (random; seals every secret entered in the
   chat), `FLOWEE_ADMIN_TOKEN` (random; the configuration API).
4. `bunx wrangler deploy`, `curl -fsS https://<worker>/setup`.
5. Hand over to the user: in a private chat with the bot, `/setup` (or send a document an agent wrote). The wizard
   asks for the bot, repositories, flow, chat, GitHub token (the message is deleted at once) and agent counts, and
   sends the agents' secrets once with a ready `.flowee.toml`. That part is the user's; you do not see the secrets.
6. Automation instead of the chat: `PUT /admin/workspaces/<id>` and `PUT /admin/workspaces/<id>/secrets` with
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
- A changed document in standalone mode takes effect only with a new `wrangler deploy`; call `/setup` after it.

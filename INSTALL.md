# Installing Flowee

This document is written for an agent that installs Flowee for a user; a human can follow it the same way. Every
Flowee instance serves it at `<instance>/INSTALL.md`, and the repository has it at its root. Follow it literally and
in order: detect, ask once, then do the procedure of the chosen variant. Where it and an instance's root document
(`<instance>/`) differ, the root document wins for that instance.

Flowee is a ticket flow for teams of AI agents over GitHub or GitLab issues. The agents change tickets only through
its HTTP API with a small Python client (`flowee.py`); the human owner gets the tickets that need them as cards in a
Telegram chat, in a terminal (`flowee-tui`), or both.

## 1. The variants

| | 1. A hosted instance, through its Telegram bot | 2. Self-hosted: container | 3. Self-hosted: one executable or a clone | 4. Your own Cloudflare deployment |
|---|---|---|---|---|
| What runs where | Someone else's Flowee; you only talk to its bot | The published image `ghcr.io/nachtalb/flowee:latest` (amd64, arm64) on your machine | The same program, built from a clone with bun, as one file or `bun run start` | A Cloudflare Worker on your Cloudflare account |
| Needs | Telegram, a tracker token, the instance's URL; the instance must let you create workspaces | Docker, Podman or WSL's `wslc` | bun 1.4+, git | A Cloudflare account, bun, git |
| Public address | no | no (polling); optional behind a reverse proxy for webhooks | no (polling); optional, as 2 | yes, the Worker's `*.workers.dev` URL |
| Who it suits | Trying Flowee, or one project without running anything | Anyone with a machine that stays on (a server, a NAS, a desktop) | A machine without containers, or development | Several people or projects, nothing to keep running yourself |
| Chat side | Telegram (the instance's bot or a bot it creates for you) | Telegram, terminal, both, or none (API only) | Telegram, terminal, both, or none | Telegram, terminal, both, or none |
| You control | your workspace (its document, export with `/export`) | everything: data, keys, upgrades | everything | everything, on Cloudflare's platform |
| You do not control | where the data lives, the instance's key that seals your tracker token, its uptime, version and limits; its operator can read the workspace's data | | | |

There is no download of a finished executable: variant 3 builds it from a clone. The terminal client `flowee-tui` is
built the same way (`bun run compile:tui`, [docs/tui.md](docs/tui.md)).

## 2. Detect, then ask once

### 2.1 Detect (before asking anything)

Run these and keep the answers; they decide which questions to ask and what to recommend.

| What | Command | Present when |
|---|---|---|
| Docker | `docker version --format '{{.Server.Version}}'` | prints a version (the daemon is reachable, not only the client) |
| Docker rootless | `docker info --format '{{.SecurityOptions}}'` | the list contains `name=rootless` |
| Docker Compose | `docker compose version`, else `docker-compose version` | prints a version |
| Podman | `podman version --format '{{.Version}}'` | prints a version |
| Podman rootless | `podman info --format '{{.Host.Security.Rootless}}'` | `true` |
| Podman with systemd (Quadlet) | `systemctl --user is-system-running` and `podman version --format '{{.Version}}'` 4.4 or later | the first prints `running` or `degraded` |
| `wslc` (Windows, WSL 2.9.3+) | PowerShell: `wslc version`; inside WSL: `"/mnt/c/Program Files/WSL/wslc.exe" version` | prints `wslc <version>` |
| bun | `bun --version` | 1.4 or later |
| python3 (the client) | `python3 --version` | 3.11 or later; needed in every variant |
| SELinux | `getenforce` | `Enforcing` (Fedora, RHEL, CentOS): container mounts need `:Z` |
| Your user | `id -u; id -g` | always |
| Port 8787 free | `ss -ltn 'sport = :8787'` | no line below the header |

### 2.2 Ask: one message, every question, each with its default

Ask all questions that apply in ONE message, numbered, each with its default, so the user can answer "defaults" to
any of them. Skip questions the detection already answered. Do not start before the answers are in.

1. **Which variant?** Recommend from the detection:

   | The user has | Recommend |
   |---|---|
   | only Telegram, and the URL of a hosted instance that lets them create workspaces | 1 |
   | Docker, Podman or `wslc` | 2 |
   | bun and no container runtime | 3 |
   | a Cloudflare account and wants nothing running at home | 4 |
   | none of these | 1 if they have a hosted instance's URL, else install Docker or Podman, then 2 |

2. **Variant 2 only, when more than one container runtime was detected:** "Docker, Podman or wslc?" Never choose for
   the user; list the ones found. Default: none, this question must be answered. With Docker or Podman also
   "Compose file, plain run command, or (Podman with systemd) a Quadlet unit?" Default: Docker → Compose when Compose
   is present, else the run command; Podman → Quadlet when systemd is available, else the run command.
3. **Variants 2 and 3: where on this machine?** Default: everything in `~/flowee` (`data/` the data directory,
   `secrets/` one file per secret, `flowee.json` the configuration document).
4. **Variants 2 and 3: a public address?** "Will a reverse proxy give this machine an https address?" Default: no:
   Telegram updates by polling, the tracker polled every minute. With one: its URL; Telegram and tracker webhooks
   then arrive at once ([docs/self-hosting.md](docs/self-hosting.md), "Polling or webhooks").
5. **The chat side: Telegram, terminal, both, or none?** Default: Telegram.
   - Telegram in variants 2, 3, 4: the user creates a bot with @BotFather (`/newbot`, a name, a username ending in
     `bot`) and stores its token in a file themselves (procedure below). Where the cards go: a private chat with the
     bot (default), a group, or one topic of a forum group.
   - Terminal: each person runs `flowee-tui --new-key` and gives you only the digest it prints; who signs in?
     Default: the owner alone.
6. **Variants 2, 3, 4: preconfigured or managed?** Default: preconfigured (standalone: one document with the
   workspaces, fixed at start). Managed (people create workspaces themselves with the bot's wizard) needs an https
   public address and Telegram or the terminal; recommend it only when several people or projects will set up
   their own workspaces.
7. **The tracker and the repositories.** GitHub or GitLab; for a self-managed GitLab or GitHub Enterprise its host;
   the repositories as `owner/name` (several are allowed: tickets are then written `alias#12`). Default: this
   directory's `git remote get-url origin`.
8. **Branching:** commits straight to the main branch, or a feature branch and pull request per ticket? Default: the
   main branch (`trunk`).
9. **Versioning:** are releases made (tags, a version file, a tested tag)? Default: no.
10. **More options:** UI review, dependency tickets, user feedback (triaged automatically or by a human first)?
    Default: none ([skills/flowee-configure/references/features.md](skills/flowee-configure/references/features.md)).
11. **The owner:** tracker login, and with Telegram their numeric user id. Default: the user you are talking to; the
    id is read from the bot's updates after they message it (procedure below).
12. **The project's checks before every commit** (typecheck, lint, tests). Default: the project's own commands.
13. **Agents:** where their clones and the project key live, who starts their runs and how often. Default: clones
    next to this one as `<project>-<agent>`, the key in `~/.secrets/flowee/<workspace>/key`, every 5 minutes with the
    cheap pre-check, the board more often ([docs/agents/README.md](docs/agents/README.md)).

## 3. Common pieces

### 3.1 The configuration document

Write it with the skill [flowee-configure](skills/flowee-configure/SKILL.md) from the answers. A document names
secrets (`ACME_GITHUB_TOKEN`), it never holds one. Self-hosted and Cloudflare, standalone, it is
`{"flowee": 1, "workspaces": [<workspace>]}`. A terminal-only workspace (no Telegram):

```json
{ "flowee": 1, "workspaces": [ {
  "flowee": 1, "id": "acme", "flow": { "preset": "trunk" },
  "tracker": { "type": "github", "repos": ["acme/app"], "token": "ACME_GITHUB_TOKEN" },
  "agents": { "key": "ACME_KEY" },
  "owners": [ { "name": "Ann", "tracker": "ann" } ],
  "tui": { "people": [ { "id": "ann", "name": "Ann", "role": "manager", "key": "<the digest flowee-tui --new-key printed>" } ] }
} ] }
```

With Telegram, add to the workspace (without `publicUrl` a self-hosted instance polls Telegram):

```json
"owners": [ { "name": "Ann", "tracker": "ann", "chat": "<Ann's Telegram user id>" } ],
"chat": { "type": "telegram", "token": "TELEGRAM_BOT_TOKEN", "webhookSecret": "TG_WEBHOOK_SECRET",
          "chatId": "<Ann's Telegram user id>", "username": "<the bot's username>" }
```

GitLab: `"tracker": {"type": "gitlab", ...}`; a self-managed host adds `"api": "https://<host>/api/v4"` (GitHub
Enterprise: `"api": "https://<host>/api/v3"`). Every field: [docs/configuration.md](docs/configuration.md).

### 3.2 Validate before anything starts

Any one of these runs the same validator the start runs; all print `ok <file>: <ids>` (or `{"ok": true, ...}`) for a
valid document and one sentence per problem, each starting with its JSON path, otherwise. Fix every line and run it
again until it is `ok`.

| Where | Command |
|---|---|
| the published image (no instance running) | `docker run --rm -v "$HOME/flowee/flowee.json:/config/flowee.json:ro" ghcr.io/nachtalb/flowee:latest validate /config/flowee.json` (Podman: the same with `podman`) |
| the executable | `./flowee validate flowee.json` |
| a clone | `bun run validate flowee.json` |
| any running instance, also someone else's | `curl -fsS -H 'content-type: application/json' --data @flowee.json <instance>/validate` (no token; nothing is stored) |

### 3.3 Secrets are files, never arguments

Each secret the document names is one file `~/flowee/secrets/<NAME>`, mode 600, holding only the value. Never put a
secret in a command's arguments, an environment variable you type, the shell history, the chat or your output.

| Secret | Who makes it | How |
|---|---|---|
| tracker token (`ACME_GITHUB_TOKEN`) | the user | GitHub: a fine-grained token limited to the repositories, the permissions in [skills/flowee-install/references/project-setup.md](skills/flowee-install/references/project-setup.md) ("Token permissions"); GitLab: `api` scope ([docs/gitlab.md](docs/gitlab.md)). The user runs `install -m 600 /dev/stdin ~/flowee/secrets/ACME_GITHUB_TOKEN` in their own terminal, pastes, presses Enter and Ctrl-D |
| bot token (`TELEGRAM_BOT_TOKEN`) | the user | from @BotFather, stored the same way |
| webhook secret (`TG_WEBHOOK_SECRET`) | you | `python3 -c 'import secrets; print(secrets.token_hex(32))' > ~/flowee/secrets/TG_WEBHOOK_SECRET` |
| `FLOWEE_KEY` | you | the same command into `~/flowee/secrets/FLOWEE_KEY`. It seals the secrets Flowee stores (webhook secrets; in the managed mode every token entered in the chat). Tell the user to copy this file into their password manager now: a lost `FLOWEE_KEY` makes those secrets unreadable |
| the project key (`ACME_KEY`) | you | the key goes to the agents' machines, the instance gets only its SHA-256 (3.4) |
| `FLOWEE_ADMIN_TOKEN` (managed only) | you | as the webhook secret; keep a copy where the operator finds it |

Create the directory and generated secrets with `umask 077` set first, so every file is mode 600.

### 3.4 The project key

```sh
umask 077
mkdir -p ~/.secrets/flowee/acme
python3 -c 'import secrets; print(secrets.token_hex(32))' > ~/.secrets/flowee/acme/key
python3 -c 'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1]).read().strip().encode()).hexdigest())' \
  ~/.secrets/flowee/acme/key > ~/flowee/secrets/ACME_KEY
```

`~/.secrets/flowee/acme/key` is what the agents use (the `key_file` of `.flowee.toml`); the instance stores only the
digest. Copy the key file to every machine an agent runs on, mode 600.

### 3.5 Telegram: what the user does, what you read

1. The user: @BotFather → `/newbot` → a name → a username ending in `bot`; then stores the token
   (`install -m 600 /dev/stdin ~/flowee/secrets/TELEGRAM_BOT_TOKEN`, paste, Enter, Ctrl-D) and sends `/start` to the
   new bot from their own account.
2. You read the bot's name, its webhook and the senders, without printing the token:

   ```sh
   python3 - ~/flowee/secrets/TELEGRAM_BOT_TOKEN <<'EOF'
   import json, sys, urllib.request
   t = open(sys.argv[1]).read().strip()
   api = lambda m: json.load(urllib.request.urlopen(f"https://api.telegram.org/bot{t}/{m}"))["result"]
   print("bot:", api("getMe")["username"])
   print("webhook:", api("getWebhookInfo")["url"] or "none")
   print("senders:", sorted({(u["message"]["from"]["id"], u["message"]["from"].get("username")) for u in api("getUpdates") if "message" in u}))
   EOF
   ```

   `bot:` is `chat.username`; the user's id among `senders:` is `owners[].chat` and `chat.chatId` (a private chat).
   `webhook:` must be `none`: otherwise the bot is in use elsewhere; stop and ask.

## 4. Variant 1: a hosted instance through its Telegram bot

Nothing is installed. The workspace lives on that instance.

1. Read the instance's root document: `curl -fsSL <instance>/`. It names the bot (`- Chat bot: @…`), the mode and
   who may create workspaces (`- New workspaces by the user:`). A standalone instance, or one whose line says you
   may not, cannot take the workspace: ask its operator, or choose variant 2.
2. Write the workspace document (3.1, without `chat` and `tui`: the bot asks where the tickets go) and validate it
   against that instance: `curl -fsS -H 'content-type: application/json' --data @acme.json <instance>/validate`
   until it answers `{"ok": true, ...}`. Show it to the user.
3. Tell the user, literally: "Open Telegram, search for @<bot from the root document>, tap **Start**. Then send it the
   file `acme.json` (paperclip → File). Answer its questions: which bot (💬 This bot, or 🤖 A new bot, then tap
   **🤖 Create the bot**), where the tickets appear, and the tracker token (tap 🔑 Create a token, create it, paste
   it: the bot deletes the message at once). At the end it sends a key file: run the block in that file in your
   terminal, then tap 🗑 under it." Without a document, `/setup` starts the same wizard.
4. Meanwhile prepare the project side (7). What only the user can do: create the tracker token, tap the bot's
   buttons, add the bot to a group, run the key file's block (it stores the project key with mode 600 at
   `~/.secrets/flowee/<workspace>/key`). You never see the token or the key.
5. Verify (8).

## 5. Variant 2: self-hosted with the container image

The image is `ghcr.io/nachtalb/flowee:latest` (also `:<version>` and `:<commit>` tags), FROM scratch, runs as uid
65532, keeps its data in `/data`, listens on 8787, and has `flowee health` as its health check. Do every step before
the first start.

### 5.1 Directories, document, secrets (every runtime)

1. Create the layout, owned by the user, closed to others:

   ```sh
   umask 077
   mkdir -p ~/flowee/data ~/flowee/secrets
   ```

2. Write `~/flowee/flowee.json` (3.1) and validate it with the image (3.2) until it prints `ok`.
3. Store every secret the document names as a file (3.3, 3.4, 3.5), plus `FLOWEE_KEY`. Check that each name exists:
   `ls ~/flowee/secrets` lists exactly the names of the document and `FLOWEE_KEY`.
4. Write `~/flowee/flowee.env`, the settings and where each secret is inside the container (one `<NAME>_FILE` line
   per secret; no value of a secret in this file):

   ```sh
   FLOWEE_CONFIG_FILE=/config/flowee.json
   FLOWEE_KEY_FILE=/run/secrets/FLOWEE_KEY
   ACME_GITHUB_TOKEN_FILE=/run/secrets/ACME_GITHUB_TOKEN
   ACME_KEY_FILE=/run/secrets/ACME_KEY
   # with Telegram:
   # TELEGRAM_BOT_TOKEN_FILE=/run/secrets/TELEGRAM_BOT_TOKEN
   # TG_WEBHOOK_SECRET_FILE=/run/secrets/TG_WEBHOOK_SECRET
   # behind a reverse proxy (https):
   # FLOWEE_PUBLIC_URL=https://flowee.example.com
   # FLOWEE_TRUST_PROXY=1
   ```

### 5.2 Ownership: who the process runs as

The files above belong to the user and are mode 600/700; the process in the container must be able to read
`secrets/` and write `data/`. The image's own user is uid 65532, which owns nothing on the host. So:

| Runtime | What to do | Why |
|---|---|---|
| Docker (rootful, the usual) | run as your own uid: `--user "$(id -u):$(id -g)"` (Compose: `user: "<uid>:<gid>"` with the numbers `id -u` and `id -g` print) | the process then owns `data/` and reads `secrets/`; no root needed, backups are plain copies |
| Docker, keeping uid 65532 | `sudo chown -R 65532:65532 ~/flowee/data ~/flowee/secrets ~/flowee/flowee.json` once, and no `--user` | needs root; afterwards only root or uid 65532 can read those files |
| Docker rootless | `--user 0:0` | container root is your own uid there; uid 65532 would map to a subordinate uid that cannot read your files (not tested here) |
| Podman rootless | `--userns=keep-id:uid=65532,gid=65532` | maps your uid to the image's uid 65532 inside the container, so your files appear as its own; no `chown`, no `:U` (which would hand the files to a subordinate uid you cannot read without `podman unshare`) |
| Podman rootful (`sudo podman`) | as Docker rootful | |
| any, with SELinux `Enforcing` | add `Z` to every mount option (`:Z`, `:ro,Z`) | relabels the files so the container may read them; without SELinux, leave it out |
| `wslc` | nothing; the data in a `wslc` volume (5.3e) | |

Without the mapping the process cannot write `data/`: the start fails with `EACCES: permission denied` or
`unable to open database file`.

### 5.3a Docker: Compose

Write `~/flowee/compose.yaml` (put the numbers of `id -u` and `id -g` in `user:`):

```yaml
services:
  flowee:
    image: ghcr.io/nachtalb/flowee:latest
    container_name: flowee
    restart: unless-stopped
    user: "1000:1000"
    ports: ["127.0.0.1:8787:8787"]
    volumes:
      - ./data:/data
      - ./flowee.json:/config/flowee.json:ro
      - ./secrets:/run/secrets:ro
    env_file: flowee.env
```

```sh
cd ~/flowee && docker compose pull && docker compose up -d
```

`127.0.0.1:8787` keeps it on this machine (agents, the terminal client and a local reverse proxy reach it there);
write `"8787:8787"` only when other machines must reach it directly.

### 5.3b Docker: one run command

```sh
docker pull ghcr.io/nachtalb/flowee:latest
docker run -d --name flowee --restart unless-stopped --user "$(id -u):$(id -g)" -p 127.0.0.1:8787:8787 \
  -v "$HOME/flowee/data:/data" -v "$HOME/flowee/flowee.json:/config/flowee.json:ro" \
  -v "$HOME/flowee/secrets:/run/secrets:ro" --env-file "$HOME/flowee/flowee.env" ghcr.io/nachtalb/flowee:latest
```

### 5.3c Podman: one run command

```sh
podman pull ghcr.io/nachtalb/flowee:latest
podman run -d --name flowee --userns=keep-id:uid=65532,gid=65532 -p 127.0.0.1:8787:8787 \
  -v "$HOME/flowee/data:/data" -v "$HOME/flowee/flowee.json:/config/flowee.json:ro" \
  -v "$HOME/flowee/secrets:/run/secrets:ro" --env-file "$HOME/flowee/flowee.env" ghcr.io/nachtalb/flowee:latest
```

A rootless container started this way does not come back after a reboot; for that use the Quadlet unit (5.3d).

### 5.3d Podman: a Quadlet unit (systemd, starts at boot)

Write `~/.config/containers/systemd/flowee.container` (`%h` is your home directory):

```ini
[Unit]
Description=Flowee

[Container]
Image=ghcr.io/nachtalb/flowee:latest
ContainerName=flowee
UserNS=keep-id:uid=65532,gid=65532
PublishPort=127.0.0.1:8787:8787
Volume=%h/flowee/data:/data
Volume=%h/flowee/flowee.json:/config/flowee.json:ro
Volume=%h/flowee/secrets:/run/secrets:ro
EnvironmentFile=%h/flowee/flowee.env

[Service]
Restart=always

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload && systemctl --user start flowee
loginctl enable-linger "$USER"      # keeps it running without a login session, and starts it at boot
```

### 5.3e wslc (Windows)

`wslc` is the container CLI that ships with WSL 2.9.3 and later (Microsoft, "WSL container":
https://learn.microsoft.com/windows/wsl/wsl-container). It runs Linux containers in its own WSL session and takes
Docker-style options (`wslc run --help`): `run -d --name -p -e --env-file -v --user --restart`, `pull`, `exec`,
`logs`, `stop`, `restart`, `remove`, `volume`. It has no Compose. Run it from PowerShell (inside WSL the same
commands work as `"/mnt/c/Program Files/WSL/wslc.exe"`).

1. The layout lives in your Windows home, `$HOME\flowee` in PowerShell (`/mnt/c/Users/<you>/flowee` from WSL):
   `flowee.json`, `flowee.env` and `secrets\` as in 5.1, created with the same commands from WSL with that path
   (`umask` and modes have no effect on a Windows folder; your profile folder is readable only by your account and
   administrators). The data does NOT go there: SQLite cannot open its database on a Windows folder mounted into
   the container (`unable to open database file`), so it goes into a `wslc` volume.
2. Validate: `wslc run --rm -v "$HOME\flowee\flowee.json:/config/flowee.json:ro" ghcr.io/nachtalb/flowee:latest validate /config/flowee.json`.
3. Start:

   ```powershell
   wslc pull ghcr.io/nachtalb/flowee:latest
   wslc volume create flowee-data
   wslc run -d --name flowee -p 127.0.0.1:8787:8787 -v flowee-data:/data `
     -v "$HOME\flowee\flowee.json:/config/flowee.json:ro" -v "$HOME\flowee\secrets:/run/secrets:ro" `
     --env-file "$HOME\flowee\flowee.env" ghcr.io/nachtalb/flowee:latest
   ```

   `WSAEADDRINUSE` means something on Windows holds port 8787: publish another one (`-p 127.0.0.1:18787:8787`) and
   use it in every URL.
4. Health: `wslc exec flowee /flowee health` exits 0; logs: `wslc logs flowee`; restart: `wslc restart flowee`.
   Upgrade: `wslc pull ghcr.io/nachtalb/flowee:latest`, `wslc stop flowee`, `wslc remove flowee`, the same run command (the volume keeps the
   data). Not verified: whether `--restart` brings it back after Windows restarts, and a backup of the volume
   (`wslc cp`, `wslc export` exist); stop the container and copy `/data` out before relying on either.

### 5.4 First start, health, verification

1. The log of the first start (`docker logs flowee`, `podman logs flowee`, `journalctl --user -u flowee`,
   `wslc logs flowee`) is JSON lines; it must show `"msg":"listening"` and, with Telegram, one line per bot
   (`telegram <bot>: polling for updates (no webhook)`), and no `error` line. A problem in the configuration stops the start with exit 2 and one
   line per problem.
2. Health: `docker exec flowee /flowee health; echo $?` prints `0` (Podman: `podman exec`); also
   `curl -fsS http://127.0.0.1:8787/health` prints `{"ok":true}`.
3. `curl -fsS http://127.0.0.1:8787/ | head -12` is this instance's root document: `- Runs on: a self-hosted Flowee
   process; …`, `- Mode: standalone` (or `managed`).
4. Then the project side (7) with `url = "http://127.0.0.1:8787"` and the checks of 8.

### 5.5 Upgrade, backup, uninstall

| Task | Docker Compose | Docker / Podman run | Podman Quadlet |
|---|---|---|---|
| upgrade | `docker compose pull && docker compose up -d` | `docker pull ghcr.io/nachtalb/flowee:latest`, `docker rm -f flowee`, the same run command again (Podman: `podman` for `docker`) | `podman pull ghcr.io/nachtalb/flowee:latest && systemctl --user restart flowee` |
| backup | `docker compose stop`, copy `~/flowee` (it holds the secrets and `FLOWEE_KEY`: keep the copy mode 600 or encrypted), `docker compose start` | `docker stop flowee`, copy, `docker start flowee` | `systemctl --user stop flowee`, copy, `start` |
| uninstall | `docker compose down`, `docker rmi ghcr.io/nachtalb/flowee:latest`, then `rm -rf ~/flowee` after a backup | `docker rm -f flowee`, `docker rmi …`, `rm -rf ~/flowee` | `systemctl --user stop flowee`, remove the `.container` file, `daemon-reload`, `podman rmi …`, `rm -rf ~/flowee` |

Storage migrations run by themselves at start; there is no downgrade. Pin a version with `:<version>` instead of
`:latest` when upgrades must be deliberate. After an uninstall revoke the tracker token and, if unused, delete the
bot with @BotFather (`/deletebot`).

## 6. Variant 3: one executable, or a clone with bun

1. `git clone https://github.com/Nachtalb/flowee && cd flowee && bun install`.
2. Either build the executable (the served material embedded):
   `bun run compile -- --target bun-linux-x64 --outfile ~/flowee/flowee` (or `bun-linux-arm64`, `bun-darwin-arm64`),
   or run from the clone with `bun run start`.
3. Directories, document, secrets: as 5.1 steps 1 to 3; validate with `~/flowee/flowee validate ~/flowee/flowee.json`
   (or `bun run validate`).
4. Start, with the secrets read from their files (the `_FILE` variables), the data in `~/flowee/data`:

   ```sh
   cd ~/flowee && FLOWEE_CONFIG_FILE=flowee.json FLOWEE_DATA=data FLOWEE_HOST=127.0.0.1 \
     FLOWEE_KEY_FILE=secrets/FLOWEE_KEY ACME_GITHUB_TOKEN_FILE=secrets/ACME_GITHUB_TOKEN ACME_KEY_FILE=secrets/ACME_KEY \
     ./flowee
   ```

   To keep it running, a systemd user unit with those variables as `Environment=` lines and `ExecStart=%h/flowee/flowee`.
5. Health: `./flowee health; echo $?` prints `0`; then 5.4 steps 3 and 4. Upgrade: `git pull`, build again, restart.

## 7. The project side (every variant)

In the project repository, with `<url>` the instance's address:

1. `curl -fsSL <url>/client/flowee.py -o scripts/flowee.py` (the client in the version the instance serves).
2. `.flowee.toml` at the repository root, committed (no secret in it):

   ```toml
   url = "http://127.0.0.1:8787"              # <url>: this one is a self-hosted instance on this machine
   workspace = "acme"
   key_file = "~/.secrets/flowee/{workspace}/key"

   [[gates]]
   name = "test"
   cmd = ["bun", "run", "test"]
   ```

3. The roles this workspace offers, then the agents (idempotent: put the same `agents add` at the start of each
   agent's scheduled run):

   ```sh
   python3 scripts/flowee.py roles
   python3 scripts/flowee.py agents add board board
   python3 scripts/flowee.py agents add developer dev1
   python3 scripts/flowee.py agents add tester tester
   python3 scripts/flowee.py agents
   ```

4. Copy Flowee's agent instructions (`curl -fsSL <url>/bundle.tar.gz | tar -xz`, then `flowee/docs/agents/`) into the
   project and fill in the placeholders; one clone per agent; the scheduled runs as
   [docs/agents/README.md](docs/agents/README.md) says. Details:
   [skills/flowee-install/references/project-setup.md](skills/flowee-install/references/project-setup.md).

## 8. Verify, and report what was printed

| Check | Command | Prints when right |
|---|---|---|
| the instance | `curl -fsS <url>/version` | `{"ok": true, "flowee": "<version>", "commit": "<commit>", "client": {...}}` |
| the client | `python3 scripts/flowee.py version` | `client X`, `server X (commit …)`, `up to date` |
| the project key | `python3 scripts/flowee.py roles` | one block per role (`board (one): …`); a wrong key: `failed: Unknown or missing token.`, exit 1 |
| an agent | `FLOWEE_AS=dev1 python3 scripts/flowee.py whoami` | `{"instance": "dev1", "role": "developer"}` |
| its queue | `FLOWEE_AS=dev1 python3 scripts/flowee.py queue` | `{"role": "developer", "queue": [], "claim": null, …}` |
| state survives a restart (2, 3) | restart the container or process, then `python3 scripts/flowee.py agents` | the agents created before are listed |
| the chat | the owner sends `/start` to the bot | the bar (`✨ Inbox empty`) or the first card |
| the terminal | `flowee-tui --url <url>` | signs in to the inbox |

More checks (webhooks, the managed configuration API, the bot's profile):
[skills/flowee-install/references/verify.md](skills/flowee-install/references/verify.md).

## 9. Variant 4: your own Cloudflare deployment

1. `git clone https://github.com/Nachtalb/flowee && cd flowee && bun install`; `bun run typecheck && bun run test`.
   Remove a stray `~/.wrangler` (it hides the wrangler login); `bunx wrangler whoami` names the account. Ask the user
   before deploying to it.
2. The document as `flowee.config.local.json` (git-ignored: ids and URLs never reach a commit):
   - standalone: 3.1 with `chat.publicUrl` set to the Worker's URL `https://flowee.<subdomain>.workers.dev` (the
     subdomain: wrangler prints the URL on the first deploy; deploy again after correcting it);
   - managed: `{"flowee": 1, "workspaces": [], "instance": {...}}` with `instance.bot` (the secret names of the bot
     token and webhook secret, `username`), `publicUrl`, `owner` (the user's Telegram id), `creators`
     ([docs/configuration.md](docs/configuration.md#instance)).

   `bun run validate flowee.config.local.json` prints `ok`.
3. Every secret it names, each value on stdin, never as an argument: `bunx wrangler secret put <NAME>` (the first one
   creates the Worker; the user pastes tokens into its prompt). Generated ones:
   `python3 -c 'import secrets; print(secrets.token_hex(32))' | bunx wrangler secret put FLOWEE_KEY` (also
   `TG_WEBHOOK_SECRET`, and `FLOWEE_ADMIN_TOKEN` when managed; keep copies of `FLOWEE_KEY` and the admin token in the
   user's password manager, wrangler never shows them again). The project key's digest from the file of 3.4:
   `python3 -c 'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1]).read().strip().encode()).hexdigest())' ~/.secrets/flowee/acme/key | bunx wrangler secret put ACME_KEY`.
   `bunx wrangler secret list` then names every one.
4. `bun run deploy`: it validates, deploys, and calls `<publicUrl>/setup`, printing each bot profile step `set` or
   `current` (managed: also `settings`, which turns on bot management, so BotFather needs no step). Tracker webhooks
   register within a minute when `FLOWEE_KEY` is set and the token may manage webhooks; otherwise the workspace
   polls.
5. Managed: the user opens the bot and sends `/setup`, or the document as a file (variant 1, step 3, with this
   instance). Automation instead: `PUT /admin/workspaces/<id>` with the admin token
   ([skills/flowee-install/references/verify.md](skills/flowee-install/references/verify.md), "Managed").
6. The project side (7) and the checks (8) with the Worker's URL.

## 10. Never

| Never | Instead |
|---|---|
| print, echo, log or paste a secret (tokens, the project key, `FLOWEE_KEY`) | files of mode 600; the user types tokens into `install -m 600 /dev/stdin <file>` themselves |
| put a secret in the document, a command's arguments, an environment variable on the command line, a Compose file or the repository | the document names secrets; `<NAME>_FILE` points at the file |
| pick a container runtime when more than one is installed | ask (2.2, question 2) |
| start the instance before the document validated | 3.2 first |
| let Flowee generate `FLOWEE_KEY` silently and forget it | generate it (3.3) and have the user back it up |
| `chown` or `:U` your files to a subordinate uid under rootless Podman | `--userns=keep-id:uid=65532,gid=65532` |
| publish port 8787 on every interface by default | `127.0.0.1:8787`, or a reverse proxy with https |
| run two processes on one data directory, or poll one bot from two places | one instance per data directory and per bot (Telegram answers 409 and Flowee stops polling) |
| give Flowee a broad personal token | a fine-grained token limited to the repositories |
| message the user's chat or a real tracker to test | the checks of 8 and the user's own `/start` |

## 11. When something fails

| Symptom | Cause | Fix |
|---|---|---|
| the container exits at once with `EACCES: permission denied` or `unable to open database file` | the process cannot write `data/` (5.2), or `data/` is a Windows folder under `wslc` | the user mapping of 5.2; under `wslc` a volume for `/data` |
| the start stops with exit 2 and `$.…` lines | the document is invalid | 3.2, fix every line |
| `<NAME>_FILE: cannot read /run/secrets/<NAME>.` | the secret file is missing or not mounted | 3.3; `ls ~/flowee/secrets` |
| `telegram …: 409` in the log, polling stopped | another process polls the bot, or a webhook is set | stop the other consumer (`getWebhookInfo` in 3.5 must say `none`), restart |
| `failed: Unknown or missing token.` from the client | wrong key file, or `agents.key` names a secret holding the key instead of its SHA-256 | 3.4: the instance holds the digest, the agents the key |
| `refused: unknown_agent` | the agent was not created | `python3 scripts/flowee.py agents add <role> <name>` (7) |
| `403 error code: 1010` from a Cloudflare instance | a client without its own User-Agent (Python's default is blocked) | `flowee.py` sends one; any other client must too |
| wrangler asks for `CLOUDFLARE_API_TOKEN` | a stray `~/.wrangler` hides the login | remove `~/.wrangler` |
| every token entered in the chat stopped working | `FLOWEE_KEY` changed or was lost | restore it from the backup (3.3); otherwise every workspace needs its tokens again |
| the tracker refuses writes to a Projects board | a fine-grained GitHub token cannot write a user-owned project | leave `tracker.project` out, or a classic `repo` + `project` token |
| a second workspace naming the same repository is refused | a repository belongs to one workspace per instance | several repositories go into one workspace (`tracker.repos`) |
| a changed document has no effect | it is read at start (self-hosted) or deploy (Cloudflare) | restart the container or process; `bun run deploy` (a plain `wrangler deploy` skips `/setup`) |
| the owner's messages in a group are not seen | the bot runs in privacy mode | answer by replying to a card ([docs/telegram.md](docs/telegram.md)) |
| any key holder can act as any agent | the project key is shared by design | `agents.secrets: "per-agent"` where roles must be enforced ([docs/api.md](docs/api.md#agents)) |

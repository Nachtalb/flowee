# Self-hosting: Flowee as one process

The same code that runs as a Cloudflare Worker runs as one ordinary process on any machine: a single executable
(or `bun run start` in a clone, or the Docker image). No Cloudflare account and no public address are needed:
Telegram updates are fetched by long polling and the trackers are polled. Put a reverse proxy in front and set a
public URL, and it receives Telegram and tracker webhooks exactly as the Worker does.

## Run it

```sh
# the published image (amd64, arm64): ghcr.io/nachtalb/flowee:latest, :<commit>, :<version>
docker run -d --name flowee --user "$(id -u):$(id -g)" -p 127.0.0.1:8787:8787 -v "$PWD/data:/data" \
  -v "$PWD/flowee.json:/config/flowee.json:ro" -v "$PWD/secrets:/run/secrets:ro" \
  -e FLOWEE_CONFIG_FILE=/config/flowee.json -e TELEGRAM_BOT_TOKEN_FILE=/run/secrets/TELEGRAM_BOT_TOKEN … ghcr.io/nachtalb/flowee:latest

# Docker Compose: compose.yaml in the repository (./flowee.json, ./secrets/<NAME>, ./data)
docker compose up -d

# from a clone (bun 1.4+)
bun install && FLOWEE_CONFIG_FILE=flowee.json bun run start

# one executable (the served material embedded): build it, copy it anywhere, run it
bun run compile -- --target bun-linux-x64 --outfile flowee    # or bun-linux-arm64, bun-darwin-arm64, bun-linux-x64-musl
FLOWEE_CONFIG_FILE=flowee.json FLOWEE_DATA=/var/lib/flowee ./flowee

# the image from the clone instead of the published one
docker build -t flowee .
```

The image runs as uid 65532. A bind-mounted `data/` must be writable by the process: run it as your own uid
(`--user`, as above), or `chown -R 65532:65532` the directories once; rootless Podman maps your uid to 65532 with
`--userns=keep-id:uid=65532,gid=65532`. Without that the start fails with `EACCES: permission denied`.

`flowee health` asks the running process (`GET /health` on `FLOWEE_PORT`) and exits 0 or 1: the image's
`HEALTHCHECK`, with no shell in the image. `flowee version` prints the version. `flowee validate <file>…` checks a
configuration document with the same validator as the start (and `bun run validate`, `POST /validate`) without
starting anything: `ok <file>: <ids>` and exit 0, else one problem per line and exit 1 (2: not JSON).

## Configuration

The configuration document is the Worker's (docs/configuration.md): a standalone document
(`{"flowee": 1, "workspaces": [...]}`) or a managed one with an `instance` section and the wizard. The mode follows
the document (`instance` → managed) unless `FLOWEE_MODE` says otherwise. Everything else comes from the environment:

| Variable | Default | Meaning |
|---|---|---|
| `FLOWEE_CONFIG_FILE` | `./flowee.config.json` when it exists | Path of the configuration document. `FLOWEE_CONFIG` gives the document itself. |
| `FLOWEE_DATA` | `./data` (image: `/data`) | The data directory (below). |
| `FLOWEE_PORT`, `FLOWEE_HOST` | `8787`, `0.0.0.0` | Where the API, webhooks and served material listen. |
| `FLOWEE_PUBLIC_URL` | none | The public base URL a reverse proxy gives this process. With it: tracker webhooks, and (https only) Telegram webhooks. Without it: polling. |
| `FLOWEE_TRUST_PROXY` | off | `1`: the client address of `/validate`'s limit is the first `X-Forwarded-For` entry (only behind your own proxy). |
| `FLOWEE_KEY` | generated | Seals the secrets stored in the data directory (webhook secrets; in the managed mode every secret entered in the chat). Not given: generated once into `<data>/flowee.key` with a log line saying so. Losing it loses those secrets. |
| `FLOWEE_LOG` | `info` | `debug` adds one line per request (method, path, status, time; never a header, body or secret). |
| `FLOWEE_TICK_SECONDS` | `60` | The period of the tick that replaces the Worker's cron. |
| `FLOWEE_TELEGRAM_API` | `https://api.telegram.org` | A local Bot API server, or a test stand-in. |
| any secret name | | Every secret the document names (`GITHUB_TOKEN`, `TELEGRAM_BOT_TOKEN`, the agents' digests …), as on the Worker. |
| `<NAME>_FILE` | | Reads the secret `<NAME>` from a file (Docker and Compose secrets: `/run/secrets/<NAME>`); a value given directly wins. |

Invalid configuration stops the start with every problem on its own log line (exit 2), the same sentences as
`bun run validate`.

## Without a messenger

A workspace with `tui` and no `chat` runs with no bot token at all: the owner (and the team) work the inbox in
the terminal (docs/tui.md). The whole configuration:

```json
{ "flowee": 1, "workspaces": [ {
  "flowee": 1, "id": "shop", "flow": { "preset": "trunk" },
  "tracker": { "repos": ["acme/shop"], "token": "GITHUB_TOKEN" },
  "roles": [ { "instance": "board", "role": "board", "secret": "SHOP_BOARD" }, { "instance": "dev1", "role": "developer", "secret": "SHOP_DEV1" },
             { "instance": "tester", "role": "tester", "secret": "SHOP_TESTER" }, { "instance": "owner", "role": "owner", "secret": "SHOP_OWNER" } ],
  "owners": [ { "name": "Ann", "tracker": "ann" } ],
  "tui": { "people": [ { "id": "ann", "name": "Ann", "role": "manager", "key": "<the digest flowee-tui --new-key printed>" } ] }
} ] }
```

`docker run -p 8787:8787 -v flowee:/data -e FLOWEE_CONFIG="$(cat flowee.json)" -e GITHUB_TOKEN_FILE=… … ghcr.io/nachtalb/flowee:latest`
(no `TELEGRAM_*` secret, no public URL needed), then `flowee-tui --url http://<host>:8787`. Behind a reverse proxy,
let it pass WebSocket upgrades on `/tui/` (the doorbell); without them the client polls and loses nothing.
`python3 test/e2e/tui_demo.py --runtime docker --image <image>` walks exactly this configuration.

## The data directory

```
<data>/flowee.sqlite          the lock, the scheduled wake-ups, the Telegram offsets
<data>/flowee.key             FLOWEE_KEY when it was generated (mode 600)
<data>/workspaces/<id>.sqlite one SQLite database per workspace (the Durable Object's storage, same schema)
<data>/instance.sqlite        the managed instance (registry, sealed secrets, wizard sessions)
```

Exactly one process may own a data directory: it holds an exclusive SQLite lock on `flowee.sqlite` while it runs,
and a second one refuses to start with one sentence. The databases are in WAL mode.

- **Backup:** copy the whole directory while the process is stopped; or, running, `sqlite3 <file> ".backup <copy>"`
  for each database (SQLite's online backup). Keep `flowee.key` (or your `FLOWEE_KEY`) with it: without the key the
  sealed secrets in a backup are unreadable.
- **Upgrade:** stop, replace the executable or image, start. Storage migrations run by themselves at start (the same
  list as on the Worker, `src/core/schema.ts`); there is no downgrade.
- **Stop:** SIGTERM or SIGINT (what `docker stop` sends). Requests stop being accepted, the polling loops end after
  the update in hand, the running pass finishes, then the databases are closed.

## Polling or webhooks

| | No public URL (the default) | `FLOWEE_PUBLIC_URL` behind a reverse proxy |
|---|---|---|
| Telegram | `chat.transport` defaults to `polling`: getUpdates, the webhook deleted first, the offset persisted after each update, `allowed_updates` as the webhook's | `https://…`: `webhook`, set at start from `<url>/telegram` as on the Worker (an `http://` URL still polls Telegram) |
| Trackers | polled every `sync.pollMinutes` on the tick; the sync status says `no public URL is configured` | webhooks registered at `<url>/hooks/<workspace>/<alias>` (`sync.webhooks`), polling only as the fallback |

One polling loop runs per bot (the standalone bot; in the managed mode with `instance.transport: polling` the
instance bot and every workspace's own bot). When Telegram answers 409 (another process polls the same bot, or a
webhook was set again) the loop stops with one sentence: stop the other consumer and restart. Errors back off from
one second to a minute. The bot's profile, commands and settings are applied at start instead of at deploy, each
only when it changed.

A reverse proxy only needs to pass the paths through:

```nginx
server {
  listen 443 ssl;
  server_name flowee.example.com;
  location / { proxy_pass http://127.0.0.1:8787; proxy_set_header X-Forwarded-For $remote_addr; client_max_body_size 6m; }
}
```

```caddy
flowee.example.com {
  reverse_proxy 127.0.0.1:8787
}
```

Then `FLOWEE_PUBLIC_URL=https://flowee.example.com` and `FLOWEE_TRUST_PROXY=1`.

## The image

`ghcr.io/nachtalb/flowee` is published by `.github/workflows/image.yml` on every push to `main` that changes the
program (`:latest` and `:<short commit>`) and on every `v*` tag (`:<version>`), for linux/amd64 and linux/arm64, public.

`Dockerfile`: a build stage compiles the executable with `bun build --compile` for musl (`scripts/compile.ts`, the
served material embedded); the final image is `FROM scratch` with that file, the musl loader, `libstdc++` and
`libgcc_s` (bun's compiled executables are not fully static) and the CA bundle for HTTPS. It runs as uid 65532,
has one volume (`/data`), `EXPOSE 8787`, a `HEALTHCHECK` by `flowee health` and the OCI labels. Size: 107 MB, almost
all of it the bun runtime inside the executable (measured: alpine + the same executable 115 MB; `oven/bun:alpine`
with the sources 116 MB; distroless/cc with the glibc executable 134 MB).

Building it yourself, multi-arch (the build stage cross-compiles, so no emulation is needed for it):

```sh
docker buildx build --platform linux/amd64,linux/arm64 -t <registry>/flowee:<version> \
  --build-arg VERSION=<version> --build-arg REVISION=$(git rev-parse --short HEAD) --push .
```

## What differs from Cloudflare

- One process instead of one Durable Object per workspace: a workspace's commands are serialised by the same lock
  in the process; workspaces run concurrently in one event loop. Scale is one machine's.
- The tick (every `FLOWEE_TICK_SECONDS`) replaces the cron trigger and in-process timers replace the alarms; the
  wake-ups are stored, so after a stop or a suspended machine the missed ones run at the first turn (within a
  minute of waking).
- Telegram by polling is possible here only; the Worker refuses `chat.transport: polling` with one sentence.
- `FLOWEE_KEY` may be generated into the data directory; on the Worker it is always a secret you set.
- The managed mode still needs `instance.publicUrl` in the document (the wizard's links); with
  `instance.transport: polling` its bots are polled.
- Backups and upgrades are yours (above); on Cloudflare the storage is managed.

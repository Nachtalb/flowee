# Flowee: notes for agents working on this repository

Flowee is a Cloudflare Worker, or one self-hosted process on bun (TypeScript, the same code), that runs a ticket flow for AI agent teams over an issue tracker and
brings the owner's inbox into a chat (the Envoy), plus `client/flowee.py`, the agents' stdlib Python client.
README.md is usage only; this file is how the code is built and laid out.

## Build, test, run

```sh
bun install
bun run typecheck                 # tsc (TypeScript 7), strict
bun run test                      # every suite twice: vitest in workerd (@cloudflare/vitest-plugin), then the same files on
                                  #   the bun runtime (test:bun, vitest.bun.config.ts) plus test/bun/; fakes via fetch
bun run start                     # the self-hosted runtime from the clone (docs/self-hosting.md)
bun run compile                   # one executable, served/ embedded (scripts/compile.ts; --target, --outfile)
docker build -t flowee .          # the image FROM scratch (Dockerfile); CI publishes it as ghcr.io/nachtalb/flowee
                                  #   (.github/workflows/image.yml); compose.yaml is the example deployment
bun run test:client               # python3 client/test_flowee.py (scratch git repos + a throwaway gpg key)
bun run tui -- --url <instance>   # the terminal client from the clone (docs/tui.md)
bun run compile:tui               # dist/flowee-tui, one executable (bun build --compile tui/main.ts; --target for others)
python3 test/e2e/tui_demo.py      # the real client in a pty against the bun runtime and a stand-in GitHub: the inbox,
                                  #   answers, files, the wizard and menu; screenshots as text and PNG (Pillow) in
                                  #   ~/.hermes/cache/scratch/flowee/t/shots or --out; --runtime worker | docker --image NAME
bun run schema                    # regenerate schema/*.schema.json after changing src/config/schema.ts or a preset
bun run validate <file>…          # a workspace or instance document through the Worker's validator (exit 0/1/2)
bun run bundle                    # build served/ (the public material); `bun run test`, wrangler dev and deploy run it
python3 test/e2e/serve.py         # the served material, the root document, /validate, flowee.py version/update in wrangler dev
python3 test/e2e/wire.py          # flowee.py against `wrangler dev` and a stand-in GitHub and GitLab, trunk and pr-release
#   --runtime bun | docker [--image NAME]: the self-hosted runtime (process or image) instead, plus a polling walk
#   (stand-in Telegram by getUpdates), a restart that keeps the state, the webhook walk with FLOWEE_PUBLIC_URL;
#   serve.py takes the same --runtime and --image
#   --flow-py PATH [--flow-env PREFIX] [--flow-heading TEXT]: also an external client with the same wire contract
bun test/e2e/gitlab-live.ts       # the GitLab adapter's reads against gitlab.com, anonymous and read-only (network)
bun run dev                       # wrangler dev; local secrets and FLOWEE_CONFIG in .dev.vars (git-ignored)
```

Before every commit: typecheck, `bun run test` and `bun run test:client` green, each exit status checked.
Test runs may create `~/.wrangler`; remove it afterwards (it hides the machine's wrangler login).

Deploy (not automated, no CI): `bun run deploy` (`scripts/deploy.ts`): refuses while `~/.wrangler` exists, validates
`flowee.config.local.json` (git-ignored, the deployment's own; else `flowee.config.json`), runs `wrangler deploy`
with `FLOWEE_MODE` from the document and the local document as the `FLOWEE_CONFIG` secret (on stdin), then calls
`<publicUrl>/setup` so the new version sets the bot's profile and webhook. `wrangler deploy` (and `dev`) first runs
`[build]`, `bun scripts/bundle.ts`, which builds `served/` (git-ignored), the `[assets]` directory, so the served
material always is the deployed commit's; the build fails when a file looks like a secret or holds a value of
`flowee.config.local.json` (chat and user ids, URLs, bot names, repositories).
Configuration and secrets: docs/configuration.md; the operator's steps: skills/flowee-install.

## Layout

```
src/
  core/       the flow: statechart loader (chart.ts), extensions merged into it (extend.ts), engine (engine.ts), guards.ts, actions.ts, repos.ts (the
              workspace's repositories as one tracker, ticket ids and alias#n), the service
              (service.ts: commands, queues, reaper), agents.ts (the agents as identities in the store, the roles
              a flow offers: `/v1/roles`, `/v1/agents`), owner card (card.ts), storage schema (schema.ts), settings.ts,
              features.ts (feature switches: defaults, terms, pruning a tagged chart), code.ts (the guards, actions
              and cron work of the code features: pull requests, checks, releases, tested tag, paths on the main branch, UI review,
              dependency and untrusted tickets), housekeeping.ts (what the cron runs for them), events.ts
              (webhooks: deliveries queued, the targeted work per event, the mirror of open tickets behind `queue`,
              registration, health, fallback to polling, the listings' schedule), errors.ts (`Fail`:
              status, code, one sentence), text.ts (hashing, constant-time compare, templates)
  ports/      interfaces: tracker.ts (+ optional capabilities), hooks.ts (the trackers' webhooks, normalised
              events), chat.ts (views, events, plain fallback), tui.ts (the terminal protocol's frames, messages,
              events: shared with tui/), store.ts,
              clock.ts, secrets.ts, files.ts, bots.ts (managed bots)
  envoy/      the owner's inbox in a chat, chat-agnostic: envoy.ts (cards, bar, answers, new tickets, sync,
              digest, profile), render.ts (the view building blocks every screen uses, cards, bar, lists,
              navigation, search)
  api/        http.ts: the agents' HTTP API (auth: the project key + X-Flowee-Agent, or an agent's own secret;
              idempotency, dispatch, the agents' paths)
  wizard/     the managed mode's chat conversation, chat-agnostic: wizard.ts (setup steps and their screens, the
              living message, drafts, the document a draft makes), manage.ts (welcome, /workspaces menu, export,
              import)
  config/     document.ts (the workspace document), trackers.ts (tracker kinds: default API, path form,
              capabilities), chats.ts (chat kinds: telegram's section `chat`, tui's `tui`), schema.ts (JSON Schema + validator; `problems()` behind
              `bun run validate`; repositories unique per instance), features.ts (the
              features' schema and rules), registry.ts (WorkspaceRegistry, StoredRegistry, settings from a
              document), presets.ts (the one chart, the starting points, flowOf: a workspace's pruned flow)
  adapters/   trackers.ts (the tracker adapters by kind), tracker-github.ts (+ tracker-github-code.ts: branches,
              pulls, checks, releases, tags), tracker-gitlab.ts (REST v4: merge requests, pipelines, tags, releases),
              hooks-github.ts / hooks-gitlab.ts (each tracker's webhooks: verify, parse, register),
              chat-telegram.ts (+ TelegramBots: managed bots), chat-tui.ts (Terminal: the Chat port over the
              terminal protocol, a conversation in the store; Tee: Telegram shown in the terminals too), chats.ts
              (the chat adapters by kind, chatOf), files-paste.ts, workspace-host.ts (one host per
              workspace on its runtime's room; wires a document to its adapters), instance.ts (mode, the instance's
              registry), instance-host.ts (managed mode: the stored registry, sealed secrets, wizard host, update
              routing, /admin, pasted imports only after /import), vault.ts (AES-GCM), photo.ts (the default bot
              photo: assets/logo-square.svg rendered at 256 px, base64)
  runtime/    the runtime boundary: platform.ts (Room, Platform: what a runtime gives the hosts), router.ts (every
              runtime's HTTP routes: resolves each request's workspace, forwards to its host; the minute's tick,
              /setup, /hooks/<workspace>/<alias>, polled Telegram updates); cloudflare/ (the Worker, the Durable
              Objects, SqlStore); bun/ (main.ts: the `flowee` command; config.ts: the environment, `*_FILE`,
              FLOWEE_KEY; app.ts: hosts, Bun.serve, the data directory's lock, served material from served/ or
              embedded; store.ts: bun:sqlite; scheduler.ts: alarms and the tick; poller.ts: Telegram getUpdates;
              compiled.ts: the executable's entry; validate.ts: `flowee validate`, `bun run validate`; bun.d.ts: the Bun/Node APIs it
              uses)
  index.ts    the Worker's entry: re-exports src/runtime/cloudflare/worker.ts
flows/        flow.json (the one XState statechart, every part tagged with its switch) + flow.options.json; the
              starting points trunk and pr-release (src/config/presets.ts) only preset switches; extensions/
              (shipped flow extensions, `builtin:<name>`: samples.json, the example)
schema/       workspace.schema.json, instance.schema.json (generated)
scripts/      schema.ts (`bun run schema`), validate.ts (`bun run validate`), flow.ts (`bun run flow <doc> --merged`:
              the merged chart for Stately), deploy.ts (`bun run deploy`),
              bundle.ts (`bun run bundle`: served/ from SOURCES, the skills/ and docs/ indexes, manifest.json,
              bundle.tar.gz; the secret and deployment-value check)
served/       generated, git-ignored: the Worker's static assets (`[assets]`, binding ASSETS, run_worker_first),
              answered by src/adapters/served.ts (the root document, headers, /version, POST /validate)
client/       flowee.py + test_flowee.py
tui/          flowee-tui, the terminal client (no dependency): screen.ts (the cell grid, widths, the ANSI diff; the
              tests' headless screen), html.ts (a View laid out: lines and the targets keys and clicks reach),
              state.ts (the conversation from the protocol's events: card, bar, focus, notices), input.ts (keys,
              SGR mouse, paste), app.ts (screens, keys, overlays: everything drawn), main.ts (terminal, config
              dir and key file, sync, the socket, reconnect), node.d.ts
assets/       logo.svg, logo-square.svg (the default bot photo's source)
docs/         api.md, flows.md, adapters.md, configuration.md, gitlab.md (GitLab's mapping and token scopes),
              tui.md (the terminal interface: keys, pairing, people), tui-protocol.md (its client protocol),
              webhooks.md (events per feature, permissions, health and fallback, the alarm/cron split),
              envoy.md (the chat interface, row by row),
              chat-style.md (how every screen looks, the living message, the reply-keyboard exception),
              flow-features.md (the feature catalogue), managed.md (wizard, management, import), self-hosting.md
              (the bun runtime: configuration, data directory, polling or webhooks, the image), telegram.md
              (profiles, setMySettings, groups and topics), agents/ (role templates for projects using Flowee)
skills/       agent skills: flowee-install, flowee-use, flowee-configure (the full configuration spec)
test/         vitest suites, fakes (fake.ts, fake-code.ts, fake-gitlab.ts, fake-hooks.ts: hooks routes, signed
              deliveries), hooks.test.ts (counts tracker calls), tracker-contract.test.ts (every tracker
              adapter, the same cases), fixtures (workspaces.json: neutral names), docs.test.ts
              (docs and skills complete, the skills' examples valid), served.test.ts (every served file equals its
              source, the bundle, links, no secrets, the root document, /validate), e2e/wire.py, e2e/serve.py
```

## Architecture rules

- **Boundaries.** `core` imports only `core` and `ports`; `ports` only `ports` (and `core/errors`); `envoy` and
  `api` only `core`, `ports` and themselves. Nothing outside `adapters`, `runtime` and `index.ts` imports an adapter or
  `cloudflare:*`, or names a platform API. `test/boundary.test.ts` enforces this, and that no source file names a
  repository, person or chat of the test workspaces: those live in configuration only. The public repository
  names no real project, person or chat id anywhere (docs, tests, fixtures included).
- **The runtime boundary.** Two runtimes run the same code: `src/runtime/cloudflare` (the Worker, a Durable Object
  per workspace and one for the instance, the cron trigger) and `src/runtime/bun` (one process). Both serve
  `src/runtime/router.ts` and build the same hosts (`adapters/workspace-host.ts`, `adapters/instance-host.ts`) on a
  `Room` (`src/runtime/platform.ts`: the store, one wake-up time, wiping), call a host's `alarm()` when its wake-up is
  due and `tick()` every minute. Only `src/runtime/cloudflare` imports `cloudflare:*`, only `src/runtime/bun`
  imports `bun:*` or names `Bun.*`, neither imports the other, and only `index.ts` (the Worker's entry) imports a
  runtime (`test/boundary.test.ts`). The Worker's bundle holds nothing of the bun runtime: check `wrangler deploy
  --dry-run --outdir` for `bun:` when a shared file starts importing from a runtime. A Workers-only API the shared
  code uses (`crypto.subtle.timingSafeEqual`) is supplied by the bun runtime (`app.ts`), not avoided in the core.
- **One process per data directory** (bun): it holds an exclusive SQLite lock on `<data>/flowee.sqlite` while it
  runs; a second refuses to start. Per-workspace serialisation is the hosts' own lock, as in a Durable Object.
- **The tracker is the record.** Every command re-reads the ticket; the store keeps only what the tracker cannot
  (claims, origins, handed commits, answers, the inbox, idempotency, chat message ids). The one copy of tracker data,
  the webhook-fed mirror of open tickets (`src/core/events.ts`), answers only the read-only `queue` and the envoy's
  sync; a webhook event is a hint to re-read, never a transition's reason.
- **Scheduled work: alarm first, cron as the net.** `Flowee.cron(force)` is one pass (reaper, queued webhook events,
  due listings and their housekeeping, the envoy's minute, pruning). The workspace's alarm runs it without `force` at
  `wakeAt()` (queued events, the earliest lease expiry, the next reconcile, the next hour for the digest); the
  every-minute cron runs it with `force`, which lists every polled repository as before. Decision: the cron stays
  every minute because polling (no or unhealthy webhooks) needs it and it wakes objects whose alarm was never set;
  for a healthy webhook workspace it makes no tracker call. Alarms are per workspace and exact, the cron one global
  tick; a rarer cron would slow the polling fallback by the same factor (docs/webhooks.md). Self-hosted, the
  scheduler (`src/runtime/bun/scheduler.ts`) is both: stored wake-ups per workspace and the tick, one loop that
  sleeps at most a tick and compares the wall clock, so missed wake-ups run at once after a restart or a suspend.
- **Telegram: webhook or polling** (`chat.transport`, `instance.transport`). Polling is the bun runtime's
  (`poller.ts`: one loop per bot, deleteWebhook first, the offset stored after each update, 409 stops it with one
  sentence) and its default without a public URL; polled updates enter the router at `polled()`, after which they
  are handled exactly like a webhook's. The Worker refuses polling (`webhookOnly()` in `src/config/schema.ts`).
- **One workspace, one host, one store** (a Durable Object, or a SQLite file in the process). Every API token, chat update and stored key resolves a
  workspace first (`src/runtime/router.ts`); a Durable Object refuses a request for another workspace than its own. Commands of
  a workspace run under its lock (`Workspace.lock`).
- **Configuration, not constants.** A workspace is one JSON document (docs/configuration.md); secrets are named in
  it, never held. Defaults are neutral (`Owner:`, `### For the owner`).
- **Standalone mode** (`FLOWEE_MODE`) serves exactly the configured workspaces with one bot. Management (workspace
  creation, managed bots, `/admin`) belongs to the managed mode and must not be reachable in standalone.
- **Managed mode** keeps workspaces in the Instance Durable Object; it hands each workspace object its document
  and sealed secrets (`Workspace.configure`), so a workspace object never reads the registry there. `wizard/`
  imports only `core`, `ports`, `config` types and `envoy/render`; the Telegram specifics stay in the adapter.

## Agents decision: one project key, agents as identities

A workspace names one project key (`agents.key`, a digest like every secret), not its agents. Agents are rows in the
workspace's store (`agents`, `src/core/agents.ts`): a name and a role, created, renamed, paused and removed through
`/v1/agents` with the key; claims, leases, origins and resuming hang on the name exactly as on the former instance.
A request acts as the agent named in `X-Flowee-Agent` (the client's `FLOWEE_AS`/`agent`); the role comes from the
record, never the request. The router finds the workspace from the key's digest like any token (the registry indexes
`agents.key`); the workspace resolves the agent. Considered: keeping a secret per agent handed out at setup (the
owner had to count agents up front and redistribute files to add one) and agents in the document (every change a
configuration edit). Trade-off, stated in docs/api.md: any key holder can act as any agent, so role separation is
by convention; `agents.secrets: "per-agent"` (strict) gives each agent created its own secret (stored as a digest in
the row) and stops the key from acting. Documents with `roles` (per-agent digests) work unchanged beside it. A
removed agent's claims get `touched = 0` and the alarm's reaper hands them back (one path for every lapse); so does
`configure()` for names neither the document nor the store knows.

## Terminal interface decisions

- **Transport: one HTTP request for data, a WebSocket as the doorbell.** `POST /tui/v1/w/<id>/sync` carries the
  terminal's frames (each with its own id, handled once) and answers the events after the client's sequence
  number; the socket only says "there is something new" (`{"seq": N}`). Considered: WebSocket for everything,
  and SSE + POST. A Durable Object holding an SSE stream stays awake (duration billed for every open terminal all
  day); hibernatable WebSockets cost nothing while idle and are rung from the object's storage, and Bun.serve has
  WebSockets natively. Keeping the data path a plain idempotent request makes reconnecting exact (the sequence
  number), lets the scripted tests and any client work without a socket (polling), and keeps the socket code tiny.
  Runtime boundary: `Room.sockets` (`accept(tag)`, `ring(tag, text)`); Cloudflare accepts with
  `ctx.acceptWebSocket` and rings `ctx.getWebSockets(tag)`; bun answers a marked response that `Bun.serve`'s fetch
  upgrades (`server.upgrade`), its sockets kept per room and tag. No runtime code in the adapter.
- **One conversation per workspace**, like a Telegram group: several people and terminals share it (answers
  signed, the first wins). A workspace with Telegram and the terminal has ONE conversation in two windows
  (`Tee`): the envoy's state (card on screen, bar, drafts, message ids) is per conversation, so a second backend
  is a mirror, never a second envoy.
- **Keys**: per person, `fwk_` + 32 random bytes; only the SHA-256 is stored (`tui.people[].key`, in the
  document: a digest is no secret); the router resolves key → people → workspaces and hands the host the person
  in `x-flowee-person` (a client's own header never passes). The managed instance's setup seat keeps one
  conversation per key (tables prefixed per person in the instance's store).
- **Client: TypeScript on bun, no TUI library.** Considered Ink (React + yoga: large, a renderer meant for
  inline CLIs), OpenTUI (a native Zig core: a shared library per platform next to a compiled binary), terminal-kit
  and blessed (large, blessed unmaintained). What the client needs is small: a cell grid with a row diff, a
  grapheme width table, an xterm input parser, and the layout of the view model the server already defines. Own
  code keeps the repository at zero runtime dependencies, makes the headless test screen the same code the
  terminal sees, and compiles to one file with `bun build --compile`. Its types are the server's
  (`src/ports/chat.ts`, `src/ports/tui.ts`); `tui/` imports nothing else of `src/` (boundary test).

## Engine decision: own interpreter, not the xstate runtime

The flow file is XState v5 JSON (loadable in Stately; `test/engine.test.ts` runs it through xstate's own
`createMachine` + `transition`), but `src/core/engine.ts` interprets it. Reason: each command is a request that
re-reads the ticket, evaluates async guards against the tracker, runs async writes, and must say *why* a
transition is refused with a code and one sentence; xstate's guards are synchronous and a disabled event is
silently dropped, so its runtime would need the same wrapping plus a dependency in the bundle. The subset used:
states, `initial`, `on` (string, object or array), `target`, one `guard` (string or `{type, params}`; `all`
combines), `actions`, `entry`, `exit`, `meta`. One deviation: exit actions run after the transition's (a failed
tracker write leaves storage untouched). `xstate` is a dev dependency only.

## How to add …

- **tracker calls for one ticket:** `c.f.tracker` (`src/core/repos.ts`) is every repository behind one `Tracker`
  over global ticket ids (issue, comments, update, comment, openIssues, board). Repository-level calls (commits,
  compare, branches, pulls, checks, releases, tags) go to the ticket's repository:
  `const { repo, n } = c.f.tracker.at(c.t.n)` gives `repo.tracker` (local numbers), `repo.branch` and the local
  `n`; show a ticket with `c.f.label(id)` (`#12` / `app#12`), write it in a response with `c.f.ref(id)`.
- **a guard or an action:** `src/core/guards.ts` (`kind: "selector" | "check"`) / `src/core/actions.ts` (code
  features: `src/core/code.ts`); a row in docs/flows.md and in skills/flowee-configure/references/statecharts.md
  (a test checks both); a test. Reach the tracker, store and clock through `c.f` only.
- **custom states for one workspace:** an extension (`extensions` in the document, docs/flows.md "Extending the
  flow"), never a second chart; a shipped one goes to `flows/extensions/<name>.json` (`BUILTIN` in
  src/config/presets.ts) with a test against it.
- **a starting point:** a name and its `start` switches in `src/config/presets.ts`, `bun run schema`, a row in
  README.md, docs/flow-features.md and skills/flowee-configure/references/features.md. A new flow part is a tagged
  part of `flows/flow.json` (a feature switch, below), never a second chart.
- **a feature switch:** its type and default in `src/core/features.ts` (`DEFAULTS`, `NEEDS` capabilities), its schema
  and rules in `src/config/features.ts`, rows in docs/configuration.md (a test checks); tag the chart's states,
  transitions and the options' roles/commands/ticks with `meta.features` / `features`; its guards and actions read
  `c.f.s.features` and pass or do nothing when it is off. Keep `flows/flow.json` openable in Stately: only `meta`
  carries the tags. Also: its token permission in docs/adapters.md and the wizard's token prompt
  (`src/wizard/wizard.ts`, step `credential`), a section in docs/flow-features.md, its options in
  skills/flowee-configure/references/features.md (a test checks), a row in README.md.
- **a tracker adapter:** one file `src/adapters/tracker-<kind>.ts` implementing `Tracker` (`src/ports/tracker.ts`;
  optional capabilities as objects or absent, `probe()` and a `parseRepo(api)` link reader), its kind in
  `TRACKER_KINDS` (`src/config/trackers.ts`: name, default API, path form, the capabilities it offers, which refuse
  workspaces needing more; the schema's `type` enum follows, `bun run schema`) and its entry in `TRACKERS`
  (`src/adapters/trackers.ts`, which `build()` uses per repository; the compiler demands it). Then a harness in
  `test/tracker-contract.test.ts` with an HTTP stand-in of its API, its own cases beside it (GitLab:
  `test/tracker-gitlab.test.ts`), a page like docs/gitlab.md (concept mapping, token scopes) and a stand-in in
  test/e2e/wire.py. Webhooks: `src/adapters/hooks-<kind>.ts` implementing `Hooks` (`src/ports/hooks.ts`: verify in
  constant time, the delivery id, parse into `TrackerEvent`s, register/unregister/status through the API, the
  permission in words) set as the adapter's `hooks`; tests with the tracker's documented payloads
  (`test/hooks-gitlab.test.ts`, `test/fixtures/`).
- **a runtime:** a directory `src/runtime/<name>/` that (1) makes a `Room` per workspace and one for the instance
  (a `Store` speaking SQLite's dialect, `wake(at)` keeping the soonest, `clear()`), (2) builds `WorkspaceHost` /
  `InstanceHost` on them and a `Platform` handing those out by id, (3) serves HTTP into `route(req, platform)`, (4)
  runs `host.alarm()` when a wake-up is due and `tick(platform)` every minute, (5) gives the configuration and secrets
  as `env` (and `ASSETS` for the served material); polling bots use `polled()`. Add it to the boundary test, give
  `test/` a harness behind `cloudflare:test` (as `test/bun/cloudflare-test.ts`) and a vitest config, so every suite
  and `test/store-contract.test.ts` run on it, and a `--runtime` in `test/e2e/wire.py`.
- **a chat adapter:** its kind in `CHAT_KINDS` (`src/config/chats.ts`) and its adapter in `CHATS`
  (`src/adapters/chats.ts`; `chatOf()` builds it for `build()`), its document section and schema, implementing
  `Chat` (`src/ports/chat.ts`, docs/adapters.md "Chat backends"); render `View`s richly or with `plain()`; give the
  router a route for its updates (`src/runtime/router.ts`). A backend without a messenger of its own (web, an app)
  is a client of the terminal protocol instead (docs/tui-protocol.md): no server code at all. For the managed mode also the optional methods
  the wizard uses (docs/adapters.md, "What the wizard needs") and, for own bots, the `Bots` port.
- **a chat screen** (wizard, menu, any message a bot shows): docs/chat-style.md is the rule (blocks, wording, the
  living message, when a new message is allowed); `test/chat-style.test.ts` and the exact payloads in
  `test/managed.test.ts` hold it. The terminal draws it too: `test/tui-parity.test.ts` renders every view the walks
  produce at 80x24 and 140x40 and snapshots them; after a wording change, `npx vitest run test/tui-parity.test.ts -u`
  and read the diff of `test/__snapshots__/tui-parity.test.ts.snap`.
- **a role:** a `roles` entry in the flow's options (or an extension's) with `sign`, `who`, a one-line
  `description` and `several` (whether more than one agent makes sense; default: it claims states and is not the
  owner); `GET /v1/roles` lists it with its commands and the states it claims. Agents of it are created through the API.
- **a wizard step:** add it to `Step` and `STEPS` (and `COUNTED`) in `src/wizard/wizard.ts`, then its three parts:
  `needed()` (does a draft still lack it: imports and edits skip answered steps), `screen()` (the view, built from
  the blocks of `src/envoy/render.ts` as docs/chat-style.md says: heading with the progress, the question, one line
  of help, button rows, `nav`) and the input it takes (`w:` button data in `press()`, typed text in `text()`, which
  deletes the message); write the answer into the `Draft` and the document in `toDoc()`. An editable part goes into `parts` in `src/wizard/manage.ts`. Host calls (sealing,
  checks) go through `WizardHost`, implemented in `instance-host.ts`. Test it in `test/managed.test.ts`
  with the fake Telegram (Back, Cancel and resume included).
- **a configuration field:** `src/config/document.ts` (type), `src/config/schema.ts` (schema + cross-field rules),
  `bun run schema`, the full example in `test/config.test.ts` (the compiler demands it), a row in
  docs/configuration.md and in skills/flowee-configure/references/fields.md (a test checks both).
- **a storage change:** append to `MIGRATIONS` in `src/core/schema.ts`; never edit a shipped entry.
- **a served file** (public, for agents setting Flowee up): it is served at its repository path. A new file under
  skills/, docs/, schema/ or flows/ is served and bundled by itself; a file elsewhere needs its glob in `SOURCES`
  (`scripts/bundle.ts`) and in the `import.meta.glob` of `test/served.test.ts`, its prefix in `MATERIAL`
  (`src/adapters/served.ts`) and a content type in `TYPES` when its extension is new. Relative links in served
  markdown must resolve to served paths (a test follows every one); never link to `src/` or `test/` from a served file.
  The root document (`rootDoc()` in served.ts) is generated per request: keep it short, numbered and literal.

## Conventions

- As few dependencies as possible: runtime has none (the bun runtime uses only bun's built-ins); dev: wrangler,
  vitest + the Workers pool, TypeScript, workers-types, xstate (test only).
- Error messages are one sentence for the agent, with a stable `error` code.
- Comments only where the code is not obvious.
- README.md is usage only (no build, layout or architecture: those are here). docs/agents/ and skills/ are
  generic: placeholders like `<project>`, never a real project's names or rules.
- Commits: one logical change, one line `type(scope): subject`, GPG-signed, pushed to `main`; never force-push.

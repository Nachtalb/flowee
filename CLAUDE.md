# Flowee: notes for agents working on this repository

Flowee is a Cloudflare Worker (TypeScript) that runs a ticket flow for AI agent teams over an issue tracker and
brings the owner's inbox into a chat (the Envoy), plus `client/flowee.py`, the agents' stdlib Python client.
README.md is usage only; this file is how the code is built and laid out.

## Build, test, run

```sh
bun install
bun run typecheck                 # tsc (TypeScript 7), strict
bun run test                      # vitest in workerd (@cloudflare/vitest-plugin): fake GitHub, GitLab + Telegram via fetch
bun run test:client               # python3 client/test_flowee.py (scratch git repos + a throwaway gpg key)
bun run schema                    # regenerate schema/*.schema.json after changing src/config/schema.ts or a preset
bun run validate <file>…          # a workspace or instance document through the Worker's validator (exit 0/1/2)
python3 test/e2e/wire.py          # flowee.py against `wrangler dev` and a stand-in GitHub and GitLab, trunk and pr-release
#   --flow-py PATH [--flow-env PREFIX] [--flow-heading TEXT]: also an external client with the same wire contract
bun test/e2e/gitlab-live.ts       # the GitLab adapter's reads against gitlab.com, anonymous and read-only (network)
bun run dev                       # wrangler dev; local secrets and FLOWEE_CONFIG in .dev.vars (git-ignored)
```

Before every commit: typecheck, `bun run test` and `bun run test:client` green, each exit status checked.
Test runs may create `~/.wrangler`; remove it afterwards (it hides the machine's wrangler login).

Deploy (not automated, no CI): `bun run deploy` (`scripts/deploy.ts`): refuses while `~/.wrangler` exists, validates
`flowee.config.local.json` (git-ignored, the deployment's own; else `flowee.config.json`), runs `wrangler deploy`
with `FLOWEE_MODE` from the document and the local document as the `FLOWEE_CONFIG` secret (on stdin), then calls
`<publicUrl>/setup` so the new version sets the bot's profile and webhook.
Configuration and secrets: docs/configuration.md; the operator's steps: skills/flowee-install.

## Layout

```
src/
  core/       the flow: statechart loader (chart.ts), engine (engine.ts), guards.ts, actions.ts, repos.ts (the
              workspace's repositories as one tracker, ticket ids and alias#n), the service
              (service.ts: commands, queues, reaper), owner card (card.ts), storage schema (schema.ts), settings.ts,
              features.ts (feature switches: defaults, terms, pruning a tagged chart), code.ts (the guards, actions
              and cron work of the code features: pull requests, checks, releases, tested tag, samples, UI review,
              dependency and untrusted tickets), housekeeping.ts (what the cron runs for them), events.ts
              (webhooks: deliveries queued, the targeted work per event, the mirror of open tickets behind `queue`,
              registration, health, fallback to polling, the listings' schedule), errors.ts (`Fail`:
              status, code, one sentence), text.ts (hashing, constant-time compare, templates)
  ports/      interfaces: tracker.ts (+ optional capabilities), hooks.ts (the trackers' webhooks, normalised
              events), chat.ts (views, events, plain fallback), store.ts,
              clock.ts, secrets.ts, files.ts, bots.ts (managed bots)
  envoy/      the owner's inbox in a chat, chat-agnostic: envoy.ts (cards, bar, answers, new tickets, sync,
              digest, profile), render.ts (the view building blocks every screen uses, cards, bar, lists,
              navigation, search)
  api/        http.ts: the agents' HTTP API (auth, idempotency, dispatch)
  wizard/     the managed mode's chat conversation, chat-agnostic: wizard.ts (setup steps and their screens, the
              living message, drafts, the document a draft makes), manage.ts (welcome, /workspaces menu, export,
              import)
  config/     document.ts (the workspace document), trackers.ts (tracker kinds: default API, path form,
              capabilities), schema.ts (JSON Schema + validator; `problems()` behind
              `bun run validate`; repositories unique per instance), features.ts (the
              features' schema and rules), registry.ts (WorkspaceRegistry, StoredRegistry, settings from a
              document), presets.ts (the one chart, the starting points, flowOf: a workspace's pruned flow)
  adapters/   trackers.ts (the tracker adapters by kind), tracker-github.ts (+ tracker-github-code.ts: branches,
              pulls, checks, releases, tags), tracker-gitlab.ts (REST v4: merge requests, pipelines, tags, releases),
              hooks-github.ts / hooks-gitlab.ts (each tracker's webhooks: verify, parse, register),
              chat-telegram.ts (+ TelegramBots: managed bots), files-paste.ts, workspace-host.ts (one host per
              workspace on its runtime's room; wires a document to its adapters), instance.ts (mode, the instance's
              registry), instance-host.ts (managed mode: the stored registry, sealed secrets, wizard host, update
              routing, /admin, pasted imports only after /import), vault.ts (AES-GCM), photo.ts (the default bot
              photo: assets/logo-square.svg rendered at 256 px, base64)
  runtime/    the runtime boundary: platform.ts (Room, Platform: what a runtime gives the hosts), router.ts (every
              runtime's HTTP routes: resolves each request's workspace, forwards to its host; the minute's tick,
              /setup, /hooks/<workspace>/<alias>); cloudflare/ (the Worker, the Durable Objects, SqlStore)
  index.ts    the Worker's entry: re-exports src/runtime/cloudflare/worker.ts
flows/        flow.json (the one XState statechart, every part tagged with its switch) + flow.options.json; the
              starting points trunk and pr-release (src/config/presets.ts) only preset switches
schema/       workspace.schema.json, instance.schema.json (generated)
scripts/      schema.ts (`bun run schema`), validate.ts (`bun run validate`), deploy.ts (`bun run deploy`)
client/       flowee.py + test_flowee.py
assets/       logo.svg, logo-square.svg (the default bot photo's source)
docs/         api.md, flows.md, adapters.md, configuration.md, gitlab.md (GitLab's mapping and token scopes),
              webhooks.md (events per feature, permissions, health and fallback, the alarm/cron split),
              envoy.md (the chat interface, row by row),
              chat-style.md (how every screen looks, the living message, the reply-keyboard exception),
              flow-features.md (the feature catalogue), managed.md (wizard, management, import), telegram.md
              (profiles, setMySettings, groups and topics), agents/ (role templates for projects using Flowee)
skills/       agent skills: flowee-install, flowee-use, flowee-configure (the full configuration spec)
test/         vitest suites, fakes (fake.ts, fake-code.ts, fake-gitlab.ts, fake-hooks.ts: hooks routes, signed
              deliveries), hooks.test.ts (counts tracker calls), tracker-contract.test.ts (every tracker
              adapter, the same cases), fixtures (workspaces.json: neutral names), docs.test.ts
              (docs and skills complete, the skills' examples valid), e2e/wire.py
```

## Architecture rules

- **Boundaries.** `core` imports only `core` and `ports`; `ports` only `ports` (and `core/errors`); `envoy` and
  `api` only `core`, `ports` and themselves. Nothing outside `adapters`, `runtime` and `index.ts` imports an adapter or
  `cloudflare:*`, or names a platform API. `test/boundary.test.ts` enforces this, and that no source file names a
  repository, person or chat of the test workspaces: those live in configuration only. The public repository
  names no real project, person or chat id anywhere (docs, tests, fixtures included).
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
  tick; a rarer cron would slow the polling fallback by the same factor (docs/webhooks.md).
- **One workspace, one Durable Object, one store.** Every API token, chat update and stored key resolves a
  workspace first (`src/runtime/router.ts`); a Durable Object refuses a request for another workspace than its own. Commands of
  a workspace run under its lock (`Workspace.lock`).
- **Configuration, not constants.** A workspace is one JSON document (docs/configuration.md); secrets are named in
  it, never held. Defaults are neutral (`Owner:`, `### For the owner`).
- **Standalone mode** (`FLOWEE_MODE`) serves exactly the configured workspaces with one bot. Management (workspace
  creation, managed bots, `/admin`) belongs to the managed mode and must not be reachable in standalone.
- **Managed mode** keeps workspaces in the Instance Durable Object; it hands each workspace object its document
  and sealed secrets (`Workspace.configure`), so a workspace object never reads the registry there. `wizard/`
  imports only `core`, `ports`, `config` types and `envoy/render`; the Telegram specifics stay in the adapter.

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
- **a chat adapter:** implement `Chat` (`src/ports/chat.ts`, docs/adapters.md); render `View`s richly or with
  `plain()`; give the router a route for its updates (`src/runtime/router.ts`), add its `chat.type` to the schema and choose the
  adapter by it in `build()` (which builds Telegram directly today). For the managed mode also the optional methods
  the wizard uses (docs/adapters.md, "What the wizard needs") and, for own bots, the `Bots` port.
- **a chat screen** (wizard, menu, any message a bot shows): docs/chat-style.md is the rule (blocks, wording, the
  living message, when a new message is allowed); `test/chat-style.test.ts` and the exact payloads in
  `test/managed.test.ts` hold it.
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

## Conventions

- As few dependencies as possible: runtime has none; dev: wrangler, vitest + the Workers pool, TypeScript,
  workers-types, xstate (test only).
- Error messages are one sentence for the agent, with a stable `error` code.
- Comments only where the code is not obvious.
- README.md is usage only (no build, layout or architecture: those are here). docs/agents/ and skills/ are
  generic: placeholders like `<project>`, never a real project's names or rules.
- Commits: one logical change, one line `type(scope): subject`, GPG-signed, pushed to `main`; never force-push.

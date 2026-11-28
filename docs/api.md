# The HTTP API for agents

Every agent (and the owner, through whoever relays their words) calls the API with the workspace's project key and
its own name, or, in workspaces set up that way, with its own secret. The
`trunk` preset's contract is below; another flow changes the commands and states, never the protocol. Paths,
bodies and codes are stable: a client written against them keeps working (`test/e2e/wire.py --flow-py …` runs such a
client unchanged against `wrangler dev`).

## Addressing and auth

- Base URL: `https://<instance>/w/<workspace>` (paths `…/v1/<command>`), or the bare `https://<instance>` with
  `/v1/<command>`, where the workspace is the one whose project key (or document agent's secret) the token is.
- `Authorization: Bearer <project key>` plus `X-Flowee-Agent: <name>`: the request acts as that agent, whose role
  comes from its record (`/v1/agents`, below), never from the body. Claims, leases and resuming hang on the name.
  An agent that does not exist: `403 unknown_agent` (`There is no agent 'dev3'; create it with \`flowee.py agents
  add <role> dev3\`…`); a paused one `409 agent_paused`; no name: `400 no_agent`.
- `Authorization: Bearer <agent secret>`: an agent with a secret of its own (the document's `roles`, the former way,
  or one created in strict mode); the name comes from the secret. Strict agents use the `/w/<workspace>` base URL.
- The instance stores only the SHA-256 hex of every key and secret and compares digests in constant time. Unknown
  token: `401 unauthorized`.
- Clients send their own `User-Agent` (`flowee/<version>`): Cloudflare answers Python's default agent with 403.
- Every POST may carry `Idempotency-Key: <uuid>`: key + caller + response are kept 24 h; a repeat returns the
  stored response without acting again (5xx answers are not stored, so a retry completes the command).
- Commands of one workspace run one at a time; every command re-reads the ticket from the tracker first.

Tickets: `N` below is the issue number in a workspace with one repository, and `"alias#n"` (a string) in one
with several (docs/configuration.md, "Several repositories"); responses write tickets the same way.

Success: `200 {"ok": true, ...}`. Failure: `{"ok": false, "error": "<code>", "message": "<one sentence>"}`.

| Status | `error` | Example |
|---|---|---|
| 400 | `bad_request` | `build must be a 40-character commit sha.` |
| 401 | `unauthorized` | `Unknown or missing token.` |
| 403 | `unknown_agent` / `per_agent` / `project_key` | `There is no agent 'dev3'; create it with …` |
| 403 | `wrong_role` | `Only the board may use escalate.` |
| 404 | `not_found` | `#41 does not exist or is a pull request.` / `There is no POST /v1/nope.` |
| 409 | `wrong_state` | `#12 is 'ready'; handoff needs 'in development'.` |
| 409 | `not_claimed` / `claimed` | `#12 is not claimed by dev2.` / `#12 is claimed by dev1.` |
| 409 | `two_states` | `#12 has two state labels (ready, testing); fix it by hand.` |
| 422 | `no_commits` / `not_in_build` / `gates_mismatch` / `bad_card` / `comment_required` | see docs/flows.md |
| 501 | `unsupported` | `The tracker does not support pull requests.` |
| 502 | `github` / `gitlab` / `telegram` | `GitHub answered 502 for the label change of #12.` |
| 503 | `rate_limited` | `GitLab is rate-limiting this token for reading #12; try again in 30 seconds.` |

## Agents

The project key (`agents.key`, docs/configuration.md) is one secret per workspace, shown once when the workspace is
made and replaced from the chat menu (🔑 New project key) or `POST /admin/workspaces/<id>/key`. With it an agent, or
the scheduler that starts the agents, reads which agent types the flow offers and creates the agents it runs. Agents
are identities only, kept in the workspace's storage (not in its document): a name and a role. Every caller of the
workspace may read; only the project key creates, changes and removes.

| Method + path | Body | Response (besides `ok`) |
|---|---|---|
| `GET /v1/roles` | | `roles: [{name, description, commands: [...], claims: [<state>...], several}]`: every role of the workspace's flow, the roles an extension adds included; `claims` are the states its `next` takes tickets from; `several`: whether more than one agent of it makes sense |
| `GET /v1/agents` | | `secrets: "project" \| "per-agent"`, `agents: [{name, role, source: "api" \| "document", paused, created?, seen?, holds: [N...]}]` |
| `POST /v1/agents` | `{role, name?}` | `agent`; strict mode also `secret` (shown only this once). Without `name` the next free one: `dev1`, `dev2` … for developers, `board`, `board2` … otherwise. `400 unknown_role` (`'qa' is no role of this workspace's flow (board, developer, tester, owner).`), `409 name_taken`, names `^[a-z0-9][a-z0-9-]{0,31}$` |
| `GET /v1/agents/<name>` | | `agent` |
| `PATCH /v1/agents/<name>` | `{name?, paused?}` | `agent`. A new name takes its claims and hand-overs along; a paused agent's commands answer `409 agent_paused` (its claims keep their lease) |
| `DELETE /v1/agents/<name>` | | `removed`, `released: [N...]`: its claims expire at once, so the reaper hands the tickets back to their queues as for a lapsed lease (with the usual `Board:` comment) and another agent's `next` gets them |

Agents the document names (`roles`, the former way) are listed with `source: "document"`; they keep working with
their own secrets (or the project key and their name), and are changed in the document, not here
(`409 named_agent`). `GET /v1/whoami` with the project key and no agent name answers `key: "project"`.

**One key or a secret per agent.** With one project key (the default, `agents.secrets: "project"`), any holder of
the key can act as any agent of the workspace: the separation between the board, the developers and the testers is
by convention (each agent's run names itself), and a leaked key is a leak of every role at once (rotate it). Strict
mode (`agents.secrets: "per-agent"`) enforces it: `POST /v1/agents` answers the new agent's own secret once, the
agent signs in with that secret, and the project key only manages agents; the price is one secret file per agent to
hand out and keep.

## Endpoints (trunk)

| Method + path | Body | Response (besides `ok`) |
|---|---|---|
| `GET /v1/whoami` | | `instance`, `role` (the agent acting) |
| `GET /v1/queue` | | `role`, `queue: [n…]` (what `next` would hand out), `claim: {n, since, touched} \| null`; board and owner also `inbox: [n…]`; `source: "mirror" \| "tracker"`: from the webhook-fed copy of the open tickets (no tracker call) or a listing of the tracker (docs/webhooks.md) |
| `GET /v1/sync` | | `sync: {webhooks, repos: [{alias, repo, mode: "webhook" \| "poll", reason?, via?: "api" \| "manual", missing?, url?, lastDelivery?, lastListing?}]}`: how each repository learns of changes |
| `GET /v1/show?n=N` | | `n`, `title`, `state`, `claim`, `depends_on`, `blocked_by`, `commits`, `origin` (board review), `answers: [{ts, text}]` |
| `POST /v1/next` | `{}` | `ticket: {n, title, state, resumed, origin?, answers?}` or `ticket: null` |
| `POST /v1/heartbeat` | `{n}` | `touched` |
| `POST /v1/release` | `{n, comment}` | `state` |
| `POST /v1/file` | `{title, body, repo?}` (`repo`: an alias, default the first repository) | `n`, `url` |
| `POST /v1/handoff` | `{n, comment}` | `state`, `commits` |
| `POST /v1/pass` | `{n, comment, build, gates: {sha, ok}, owner_check?}` | `state` (`closed` or `board review`) |
| `POST /v1/fail` | `{n, comment, build}` | `state` |
| `POST /v1/stuck` | `{n, comment}` | `state` |
| `POST /v1/triage` | `{n, comment}` | `state` |
| `POST /v1/spec` | `{n, body, title?, comment?}` | `state` |
| `POST /v1/sendback`, `rework`, `drop` | `{n, comment}` | `state` |
| `POST /v1/escalate` | `{n, comment}` (with the owner card) | `state`, `telegram: "sent" \| "queued"` |
| `POST /v1/approve`, `postpone`, `resume` | `{n, comment?}` | `state` |
| `POST /v1/answer` | `{n, text}` | `state` |
| `POST /telegram` | a Telegram update | the chat webhook (`X-Telegram-Bot-Api-Secret-Token`) |
| `GET /setup` | | per workspace: the profile/webhook steps run (the deploy calls it); a standalone workspace takes the request's origin as the base of its webhook address |
| `POST /hooks/<workspace>/<alias>` | a tracker's webhook delivery | `200 ok` (also a redelivery, and in a paused workspace), `401` with no body for a wrong or missing signature/token or an unknown hook, `413` over 5 MB; the work runs after the response (docs/webhooks.md) |

## States and transitions (trunk)

| State label | Means | Board | Owner assigned |
|---|---|---|---|
| `needs triage` | new; the board specifies it (no label counts as this) | Todo | no |
| `ready` | specified, a developer may take it | Todo | no |
| `in development` | a developer holds it | In progress | no |
| `ready for testing` | commits on main, waits for the tester | In progress | no |
| `testing` | the tester holds it | In progress | no |
| `back to development` | testing, the board or the owner found problems | Todo | no |
| `board review` | waits for the board: a question, a blocker, a passed ticket | Todo | no |
| `human review` | the owner's inbox; only the board puts a ticket here | Owner | yes |
| `postponed` | parked on the owner's word | On hold | no |
| (closed) | done (`completed`) or dropped (`not planned`) | Done | no |

| Command | Role | From | To | Comment | Checks |
|---|---|---|---|---|---|
| `file` | all | (new) | `needs triage` | none | title 1-120 chars, body non-empty |
| `next` | developer | `back to development`, `ready` | `in development` | none | resumes the caller's claim first; dependencies closed |
| `next` | tester | `ready for testing` | `testing` | none | as above |
| `next` | board | `board review`, `needs triage` | (unchanged) | none | claim only; oldest hand-over first, then lowest number |
| `heartbeat` | board, developer, tester | `needs triage`, `board review`, `in development`, `testing` | (unchanged) | none | caller holds the claim |
| `release` | board | `needs triage`, `board review` | (unchanged) | optional | caller holds the claim |
| `release` | developer | `in development` | `back to development` with commits, else `ready` | required | caller holds the claim |
| `release` | tester | `testing` | `ready for testing` | required | caller holds the claim |
| `handoff` | developer | `in development` | `ready for testing` | required; `Commits: …` appended | claim; a new ` (#N)` commit on main |
| `pass` | tester | `testing` | closed; `board review` with `owner_check` | required; `Tested build: …` appended | claim; gates on the build; build on main and containing the ticket's commits; with `owner_check` a valid card |
| `fail` | tester | `testing` | `back to development` | required | claim; build on main |
| `stuck` | developer, tester | `in development`, `testing` | `board review` | required | claim; origin recorded |
| `triage` | board | `needs triage`, `board review`, `human review` | `ready` | required | no developer/tester claim; `## Acceptance` |
| `spec` | board | `needs triage`, `ready`, `back to development`, `board review` | (unchanged) | optional | no developer/tester claim |
| `sendback` | board | `board review` | origin `in development` → `back to development`, `testing` → `ready for testing` | required | origin not `passed` |
| `rework` | board | `board review`, `human review`, `ready for testing`, `needs triage (answered)` | `back to development` | required | no tester claim |
| `escalate` | board | `needs triage`, `ready`, `back to development`, `board review` | `human review` | the card | card valid; the chat card goes out in the same request |
| `approve` | board | `board review`, `human review`, `needs triage (answered)` | closed `completed` | optional | |
| `drop` | board | `needs triage`, `ready`, `back to development`, `board review`, `human review`, `postponed` | closed `not planned` | required | no developer/tester claim |
| `postpone` | board | `human review`, `needs triage (answered)` | `postponed` | optional | |
| `resume` | board | `postponed` | `needs triage` | optional | |
| `answer` | owner | any, also closed | `needs triage` from `human review`, `postponed`, closed; else unchanged | the owner's words | text non-empty |

Leaving `board review` drops the recorded origin; every state change drops the claim except `next` and
`answer`. Claims expire after `leaseHours` (3) without a heartbeat or command: the cron puts an expired
developer/tester claim back in its queue with a `Board:` comment and drops an expired board claim silently.
`(answered)`: only when an owner answer was recorded after the ticket last entered that state.

## The switches' commands and states

Branching, versioning and the other options (docs/flow-features.md). Every part beyond the base belongs to a
feature of the workspace document (docs/configuration.md, "Features"); with every feature off the flow is the base
above, whatever the starting point (`trunk` or `pr-release`) is called. The commands and
states below exist only with their feature; the rest is as in `trunk`, with `sampler` added where it applies.

| State label | Feature | Means | Board | Owner assigned |
|---|---|---|---|---|
| `needs samples` | `samples` | specified, no real sample yet; the sampler's queue | Todo | no |
| `in procurement` | `samples` | the sampler holds it | In progress | no |
| `samples unobtainable` | `samples` | the owner's inbox: a sample only the owner can provide (only the board puts it here) | Owner | yes |
| `awaiting release` | `releases` (`hold`) | a test card waits until the published release has the ticket's code | Owner | no |

| Command | Feature | Role | From | To | Body | Checks |
|---|---|---|---|---|---|---|
| `triage` | `samples` | board | as `trunk` | `needs samples` with `samples: true`, else `ready` | `{n, comment, samples?, paths?}` | `ready` needs `paths` on main or the not-file-related label |
| `found` | `samples` | sampler | `in procurement` | `ready` | `{n, paths, comment?}` | claim; paths on main |
| `unobtainable` | `samples` | sampler | `in procurement` | `board review` (origin `unobtainable`) | `{n, comment}` with a card | claim; card valid |
| `needsamples` | `samples` | board | `board review`, `human review`, `samples unobtainable`, `needs triage (answered)` | `needs samples` | `{n, comment?}` | |
| `escalate` | `samples` / `releases` | board | as `trunk` | `samples unobtainable` for an unobtainable ticket (needs `Kind: sample`); `awaiting release` for a test card whose commits the release lacks; else `human review` | `{n, comment}` | card valid |
| `pr` | `pullRequests` | developer | `in development` | (unchanged) | `{n}` | claim; the branch exists. Answers `pull: {number, url, branch}` |
| `merge` | `pullRequests` (`merger: developer`), `dependencyTickets` | developer | `in development` | (unchanged) | `{n}` | claim; the pull request open, checks green. Answers `merged` |
| `handoff` | `pullRequests` / `dependencyTickets` | developer | `in development` | `ready for testing` | `{n, comment}` | claim; `merger: flow`: pull request open + checks green; `merger: developer` or a dependency ticket: merged. `Pull request: …` appended |
| `pass` | `pullRequests` / `uiReview` | tester | `testing` | closed, or `board review` with `owner_check` or a UI change (then a card is required) | as `trunk` | `merger: flow`: the build contains the pull request's head, which pass merges. Answers `merged`, `tested` |
| `checked` | `userFeedback.autoTriage` | board | any open state | (unchanged) | `{n, comment}` | the ticket has the feedback label, which goes |
| `released` | `releases` | (cron) | `awaiting release` | `human review`, the card goes out with `📦 In <version> or later` | | the release contains the ticket's commits |

`show` adds `branch` and `pull: {number, url, state, head, checks: green|pending|failed|none, waiting?}` with
`pullRequests` (and for dependency tickets). The cron also files dependency tickets and moves the tested tag.

## The owner card

`escalate` and `pass` with `owner_check` need this block in the comment (`texts.cardHeading`, default
`For the owner`):

```
### For the owner
Kind: test | question | decision
Changed: <one line, what is different now, in user words>   (test)
Check:                                                       (test)
- <where to look and what to see>
Question: <the question, the options, a recommendation>      (question, decision)
```

The block runs from the heading (2 to 4 `#`) to the next heading; field names are case-sensitive at line start;
a value continues on the following non-empty lines.

## Configuration API (managed mode)

For automation: an agent writes a workspace document (docs/configuration.md, `schema/workspace.schema.json`)
and submits it; the same validation as the chat import. `Authorization: Bearer <FLOWEE_ADMIN_TOKEN>` (a Worker
secret; without it every call is 401). In the standalone mode every `/admin/` path answers `501 unsupported`.

| Method + path | Body | Response (besides `ok`) |
|---|---|---|
| `GET /admin/workspaces` | | `flowee: 1`, `workspaces: [<document>…]`: the instance document, no secrets |
| `GET /admin/workspaces/<id>` | | `workspace`, `missing: [<secret name>…]`, `owner`, `paused` |
| `PUT /admin/workspaces/<id>` | the workspace document (`id` must be `<id>`) | `id`, `created`, `missing` (the secret names still needed). Invalid: `400 bad_config` with `problems: ["$.path: one sentence.", …]`, nothing changed. Owner: the instance owner (kept when replacing). |
| `PUT /admin/workspaces/<id>/secrets` | `{"<SECRET_NAME>": "<value>", …}` | `stored`, `missing`. Names the document does not reference are refused. The project key (`agents.key`) and an agent's secret (`roles[].secret`) are given as themselves and stored only as their SHA-256; the rest is sealed (AES-GCM). |
| `POST /admin/workspaces/<id>/key` | | `id`, `key`: a new project key, answered only this once; the old one stops working at once. A workspace without `agents` gets `agents.key` (its slot `W_<ID>_KEY`); its agents with their own secrets keep them |
| `DELETE /admin/workspaces/<id>` | | `deleted: true` |
| `POST /admin/workspaces/<id>/people` | `{"id"?, "name"?, "role"?: "member" \| "manager"}` | `person`, `key`: a terminal person (docs/tui.md) with a new key, answered only this once; the document keeps its SHA-256 (`tui.people[].key`) |
| `DELETE /admin/workspaces/<id>/people/<person>` | | `removed: true`; the key stops working at once (the last person stays: `409`) |
| `GET /w/<id>/config` | (the project key or an agent token of that workspace) | `workspace`: its document, no secrets; `sync`: as `GET /v1/sync` |

The documents keep the secret names they are given (the operator's API); the chat import gives a workspace its
own slot names instead (docs/configuration.md, "Secrets in the managed mode").

## The terminal interface

`/tui/v1/…` is the terminal client protocol (docs/tui-protocol.md): `GET /tui/v1/me`, `POST /tui/v1/w/<id>/sync`,
the WebSocket `GET /tui/v1/w/<id>/socket`, and in the managed mode the setup seat `…/tui/v1/instance/sync|socket`.
Authentication is a person's key (`Authorization: Bearer <key>`), never an agent's token.

## Public material and validation (no authentication)

Every instance serves the material of the version it runs, built from the repository at deploy (`served/`, the
Worker's static assets), outside every workspace and Durable Object. No path needs a token; none holds a secret or a
deployment value (the build refuses one). `GET` and `HEAD` only; each answer has a content type, `Cache-Control:
public, max-age=60, must-revalidate` and an `ETag` (`If-None-Match` answers `304`).

| Path | Answer |
|---|---|
| `/`, `/llms.txt`, `/index.md` | the root document for an agent told "use this URL to set Flowee up": this instance's facts (base URL, version and commit, mode, bot, trackers, chat backends, who may create workspaces and how), the questions to ask the user and the procedure. `text/markdown`; `/` with `Accept: text/html` answers the landing page instead (`/site/`, with the same facts) |
| `/INSTALL.md` | the installation procedure for every variant (a hosted instance, the published image, one executable, Cloudflare), written for an agent; the root document points to it |
| `/skills/`, `/skills/<skill>/SKILL.md`, `/skills/<skill>/references/<file>.md` | the three skills; `/skills/` is a generated index, one line per file |
| `/docs/`, `/docs/<file>.md`, `/docs/agents/` (`README.md`), `/docs/agents/<role>.md` | the docs and the agent role templates; `/docs/` is a generated index |
| `/client/flowee.py` | the client (`text/plain`) |
| `/schema/workspace.schema.json`, `/schema/instance.schema.json`, `/flows/<file>.json` | the JSON Schemas, the flow and its options |
| `/LICENSE`, `/assets/logo.svg` | the licence, the logo |
| `/site/landing.css`, `/site/landing.js`, `/site/index.html` | the landing page's style, script and template (`{{fact}}` placeholders) |
| `/bundle.tar.gz` | all of the above but the logo and the landing page under `flowee/` (`INSTALL.md`, `skills/`, `docs/`, `client/`, `schema/`, `flows/`, `LICENSE`) |
| `/manifest.json` | `flowee` (version), `commit`, `client: {version, sha256}`, `files`, `bundle` (the archive's entries) |
| `/version` | `{"ok": true, "flowee", "commit", "client": {"version", "sha256"}}`; `flowee.py version` reads it |

`POST /validate` checks a workspace or instance document with the same validator as `bun run validate`, `flowee validate` and the
import, against this instance's version. Nothing is stored, logged or changed; it does not know the instance's other
workspaces (a repository another workspace already has is refused only at submission).

| Request | Answer |
|---|---|
| a valid document (JSON body) | `200 {"ok": true, "kind": "workspace" \| "instance", "ids": ["acme"]}` |
| an invalid one | `400 {"ok": false, "error": "bad_config", "message": "The document has 2 problems.", "problems": ["$.path: one sentence.", …]}` (`$: is not JSON (…).` when it is no JSON) |
| more than 256 KiB | `413 too_large` |
| more than 30 a minute from one address | `429 rate_limited` (counted per Worker isolate: a simple brake, not a quota) |
| another method | `405 method_not_allowed` |

```sh
curl -fsS -H 'content-type: application/json' --data @workspace.json https://<instance>/validate
```

## The client

`client/flowee.py` (stdlib Python ≥ 3.11) is one subcommand per endpoint, the agents' commands (`roles`, `agents`,
`agents add ROLE [NAME]`, `agents rename OLD NEW`, `agents pause|resume|remove NAME`, with the project key; `agents
add` with a name is idempotent: an agent of that name and role exits 0; in strict mode it writes the new agent's
secret to its `secret_file` with mode 600 and prints only the path), plus the local steps `gates`, `commit`,
`push`, `busy`, and `version` / `update` against the instance (`GET /version`, `GET /client/flowee.py`; no secret):
`version` prints the client's and the instance's version and says when the served client is newer or differs;
`update` replaces the file with the served one after checking it parses, atomically, and only when called. It reads `.flowee.toml` in the repository root:

```toml
url = "https://flowee.example.workers.dev"
workspace = "acme"                                   # → /w/acme/v1/…
key_file = "~/.secrets/flowee/{workspace}/key"       # the project key, mode 600 (or FLOWEE_TOKEN)
agent = "dev1"                                       # this clone's agent (or FLOWEE_AS); sent as X-Flowee-Agent
# secret_file = "~/.secrets/flowee/{workspace}/{instance}"  # an agent's own secret: strict mode, or the former way
main_branch = "main"
commit_types = ["feat", "fix", "docs", "test", "refactor", "perf", "build", "chore", "style"]
ticket_suffix = " (#{n})"
busy_hours = 2
git_config = ["credential.helper=!/usr/bin/gh auth git-credential"]   # -c values for fetch and push

[[gates]]
name = "test"
dir = "."
cmd = ["bun", "run", "test"]
```

With pull requests (`features.pullRequests`; the Worker names the branch in `show`): `branch N` switches to the
ticket's branch (fetched when it exists on `origin`, else created from the main branch); `pr N` pushes it (fast-forward
only, commits signed and ending with the ticket suffix) and calls `pr`; `checks N` prints the pull request's checks
(`green`, `pending: build (in progress)`, `failed`, `none`; exit 0 green or merged, 3 still waiting, 2 failed or no
pull request); `merge N` calls `merge`, which the Worker refuses unless the flow lets the developer merge. `push` on
a ticket branch pushes that branch and never the main branch; the client never merges by itself. A tester checks out
the ticket's branch with `branch N`, so `pass` sends its head as the build. Samples and untrusted text:
`found N PATH…`, `triage N [--samples] [PATH…]`, `unobtainable N`, `needsamples N`, `checked N`.

Exit codes: 0 ok, 2 refused, 1 failure, 3 `next` found nothing. `pass` sends `HEAD` as the build and refuses
locally unless `flowee.py gates` passed on a clean `HEAD`; `commit` refuses unless the gates passed on exactly
the working tree; `push` only ever pushes to the clone's own `origin`.

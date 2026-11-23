# Every field

Taken from Flowee's `docs/configuration.md`; a test in the Flowee repository fails when a field of the JSON Schema
is missing here. A **secret name** matches `^[A-Z][A-Z0-9_]*$` and names a Worker secret; it never holds one.

## The workspace document

| Field | Type | Default | Meaning |
|---|---|---|---|
| `flowee` | `1` | required | Schema version. |
| `id` | string `^[a-z0-9][a-z0-9-]{0,62}$` | required | Workspace id; the API base is `/w/<id>`. |
| `name` | string | | Display name. |
| `flow` | object | required | `{"preset": "trunk"}` or `{"chart": {…}, "options": {…}}` (inline XState statechart and options, see `statecharts.md`). |
| `flow.preset` | `"trunk"`, `"pr-release"` | | A named starting point; both load the one chart, whose parts switch with `features` only (`features.md`): `trunk` starts as Single branch, `pr-release` as Feature branches with Versioning. |
| `flow.chart`, `flow.options` | object | | An inline flow; validated by the same loader as presets. |
| `features` | object | `{}` | Feature switches of the flow, each off unless given; see `features.md`. |
| `tracker` | object | required | The tracker that keeps the record. |
| `tracker.type` | `"github"`, `"gitlab"` | `"github"` | The tracker of every repository that names none (docs/gitlab.md for GitLab). |
| `tracker.repos` | array, ≥ 1, of paths or `{repo, alias?, token?, mainBranch?, type?, api?}` | required | The repositories. With several, a ticket is `alias#n` (see below). |
| `tracker.repos[].repo` | `owner/name` (GitLab: `group/subgroup/project`, any depth) | required | The repository's path on its tracker. |
| `tracker.repos[].alias` | string `^[a-z0-9][a-z0-9-]{0,31}$` | the last path part, lowercased | The `app` of `app#12`; unique in the workspace. |
| `tracker.repos[].token` | secret name | `tracker.token` | This repository's own tracker token; required when its `type` differs from `tracker.type`. |
| `tracker.repos[].mainBranch` | string | `tracker.mainBranch` | This repository's branch commits land on. |
| `tracker.repos[].type` | `"github"`, `"gitlab"` | `tracker.type` | This repository's tracker: a workspace may mix GitHub and GitLab repositories, each ticket goes through its own repository's tracker. |
| `tracker.repos[].api` | URL | `tracker.api` when its type is `tracker.type`, else the type's public API | This repository's tracker API (self-managed GitLab `https://gitlab.example.com/api/v4`, GitHub Enterprise). |
| `tracker.mainBranch` | string | `main` | The branch commits land on. |
| `tracker.api` | URL | `https://api.github.com` (`gitlab`: `https://gitlab.com/api/v4`) | The API base of `tracker.type` (GitHub Enterprise, self-managed GitLab, a local stand-in). |
| `tracker.token` | secret name | required | The tracker token, shared by every repository without its own. |
| `tracker.project` | `{owner, number}` | | A user's GitHub Projects (v2) board whose Status follows the state (needs a classic token). |
| `tracker.project.owner` | string | required | The user login owning the project. |
| `tracker.project.number` | integer ≥ 1 | required | The project number. |
| `tracker.tokenDays` | integer 1 to 366, or `"none"` | `366` (else `instance.tokenDays`) | The lifetime the wizard's token link asks for: GitHub's `expires_in` (1 to 366 days, or `none` for no expiry; an organisation's lifetime policy may still cap it); GitLab's form takes no expiry in the link, so the screen asks for a date that many days ahead (GitLab caps it at 365). |
| `tracker.notPlannedLabel` | string | `not planned` | GitLab stores no close reason: a ticket the flow closes as not planned (`drop`) gets this label, taken off again when it reopens. GitHub uses its own `not_planned` reason. |
| `roles` | array, ≥ 1 | required | The callers of the API. |
| `roles[].instance` | string `^[a-z0-9][a-z0-9-]*$` | required | Instance name (claims belong to it), unique. |
| `roles[].role` | string | required | A role of the flow (`trunk`: board, developer, tester, owner). |
| `roles[].secret` | secret name | required | Holds the SHA-256 hex of this instance's API secret. |
| `owners` | array, ≥ 1 | required | The humans in the loop. |
| `owners[].name` | string | | Name. |
| `owners[].tracker` | string | | Tracker login, assigned while a ticket is in the inbox state (the first owner that has one). |
| `owners[].chat` | numeric string | | Chat user id; only owners' messages and button presses count. |
| `chat` | object | | The owner's chat (the envoy). Without it the API works alone and `escalate` answers `queued`. |
| `chat.type` | `"telegram"` | required | The chat adapter. |
| `chat.token` | secret name | required | The bot token. |
| `chat.webhookSecret` | secret name | required | The webhook's secret token. |
| `chat.username` | string | | The bot's username, so `/cmd@Bot` is recognised; other bots' commands are text. |
| `chat.chatId` | numeric string | required | The bound chat: a private chat, a group or a supergroup. |
| `chat.topicId` | integer ≥ 1 | | Bind only this forum topic of the chat (without it, the whole chat). |
| `chat.publicUrl` | `https://…` | | The instance's public URL: `GET /setup` sets the webhook (`<url>/telegram`) and the bot profile from this workspace. Give it in one workspace only. |
| `chat.managed` | boolean | `false` | Managed mode: the workspace's own bot, created through the instance bot; its webhook is `<publicUrl>/telegram/w/<id>` and its profile and settings come from this workspace. Without it the workspace uses the instance's bot. |
| `chat.transport` | `webhook`, `polling` | `webhook`; self-hosted without a public URL: `polling` | `polling`: the self-hosted runtime fetches the bot's updates (getUpdates), no public address needed; `webhook`: needs `chat.publicUrl`. Cloudflare supports only `webhook`. |
| `chat.members` | array of user ids | every member | In a group or topic: only these users work the tickets (the owners always do). Refused for a private chat. |
| `tui` | object | | The terminal interface (docs/tui.md): people who sign in with `flowee-tui`. With `chat` too, Telegram and the terminals show one conversation: the same cards, bar and answers, each answer visible in both. Without `chat` the workspace needs no messenger at all. |
| `tui.people` | array, ≥ 1 | required | Who may sign in. More than one person makes the inbox a team inbox: answers are signed by name and the first answer to a card wins. |
| `tui.people[].id` | string `^[a-z0-9][a-z0-9-]{0,31}$` | required | The person's id, unique in the workspace (in `/admin/workspaces/<id>/people/<person>`). |
| `tui.people[].name` | string | the id | The display name; signs the person's answers in a team inbox. |
| `tui.people[].role` | `member`, `manager` | `member` | `member` answers the inbox; `manager` also manages the workspace in the managed mode (people and their keys). |
| `tui.people[].key` | SHA-256 hex | required | The digest of the person's key (`flowee-tui --new-key` writes the key to its key file and prints only this digest). The key itself is never in a document. One key may open several workspaces: give the same digest in each. |
| `files` | object | | Where files the owner sends are uploaded; without it files are refused. |
| `files.url` | URL | required | A rustypaste-compatible endpoint (multipart `file`, `Authorization`, `expire` headers; answers the link). |
| `files.token` | secret name | required | The upload token. |
| `files.expire` | string | `90d` | The `expire` header. |
| `texts` | object | | Texts the envoy and the flow show. |
| `texts.owner` | string | `Owner` | The owner's comment signature (`Owner:`). |
| `texts.cardHeading` | string | `For the owner` | The card heading (`### For the owner`). |
| `texts.botName` | string | `Flowee Envoy` | The bot's name. |
| `texts.project` | string | the id | The project's name in the texts below. |
| `texts.welcome` | string (HTML) | built from `botName` and `project` | The one-off welcome. |
| `texts.about` | string | `Your <project> review inbox as a todo list: tests, questions and decisions waiting for you, answered by replying.` | The bot description. |
| `texts.shortAbout` | string | `The <project> review inbox as a todo list.` | The short description. |
| `texts.filedBody` | string | `Filed by the owner through Envoy; the Board writes the spec from their words.` | First line of a ticket filed from the chat. |
| `texts.untitled` | string | `Request from the owner` | Title of a ticket filed with an empty first line. |
| `texts.memberSign` | string | `{who}` | The signature of an answer given in a group or topic: `{who}` is the name with `(@username)`, `{name}` and `{username}` alone (docs/envoy.md, "Teams"). |
| `schedule` | object | | Times. |
| `schedule.timezone` | IANA zone | `UTC` | The digest hour and "answered today". |
| `schedule.digestFrom` | integer 0-23 | `9` | The morning digest is sent from this hour… |
| `schedule.digestTo` | integer 1-24 | `12` | …until before this hour. |
| `sync` | object | | How Flowee learns of tracker changes: webhooks first, polling as the fallback. |
| `sync.webhooks` | `auto`, `off`, `required` | `auto` | `auto`: register the webhook through the tracker token and poll while it is missing or unhealthy; `off`: always poll; `required`: never poll. |
| `sync.reconcileMinutes` | integer 5-1440 | `30` | Full listing this often while webhooks are healthy (catches missed deliveries). |
| `sync.pollMinutes` | integer 1-60 | `1` | Full listing this often without webhooks. |
| `managers` | array of user ids | the creator only | Managed mode: who manages the workspace besides the one who set it up: configuration, secrets, pause, delete, export. A manager's changes keep the creator as creator and do not add the manager to `owners`. |
| `profile` | object | | The bot's profile. |
| `profile.photo` | `https://…` | | A PNG fetched and set as the bot's photo (once per change). |

## Several repositories

With one repository a ticket is its issue number (`12`, `#12`, commits end with ` (#12)`). With several, a ticket
is `alias#n` everywhere: API bodies (`{"n": "app#12"}`), query strings (`show?n=app%2312`), responses, cards and
errors; a bare number is refused. A commit names its ticket with ` (#12)` in the ticket's own repository or with
` (app#12)`. `Depends on: #3, lib#4` resolves a bare `#3` in the ticket's own repository. `file` takes an optional
`repo` (an alias; default the first repository). Aliases default to the repository name, lowercased, other
characters as `-`; give one when two names would collide or the name gives no usable alias.

Repositories may live on different trackers (`tracker.repos[].type`, `tracker.repos[].api`): each ticket's issue,
comments, commits, pull or merge request, checks, tags and releases go through its own repository's tracker, and
every feature must be one each of them can do. The same path on GitHub and on GitLab is two repositories; slots of
a non-GitHub repository are kept by `<type>:<host>/<path>`.

## Secrets

| Field naming a secret | The secret's value |
|---|---|
| `tracker.token` | the tracker token (GitHub: a fine-grained token with Issues read/write and Contents read on the repository; a classic token with `repo` + `project` when `tracker.project` is set. GitLab: a project or personal access token with `api` scope and at least the Planner role, Developer for the code features: docs/gitlab.md) |
| `roles[].secret` | the SHA-256 hex of the instance's API secret (`printf %s "$SECRET" \| sha256sum`), never the secret |
| `chat.token` | the bot token |
| `chat.webhookSecret` | a random string; Telegram sends it back with every update |
| `files.token` | the upload endpoint's token |

In the managed mode, workspaces made or imported in the chat name their own slots: `W_<ID>_TRACKER`, `W_<ID>_BOT`,
`W_<ID>_HOOK`, `W_<ID>_<INSTANCE>` (upper case, `-` as `_`).

## The instance document

`{"flowee": 1, "workspaces": [<workspace>, …], "instance": {…}}` (`schema/instance.schema.json`). `instance` is
required in the managed mode (`FLOWEE_MODE = "managed"`) and ignored in the standalone one.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `flowee` | `1` | required | Schema version. |
| `workspaces` | array of workspace documents | required | The preconfigured workspaces (managed: imported at start, owned by `instance.owner`). |
| `instance` | object | | The managed instance. |
| `instance.bot` | object | required | The instance bot. |
| `instance.bot.token` | secret name | required | Its token. Bot management must be on (BotFather) for own workspace bots. |
| `instance.bot.webhookSecret` | secret name | required | Its webhook secret (any random string). |
| `instance.bot.username` | string | | Its username, shown in the wizard. |
| `instance.publicUrl` | `https://…` | required | The Worker's URL; webhooks `<url>/telegram` and `<url>/telegram/w/<workspace>`. |
| `instance.transport` | `webhook`, `polling` | `webhook` | `polling` only self-hosted: the instance bot and the own bots by getUpdates. |
| `instance.owner` | chat user id | required | The instance owner. |
| `instance.creators` | array of chat user ids | `[owner]` | Who may create workspaces (wizard and imports). |
| `instance.limits` | object | | Limits. |
| `instance.limits.workspacesPerUser` | integer ≥ 1 | `5` | Workspaces one user may own. |
| `instance.profile` | object | Flowee's texts, the bundled photo | The instance bot's profile. |
| `instance.profile.name` | string | `Flowee` | Bot name. |
| `instance.profile.description` | string | Flowee's | Bot description. |
| `instance.profile.shortDescription` | string | Flowee's | Short description. |
| `instance.profile.photo` | `https://…` PNG | the bundled logo | Profile photo. |
| `instance.trackerApi` | URL | `https://api.github.com` | The tracker API of workspaces made in the wizard. |
| `instance.tokenDays` | integer 1 to 366, or `"none"` | `366` | The token lifetime the wizard asks for when a workspace's `tracker.tokenDays` names none. |

Instance vars (in `wrangler.toml` or as secrets): `FLOWEE_MODE` (`standalone` default, `managed`), `FLOWEE_CONFIG`
(the instance document as JSON; wins over the committed `flowee.config.json`), `FLOWEE_KEY` (managed, required:
seals the secrets entered in the chat; changing it makes them unreadable), `FLOWEE_ADMIN_TOKEN` (managed: the
configuration API's bearer token).

## Invalid combinations (the validator says each in one sentence)

- A `roles[].role` that is no role of the flow; an `instance` used twice.
- Two repositories with the same alias, the same repository twice on one tracker, or a name that gives no usable alias.
- A repository path that is not of its tracker's form (GitHub: `owner/name`); a repository whose `type` differs from
  `tracker.type` without its own `token`; `tracker.project` (a GitHub board) without any GitHub repository.
- No instance with the flow's owner role (`trunk`: `owner`): the owner could not answer through the API.
- `chat` without any `owners[].chat`.
- `files` without `chat`; `profile` without `chat.publicUrl`.
- `schedule.digestFrom` not before `schedule.digestTo`; a `schedule.timezone` that is no IANA zone.
- An inline `flow` that does not load (every loading check of `statecharts.md`).
- A feature the flow has no states for, or that the tracker cannot do (`$.features.samples: the inline flow has no
  feature 'samples'.`); `releases.source: "tag"` without `releases.tag`; `releases.testedTag` equal to `releases.tag`;
  `uiReview` without any of `paths`, `addedFiles`, `addedLines`, or with an `addedLines` entry that is no regular
  expression; `untrustedReports.role` that is no role of the flow; an instance of a role whose feature is off.
- In an instance document: a workspace id twice; two workspaces bound to the same chat and topic; one repository
  in two workspaces (their claims and tickets would clash); (standalone) two different bots.

# Ports and adapters

The core (`src/core`) and the envoy (`src/envoy`) talk to the world only through the ports in `src/ports`.
Adapters (`src/adapters`) implement them; `src/adapters/store-durable-object.ts` (`build()`) wires a workspace's
document to its adapters. `test/boundary.test.ts` fails when a layer imports across these lines.

| Port | Phase 1 adapter |
|---|---|
| `Tracker` | `tracker-github.ts` (REST + Projects v2 GraphQL) |
| `Chat` | `chat-telegram.ts` (Bot API, rich messages) |
| `Store` | `store-durable-object.ts` (`SqlStore`, Durable Object SQLite; one object per workspace) |
| `Clock` | the Durable Object (`Date.now`, its alarm) |
| `Secrets` | Worker secrets by name (`envSecrets`) |
| `Files` | `files-paste.ts` (rustypaste-compatible upload) |

## Tracker

Required: `issue`, `openIssues`, `create`, `update` (labels, assignees, open/closed with reason, title, body; one
write), `comment`, `comments`, `commits(branch, since)` (oldest first, first line only), `contains(base, head)`.
Errors are `Fail`s: `404 not_found` for a missing issue, `502 <tracker>` naming the write that failed.

Optional capabilities, each an object the adapter sets or leaves undefined; `capability(tracker, "pulls")`
turns a missing one into `501 unsupported` (`The tracker does not support pull requests.`):

| Capability | Methods | Used by |
|---|---|---|
| `board` | `setStatus(issue, status)` | the project board column per state (GitHub adapter: when `tracker.project` is set) |
| `branches` | `head(name)`, `exists(ref, path)`, `changes(sha)` (files + added lines), `remove(name)` | `pullRequests` (the ticket's branch), `samples` (sample paths on main), `uiReview` (the diff) |
| `pulls` | `forBranch(name)`, `get(n)`, `open()`, `create(head, base, title, body)`, `update(n, {title, body})`, `merge(n, method, subject)` | `pullRequests`, `dependencyTickets` |
| `checks` | `forCommit(sha)` (check runs and commit statuses, newest per name) | `pullRequests` (`checksGreen`), `releases` (`checks`: the `tested` tag only onto a green commit) |
| `releases` | `latest()` (tag, name, the built-from sha its notes name, body) | `releases` (`source: "release"`) |
| `tags` | `get(name)`, `move(name, sha)` | `releases` (`source: "tag"`, `testedTag`) |

A workspace that switches on a feature its tracker cannot do is refused when it is loaded
(`$.features.pullRequests: the tracker 'github' cannot do pull requests.`); a call that reaches a missing
capability anyway answers `501 unsupported`. Errors map to the existing codes: a missing pull request is
`404 not_found`, a merge GitHub refuses (not mergeable, head moved) `409 not_mergeable`, anything else `502 github`
naming the call.

### GitHub token permissions per feature

A fine-grained token limited to the workspace's repositories. The base flow needs **Issues: read and write**,
**Metadata: read** and **Contents: read** (commits, compare); a `tracker.project` board needs a classic token with
`repo` + `project` instead (fine-grained tokens cannot write a user's project).

| Feature | Calls | Permission |
|---|---|---|
| `pullRequests` | branch heads, open/update/read pull requests, check runs and statuses, merge, delete the branch | **Pull requests: read and write**, **Checks: read**, **Commit statuses: read**, **Contents: read and write** (merging and deleting a branch write contents) |
| `releases` | the latest release, read a tag | **Contents: read** |
| `releases.testedTag` | move the tag | **Contents: read and write** |
| `releases.checks` | check runs and statuses of main's commits | **Checks: read**, **Commit statuses: read** |
| `samples` | does a path exist on main | **Contents: read** |
| `uiReview` | the files and lines of the ticket's commits | **Contents: read** |
| `dependencyTickets` | list open pull requests, read one, file a ticket | **Pull requests: read**, **Issues: read and write** |
| `untrustedReports` | labels only | (base) |

## Chat

A chat adapter implements `Chat` (`src/ports/chat.ts`):

- `parse(update)`: a raw update to a `ChatEvent`: a `message` (update id, chat + topic, sender id, message id,
  text, the message it replies to and whether that is the bot's, album id, content: text / files / voice /
  unsupported) or a `press` (update id, sender, query id, button data, the message pressed). Anything else: null.
- `view(to, view, {forceReply?, replyTo?})`, `editView`: a `View` is a list of blocks: `{html}` (p, b, i, a,
  code, pre, ul, li, details, summary), `{buttons}` (a centred row), `{table}` (head + rows with one button
  each). A backend with rich messages renders them (Telegram: `sendRichMessage`, `tg-button`); one without
  renders `plain(view)` (text plus keyboard rows, exported by the port) and fakes `details` by showing it.
- `text(to, text, {html, quiet, buttons, replyTo, noPreview})`, `editText`, `remove`, `dropButtons`, `react`,
  `answer(query, toast?)`, `setCommands(commands, to?)`, `download(file)` (never put a token in an error).
- Profile: `setName`, `setDescription`, `setShortDescription`, `setPhoto(png)`, `setWebhook(url, secret)`,
  `webhookUrl()`. A backend without one of them makes it a no-op.

The routing of an update to its workspace is the adapter's too (`Telegram.route(update)` gives the chat and
topic; the Worker looks the binding up in the registry). A Discord adapter would map channels/threads to
`ChatRef {chat, topic}`, interactions to `press`, and render views with `plain()` and components.

### What the wizard needs from a chat adapter

The wizard and the management menu (`src/wizard/`, docs/managed.md) use `text` with HTML and button rows (button
data `w:…`, `m:…`), `dropButtons`, `remove` (the credential message is deleted right after reading), `download`
(an imported `.json` file) and these optional methods: `request(to, html, request)` (a reply-keyboard request:
`managedBot` with a suggested name and username, or `chat` to pick a group), `dropKeyboard`, `sendFile` (exports
and the agents' secrets; without it they are sent as a message), `setScopedCommands(commands, scope)` (`default`,
`private`, `groups` or one chat) and `setSettings` (bot-wide settings, docs/telegram.md). `parse` must also give
`managed` events (a bot the user created), `chatKind` (private or group) and `shared` (a chat picked with a
`chat` request), and `/bind <code>` arrives as a plain message. Managed bots themselves are the optional `Bots`
port (`src/ports/bots.ts`: `token`, `replaceToken`, `access`, `setAccess`; Telegram: `TelegramBots`). A Discord
adapter would render the same views as messages with components, offer no `managedBot` request (the wizard then
skips the bot step: only the instance's bot) and bind channels/threads with the same `/bind` command.

## WorkspaceRegistry

`src/config/registry.ts`: `list`, `get(id)`, `byDigest(sha256hex)` (the API token's workspace and instance),
`byChat({chat, topic})`, `export(id)`, `exportAll()`, `import(doc)` (create or replace, validated before anything
changes), `importAll(instanceDoc)`. `StaticRegistry` is the standalone instance's configuration; `StoredRegistry`
(the managed mode) keeps the same in a `Store` (the Instance Durable Object's SQLite) with each workspace's owner
and paused flag, written through on every change.

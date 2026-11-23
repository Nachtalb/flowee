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

| Capability | Methods | Used by (phase 2, AnyFile's flow) |
|---|---|---|
| `board` | `setStatus(issue, status)` | the project board column per state (GitHub adapter: when `tracker.project` is set) |
| `branches` | `head(name)` | a ticket's branch |
| `pulls` | `forIssue(n)`, `get(number)`, `merge(number, method)` | branch + pull request flows |
| `checks` | `forCommit(sha)` | CI checks green before a pass or a merge (AnyFile: the build workflow on master) |
| `releases` | `latest()` (tag, built-from sha, body) | `awaiting release`: a test card waits until the published build has the ticket's commits |
| `tags` | `get(name)`, `move(name, sha)` | the `tested` tag that moves over main as far as tested tickets allow |

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

## WorkspaceRegistry

`src/config/registry.ts`: `list`, `get(id)`, `byDigest(sha256hex)` (the API token's workspace and instance),
`byChat({chat, topic})`, `export(id)`, `exportAll()`, `import(doc)` (create or replace, validated before anything
changes), `importAll(instanceDoc)`. Phase 1 has `StaticRegistry` (the standalone instance's configuration);
the managed mode of phase 2 adds a stored registry behind the same interface.

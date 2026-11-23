# The terminal client protocol

How a terminal (`flowee-tui`, docs/tui.md) or any other client talks to a Flowee instance's `tui` chat backend. It
is the Chat port (docs/adapters.md) over HTTP: the server keeps the conversation, the client shows it and sends
what the person does. Everything here works the same on the Cloudflare Worker and on the self-hosted runtime.
Another client (a web page, a Discord bridge) implements exactly this page.

## The model

One workspace has one conversation, as one Telegram chat has. The envoy writes into it what it would send to
Telegram: messages holding a **view** (the Chat port's `View`, below), edits of them, removals, toasts and the
command menu. Every change is an **event** with a **sequence number** (`seq`), counted per workspace from 1 and
never reused. The server keeps the newest 2000 events and the newest 300 messages.

A client keeps `seq`, the number of the last event it applied. It asks for the events after it; when the server no
longer has them (the client was away very long, or the server's store was wiped) it answers the whole conversation
instead (a **reset**). So a reconnect resumes exactly: nothing is lost, nothing shown twice; several terminals of
the same person, or of the team, stay in sync, and what happened while a terminal was closed is there when it
connects.

With more than one person the conversation is a team inbox, as a Telegram group is: everyone sees the same
messages, every answer is signed with the name of who gave it, and the first answer to a card wins.

With a workspace on Telegram too (`chat` and `tui` in its document), the conversation is the Telegram chat's:
messages carry Telegram's message ids, and what a person does in a terminal reaches the same envoy as a press in
Telegram, so an answer given on one side shows on the other.

## Authentication

Every request carries the person's key: `Authorization: Bearer <key>`. The server keeps only the key's SHA-256
hex digest (in the workspace document, `tui.people[].key`); a person's key opens every workspace whose people list
that digest. Unknown key: `401`. A key that does not open the workspace in the path: `403`. A paused workspace:
`503`. Keys are 43 characters of base64url (32 random bytes) after `fwk_`; `flowee-tui --new-key` makes one.

## Endpoints

All under the instance's base URL. Answers are JSON with `ok`; errors are `{ok: false, error, message}` with a
stable `error` code and one sentence.

### `GET /tui/v1/me`

The person and the workspaces their key opens.

```json
{ "ok": true,
  "person": { "id": "ann", "name": "Ann", "role": "manager" },
  "workspaces": [ { "id": "desk", "name": "Desk", "paused": false, "person": { "id": "ann", "name": "Ann", "role": "manager" } } ] }
```

`person` per workspace: the same key may be another id or role in another workspace.

### `POST /tui/v1/w/<workspace>/sync`

Sends what the person did and fetches what changed. Body:

```json
{ "after": 41, "send": [ { "id": "c7a1-0001", "press": { "data": "k", "message": 12 } } ] }
```

`after`: the client's `seq` (0 for a new client). `send`: up to 50 **frames**, handled in order before the answer is
built; each frame has an `id` the client makes unique (a random prefix and a counter). A frame whose id the server has
seen in the last seven days is skipped, so a request retried after a lost answer does nothing twice.

A frame is exactly one of:

| Frame | Meaning |
| --- | --- |
| `press: {data, message}` | A button with `data` was pressed on message `message`. |
| `text: {text, replyTo?}` | Typed text. `replyTo` the message it answers (the card being worked on, a prompt): without it, text goes to the card on screen as on Telegram. A text starting with `/` is a command (`/start`, `/todo`, `/postponed`, `/new`, `/next`, `/prev`, `/skip`, `/stats`, `/search words`). |
| `file: {name, data, caption?, replyTo?}` | A file, `data` base64, at most 20 MB. It answers like a photo or document sent on Telegram: uploaded to the workspace's file store, linked in the answer. |

The answer:

```json
{ "ok": true, "seq": 44,
  "events": [ { "seq": 42, "op": "put", "msg": { "id": 13, "at": 1764000000000, "view": [ … ], "reply": "Your answer…" } },
              { "seq": 43, "op": "del", "id": 11 },
              { "seq": 44, "op": "toast", "text": "✅ #1 OK", "to": "ann" } ] }
```

or, when the log does not reach back to `after`:

```json
{ "ok": true, "seq": 44, "events": [], "reset": { "messages": [ … ], "menu": [ … ], "panel": [ … ] } }
```

On a reset the client drops what it had and takes `messages` (oldest first), `menu` and `panel`. An answer brings at
most 500 events: when `seq` is beyond the last event's, the client syncs again.

### `GET /tui/v1/w/<workspace>/socket`

A WebSocket (`Upgrade: websocket`, the same `Authorization` header): the **doorbell**. The server sends
`{"seq": N}` whenever the conversation changed; the client then calls `sync`. The client may send `ping` (the
server answers `pong`) to keep proxies from closing an idle socket. The socket carries nothing else: all data
goes through `sync`, so a client without sockets works by calling `sync` every few seconds, and a lost socket loses
nothing.

## Events

| `op` | Fields | The client |
| --- | --- | --- |
| `put` | `msg` | Adds the message or replaces the one with the same `id` (an edit). |
| `del` | `id` | Removes the message. |
| `toast` | `text`, `to?` | Shows `text` briefly when `to` is absent or the person's id (the answer to their press). |
| `menu` | `commands` | The command list with its counts (`{command, description}`; `todo`: "3 open items"). |
| `panel` | `view` | The side view: the open items as a table, each row with its Open button (the inbox pane). |

A message (`msg`):

| Field | Meaning |
| --- | --- |
| `id` | Positive: the server's message. Negative: what a person typed or sent (`by`, `said`). |
| `at` | When it was first sent (epoch ms). |
| `view` | Its blocks, below. |
| `reply` | Typing answers this message; the text is the input's placeholder (Telegram's ForceReply). |
| `replyTo` | It answers that message. |
| `quiet` | Sent without notification (the digest, sync notices). |
| `file` | `{name, data, caption?}`: a file to keep (the project key, an export), `data` as text. A client saves it (mode 600) and shows where. |
| `by`, `said` | A person's own message: their name and words (a file as `📎 name`). |
| `reaction` | The server's reaction to it (`👀` seen, `✍` collected, `👍` recorded, `👎` refused). |

## Views

A view is a list of blocks (`src/ports/chat.ts`), the same every chat backend renders (docs/chat-style.md):

| Block | Meaning |
| --- | --- |
| `{html}` | Text in a small HTML subset: `p`, `b`, `i`, `a href`, `code`, `pre` (with `<code class="language-x">`), `details` (`open` or folded) with `summary`; `ul`/`li` only inside a ticket's own text. Entities `&amp; &lt; &gt; &quot;`. |
| `{buttons}` | A row of buttons. |
| `{table: {head?, rows}}` | A table; each row has `cells` (inline HTML) and its own `buttons`, shown in the same row. |

A button is `{label, data?, url?, copy?, style?}`: `data` is pressed back (a `press` frame with the message's id),
`url` opens a link, `copy` copies a text, none of them a label that cannot be pressed.

What the messages are, as `flowee-tui` reads them (a client may do the same): the message that takes typing
(`reply`) is the card being worked on, or a prompt (search words, a new ticket); the newest message with the
envoy's navigation buttons (`t`, `p`, `k`, `s`, `n`, `L:0`, `b`, `F`, `X`) is the bar; a message whose only
button is `k` (✅ OK) is a new item's note; messages without buttons are notices. A wizard or menu screen of the
managed mode is a message with its own buttons (`w:…`), edited in place step by step.

## Writing a client

1. `GET /tui/v1/me` with the key; pick the workspace.
2. `sync` with `after: 0`; apply the events (or the reset).
3. Open the socket; on every ring, and every 30 s anyway, `sync` with the last `seq`.
4. On a key or button: a frame with a fresh id, in the next `sync`. Keep frames that were not answered and send them
   again with the same ids.
5. Render views as above; give every button a key or a click; save `file` messages with mode 600.

The shared types are `src/ports/tui.ts` and `src/ports/chat.ts`; `tui/state.ts` is the reference for applying events.

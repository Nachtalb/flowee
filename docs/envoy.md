# The Envoy: the owner's inbox in a chat

The Envoy (`src/envoy`, rendered by a chat adapter such as `src/adapters/chat-telegram.ts`) brings the tickets that
wait for the owner into a chat as a todo list. This document specifies what the owner sees and what each message,
command and button does. Each row is one user-visible behaviour; the tests in `test/envoy.test.ts`,
`test/render.test.ts`, `test/render-features.test.ts` and `test/card.test.ts` hold the Envoy to it. Its look
(heading line, bold title, centred button rows, toasts) is the grammar every other screen of the bot follows:
docs/chat-style.md.

Names used below:

- **The owner** is anyone in `owners[].chat`, writing in the bound chat (and topic, docs/telegram.md). Comments the
  Envoy writes for them are signed `<texts.owner>:`; the card heading is `### <texts.cardHeading>`. In a group or
  topic, the whole team works the inbox ("Teams" below).
- **The inbox** is the state with `meta.inbox`, **postponed** the one with `meta.parked` (`trunk`: `human review`,
  `postponed`). **The project** is `texts.project`; the bot's name, descriptions, welcome and filing note are
  `texts.*` (docs/configuration.md).
- **Feature** marks a row that exists only when the workspace switches that feature on (docs/flow-features.md).

## Commands and menu

| # | Behaviour |
|---|---|
| 1 | `setMyCommands` (default scope), in this order: `start` "what this bot does", `todo` "open items", `postponed` "postponed tickets", `new` "new ticket". |
| 2 | Per-chat menu (scope `chat`) with counts: `todo` "`N` open items", `postponed` "`P` postponed tickets"; set after every command, button, recorded answer and poll, only when the whole list changed; a failed call is not retried until `/start`. |
| 3 | Hidden commands that work when typed: `/next`, `/prev`, `/skip`, `/stats`, `/help`, `/search <words>`; arguments of the others are ignored; `/cmd@OtherBot` and unknown commands are handled as plain text. |
| 4 | `/start` and `/help`: clear the menu mark, then straight to work: the current item (or the first open one) as a card with the bar under it; nothing open: the bar alone. |
| 5 | `/todo`: the bar at the bottom becomes page 1 of the list (row 27). |
| 6 | `/postponed`: the bar becomes page 1 of the postponed table (row 31). |
| 7 | `/new`: the ➕ prompt and the File/Cancel bar (row 43). |
| 8 | `/next`, `/prev`: as ▶ Next / ◀ Prev; `/skip` as a reply to a card skips that card, else the current one. |
| 9 | `/stats`: `📋 N open · ✅ M answered today` and, with an open item, `\n⏳ oldest: #n (age)`. |
| 10 | `/search <words>`: results in a fresh bar; no words: `Usage: /search words to find`. |
| 11 | A command's notice (the Prev/Next/Skip toast texts) is sent as a message (HTML, escaped). |

## Cards (rich messages, buttons in the body)

| # | Behaviour |
|---|---|
| 12 | Card: `<p>{emoji} <b>{Kind}</b> · <a href="{issue}#issuecomment-{id}">#n</a> · ⏳ {age}</p><p><b>{title}</b></p><details[ open]><summary>Details</summary>…</details>`; age `N min` / `N h` (under 48 h) / `N d`; answered: `· ✓ answered {age} ago` instead of `⏳`. In a workspace over several repositories the ticket is `alias#n`. |
| 13 | Kinds: 🧪 Test, ❓ Question, ⚖️ Decision, 💤 Postponed, 👀 Review (no valid card block); 📎 Sample (feature `samples`). |
| 14 | Details: `<p><b>Changed:</b></p>`, `<p><b>Samples:</b> <code>a</code>, …</p>` (feature `samples`), `<p><b>Check:</b></p>`, `<p><b>Question:</b></p>`, each value as rich blocks: fenced code `<pre>` (with language), `- ` lines a list, `` `x` `` `<code>`, never a quote. |
| 15 | No valid block: the first 600 characters of the newest comment signed by a role of the flow (`Board:`, `Tester:`, `Developer:`, `Sampler:` …; unsigned text is never shown); none at all: `<i>Older ticket without a hand-over note: open the issue for the details.</i>` |
| 16 | A card is one message, never split. |
| 17 | `📦 In {version} or later` under test cards (feature `releases`, `versionLine`). |
| 18 | New item: the card with details folded and a centred `✅ OK` row, with sound; a reply to it answers it. |
| 19 | Test cards wait until the published build has the code (feature `releases`, `hold`: the `awaiting release` state). |
| 20 | `escalate` sends the card at once; the cron (every minute) also picks up inbox tickets that were never carded and retires the cards of tickets that left the inbox. The first run stores every inbox item as already notified, so a new instance does not flood the chat. |

## The bar (one navigation message, always the last one)

| # | Behaviour |
|---|---|
| 21 | Bar: `<p>✨ Inbox empty</p>` when nothing is open, `<p>N open</p>` when no card is shown; row `➕ New ticket`; row `◀ Prev`, `✅ OK` + `⏭ Skip` (only under an open item), `📋 List`, `▶ Next` (only when something is open), all centred; sent as a reply to the current card; the previous bar is deleted. |
| 22 | Showing an item: its card (details open) with a forced reply, placeholder `Your test result…` (Test), `Where the sample is…` (Sample), else `Your answer…`, then the bar. |
| 23 | ▶ Next: sends what was typed, shows the next open item (work order: skipped last, then oldest; wraps); none: bar + `✨ Inbox empty`. |
| 24 | ◀ Prev: back through the last 30 shown items (skipped ones too); else `Nothing before this one`. |
| 25 | ⏭ Skip: something typed: sent, `📨 #n sent`; else the item goes last, `⏭ #n moved to the end`; `#n isn't open`; `Nothing to skip`. |
| 26 | ✅ OK: records `OK` (typed text + `\n\nOK`), the card says answered, the next item shows; on a note only the note changes (its OK goes); `✅ #n OK`, `#n isn't open`, `Nothing to OK here`. |
| 27 | 📋 List (same message): `<p><b>N open · M answered today</b></p>` + table `# Kind Waiting Title` (title cut to 40) with a blue `Open` per row, 8 per page; row `◀ k/N ▶` (wraps, the counter is a disabled button) `🔎 Search` `« Back`; empty: `✨ Inbox empty`. |
| 28 | `Open` shows that item's card and the bar; « Back turns the message back into the bar. |
| 29 | 🔎 Search: forced-reply prompt `<p>🔎 Search</p>` (`Words to find…`); a reply to it or to the results searches; results replace the bar: `<p>🔎 <b>q</b> · N found</p>` + the list's table + the snippets as a one-column table, `<td><b>#n</b> … <b>word</b> …</td>`; `No open item matches <b>q</b>`; no words: `🔎 Type a few words to find.` |
| 30 | Search rules: every word must start a word of the title or card text, case and Latin accents ignored, `#n`/`n` the number, `"quoted"` or dotted words adjacent; title matches first, then more matches, then inbox order. |
| 31 | `/postponed` table: `<p><b>💤 N postponed</b></p>`, `Nothing postponed`, paging `P:`, no Search; `Open` sends just the card (details open, no bar); a reply to it is the whole answer; `#n isn't postponed any more`. |
| 32 | Typing `977` or `#977` (or `alias#977`) opens that item (open or answered); else `#977: Not in your inbox`. |
| 33 | Buttons of older card layouts still do something: they open the card (`a:n:*`, `c:n`) or the list (`i:p`). |

## Answers

| # | Behaviour |
|---|---|
| 34 | A reply to any card, note, prompt or the bar answers that item; replies to other bot messages route nowhere. |
| 35 | Going through the cards, plain messages (and replies to the owner's own messages) are collected (`✍` reaction, bar re-posted) and sent when a button leaves the card. In a group with privacy mode on, the bot only sees replies to its own messages (docs/telegram.md). |
| 36 | A reply to any other card is the whole answer: `👀`, the card says answered, the bar is re-posted; then `👍` or `👎`. |
| 37 | Not recorded: `⚠️ #n: not recorded: {why}` (+ `. It is open again and your text is kept.` for collected text), as a reply to the owner's message; the item is open again. |
| 38 | A plain message with no open card on screen: `Reply to a card to answer it.` |
| 39 | Photos, videos and documents: downloaded (≤ 20 MB), uploaded to `files.url` (`Authorization: <files.token>`, `expire: <files.expire>`), linked after the caption: `![name](url)` for images, `[name](url)` else; photo name `screenshot-<id>.jpg`, other names made safe. Without `files` they are refused. |
| 40 | Over 20 MB: `⚠️ {name} is over 20 MB, which bots can't download. Nothing recorded.`; failure: `⚠️ Upload failed ({e}). Nothing recorded.` |
| 41 | Voice, audio, video notes: `🎙 Sorry, voice messages aren't supported. Please type the answer (screenshots and files work).`; anything else: `Sorry, I can only pass on text, photos, videos and files.` |
| 42 | An album is collected (2.5 s, a Durable Object alarm) and answered once. |

## New ticket

| # | Behaviour |
|---|---|
| 43 | ➕ New ticket: prompt `<p>➕ New ticket: send text and files, then press 📨 File ticket</p>` (forced reply `What should be built or fixed…`), bar `✖ Cancel` `📨 File ticket`; every message that answers no card is added (`✍`); opening a card before writing anything ends it. |
| 44 | 📨 File ticket: `Nothing written yet`; status `⏳ Filing your ticket…` turns into `🆕 #n filed for the Board` or `⚠️ Ticket not filed: {e}. Your text is kept: ➕ New ticket, then 📨 File ticket.`; title = first line, cut at a word after 80 chars + `…` (`texts.untitled` when empty); body `texts.filedBody` + the owner's words quoted; the words are recorded as the owner's answer. |
| 45 | A reply to the filed note adds to that ticket (`👀`, then `👍`/`👎`). |
| 46 | ✖ Cancel: `New ticket dropped`. |

## Pushed without being asked

| # | Behaviour |
|---|---|
| 47 | A new inbox item arrives as a note (row 18). |
| 48 | A digest once a day between `schedule.digestFrom` and `schedule.digestTo` in `schedule.timezone`, silent, only with open items: `☀️ <b>Good morning: N open</b>` + one line per item `{emoji} <a>#n</a> {title cut to 70}`, split under 3800 characters, `▶ Start` on the last part; no digest on the first day. |
| 49 | A one-off `hello` after a new interface version: the welcome text (`texts.welcome`) and the todo list (`📋 <b>N open</b>`); cards sent by an older layout are edited once into the current note layout (where the chat refuses the edit, their old buttons are removed); replies to them keep answering their ticket and no card is sent twice. |
| 54 | A repository's webhooks fall back to polling, or come back (docs/webhooks.md): one silent plain line, once per change: `Instant updates for <repo> are off: <reason>. Flowee checks the tracker every few minutes instead.` / `⚡ Instant updates for <repo> are on again.` (with several repositories `<alias> (<repo>)`). Not on the first state after setup. |

## Buttons, errors, others

| # | Behaviour |
|---|---|
| 50 | Every press is answered; a failure as `⚠️ {error}` (190 chars). |
| 51 | Only the owners in the bound chat (and topic) are served; everyone else is ignored, their button presses get no answer. |
| 52 | Profile: name (`texts.botName`), description `texts.about`, short description `texts.shortAbout`, commands, photo (`profile.photo`); each set only when it changed (a hash per item), on `GET /setup` and when the configuration changes. |
| 53 | Transport and storage: a webhook and Durable Object storage; the behaviour above does not depend on them. |

## Errors the agents see from the chat side

| What | Message |
|---|---|
| The tracker token is missing | `GitHub is not connected yet (the secret <NAME> is missing); nothing was changed.` |
| The bot token is missing | `Telegram is not connected (the secret <NAME> is missing).` |
| Unexpected error | `The service failed unexpectedly; …` |
| `GET /setup` | `{<workspace>: {<step>: "set" \| "current" \| …}}`, one entry per workspace |

## Teams: the inbox in a group or topic

| # | Behaviour |
|---|---|
| T1 | Who works the inbox: the owners, and in a group or topic everyone Telegram delivers an update from there (or only `chat.members`). Others, other chats and other topics: ignored silently. |
| T2 | Each answer is recorded with who gave it: `texts.memberSign` filled with `{who}` (`Bea Berg (@bea)`, the name without a username), `{name}`, `{username}`; then `: ` and the answer. In a private chat: `<texts.owner>:`. ✅ OK is `<signature>: OK`. |
| T3 | The first answer to a card wins (checked and marked in one step, so two at once cannot both win); the second person gets, as a reply, `⚠️ #n was already answered by <signature>; yours was not recorded.`, a second ✅ OK the toast `#n was already answered by <signature>`. The one who answered may add to it. |
| T4 | A reply is a whole answer (privacy mode shows the bot replies only, docs/telegram.md): no draft under the current card. |


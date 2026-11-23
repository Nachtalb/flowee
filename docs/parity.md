# Telegram parity with the AnyFile Envoy

The envoy (`src/envoy`, rendered by `src/adapters/chat-telegram.ts`) is a one-for-one port of the AnyFile Envoy
(`Nachtalb/anyfile-envoy`, Rust: `src/bot.rs`, `render.rs`, `nav.rs`, `search.rs`, `poll.rs`, `answer.rs`,
`fornick.rs`, `main.rs`), reached through livedu-envoy, whose behaviour the `trunk` preset reproduces. The tables
below are livedu-envoy's record of that port: each row is one user-visible behaviour of the reference, what
livedu-envoy did before its port, and the decision. They hold for Flowee with these generalisations:

- "AnyFile"/"livedu" in a text is the workspace's `texts.project`; "Nick" is `texts.owner`; `### For Nick` is
  `### <texts.cardHeading>`; the bot's name, descriptions, welcome and filing note are `texts.*`
  (docs/configuration.md). The inbox is the state with `meta.inbox`, the parked tickets the one with
  `meta.parked` (`trunk`: `human review`, `postponed`).
- The owner is whoever is in `owners[].chat`, in the bound chat (and topic); f.naa.gg is `files.url`; the digest's
  Europe/Zurich is `schedule.timezone`, its 09:00-12:00 `schedule.digestFrom`/`digestTo`.

Decisions: **same** (already identical), **port** (now as in the reference), **n/a** (cannot exist in livedu,
reason given).

## Where Flowee differs from livedu-envoy

| What | livedu-envoy | Flowee | Why |
|---|---|---|---|
| Missing tracker token | `GitHub is not connected yet (the Worker has no GITHUB_TOKEN); nothing was changed.` | `… (the secret GITHUB_TOKEN is missing); …` | the secret's name comes from the document |
| Missing bot token | `Telegram is not connected (no TELEGRAM_BOT_TOKEN).` | `… (the secret TELEGRAM_BOT_TOKEN is missing).` | same |
| Bad `gates` body | `gates must be {sha, ok} from flow.py gates.` | `gates must be {sha, ok} from the client's gates command.` | the client is flowee.py now |
| Unexpected error | `The Worker failed unexpectedly; …` | `The service failed unexpectedly; …` | |
| `GET /setup` | the steps of the one bot | `{<workspace>: {steps}}` | several workspaces per instance |
| Profile photo | `assets/profile.png` in the bundle | `profile.photo` URL, fetched at setup | nothing project-specific in the code |
| Answer source in storage | `via = 'telegram'` | `via = 'chat'` | chat-agnostic envoy (not visible) |
| Paste upload | `f.naa.gg` default | `files.url`, no default | |

Everything else (states, transitions, refusals and their messages, texts, layouts, buttons, timing) is
unchanged: livedu-envoy's 95 tests run unchanged in substance against the `trunk` preset (`test/flow.test.ts`,
`test/envoy.test.ts`, `test/render.test.ts`, `test/card.test.ts`), with only the lines above adjusted.

## Commands and menu

| # | AnyFile Envoy | livedu-envoy before | Decision |
|---|---|---|---|
| 1 | `setMyCommands` (default scope), in this order: `start` "what this bot does", `todo` "open items", `postponed` "postponed tickets", `new` "new ticket" | `inbox` "Tickets waiting for you", `new` "File a ticket: /new <text>" | port |
| 2 | Per-chat menu (scope `chat`) with counts: `todo` "`N` open items", `postponed` "`P` postponed tickets"; set after every command, button, recorded answer and poll, only when the whole list changed; a failed call is not retried until `/start` | none | port |
| 3 | Hidden commands that work when typed: `/next`, `/prev`, `/skip`, `/stats`, `/help`, `/search <words>`; arguments of the others are ignored; `/cmd@OtherBot` and unknown commands are handled as plain text | `/inbox`, `/new <text>`, everything else: help text | port |
| 4 | `/start` and `/help`: clear the menu mark, then straight to work: the current item (or the first open one) as a card with the bar under it; nothing open: the bar alone | help text | port |
| 5 | `/todo`: the bar at the bottom becomes page 1 of the list (row 18) | `/inbox`: a new plain list message with one button per ticket | port |
| 6 | `/postponed`: the bar becomes page 1 of the postponed table (row 21) | none | port |
| 7 | `/new`: the ➕ prompt and the File/Cancel bar (row 31) | `/new <text>` files at once | port |
| 8 | `/next`, `/prev`: as ▶ Next / ◀ Prev; `/skip` as a reply to a card skips that card, else the current one | none | port |
| 9 | `/stats`: `📋 N open · ✅ M answered today` and, with an open item, `\n⏳ oldest: #n (age)` | none | port |
| 10 | `/search <words>`: results in a fresh bar; no words: `Usage: /search words to find` | none | port |
| 11 | A command's notice (Prev/Next/Skip toast texts) is sent as a message (HTML, escaped) | n/a | port |

## Cards (rich messages, Bot API `sendRichMessage`, buttons in the body)

| # | AnyFile Envoy | livedu-envoy before | Decision |
|---|---|---|---|
| 12 | Card: `<p>{emoji} <b>{Kind}</b> · <a href="{issue}#issuecomment-{id}">#n</a> · ⏳ {age}</p><p><b>{title}</b></p><details[ open]><summary>Details</summary>…</details>`; age `N min` / `N h` (under 48 h) / `N d`; answered: `· ✓ answered {age} ago` instead of `⏳` | HTML `sendMessage`: `#n title`, `<i>Kind</i>`, fields, 3500-char chunks | port |
| 13 | Kinds: 🧪 Test, ❓ Question, ⚖️ Decision, 💤 Postponed, 👀 Review (no valid block); 📎 Sample | Test / Question / Decision as text | port; 📎 Sample n/a (livedu has no sampler or samples) |
| 14 | Details: `<p><b>Changed:</b></p>`, `<p><b>Samples:</b> <code>a</code>, …</p>`, `<p><b>Check:</b></p>`, `<p><b>Question:</b></p>`, each value as rich blocks: fenced code `<pre>` (with language), `- ` lines a list, `` `x` `` `<code>`, never a quote | Changed, Check as bullets, Question | port; Samples n/a (no samples) |
| 15 | No valid block: the first 600 characters of the newest comment signed `Board:`/`Tester:`/`Developer:` (unsigned text is never shown); none at all: `<i>Older ticket without a hand-over note: open the issue for the details.</i>` | a fixed "No card on this ticket" question | port (signatures: livedu's roles; legacy agent names and `Sampler:` n/a) |
| 16 | A card is one message, never split | split into "#n continued" chunks | port |
| 17 | `📦 In {version} or later` under test cards | none | n/a: livedu has no releases |
| 18 | New item: the card with details folded and a centred `✅ OK` row, with sound; a reply to it answers it | card + `OK`/`Not OK`/`Later` or `Answer`/`Later`/`Drop` + `Open on GitHub` | port |
| 19 | Test cards wait until the published build has the code | none | n/a: livedu has no releases or `tested` tag |
| 20 | First poll stores every inbox item as already notified (no flood); later polls send a note per new item; items leave the list when their ticket leaves the inbox | cards only on `escalate` | port: `escalate` notifies at once (contract), and the cron (now every minute, the reference's poll interval) picks up `human review` tickets the Worker never carded and retires the ones that left |

## The bar (one navigation message, always the last one)

| # | AnyFile Envoy | livedu-envoy before | Decision |
|---|---|---|---|
| 21 | Bar: `<p>✨ Inbox empty</p>` when nothing is open, `<p>N open</p>` when no card is shown; row `➕ New ticket`; row `◀ Prev`, `✅ OK` + `⏭ Skip` (only under an open item), `📋 List`, `▶ Next` (only when something is open), all centred; sent as a reply to the current card; the previous bar is deleted | none | port |
| 22 | Showing an item: its card (details open) with ForceReply, placeholder `Your test result…` (Test) / `Your answer…`, then the bar | n/a | port (`Where the sample is…` n/a) |
| 23 | ▶ Next: sends what was typed, shows the next open item (work order: skipped last, then oldest; wraps); none: bar + `✨ Inbox empty` | none | port |
| 24 | ◀ Prev: back through the last 30 shown items (skipped ones too); else `Nothing before this one` | none | port |
| 25 | ⏭ Skip: something typed: sent, `📨 #n sent`; else the item goes last, `⏭ #n moved to the end`; `#n isn't open`; `Nothing to skip` | none | port |
| 26 | ✅ OK: records `OK` (typed text + `\n\nOK`), the card says answered, the next item shows; on a note only the note changes (its OK goes); `✅ #n OK`, `#n isn't open`, `Nothing to OK here` | `OK` button records `OK` | port |
| 27 | 📋 List (same message): `<p><b>N open · M answered today</b></p>` + table `# Kind Waiting Title` (title cut to 40) with a blue `Open` per row, 8 per page; row `◀ k/N ▶` (wraps, counter is a disabled button) `🔎 Search` `« Back`; empty: `✨ Inbox empty` | plain list, `◀ Prev`/`Next ▶`, one button per ticket | port |
| 28 | `Open` shows that item's card and the bar; « Back turns the message back into the bar | tap re-sends the card | port |
| 29 | 🔎 Search: ForceReply prompt `<p>🔎 Search</p>` (`Words to find…`); a reply to it or to the results searches; results replace the bar: `<p>🔎 <b>q</b> · N found</p>` + the list's table + snippets `<li><b>#n</b> … <b>word</b> …</li>`; `No open item matches <b>q</b>`; no words: `🔎 Type a few words to find.` | none | port |
| 30 | Search rules: every word must start a word of the title or card text, case and Latin accents ignored, `#n`/`n` the number, `"quoted"` or dotted words adjacent; title matches first, then more matches, then inbox order | none | port |
| 31 | `/postponed` table: `<p><b>💤 N postponed</b></p>`, `Nothing postponed`, paging `P:`, no Search; `Open` sends just the card (details open, no bar); a reply to it is the whole answer; `#n isn't postponed any more` | none | port (livedu's `postponed` state) |
| 32 | Typing `977` or `#977` opens that item (open or answered); else `#977: Not in your inbox` | hint text | port |
| 33 | Old buttons still do something: old `next` = Next, old note buttons open the card | n/a | port: the old `a:n:*` and `c:n` buttons open the card, `i:p` the list |

## Answers

| # | AnyFile Envoy | livedu-envoy before | Decision |
|---|---|---|---|
| 34 | A reply to any card, note, prompt or the bar answers that item; replies to other bot messages route nowhere | reply to a card or prompt | port |
| 35 | Going through the cards, plain messages (and replies to his own messages) are collected (`✍` reaction, bar re-posted) and sent when a button leaves the card | n/a | port |
| 36 | A reply to any other card is the whole answer: `👀`, the card says answered, the bar is re-posted; then `👍` or `👎` | `#n: answer recorded; now '…'.` | port |
| 37 | Not recorded: `⚠️ #n: not recorded: {why}` (+ `. It is open again and your text is kept.` for collected text), as a reply to his message; the item is open again | `#n: not recorded. …` | port |
| 38 | A plain message with no open card on screen: `Reply to a card to answer it.` | `Reply to a card, or /new <text> to file a ticket.` | port |
| 39 | Photos, videos and documents: downloaded (≤ 20 MB), uploaded to `https://f.naa.gg/` (`Authorization: <token>`, `expire: 90d`), linked after the caption: `![name](url)` for images, `[name](url)` else; photo name `screenshot-<id>.jpg`, other names made safe | caption only, `Attachments are not stored yet.` | port: the Worker fetches the file from Telegram and posts it to f.naa.gg with the same token (`PASTE_TOKEN` secret) |
| 40 | Over 20 MB: `⚠️ {name} is over 20 MB, which bots can't download. Nothing recorded.`; failure: `⚠️ Upload failed ({e}). Nothing recorded.` | n/a | port |
| 41 | Voice, audio, video notes: `🎙 Sorry, voice messages aren't supported. Please type the answer (screenshots and files work).`; anything else: `Sorry, I can only pass on text, photos, videos and files.` | caption-only rule | port |
| 42 | An album is collected (2.5 s) and answered once | each message separately | port (Durable Object alarm) |

## New ticket

| # | AnyFile Envoy | livedu-envoy before | Decision |
|---|---|---|---|
| 43 | ➕ New ticket: prompt `<p>➕ New ticket: send text and files, then press 📨 File ticket</p>` (ForceReply `What should be built or fixed…`), bar `✖ Cancel` `📨 File ticket`; every message that answers no card is added (`✍`); opening a card before writing anything ends it | `/new <text>` | port |
| 44 | 📨 File ticket: `Nothing written yet`; status `⏳ Filing your ticket…` turns into `🆕 #n filed for the Board` or `⚠️ Ticket not filed: {e}. Your text is kept: ➕ New ticket, then 📨 File ticket.`; title = first line, cut at a word after 80 chars + `…` (`Request from Nick` when empty); body `Filed by Nick through Envoy; the Board writes the spec from his words.` + his words quoted; his words recorded as his answer | `Filed #n; replies to this message go to it.` | port |
| 45 | A reply to the filed note adds to that ticket (`👀`, then `👍`/`👎`) | same idea | port |
| 46 | ✖ Cancel: `New ticket dropped` | none | port |

## Pushed without being asked

| # | AnyFile Envoy | livedu-envoy before | Decision |
|---|---|---|---|
| 47 | New item note (row 18) | card on `escalate` | port |
| 48 | Digest once a day between 09:00 and 12:00 Europe/Zurich, silent, only with open items: `☀️ <b>Good morning: N open</b>` + one line per item `{emoji} <a>#n</a> {title cut to 70}`, split under 3800 characters, `▶ Start` on the last part; no digest on the first day | none | port |
| 49 | `hello` (one-off): the welcome text and the todo list (`📋 <b>N open</b>`) | none | port: sent once by the new version's `/setup`, after the cards sent by the old interface were edited once into the new note layout (card + `✅ OK`; where Telegram refuses the edit, their old buttons are removed); replies to them keep answering their ticket, no card is sent twice |

## Buttons, errors, others

| # | AnyFile Envoy | livedu-envoy before | Decision |
|---|---|---|---|
| 50 | Every press is answered; a failure as `⚠️ {error}` (190 chars) | answered, `show_alert` for long texts | port |
| 51 | Only the owner's private chat is served; everyone else is ignored, buttons from others get no answer | same | same |
| 52 | Profile: name, description `Your … review inbox as a todo list: tests, questions and decisions waiting for you, answered by replying.`, short description `The … review inbox as a todo list.`, commands, photo; set when they differ | own texts, hash-gated per item | port (texts); the hash gating and webhook setup stay |
| 53 | Long polling, SQLite file | webhook, Durable Object storage | n/a: transport and storage of a Worker; behaviour is the same |

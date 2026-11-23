# Chat style: how every screen looks and behaves

Everything a Flowee bot shows in a chat (the envoy's cards and bar, the welcome, every wizard step, the management
menu and its sub-screens, import results, errors, the confirmation in a group) follows these rules, so that a new
screen cannot drift from the rest. The envoy set them (docs/envoy.md); the wizard and the menu (`src/wizard/`)
follow them. The building blocks are written once, in `src/envoy/render.ts`; no screen builds its own markup.
`test/managed.test.ts` asserts each screen's exact payload and `test/chat-style.test.ts` guards the rules below.

## Visual grammar

| Part | Block (`src/envoy/render.ts`) | Looks like |
|---|---|---|
| First line, always | `heading(emoji, name, ...facts)` | `<p>❓ <b>Question</b> · #12 · ⏳ 5 min</p>`, `<p>🆕 <b>New workspace</b> · Step 2 of 6</p>` |
| What the screen asks or shows | `question(html)` | `<p><b>Which bot should bring you the tickets?</b></p>` (a card: the ticket's title) |
| One line of help | `text(html)` | a full sentence; at most two per screen |
| Choices and toggles | `options(option(name, description, ...buttons), …)` | a one-column table: `<tr><td><b>🌿 Single branch</b> · The agents commit straight to…</td><td>[🌿 Choose]</td></tr>`, one row per choice |
| What something is (a summary, problems, permissions) | `facts([[label, value], …])`; a row may carry its own button (`{cells, buttons}`) | a two-column (or one-column) table: `<tr><td>📦 Repositories</td><td>acme/app</td><td>[✏️ Change]</td></tr>` |
| Detail most people skip | `details(summary, html)` | folded, like a card's Details |
| What was wrong | `warning(sentence)` | `<p>⚠️ That does not look like a GitHub token; paste just the token.</p>`, under the text, above the buttons |
| A list of things | `{table}` | head row, one blue `Open` button per row, like the envoy's 📋 List |
| Buttons | `row(...)` of `btn(label, data)`, `linkBtn(label, url)`, `copyBtn(label, text)` | centred rows in the message body |

## Layout (the owner's rules)

- **No list items anywhere**: no `<ul>`, `<ol>`, `<li>`, no line starting with a bullet or a dash. A set of things is
  a table: choices and toggles a one-column table of `option()` rows, a summary a two-column `facts()` table, a set of
  lines (problems, permissions, snippets) a one-column `facts()` table. The one exception is a ticket's own text on a
  card (`Changed:`, `Check:` as its author wrote them, `md()`).
- **Each choice is one row: its name, its one-line description and its own button**, in that order, in the same
  table row (`option()`). Never a block of descriptions followed by a block of buttons: a button row (`row()`) may
  come only after the screen's last table. Telegram's rich-message table cells take inline formatting only
  (Bot API 10.5, "Rich HTML style"), and a `tg-button` is inline, so the button sits in the row's last cell; the
  reference states no limit of rows or buttons per message, and a screen keeps to a handful of rows.
- **A toggle is a row too**: state (✅/⬜), name, description, and its `Switch on` / `Switch off` button; an option that asks for values first has `⚙️ Configure` in place of `Switch on`, and its screen ends with `✅ Apply`.
- **The current choice** is marked on its own row's button: `● Chosen`.
- **Navigation stays in the bottom button row**: `◀ Back`, `▶ Next` (where a screen has toggles or counters),
  `✖ Cancel` in one row; `« Back` / `« All workspaces` in the menu. A screen's main action (`✅ Create the
  workspace`, `🔑 Create a token`) is the one row above it.
- `test/chat-style.test.ts` fails on list markup in the source and on described choices outside `option()`;
  `test/managed.test.ts` checks every payload the wizard and the menu send (no list, every option row with its own
  button, no button row between tables) and walks each choice screen asserting its rows.

Buttons: an emoji then a verb or the thing it opens (`✅ Create the workspace`, `👥 In a group`, `🔑 Create a
token`, `« All workspaces`); the main action alone on its row, navigation last: `◀ Back` (when there is a way back)
and `✖ Cancel` on one row, `« Back` / `« All workspaces` in the menu. Counters and states are disabled buttons
(the count in an agent's row). A toggle's row reads `✅ Name` / `⬜ Name`, the current choice's button `● Chosen`.

Emoji vocabulary: 🆕 new workspace, ✏️ change, 📂 workspaces, 📥 import, 📤 export, 🔑 secrets and tokens, 🤖 a bot,
💬 a chat, 👥 a group, 🔀 way of working, 📦 repositories, ⏸ / ▶ paused / running, 🗑 delete, ✅ done or confirm,
✖ cancelled, ⌛ expired, ⚠️ a problem, 👋 welcome; the envoy's own: 🧪 ❓ ⚖️ 💤 👀 📎 ✨ ➕ 📋 🔎 ⏭ ◀ ▶.

## Wording

- A heading says what the screen is in plain words; progress is a fact after ` · ` (`Step 1 of 6`, `Last check`),
  never a bare number glued to a noun (`1 Bot` reads as "one bot").
- The question is a full sentence a first-time user understands: "Where should the tickets appear?", not "Where".
- One short sentence of what to do; the choices as buttons whose labels say what happens; one line of help only
  where a choice needs it.
- No internal names: say "where the tickets appear", not binding; "this bot", not the instance bot; "secret", not
  slot or digest; "way of working" and its names, not preset ids; feature labels, not their keys.
- **No internal terms on screens.** Say what happens for the user, in one short sentence, and name the thing by what
  the user already knows (a release on GitHub, a git tag, a pull request): "Wait for a release · You are asked to
  test a ticket only once a release contains its change", not "Hold test cards · Test cards wait until a published
  version has the ticket's code". A current value reads in words (`Now: off.`, `Now: all of them.`), never `Now:
  none.` A setting that cannot be said in one plain sentence goes behind the screen's ⚙️ Advanced row (shown while
  it is at its default) or stays in the configuration file. `test/wording.ts` (`JARGON`) fails a test on a screen
  with a banned term; the words in code spans and a document's JSON paths are not checked.

## Glossary: the terms a screen may use

| Term | What it means to the user |
|---|---|
| workspace | One project in Flowee: its repositories, its agents and where its tickets appear. |
| ticket | An issue on GitHub or GitLab that the agents work on. |
| agent | An AI worker that signs in with the project key; its role (Board, Developer, Tester, Owner, or one an extension adds) says what it does. Board: the agent that sorts new tickets. |
| project key | The one secret the agents sign in with, handed over once as a file. |
| token | The GitHub or GitLab access token Flowee works with. |
| single branch / feature branches | Agents commit to the main branch, or each ticket gets its own branch and pull request. |
| pull request (merge request on GitLab), check, label, release, git tag | As on GitHub or GitLab. |
| custom steps, extension file | Steps and rules of your own added to how tickets move, written in a file. |
| this bot / a new bot, group, topic | As in Telegram. |

Banned on screens (`JARGON`): test card, tested tag, release source, hold (test cards), moves forward, published
version or build, triage, on the pass, hand-off, binding, instance bot, slot, preset, chart, versioning, suggested
(an unselected value is `not added`), `Now: none`.
- Offer instead of asking to type: a button or link wherever the bot can infer or prefill (the suggested bot name,
  the chat the user is in, the group picker link, the token form with its permissions, ✅ Keep the current value).
  Typed input accepts what people naturally paste (a repository's link in any form).
- Errors: one sentence that says what to do, with an example where it helps.
- **Never explain how to use the interface on the interface.** A settings screen explains itself: one row per
  setting with its current value and its buttons (`● Latest release`, `✏️ Type`, `Switch on`), the bottom row with
  `◀ Back`, `✅ Apply`, `✖ Cancel`. No sentence like "Tap a value, ✏️ Type your own, or send a file … ✅ Apply keeps
  what is shown". What the interface also accepts without a button (a `.json` or text file with an option's values)
  is documented here, in docs/managed.md and in the flowee-configure skill, never on the screen. The exceptions are
  the inputs that have no button: the screen that asks for a pasted link, token or configuration says what to
  send, and the bot-creation step points at the reply keyboard. `test/wording.ts` (`INSTRUCTIONS`) fails a test on
  every screen with such a sentence; add a pattern when one slips through.
- **A switch is never a dead end; an option asks for what it needs.** Switching on an option that needs values opens
  its follow-up screen in the same living message (one screen per option, one row per value: the default marked,
  suggestions as buttons, ✏️ Type, a sent file); the option is on only when its values are usable, ✅ Apply works
  without typing wherever a default exists, and switching it off keeps the values. No screen tells the user to
  export, edit and import to finish a choice the bot could ask for.

## The living message

- **One living message per conversation.** A screen replaces the previous one by editing the same message
  (`live()` in `src/ports/chat.ts`, `Living` in `src/wizard/wizard.ts`). The wizard is one message from the first
  step to `✅ Workspace ready`; Back, Cancel, Next and every menu button edit it.
- **A typed command** (`/setup`, `/workspaces`, `/start`) shows its screen as a new message at the
  bottom and deletes the previous living message, like the envoy's bar.
- **A pressed button** edits the message it was pressed on; an older living message is deleted.
- **Typed answers are deleted** after reading (the token always; in private chats everything the bot asked for:
  a repository, a pasted configuration); the result appears in the living message.
- **Every press is answered** (`answerCallbackQuery`); a done action gets a short toast (`⏸ Paused`, `📤 Sent
  below`), a failure `⚠️ {error}`.

## When a new message is allowed

1. Telegram refuses the edit (too old, deleted, another kind of message): the screen is sent anew and the old one
   deleted (`live()`).
2. The content must stay in the chat history by its nature: the project key (a file, or a rich message where
   files are refused), an exported configuration, the envoy's cards and bar (docs/envoy.md). A key file
   carries its own buttons: 🗑 Delete this file from the chat (deletes that message, answered with a toast; a
   refusal is one sentence in the toast) and ❓ How do I use these? (the served `/docs/agents/`). A press on it is
   never taken as the living message.
3. Another chat: the confirmation in a group (`✅ Tickets of <id> appear here`).
4. The envoy's notices and statuses as docs/envoy.md specifies them (rows 11, 37 to 41, 44, 48 and 54, and its toasts).
   They are rich messages like every other screen: one paragraph per line, the digest's items as a one-column
   table with ▶ Start under it, the filing status edited in place. There is no plain message left: the Chat port
   has no `text`/`editText`, and `test/chat-style.test.ts` fails if one comes back.

## Exceptions: reply keyboards

Only one: 🤖 Create the bot (a `KeyboardButtonRequestManagedBot`, which no inline or rich-message button can do;
docs/telegram.md quotes the Bot API). Its keyboard sits on a helper message under the living message for that one
step and is removed (`ReplyKeyboardRemove`, both messages deleted) the moment the step is done or left. Picking a
group needs no keyboard (the `startgroup` link).

## Backends without rich messages

`plain(view)` (`src/ports/chat.ts`) turns a view into text plus keyboard rows. Telegram never uses it; another
backend implements the same living-message contract (docs/adapters.md, "The living message").

## In a terminal

The terminal client (`flowee-tui`, docs/tui.md) draws the same views; the rules above hold, in their terminal
form:

- **One living screen.** The main pane shows one message: the card being worked on, or the list, the results or
  the setup screen that replaced it; an edit redraws it in place. The bar is its own line at the bottom, its
  buttons with their keys. Nothing scrolls past like a chat; notices (the digest, sync messages, filed tickets)
  go to the status line once and to the notices window (`!`).
- **Each choice is one row with its own button**, right-aligned at the end of the row's text; when the text does
  not leave room, the button goes on the line directly under it. A button label is never cut: a row of buttons
  that does not fit wraps whole buttons onto the next line.
- **Every button is reachable by keyboard** (`↑` `↓` walk the buttons, links and folds of the screen in reading
  order; the bar's buttons have their letter) and by mouse; the focused pane has heavy borders and the selected
  button is drawn reversed, so focus shows without colour too.
- **No list markup** in the screens: tables as on Telegram (a grid when it fits, else each row's cells joined
  with ` · ` and wrapped). A ticket's own text keeps its author's list, drawn with `•`.
- **Typed input that is read is removed**: a token typed in the setup disappears from the conversation and from
  its log once read.
- **Colours are the terminal's own eight** and only mark meaning (green primary, cyan keys and folds, red an
  error, yellow a notice); `NO_COLOR` drops them and nothing is lost. Width is counted per grapheme (East Asian
  wide and emoji are two cells), so columns stay aligned in tmux and over SSH.
- **Errors are one sentence** in the status line; a refused action never leaves the screen silent.

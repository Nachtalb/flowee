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
| Choices explained | `bullets([...])` | `<li><b>This bot</b>: I bring them myself…</li>`, one line per choice |
| Detail most people skip | `details(summary, html)` | folded, like a card's Details |
| What was wrong | `warning(sentence)` | `<p>⚠️ That does not look like a GitHub token; paste just the token.</p>`, under the text, above the buttons |
| A list of things | `{table}` | head row, one blue `Open` button per row, like the envoy's 📋 List |
| Buttons | `row(...)` of `btn(label, data)`, `linkBtn(label, url)`, `copyBtn(label, text)` | centred rows in the message body |

Buttons: an emoji then a verb or the thing it opens (`✅ Create the workspace`, `👥 In a group`, `🔑 Create a
token`, `« All workspaces`); the main action alone on its row, navigation last: `◀ Back` (when there is a way back)
and `✖ Cancel` on one row, `« Back` / `« All workspaces` in the menu. Counters and states are disabled buttons
(`🛠 Developers: 1`). A toggle reads `✅ Name` / `⬜ Name`, the current choice `● Name`.

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
- Offer instead of asking to type: a button or link wherever the bot can infer or prefill (the suggested bot name,
  the chat the user is in, the group picker link, the token form with its permissions, ✅ Keep the current value).
  Typed input accepts what people naturally paste (a repository's link in any form).
- Errors: one sentence that says what to do, with an example where it helps.

## The living message

- **One living message per conversation.** A screen replaces the previous one by editing the same message
  (`live()` in `src/ports/chat.ts`, `Living` in `src/wizard/wizard.ts`). The wizard is one message from the first
  step to `✅ Workspace ready`; Back, Cancel, Next and every menu button edit it.
- **A typed command** (`/setup`, `/workspaces`, `/import`, `/start`) shows its screen as a new message at the
  bottom and deletes the previous living message, like the envoy's bar.
- **A pressed button** edits the message it was pressed on; an older living message is deleted.
- **Typed answers are deleted** after reading (the token always; in private chats everything the bot asked for:
  a repository, a pasted configuration); the result appears in the living message.
- **Every press is answered** (`answerCallbackQuery`); a done action gets a short toast (`⏸ Paused`, `📤 Sent
  below`), a failure `⚠️ {error}`.

## When a new message is allowed

1. Telegram refuses the edit (too old, deleted, another kind of message): the screen is sent anew and the old one
   deleted (`live()`).
2. The content must stay in the chat history by its nature: the agents' secrets (a file, or a rich message where
   files are refused), an exported configuration, the envoy's cards and bar (docs/envoy.md).
3. Another chat: the confirmation in a group (`✅ Tickets of <id> appear here`).
4. The envoy's notices and statuses as docs/envoy.md specifies them (rows 11, 37 to 41, 44 and 48, and its toasts); these
   stay plain messages exactly as in the bot the envoy reproduces.

## Exceptions: reply keyboards

Only one: 🤖 Create the bot (a `KeyboardButtonRequestManagedBot`, which no inline or rich-message button can do;
docs/telegram.md quotes the Bot API). Its keyboard sits on a helper message under the living message for that one
step and is removed (`ReplyKeyboardRemove`, both messages deleted) the moment the step is done or left. Picking a
group needs no keyboard (the `startgroup` link).

## Backends without rich messages

`plain(view)` (`src/ports/chat.ts`) turns a view into text plus keyboard rows. Telegram never uses it; another
backend implements the same living-message contract (docs/adapters.md, "The living message").

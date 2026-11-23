# The terminal interface

`flowee-tui` is the owner's (or the team's) inbox as a full-screen terminal application: the same cards, bar,
answers, files, digest and, in the managed mode, the same setup wizard and management menu as the Telegram bot,
without a messenger. It works over SSH and inside tmux, with the mouse where the terminal has one, and with
or without colours. The protocol it speaks is docs/tui-protocol.md.

## Use it

```sh
flowee-tui --new-key                            # once: makes your key, prints only its digest
flowee-tui --url https://flowee.example         # every day: sign in and work the inbox
flowee-tui --url https://flowee.example --key-file ~/keys/flowee.key --workspace shop
```

Give the digest `--new-key` printed to whoever runs your Flowee: they add you to the workspace's people
(`tui.people` in its document, the admin API, or *Add a person* in the menu, below). Until then the client shows
the pairing screen with the same digest and signs you in by itself once you are added. A key someone made for
you (a `.key` file from *Add a person*) works the same: `--key-file <file>`, or paste it on the sign-in screen.

The URL and the last workspace are remembered in `$XDG_CONFIG_HOME/flowee-tui/config.json` (default
`~/.config/flowee-tui/`); the key in `<config>/key`, mode 600, never printed or shown. Files the server hands
over (the project key, an export, a new person's key) are saved to `<config>/files/` with mode 600, and the
status line says where once. `NO_COLOR=1` or `--no-color` drops colours (focus and buttons stay visible by
bold, reverse and heavy borders); the colours used are the terminal's own eight, so a light or dark theme keeps
its contrast.

## Get the client

From a clone: `bun run tui -- --url …` runs it, `bun run compile:tui` builds one executable `dist/flowee-tui`
(the bun runtime inside, ~100 MB, no dependency). Other platforms: `bun build --compile --minify
tui/main.ts --target=<target> --outfile flowee-tui`, with `bun-linux-x64`, `bun-linux-arm64`, `bun-darwin-arm64`,
`bun-darwin-x64` or `bun-windows-x64`. A release would attach those five executables and their SHA-256 sums; the
instance does not serve them (too large for its static material), it serves this page.

## The screen

```
 Flowee · Shop ▾                                       3 open · 0 postponed  ● live  ? help
┌─ Inbox · 3 open · 1 answered today ─┐┏━ Card #1 ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
│▶ #1 ❓ Question  5 min  Export for… │┃ ❓ Question · #1 · ⏳ 5 min                       ┃
│  #2 🧪 Test      2 h    Faster les… │┃ Export format for the reports                    ┃
│  #3 ⚖️ Decision  1 d    Dark theme  │┃ ▾ Details                                        ┃
│                                     │┃   Question: Should the export be CSV or JSON?    ┃
│                                     │┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
│                                     │┌─ ✎ Your answer… · a to write ───────────────────┐
│                                     ││ Your answer…                                     │
└─────────────────────────────────────┘└──────────────────────────────────────────────────┘
  t  ➕ New ticket  p  ◀ Prev  o  ✅ OK  s  ⏭ Skip  l  📋 List  n  ▶ Next
 ✅ #4 OK                                                                     ! 2 notices
```

The header names the workspace (`▾`: your key opens several; `w` switches), the counts and the connection:
`● live` (rung by the server the moment something changes), `◐ polling` (no socket: it asks every few
seconds), `○ offline, retrying`. The inbox pane lists the open items (`▶` the one on screen, `✎` one with a
draft). The main pane shows the card being worked on, or a list, search results or a setup screen; the editor
under a card takes the answer. The bar is the envoy's bar, each button with its key. The status line shows the
answer to what you did, one sentence for an error, and the newest notice (the morning digest, a filed ticket,
webhooks off or back on); `!` lists all notices. Below 100 columns the inbox goes above the card.

## Keys

| Key | |
| --- | --- |
| `n` / `p` | Next item / previous item |
| `o` | OK: answers the card with OK |
| `s` | Skip: the item goes to the end |
| `l` | List the open items (`[` `]` page, `b` back) |
| `t` | New ticket: write it in the editor, `f` files it, `x` drops it |
| `a` or `Enter` | Write an answer to the card on screen |
| `Ctrl+S` (or `Alt+Enter`) | Send what you wrote; `n` then records it and moves on, `o` adds OK |
| `Ctrl+O` | Attach a file: the file picker (type to filter, or a path; `Enter` sends it, the draft as its caption) |
| `Esc` | Leave the editor (the draft stays, one per ticket) or close a window |
| `/` | Search the open items |
| `P` | Postponed tickets |
| `:` | A command: `todo`, `postponed`, `stats`, `new`, `start`, `search words` |
| `Tab` / `Shift+Tab` | Inbox, card, editor |
| `↑` `↓` `j` `k` | Move in the inbox; move between the buttons, links and folds of the card |
| `Enter` / `Space` | Open the selected item; press the selected button; open or close a fold |
| `PgUp` `PgDn` `g` `G` | Scroll the card |
| `w` | Switch the workspace |
| `!` | Notices |
| `r` | Fetch now |
| `?` | Every key |
| `q` / `Ctrl+C` | Quit |

The mouse: a click presses a button, opens an inbox row, a fold or a link (opened in the browser on a desktop,
copied to the clipboard over SSH); the wheel scrolls the pane under it.

## Several people

A workspace with more than one person in `tui.people` is a team inbox, like a Telegram group: everyone sees
the same conversation, each answer is signed with the name of who gave it, and the first answer to a card wins
(the second person is told who answered). `member` answers; `manager` also manages the workspace in the managed
mode. Several terminals of one person stay in step; a terminal that was closed catches up on what it missed.

A workspace with both `chat` (Telegram) and `tui` shows the one Telegram conversation in the terminals as well:
the same cards under the same ids, an answer given in Telegram shows in the terminal and the other way round.

## Setup and management (managed mode)

People listed in the instance's `instance.tui.people`, and every manager of a workspace's `tui.people`, see a
seat **Setup and management** (`w`). It is the instance bot's private chat in the terminal: the welcome, the
setup wizard (`/setup`), your workspaces (`/workspaces`), export (`/export`: the file is saved) and import (`Ctrl+O`
a `.json` file, or `/import` and paste it). A workspace set up here gets the terminal as its inbox and you as its
first manager; the project key is saved as a file (mode 600). Its menu has **👥 People**: *Add a member* or
*Add a manager* makes a key and hands it over once as a `.key` file for you to pass on; *Remove* stops a key at
once. The admin API does the same (docs/api.md, "Configuration API").

## Flowee without a messenger

A workspace with `tui` and no `chat` needs no bot and no Telegram account: the instance (the Worker, or the
self-hosted process or image) serves the terminal protocol and nothing else of a chat. docs/self-hosting.md has
the example.

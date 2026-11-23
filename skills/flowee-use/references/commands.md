# Every `flowee.py` command

`N` is a ticket: `12` (or `#12`) in a workspace with one repository, `alias#12` with several. Comments and bodies
come on stdin. Output is the API's JSON without `ok`. Which commands exist depends on the workspace's flow:
`python3 flowee.py whoami` names your instance and role; a command your flow lacks answers `404 not_found`.

## Everyone

| Command | When | Notes |
|---|---|---|
| `whoami` | check the setup | `{"instance", "role"}` |
| `queue` | a cheap look before a run (monitors) | what `next` would hand out, your current claim; board and owner also the owner's `inbox` |
| `show N` | read a ticket's state | `state`, `claim`, `depends_on`, `blocked_by`, `commits`, `origin`, `answers`; with pull requests `branch` and `pull` |
| `next` | start of every run | claims and prints the next ticket, resuming your own claim first; exit 3 `none` |
| `heartbeat N` | long work, before ending a run without hand-over | renews your claim |
| `release N` | give a ticket back without a question | developer: back to `ready` (or `back to development` with commits); tester: `ready for testing`; comment required |
| `file TITLE [--repo ALIAS]` | an unrelated problem you found | new ticket in `needs triage`, body on stdin |
| `version` | after setup, or when a command behaves unexpectedly | the client's and the instance's version (`GET /version`, no secret); names `update` when the instance serves a newer client |
| `update` | only when asked to update the client | replaces this file with the instance's `/client/flowee.py` after checking it parses; never runs by itself |

## Developer

| Command | When |
|---|---|
| `gates` | before every commit; runs `[[gates]]`, one log per step, stops at the first failure |
| `commit N MSG [PATH…]` | one logical change, after green gates on exactly this tree; signed, suffix appended |
| `push` | after every commit; on a ticket branch pushes that branch (fast-forward only) |
| `branch N` | (pull requests) switch to the ticket's branch, fetched when it exists, else created from the main branch |
| `pr N` | (pull requests) push the branch and open or update the pull request; prints `pull: {number, url, branch}` |
| `checks N` | (pull requests) `green` exit 0 (or merged), `pending: …` exit 3, `failed`/no pull request exit 2 |
| `merge N` | (`merger: developer`, dependency tickets) merge the pull request with green checks |
| `handoff N` | done: `ready for testing`; needs a new commit on the main branch ending with the suffix (or an open pull request with green checks / a merged one) |
| `stuck N` | a question or blocker for the board: what you need, the options, your pick, what you pushed |

## Tester

| Command | When |
|---|---|
| `gates` | on the exact build you test, before `pass` |
| `branch N` | (pull requests) check out the ticket's branch: its head is the build |
| `pass N [--owner-check]` | every acceptance point checked; sends `HEAD` as the build with the gates result. `--owner-check`: the owner should see it; the comment then holds an owner card draft. With `merger: flow` it merges the pull request; with `uiReview` a UI change goes to the board and needs the card |
| `fail N` | with evidence per acceptance point; sends `HEAD` as the build |
| `stuck N` | cannot judge: a question for the board |

## Board

| Command | When |
|---|---|
| `triage N` | specified (`## Acceptance` present) → `ready`; with `samples`: `--samples` → `needs samples`, or the sample `PATH…` on the main branch |
| `spec N [--title T]` | rewrite the body (stdin) |
| `sendback N` | answer an agent's question; back where it came from |
| `rework N` | the owner or a check found problems → `back to development` |
| `escalate N` | put it in front of the owner, with an owner card in the comment |
| `approve N` / `drop N` | close completed / not planned |
| `postpone N` / `resume N` | park on the owner's word / bring back |
| `needsamples N` | (`samples`) back to the sampler |
| `checked N` | (`userFeedback` with `autoTriage`) read the user's text as text; the feedback label goes |

## Sampler (`samples`)

| Command | When |
|---|---|
| `found N PATH…` | the sample files are on the main branch → `ready` |
| `unobtainable N` | tried everything; report with a `Kind: sample` card draft → `board review` |

## Owner

`answer N` records the owner's words (text on stdin); usually the chat does this.

## Configuration

`.flowee.toml` in the repository root (or the file `FLOWEE_CONFIG` names): `url`, `workspace`, `instance`,
`secret_file` (template with `{workspace}`, `{instance}`), `main_branch`, `commit_types`, `ticket_suffix`,
`busy_hours`, `git_config` (extra `-c` values for fetch and push), `[[gates]]` (`name`, `dir`, `cmd`). Environment
wins: `FLOWEE_URL`, `FLOWEE_WORKSPACE`, `FLOWEE_AS`, `FLOWEE_TOKEN`. Gate logs go under `FLOWEE_GATES_LOGS` (default
the temp directory).

# Flow features: the catalogue

Flowee has two flow presets. `trunk` is the base: developers commit straight to the main branch, a tester tests the
main branch, the board specifies and decides, the owner answers in the chat. `pr-release` is one statechart that
holds `trunk` plus six optional parts; each part is a **feature switch** of the workspace document
(`features.<name>`, docs/configuration.md). With every switch off, `pr-release` is `trunk`'s states and commands.
docs/flows.md says how a chart tags its parts; docs/adapters.md lists the token permission each feature needs.

## The base (both presets)

| Rule | How |
|---|---|
| States as tracker labels; an open ticket without one is `needs triage`; two state labels are refused (`two_states`) | `meta.label`, `initial` |
| A project board column per state (GitHub Projects v2 Status), the item added when missing | `meta.status`, `tracker.project` |
| One lock per workspace for every command; each command re-reads the ticket | the workspace's Durable Object |
| Claims are exclusive and belong to a role instance; `next` resumes the caller's claim first | `claim`, `holder`, `roles[].instance` |
| A claim idle for `leaseHours` (3) goes back to its queue with a `Board:` comment | the cron's reaper |
| Queue order per role: board = `board review` (oldest hand-over first), then `needs triage`; developer = `back to development`, then `ready`; tester = `ready for testing` | `meta.claimable` (`rank`, `sort`) |
| `Depends on: #n` in the body holds a ticket back until those are closed | `dependenciesClosed` |
| Comments signed with the role, never an agent; every hand-back needs a comment (`comment_required`) | `comment`, options `roles[].sign` |
| `handoff` needs a new commit on the main branch whose subject ends with the ticket suffix; `Commits:` appended | `commitsOnMain`, `recordHanded` |
| `pass` needs green gates on the tested build, the build on main and containing the ticket's commits | `gatesMatchBuild`, `buildOnMain`, `buildContainsCommits` |
| `pass` with `owner_check` goes to `board review` with an owner card instead of closing | `flag`, `cardValid` |
| Only the board puts a ticket in front of the owner (`escalate`), only with a valid owner card | `roleIs`, `cardValid`, `sendCard` |
| The owner's answers are kept apart from comments and shown to the board in `next` and `show` | `recordAnswer` |
| The board-review origin (who handed it over, from where) is kept; `sendback` returns it there, a passed ticket cannot be sent back | `recordOrigin`, `originIs` |
| The owner's answer reopens an inbox, postponed or closed ticket into `needs triage`; decisions on an answered `needs triage` ticket | `answer`, `answered` |
| A closed ticket refuses everything but `show` and `answer` | the closed state's transitions |
| Pull requests are never tickets | the tracker adapter |

## `pullRequests`: a branch and a pull request per ticket

| Adds | How |
|---|---|
| The ticket's branch (`branch`, default `flowee/{n}`), created by the client (`flowee.py branch N`) | `show` names it |
| `pr`: the Worker opens the pull request from the branch (title + ticket suffix, body `Closes #n`) or updates its title | `openPull` |
| `handoff` needs the pull request open with its required checks green (`checks`; empty: every reported check, at least one) | `pullRequestOpen`, `checksGreen` |
| `merger: flow` (default): the tester tests the pull request's head; `pass` merges it (`method`, subject ending with the ticket suffix) and deletes the branch (`deleteBranch`); a merge the tracker refuses is `409 not_mergeable`; a `pass` retried after its merge went through completes | `buildTested`, `mergePull` |
| `merger: developer`: the developer merges with `merge` (checks green) before `handoff`; the tester tests the main branch | `merged` |
| `show` adds `branch` and `pull: {number, url, state, head, checks}` | `codeView` |

## `releases`: which release contains a ticket

| Adds | How |
|---|---|
| The published build: the latest release (its notes' `build from <sha>` names the built commit, else its tag) or a moving tag (`source: "tag"`, `tag`) | `inRelease` |
| `hold` (default on): a `Kind: test` card whose commits the published build lacks waits in `awaiting release`; the cron hands it to the owner once a release has them | `awaitsRelease`, tick `released` |
| `versionLine` (default on): test cards say `📦 In <version> or later` | `sendCard` |
| `testedTag`: a tag the cron moves forward over the main branch up to the first commit of a ticket still untested (`meta.untested`), never onto a commit of a `skip` type, only onto a commit with the `checks` green; CI can release from it | `moveTag` |

## `samples`: a real sample file before development

| Adds | How |
|---|---|
| The `sampler` role and the states `needs samples`, `in procurement` (the sampler holds it), `samples unobtainable` (the owner's inbox) | tagged states |
| `triage` with `samples: true` → `needs samples`; `triage` to `ready` needs sample paths on the main branch (under `root`, a path may point into a container) or the `notNeededLabel` | `samplesGiven` |
| `found` (sampler): paths on main → `ready`; `unobtainable`: a `Kind: sample` draft → `board review` | |
| `escalate` of an unobtainable ticket → `samples unobtainable`, only with a complete `Kind: sample` card (`Samples:` names files, never paths; a code span holds exactly one file name) | `cardKind`, `cardValid` |
| `needsamples` (board): back to the sampler from review, the inbox or an answered `needs triage` | |
| The sampler's claims expire like the others (`in procurement` → `needs samples`); `sendback` of a sampler's ticket → `needs samples` | |
| 📎 Sample cards in the chat (docs/envoy.md rows 13, 14, 22) | |

## `uiReview`: new UI goes past the owner

| Adds | How |
|---|---|
| A `pass` whose changes touch the UI goes to `board review` with an owner card instead of closing; the reasons are appended to the comment | `uiChanged` |
| UI is: a file under `paths`; a file added under `addedFiles`; an added line matching `addedLines`; minus files under `ignore`. With a pull request, every file it changes counts | `uiReasons` |

## `dependencyTickets`: one ticket per dependency pull request

| Adds | How |
|---|---|
| The cron files one ticket per open pull request of `authors` (default `dependabot[bot]`): `deps: <title> (PR #p)`, body `Pull request: #p`, labels `labels` | `fileDependencyTickets` |
| The developer merges it (`merge`, checks green) and hands it off; `handoff` needs it merged | `isDependencyTicket`, `merged` |

## `untrustedReports`: text from outside reviewed first

| Adds | How |
|---|---|
| A ticket with `label` (default `feedback`, set by an outside service) goes only to `role` (default `board`), in any state | `trusted`, `untrustedQueue` |
| `triage` or `checked` removes the label | `markChecked` |

## Deliberately not in Flowee

| What | Why |
|---|---|
| A project-specific endpoint as the release source | The tracker's releases or a tag carry the same answer; a release's notes may name the built sha. |
| Merging past branch protection with an admin token | Flowee's token is narrow on purpose; a protected branch stays protected. |
| Scanning attached sample files for malware | Project tooling the board runs itself; not a flow rule. |
| Native sub-issues and blocked-by links | The ordering rule reads `Depends on:` in the body. |
| Hard-coded board column ids, repositories or owners | Configuration (`tracker.project`, `tracker.repos`, `owners`). |

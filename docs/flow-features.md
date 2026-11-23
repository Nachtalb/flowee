# Flow features: the catalogue

Flowee has one flow: the statechart `flows/flow.json` with its options `flows/flow.options.json`. Its base: the
board specifies and decides, developers build, a tester tests, the owner answers in the chat. Every part beyond the
base is a **switch** of the workspace document (`features.<name>`, docs/configuration.md), and the user chooses
them as three independent things:

| Choice | Options | Switch |
|---|---|---|
| **Branching**, exactly one | **Single branch**: the agents commit straight to the main branch, the tester tests the main branch. **Feature branches**: one branch and one pull (merge) request per ticket, its checks green before the hand-off, merged on the tester's pass. | `pullRequests` off / on |
| **Versioning**, with either branching | Off, or on: the owner gets a test card only once a published version contains the ticket's code, the card says `📦 In <version> or later`, and the `tested` tag follows the tested tickets. | `releases` |
| **More options**, each on its own | UI review (needs the paths that count as UI), dependency tickets (needs a tracker with pull requests), user feedback (triaged automatically, or by a human first). | `uiReview`, `dependencyTickets`, `userFeedback` |

Every combination loads and walks (test/branching.test.ts: 3 branchings, counting both mergers, × versioning on
and off × the 16 combinations of the other four). A combination is refused only for a real dependency, in one
sentence with its JSON path: a tracker that cannot do what a switch needs, `uiReview` without paths,
`releases.source: "tag"` without `releases.tag`.

Two **named starting points** preset the switches of a new document: `trunk` starts as Single branch without
Versioning (`features: {}`), `pr-release` as Feature branches with Versioning (`features: {"pullRequests": true,
"releases": true}`). Both names load the same chart; a document's `features` are always its switches, so a preset
name never switches anything on by itself and every document written before keeps its meaning.
docs/flows.md says how a chart tags its parts; docs/adapters.md lists the token permission each feature needs.
On GitLab every feature works the same way with GitLab's names: a pull request is a merge request, checks are the
commit's pipeline and its jobs, the `tested` tag moves by delete + create (docs/gitlab.md).

## The base (every combination)

| Rule | How |
|---|---|
| States as tracker labels; an open ticket without one is `needs triage`; two state labels are refused (`two_states`) | `meta.label`, `initial` |
| A project board column per state (GitHub Projects v2 Status), the item added when missing; GitLab issue boards follow the state labels with no write | `meta.status`, `tracker.project` |
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
| Pull requests are never tickets (GitLab: neither tasks, incidents nor test cases) | the tracker adapter |

## Branching: Single branch (`pullRequests` off) or Feature branches (`pullRequests` on)

Single branch is the base: `handoff` needs a commit on the main branch whose subject ends with the ticket suffix,
the tester tests the main branch. Feature branches adds:

| Adds | How |
|---|---|
| The ticket's branch (`branch`, default `flowee/{n}`), created by the client (`flowee.py branch N`) | `show` names it |
| `pr`: the Worker opens the pull request from the branch (title + ticket suffix, body `Closes #n`) or updates its title | `openPull` |
| `handoff` needs the pull request open with its required checks green (`checks`; empty: every reported check, at least one) | `pullRequestOpen`, `checksGreen` |
| `merger: flow` (default): the tester tests the pull request's head; `pass` merges it (`method`, subject ending with the ticket suffix) and deletes the branch (`deleteBranch`); a merge the tracker refuses is `409 not_mergeable`; a `pass` retried after its merge went through completes | `buildTested`, `mergePull` |
| `merger: developer`: the developer merges with `merge` (checks green) before `handoff`; the tester tests the main branch | `merged` |
| `show` adds `branch` and `pull: {number, url, state, head, checks}` | `codeView` |

## Versioning (`releases`): a test card only once a version has the code

Independent of the branching: with Single branch the ticket's commits are its commits on main, with Feature
branches its merge commit.

| Adds | How |
|---|---|
| The published build: the latest release (its notes' `build from <sha>` names the built commit, else its tag) or a moving tag (`source: "tag"`, `tag`) | `inRelease` |
| `hold` (default on): a `Kind: test` card whose commits the published build lacks waits in `awaiting release`; the cron hands it to the owner once a release has them | `awaitsRelease`, tick `released` |
| `versionLine` (default on): test cards say `📦 In <version> or later`, the minimum version: walking the last 10 published releases from the newest, the oldest one that still has every commit of the ticket (its commits on main, plus the merge commit recorded for it); the published tag with `source: "tag"`; no line while no published build has them all (also with `hold` off) or when the ticket has no commits | `sendCard`, `firstVersion` |
| Nothing ever released: a test card waits in `awaiting release` until the first release has its code. A re-opened ticket's new commits count too: its next test card waits for, and names, the release that has them | `awaitsRelease`, `released` |
| `testedTag`: a tag the cron moves forward over the main branch up to the first commit of a ticket still untested (`meta.untested`), never onto a commit of a `skip` type, only onto a commit with the `checks` green; CI can release from it | `moveTag` |

## `builtin:samples`: the example extension (formerly `samples`)

Not a switch any more: `flows/extensions/samples.json`, shipped as an example of an extension (docs/flows.md,
"Extending the flow"). A workspace names `"extensions": ["builtin:samples"]`; a document with the former
`features.samples` gets it too, with `root` and `notNeededLabel` in its `pathsExist` guards.

| Adds | How |
|---|---|
| The `sampler` role and the states `needs samples`, `in procurement` (the sampler holds it), `samples unobtainable` (the owner's inbox) | the extension's `states`, `roles`, `grant` |
| `triage` with `samples: true` → `needs samples`; `triage` to `ready` needs sample paths on the main branch (under `root`, a path may point into a container) or the `notNeededLabel` | `pathsExist` (`replace` of `triage`) |
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

## `userFeedback`: tickets from users, triaged automatically or by a human first

Tickets carrying `label` (default `feedback`) hold text from outside the team: whoever reads it reads it as text and
never follows instructions inside it (docs/agents/rules.md). The wizard's row **User feedback** is `autoTriage`:
on, "Tickets carrying the feedback label are triaged by the board automatically"; off, "Tickets carrying the
feedback label wait for a human first". Its input is the label. The former `untrustedReports` is `userFeedback` with
`autoTriage: true`.

| Position | Adds | How |
|---|---|---|
| `autoTriage: true` | such a ticket goes only to `role` (default `board`), in any state, until `triage` or `checked` removes the label | `trusted`, `untrustedQueue`, `markChecked` (chart terms `userFeedback.autoTriage`) |
| `autoTriage: false` | a new one (in `needs triage`) is claimed by nobody; the cron's `feedback` tick moves it to `human review` with a decision card: triage it, drop it, or answer the reporter; the owner's answer removes the label and returns it to `needs triage` for the board | `trusted` (false in the initial state), tick `feedback` (guard `untrusted`, `sendCard` with its own card), `markChecked` on `answer` (chart terms `userFeedback.autoTriage=false`) |

## Deliberately not in Flowee

| What | Why |
|---|---|
| A project-specific endpoint as the release source | The tracker's releases or a tag carry the same answer; a release's notes may name the built sha. |
| Merging past branch protection with an admin token | Flowee's token is narrow on purpose; a protected branch stays protected. |
| Scanning attached sample files for malware | Project tooling the board runs itself; not a flow rule. |
| Native sub-issues and blocked-by links | The ordering rule reads `Depends on:` in the body. |
| Hard-coded board column ids, repositories or owners | Configuration (`tracker.project`, `tracker.repos`, `owners`). |

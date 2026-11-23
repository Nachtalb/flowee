# Ways of working: branching, versioning, more options

One flow, three independent choices, each written as switches under `features`:

| Choice | Options | Switch |
|---|---|---|
| **Branching**, exactly one | **Single branch**: commits straight to the main branch (subject ending ` (#n)`), the tester tests the main branch. **Feature branches**: one branch and one pull (merge) request per ticket, checks green before the hand-off, merged on the tester's pass. | `pullRequests` off / on |
| **Versioning**, with either branching | Off, or on: a test card reaches the owner only once a published version contains the ticket's code, saying `📦 In <version> or later`; the `tested` tag follows. | `releases` |
| **More options**, each on its own | `uiReview` (needs `paths`, `addedFiles` or `addedLines`), `dependencyTickets` (needs a tracker with pull requests), `userFeedback` (`autoTriage` on or off). | as named |

## Starting points

| `flow.preset` | Starts as | Write |
|---|---|---|
| `trunk` | Single branch, Versioning off | `features` left out |
| `pr-release` | Feature branches with Versioning | `"features": {"pullRequests": true, "releases": true}` |

Both names load the same chart, and a preset name never switches anything on by itself: write every switch the
project uses in `features` (a `trunk` document may switch Versioning on, a `pr-release` one may leave everything
off). Roles: `board`, `developer`, `tester`, `owner`, plus the roles an extension adds (`sampler` with `builtin:samples`).

States (labels on the issue): `needs triage` (also: no label), `ready`, `in development`, `ready for testing`,
`testing`, `back to development`, `board review`, `human review` (the owner's inbox), `postponed`, closed.
The switches add `awaiting release` (`releases` with `hold`); extensions add their own (`builtin:samples`: `needs
samples`, `in procurement`, `samples unobtainable`).

## Switches

Each feature is off unless the document gives it: `true` switches it on with the defaults, an object with options,
`false` or absence leaves it off. A feature an inline flow has no states for, or that the tracker cannot do, is
refused.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `features.pullRequests` | `true` or object | off | A branch and a pull request per ticket. The developer pushes the branch and calls `pr` (the Worker opens or updates the pull request); `handoff` needs it open with its checks green (or merged, see `merger`). |
| `features.pullRequests.branch` | string with `{n}` | `flowee/{n}` | The ticket's branch name (the client creates it). |
| `features.pullRequests.checks` | array of names | `[]` | Checks that must be green on the pull request's head; empty: every check run and status, and at least one. |
| `features.pullRequests.method` | `merge`, `squash`, `rebase` | `merge` | How the pull request is merged; the merge commit's subject ends with the ticket suffix (` (#n)`). |
| `features.pullRequests.merger` | `flow`, `developer` | `flow` | `flow`: the tester tests the pull request's head and `pass` merges it. `developer`: the developer merges with `merge` (checks green) before `handoff`, and the tester tests the main branch. |
| `features.pullRequests.deleteBranch` | boolean | `true` | Delete the branch after the merge. |
| `features.releases` | `true` or object | off | Releases: which one contains a ticket, test cards held until then, the version line, the `tested` tag. |
| `features.releases.source` | `release`, `tag` | `release` | `release`: the latest published release (its notes' `build from <sha>` names the built commit, else its tag's commit). `tag`: the commit `tag` points at (a moving tag). |
| `features.releases.tag` | string | | The tag marking the published build (`source: "tag"`, required there). |
| `features.releases.testedTag` | string | | A tag the cron moves forward over the main branch as far as no commit belongs to a ticket still in an untested state (`meta.untested`); CI can release from it. |
| `features.releases.checks` | array of names | `[]` | `testedTag` lands only on a commit with these checks green. |
| `features.releases.skip` | array of commit types | `["docs", "chore", "test"]` | `testedTag` never lands on a commit of these types. |
| `features.releases.hold` | boolean | `true` | A `Kind: test` card for a ticket whose commits the release lacks waits in `awaiting release`; the cron hands it to the owner when a release has them. |
| `features.releases.versionLine` | boolean | `true` | Test cards say `📦 In <version> or later`: the first of the last 10 published releases that has every commit of the ticket (the minimum version to install); no line while no published build has them all, or for a ticket without commits. |
| `features.samples` | `true` or object | off | The former samples switch, still read: with a preset the workspace gets the `builtin:samples` extension (the `sampler` role, the states `needs samples`, `in procurement`, `samples unobtainable`, `Kind: sample` cards) with these options in its `pathsExist` guards; with an inline chart, a switch of that chart's own `samples` tags. New documents name `"extensions": ["builtin:samples"]` instead. |
| `features.samples.root` | string | `""` | Sample paths must start with this (e.g. `Samples/`). |
| `features.samples.notNeededLabel` | string | `not file related` | A ticket with this label needs no sample to become `ready`. |
| `features.uiReview` | object | off | A `pass` whose commits change the UI goes to `board review` with an owner card instead of closing. |
| `features.uiReview.paths` | array of globs | `[]` | A change to a file under one of them is a UI change (`**/ui/**`, `**/src/main/res/**`). |
| `features.uiReview.addedFiles` | array of globs | `[]` | A file added under one of them is a UI change (a new view). |
| `features.uiReview.addedLines` | array of regular expressions | `[]` | An added line matching one is a UI change (`@Composable`). |
| `features.uiReview.ignore` | array of globs | `[]` | Files never counted (`formats/**`, tests). |
| `features.dependencyTickets` | `true` or object | off | The cron files one ticket per open pull request of these authors (`deps: <title> (PR #p)`, body `Pull request: #p`); its hand-off needs that pull request merged. |
| `features.dependencyTickets.authors` | array | `["dependabot[bot]"]` | Pull request authors. |
| `features.dependencyTickets.labels` | array | `[]` | Labels the ticket gets (e.g. `not file related`). |
| `features.userFeedback` | `true` or object | off (the wizard always sets it) | User feedback: tickets carrying `label` are untrusted text from outside the team. With `autoTriage` they go to `role` automatically (in any state) until `triage` or `checked` removes the label; without it a new ticket with the label waits for a human first: the cron moves it from `needs triage` to the owner's inbox as a card (triage it, drop it, or answer the reporter), and the owner's answer removes the label and hands it to the board. |
| `features.userFeedback.label` | string | `feedback` | The label that marks user feedback (an outside service or the reporter's form sets it). |
| `features.userFeedback.role` | string | `board` | The role that triages it. |
| `features.userFeedback.autoTriage` | boolean | `true` | `true`: the board triages it automatically; `false`: it waits for a human first. The wizard's switch is this value. |
| `features.untrustedReports` | `true` or object | off | The former name of `userFeedback` with `autoTriage: true` (`label`, `role` as there); still valid, read only when `userFeedback` is absent; the wizard rewrites it as `userFeedback`. |
| `features.untrustedReports.label` | string | `feedback` | As `userFeedback.label`. |
| `features.untrustedReports.role` | string | `board` | As `userFeedback.role`. |

## What each switch adds

| Feature | States | Commands | Rules |
|---|---|---|---|
| `pullRequests` | | `pr` (open or update the pull request from the ticket's branch), `merge` (`merger: developer`) | `handoff` needs the pull request open with the checks green (or merged with `merger: developer`); with `merger: flow` the tester tests its head and `pass` merges it; `show` adds `branch` and `pull` |
| `releases` | `awaiting release` (`hold`) | | an escalated `Kind: test` card waits until the published build has the ticket's commits; the cron moves it to the owner; `📦 In <version> or later` on test cards; `testedTag` moved forward by the cron |
| `uiReview` | | | a `pass` whose changes (every file of the open pull request, else the ticket's commits) touch the UI goes to `board review` and needs an owner card |
| `dependencyTickets` | | `merge` | the cron files one ticket per open pull request of `authors`; its hand-off needs that pull request merged |
| `userFeedback` | | `checked` (`autoTriage`); the cron's `feedback` tick (without) | `autoTriage`: a ticket with `label` goes only to `role`, in any state, until `triage` or `checked` removes the label; without: a new one goes to the owner's inbox first, the answer removes the label |

## GitHub token permissions

A fine-grained token limited to the workspace's repositories. The base flow needs **Issues: read and write**,
**Metadata: read** and **Contents: read** (commits, compare); a `tracker.project` board needs a classic token with
`repo` + `project` instead (fine-grained tokens cannot write a user's project).

| Feature | Calls | Permission |
|---|---|---|
| `pullRequests` | branch heads, open/update/read pull requests, check runs and statuses, merge, delete the branch | **Pull requests: read and write**, **Checks: read**, **Commit statuses: read**, **Contents: read and write** (merging and deleting a branch write contents) |
| `releases` | the latest release, read a tag | **Contents: read** |
| `releases.testedTag` | move the tag | **Contents: read and write** |
| `releases.checks` | check runs and statuses of main's commits | **Checks: read**, **Commit statuses: read** |
| `builtin:samples` (extension) | does a path exist on main | **Contents: read** |
| `uiReview` | the files and lines of the ticket's commits | **Contents: read** |
| `dependencyTickets` | list open pull requests, read one, file a ticket | **Pull requests: read**, **Issues: read and write** |
| `userFeedback` | labels only | (base) |

Without `tracker.project`, a fine-grained token limited to the workspace's repositories is enough and safest.

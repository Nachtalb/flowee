# Flow parity with AnyFile

AnyFile's agent team runs the richest flow Flowee replaces: `Board/scripts/flow.py`, its agent docs
(`docs/agents/{workflow,board,developer,tester,sampler}.md`, `scripts/issues.sh`) and the Rust AnyFile Envoy's
release handling (`src/release.rs`, `src/poll.rs`, `src/bot.rs`). This table is every flow feature of those sources:
what Flowee's phase 1 (the `trunk` preset) does about it, and how the `pr-release` preset carries it.

Third column: **preset** = a state, command or rule of `pr-release` that is always there; **switch `x`** = there when
the workspace switches on the feature `x` (`features.x`, docs/configuration.md); **not carried over** = left out, with
the reason. "AnyFile" names below are generalised as in docs/parity.md (`Nick` → the owner, `### For Nick` →
`### <texts.cardHeading>`).

## States

| # | AnyFile | Flowee phase 1 (`trunk`) | `pr-release` |
|---|---|---|---|
| 1 | `needs triage`; an open ticket without a state label counts as it | same | preset |
| 2 | `needs samples`: specified, no real sample yet (Todo) | none | switch `samples` |
| 3 | `in procurement`: a Sampler holds it (In Progress) | none | switch `samples` |
| 4 | `samples unobtainable`: the owner's inbox, owner assigned (only the Board puts a ticket here) | none | switch `samples` |
| 5 | `ready` | same | preset |
| 6 | `in development` | same | preset |
| 7 | `ready for testing` | same | preset |
| 8 | `testing` | same | preset |
| 9 | `back to development` | same | preset |
| 10 | `board review` (an agent's question, blocker, unobtainable sample or a pass with new UI) | same | preset |
| 11 | `awaiting release`: a test card waits until the published release has the ticket's code (To Test, not assigned) | none | switch `releases` (`hold`) |
| 12 | `human review`: the owner's inbox, owner assigned | same | preset |
| 13 | `postponed` | same | preset |
| 14 | closed (`completed` / `not planned`), reopened by the owner's answer | same | preset |
| 15 | Two state labels: refused, fix by hand | same (`two_states`) | preset |
| 16 | A board column per state (Projects v2 Status), the item added when missing | same (`meta.status`, `tracker.project`) | preset |

## Commands and their preconditions

| # | AnyFile | Flowee phase 1 (`trunk`) | `pr-release` |
|---|---|---|---|
| 17 | `next <role> --worker <id>`: resume the worker's claim, else claim the first queued ticket | `next`; the instance comes from the token | preset |
| 18 | `queue <role>` (monitors) | `GET /v1/queue` | preset |
| 19 | `show <n>`: state, claim, commits | `show` (+ answers, origin, dependencies) | preset; with `pullRequests` also the ticket's branch, pull request and its checks |
| 20 | `heartbeat` | same | preset |
| 21 | `triage <n> ready <paths…>`: refused unless every sample path is on `origin/master` (or the ticket is `not file related`) | `triage` (needs `## Acceptance`) | preset; with `samples` the paths are required and checked on the main branch (`samplesGiven`) |
| 22 | `triage <n> samples` → `needs samples` | none | switch `samples` (`triage` with `samples: true`) |
| 23 | `triage <n> review` → `human review` with a card | `escalate` from `needs triage` | preset |
| 24 | `found <n> <paths…>` (Sampler): paths on master → `ready` | none | switch `samples` |
| 25 | `unobtainable <n>` (Sampler): `Kind: sample` draft → `board review`, origin kind `unobtainable` | none | switch `samples` |
| 26 | `handoff`: a commit on master names `#n` since the last handoff; `Commits:` appended | same (subject ends with ` (#n)`) | preset without `pullRequests`; with it: an open pull request whose required checks are green (`pullRequestOpen`, `checksGreen`), or a merged one when the developer merges (`merged`) |
| 27 | `pass --build <sha>`: the build contains every commit of the ticket; closes, or → `board review` | same, plus green gates on the build | preset; with `pullRequests` (the flow merges) the build is the pull request's head, checks green, and pass merges it (`mergePull`) |
| 28 | `pass --ui`: the tester saw new UI → `board review` with a card | `owner_check` | preset |
| 29 | `fail` → `back to development` | same | preset |
| 30 | `stuck` (developer, tester, sampler) → `board review`, origin recorded | same (developer, tester) | preset; the sampler with `samples` |
| 31 | `review`: only the Board escalates; agents get an explanation | `escalate`, board only (`wrong_role`) | preset |
| 32 | `review` of an unobtainable ticket → `samples unobtainable`, only with a complete `Kind: sample` card | none | switch `samples` |
| 33 | `review` with a `Kind: test` card whose commits the release lacks → `awaiting release` | none | switch `releases` (`hold`) |
| 34 | `sendback`: back where it came from; refused for a passed ticket | same | preset; origins `in procurement`/`unobtainable` → `needs samples` with `samples` |
| 35 | `rework` from `human review`, `board review`, `ready for testing` (red CI) | same | preset |
| 36 | `needsamples` (board review, human review, samples unobtainable, answered triage) | none | switch `samples` |
| 37 | `approve`, `drop`, `postpone`, `resume` | same | preset |
| 38 | `build <n> [paths]` (the owner says build it) → `ready` | `triage` from `human review`/`board review` | preset |
| 39 | `answer` (owner, through the Envoy only): inbox, postponed or closed → `needs triage`, else a comment | same | preset; `samples unobtainable` is an inbox state too |
| 40 | The owner's decisions from `needs triage` once he answered | same (`answered`) | preset |
| 41 | `checked <n>`: the Board reviewed new untrusted text; the label goes | none | switch `untrustedReports` |
| 42 | `reap`: claims idle > 3 h go back to their queue with a `Board:` comment | same (cron, `leaseHours`) | preset; `in procurement` → `needs samples` with `samples` |
| 43 | `advance-tested` (every 2 min, and after each pass) | none | switch `releases` (`testedTag`) |

## Automatic rules

| # | AnyFile | Flowee phase 1 (`trunk`) | `pr-release` |
|---|---|---|---|
| 44 | One lock for every command, the ticket re-read inside it | same (Durable Object lock) | preset |
| 45 | Claims are exclusive; a Board claim on a ticket that moved on is dropped | same | preset |
| 46 | Queue order per role: board = `board review` (oldest hand-over first), then `needs triage` and new tickets; developer = `back to development`, then `ready`; tester = `ready for testing`; sampler = `needs samples` | same (`meta.claimable` rank/sort) | preset; the sampler with `samples` |
| 47 | Worker ids (Developer I, II, III …) | role instances (`roles[].instance`) | preset |
| 48 | Monitors: script-only cron jobs ask `queue` before starting an AI run | `GET /v1/queue` | preset |
| 49 | Comments signed with the role, never an agent; a self-signed comment is not signed twice | same | preset |
| 50 | Every hand-back needs a comment | same (`comment_required`) | preset |
| 51 | The owner card: `Kind: test\|question\|decision\|sample`, `Changed`, `Samples`, `Check`, `Question`, validated | same for test/question/decision | preset; `Kind: sample` (needs `Samples:` and `Check:`) with `samples` |
| 52 | Card file names: a code span holds exactly one file name, `Samples:` names no paths | none | switch `samples` (a card breaking it is `422 bad_card`) |
| 53 | Answers kept apart from comments (`answers.jsonl`) and shown to the Board in `next` | same | preset |
| 54 | Board-review origins with kind (`board-review.json`), hand-off commits (`handoffs.json`) | same (stored) | preset |
| 55 | A closed ticket refuses everything but `show` and `answer` | same | preset |
| 56 | `Depends on` order | `dependenciesClosed` (`Depends on: #n` in the body) | preset |
| 57 | Branch per ticket (developers once used `t/…` branches; today they commit to master) | none: commits straight to main | switch `pullRequests` (`branch` template; the client creates it) |
| 58 | Pull request per ticket (AnyFile: only dependency PRs) | none | switch `pullRequests` (opened/updated by the Worker on the client's `pr`) |
| 59 | CI checks must be green: a dependency PR before its merge; the `tested` tag only onto a green master build | none (local gates only) | switch `pullRequests` (`checks`) and `releases` (`checks`) |
| 60 | Merge rules: merge commit, branch deleted, never past a failing check | none | switch `pullRequests` (`method`, `merger`, `deleteBranch`); refused while a required check is not green |
| 61 | New UI from the diff: a change under a UI package or a resource folder, a new renderer file, an added `@Composable`/dialog/toast/control line, parser modules ignored → a pass goes to `board review` | none (only the tester's `owner_check`) | switch `uiReview` (`paths`, `addedFiles`, `addedLines`, `ignore`) |
| 62 | The `tested` tag moves forward over master while no commit belongs to an untested ticket (in development … back to development), skips `docs`/`chore`/`samples`/`test` commits and lands only on a green build | none | switch `releases` (`testedTag`, `skip`, `checks`; states with `meta.untested`) |
| 63 | Which release contains a ticket: the published build's sha (notes `build from <sha>`), ancestor check per commit | none | switch `releases` (`source`: latest GitHub release or a moving tag; notes naming a sha win) |
| 64 | `📦 In {version} or later` under a test card | none (parity row 17: n/a) | switch `releases` (`versionLine`) |
| 65 | Owner test cards held until a release contains the code (Envoy poll + `awaiting release`) | none (parity row 19: n/a) | switch `releases` (`hold`), as a state: cron event `released` |
| 66 | Dependency-PR tickets: one ticket per open Dependabot PR, titled `deps(<repo>): … (<repo>#<n>)`, labelled `not file related`, in `needs triage`; the developer merges it green and hands off | none | switch `dependencyTickets` (`authors`, `labels`); hand-off needs the PR merged |
| 67 | Untrusted user text (`feedback` label): no role but the Board gets the ticket; the Board gets it in any state; triage and `checked` clear the label | none | switch `untrustedReports` (`label`, `role`) |
| 68 | The 📎 Sample card in the Envoy, placeholder `Where the sample is…` | none (parity rows 13, 14, 22: n/a) | switch `samples` |
| 69 | Housekeeping cron (reap, advance-tested, inbox notes) | Worker cron (reaper, envoy tick) | preset |
| 70 | Dependabot's own issues never count as new tickets | pull requests are never tickets | preset |

## Not carried over

| # | AnyFile | Why |
|---|---|---|
| 71 | The update service `GET /api/anyfile/latest` `{sha, version}` as the release source (Rust Envoy) | A project-specific endpoint. Flowee reads the tracker's releases or a tag; AnyFile's `latest` release, whose notes name the build sha, gives the same answer. |
| 72 | Dependency PRs of other repositories (`anyfile-*`): merged there, reported through `stuck`, closed by the Board | Needs a workspace over several repositories (multi-repo tickets, built in parallel); until then dependency tickets cover the workspace's own repository. |
| 73 | `gh pr merge --admin` past branch protection on a green PR | Bypassing protection needs an admin token; Flowee's fine-grained token never gets one, and a protected branch should stay protected. |
| 74 | `sample-check.py` (VirusTotal/ClamAV on attached samples) | Project tooling the Board runs itself; not a flow rule. |
| 75 | `issues.sh issue block/parent` (native blocked-by, sub-issues) | Issue-editing helpers outside the flow; Flowee's ordering rule reads `Depends on:` in the body. |
| 76 | Hard-coded board column ids, repository and owner in the script | Configuration in Flowee (`tracker.project`, `owners[].tracker`). |

## Counts

**25 switch** rows (six features), **45 preset** rows (several of them gain a switched part), **6 not carried over**
(71-76).

| Feature | Rows |
|---|---|
| `pullRequests` | 57, 58, 60 (+ the PR side of 19, 26, 27, 59) |
| `releases` | 11, 33, 43, 62, 63, 64, 65 (+ 59) |
| `samples` | 2, 3, 4, 22, 24, 25, 32, 36, 52, 68 (+ 21, 30, 34, 39, 42, 46, 51) |
| `uiReview` | 61 |
| `dependencyTickets` | 66 |
| `untrustedReports` | 41, 67 |

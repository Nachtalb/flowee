# Statecharts: writing or changing a flow

A flow is two JSON files: a **statechart** in XState v5 JSON (drawable and editable in Stately's editor) and its
**options**. Flowee ships one, `flows/flow.json` + `flows/flow.options.json`, whose parts are tagged with the
switches that keep them; a workspace names it by a starting point (`"flow": {"preset": "trunk"}` or
`"pr-release"`, the same chart) or carries its own inline (`"flow": {"chart": {…}, "options": {…}}`).

## The statechart

```json
{
  "id": "trunk",
  "initial": "needs triage",
  "states": {
    "ready": {
      "meta": { "label": "ready", "status": "Todo", "claimable": { "role": "developer", "rank": 2, "when": "dependenciesClosed" } },
      "on": {
        "next": { "target": "in development", "guard": { "type": "roleIs", "params": { "roles": ["developer"] } },
                  "actions": ["setStatus", "setLabel", "claim"] }
      }
    }
  }
}
```

- **States** are the ticket states. A ticket's state is read from the tracker on every call: the state whose
  `meta.label` the issue carries; none means `initial`; a closed issue is in the state with `meta.closed`.
- **Events** are the API commands (`next`, `handoff`, `pass`, …) plus the reaper's event (`expire` in `trunk`).
- **Transitions** (`on.<event>`): a target or none (the ticket stays), one `guard`, a list of `actions`. An array
  lists alternatives; the first whose guard passes is taken.
- **`entry` / `exit`** actions of a state run when a transition changes the state.

### `meta` of a state

| Field | Meaning |
|---|---|
| `label` | The tracker label of the state (required except on the closed state). |
| `status` | The project board column (`setStatus`). |
| `holder` | The role whose claim holds a ticket here; `next` resumes such a claim, the reaper only requeues it. |
| `claimable` | `{role, rank, sort?, when?}`: tickets here are in that role's queue, states by `rank` (lower first), tickets by number or (`sort: "handover"`) by oldest recorded origin; `when` is a selector guard each ticket must pass. |
| `assignOwner` | The owner's tracker login is assigned while the ticket is here. |
| `closed` | The issue is closed (exactly one state). |
| `inbox` | The owner's inbox: tickets here become cards in the chat, `queue` lists them for `inboxRoles`. |
| `parked` | Parked tickets the owner lists with `/postponed`. |
| `review` | `show` and `next` include the recorded origin here. |

### How the engine runs an event

1. The caller's role must be in `options.commands[cmd].roles` (`403 wrong_role`), then the body's fields are
   checked in the order of `input` (after `n`).
2. The ticket is read; the event's transitions in its state are tried in order. A **selector** guard that fails
   moves on to the next transition; a **check** guard that fails refuses the command with its error.
3. No transition left: `409 wrong_state`, naming the states where the caller's role could use the event (states
   only reachable through `answered` get ` (answered)` and come last).
4. The transition's actions run in order; then, if the state changed, the source's `exit` and the target's
   `entry` actions, and the engine records when the ticket entered its state.

**Deviation from XState:** XState runs exit actions before transition actions. Flowee runs them after, so a
tracker write that fails (502) leaves the stored state as it was and a retry completes it. The chart stays valid
XState: a test loads `flows/flow.json` with xstate's `createMachine` and walks it with `transition()`.

**Why not the xstate runtime:** the service is request/response over a tracker that is the record: each command
re-reads the ticket, evaluates async guards (tracker reads), runs async actions and must report *why* a
transition is refused. xstate's guards are synchronous and a disabled transition is silently ignored, so the
runtime would need the same wrapping the ~110-line interpreter (`src/core/engine.ts`) is. `xstate` is a dev
dependency only, for the compatibility test.

## Guards

Selectors return false (try the next transition); checks refuse with the error shown.

| Guard | Kind | Params | Checks | Refusal (status, code, message) |
|---|---|---|---|---|
| `all` | selector | `guards: [...]` | every listed guard, in order; stops at the first false | the first check that refuses |
| `roleIs` | selector | `roles: [...]` | the caller's role is listed | — |
| `flag` | selector | `name` | the body field `name` is `true` | — |
| `answered` | selector | | an owner answer was recorded since the ticket entered this state | — (adds ` (answered)` to the state in `wrong_state`) |
| `hasCommits` | selector | | the ticket has commits on the main branch (subject ends with `commitSuffix`) | — |
| `originIs` | selector | `from` | the recorded origin (`recordOrigin`) is `from` | — |
| `dependenciesClosed` | selector | | every `Depends on: #n` ticket is closed | — |
| `holdsClaim` | check | | the caller's instance holds the claim | 409 `not_claimed` `#12 is not claimed by dev2.` |
| `notClaimedBy` | check | `roles` | no instance of these roles holds the claim | 409 `claimed` `#12 is claimed by dev1.` |
| `hasAcceptance` | check | `heading` (`Acceptance`) | the body has a `## <heading>` section | 400 `bad_request` `#12 has no ## Acceptance section; add one with spec first.` |
| `commitsOnMain` | check | | a commit on the main branch for the ticket that no earlier handoff listed (kept for `recordHanded`) | 422 `no_commits` `No new commit on main ends with (#12); push first.` |
| `gatesMatchBuild` | check | | `gates.sha == build` and `gates.ok` | 422 `gates_mismatch` `The gates ran on 1a2b3c4, not on the build 5d6e7f8.` / `The gates failed on 5d6e7f8; pass needs them green.` |
| `buildOnMain` | check | | `build` is on the main branch | 422 `not_in_build` `Build 1a2b3c4 is not on main; push it and test again.` |
| `buildContainsCommits` | check | | `build` contains every commit of the ticket | 422 `not_in_build` `Build 1a2b3c4 lacks 9f8e7d6 (#12); pull and test again.` |
| `cardValid` | check | `field` (`comment`) | the field holds a valid owner card (kept for `sendCard`) | 422 `bad_card` `The card has no Check: lines (needed for Kind: test).` |
| `refuse` | check | `status`, `code`, `message` (`{n}`, `{state}`) | always refuses | as given |
| `pullRequestOpen` | check | | the ticket's pull request (the one its body names as `Pull request: #p`, else the one from its branch) is open | 422 `no_pull_request` `No open pull request for #12 from flowee/12; push the branch and run pr first.` |
| `checksGreen` | check | | every required check (`pullRequests.checks`, else all) on the pull request's head completed green | 422 `checks_failed` `Checks failed on 1a2b3c4: build (failure); fix them first.` / 422 `checks_pending` `Checks of 1a2b3c4 are not done yet: build (in progress); wait and try again.` / `No checks reported on 1a2b3c4 yet; wait and try again.` |
| `merged` | check | | the ticket's pull request is merged (its merge commit counts as the ticket's) | 422 `not_merged` `Pull request #1001 of #12 is not merged yet; merge it first.` |
| `isDependencyTicket` | selector | | the body names a pull request (`Pull request: #p`, feature `dependencyTickets`) | — |
| `buildTested` | check | `contains` (`true`) | with the flow merging an open pull request: `build` contains its head (`contains: false`: is on it or on main); a pass retried after its merge went through (a later tracker write failed): the merged pull request's head is `build`, and the merge counts; otherwise as `buildOnMain` + `buildContainsCommits` (merge commits included) | 422 `not_in_build` `Build 1a2b3c4 lacks the head 5d6e7f8 of pull request #1001; pull and test again.` (and the two above) |
| `uiChanged` | selector | | the ticket's changes (every file of its open pull request, else its commits) match `uiReview` (`paths`, added files under `addedFiles`, added lines matching `addedLines`, minus `ignore`); the reasons go to the comment as `{ui}` | — |
| `inRelease` | selector | | the published build (`releases.source`) contains every commit of the ticket (none: true); remembers the release for the card's version line | — |
| `awaitsRelease` | selector | | `releases.hold`, the card is `Kind: test` and the published build lacks a commit of the ticket (nothing published: all) | — |
| `cardKind` | selector | `kinds` | the card checked by the command's input is of one of these kinds | — |
| `hasCard` | selector | | the newest comment with a valid owner card (kept for `sendCard`) | — |
| `samplesGiven` | check | | `paths` are given, start with `samples.root` and exist on the main branch (or a container they point into does), or the ticket has `samples.notNeededLabel`; the paths go to the comment as `{paths}` | 422 `no_samples` `#12 needs sample paths (or the 'not file related' label).` / `Not on main yet: Samples/a.png.`; 400 `bad_request` `Sample paths start with Samples/: a.png.` |
| `untrusted` | selector | | the ticket has the `untrustedReports.label` | — |
| `isUntrusted` | check | | the ticket has the label | 409 `not_untrusted` `#12 has no 'feedback' label.` |
| `trusted` | selector | | no untrusted label, or the caller is `untrustedReports.role` (in `claimable.when`: other roles never get such a ticket) | — |

## Actions

| Action | Params | Does |
|---|---|---|
| `setStatus` | | sets the board column of the target state (no-op without a board or when the state stays) |
| `comment` | `field` (`comment`), `text`, `append` | posts the field's text (or `text`) plus `append`, signed with the caller's role; nothing when empty. Templates: `{n}`, `{build}`, `{gates}`, `{commits}`, `{claim}`, `{lease}`, and from the feature guards `{pull}`, `{merge}`, `{ui}`, `{paths}` (empty when unset) |
| `setLabel` | `reason` (`completed`) | one tracker write: the target's label instead of any state label, the owner assigned or not, closed (with `reason`) or reopened |
| `updateBody` | | replaces the body (and the title when given) with the `body`/`title` fields |
| `claim` | | the caller's instance claims the ticket |
| `releaseClaim` | | drops the ticket's claim |
| `touchClaim` | | renews the claim's lease; answers `touched` |
| `recordOrigin` | `from` (the source state) | records who handed the ticket over and from where |
| `clearOrigin` | | forgets the origin (the trunk's `board review` exit) |
| `recordHanded` | | stores the commits `commitsOnMain` found; answers `commits` |
| `recordAnswer` | `field` (`text`) | stores the owner's answer; the chat card says answered |
| `sendCard` | `field` (`chat`) | the ticket becomes an inbox item and its card goes to the chat; answers `field: "sent" \| "queued"`; with `releases.versionLine` a test card carries the published version (`📦 In <version> or later`) |
| `dropInboxCard` | | the ticket's card leaves the owner's todo list |
| `openPull` | | opens the ticket's pull request from its branch (title: the ticket's title + the commit suffix, body `Closes #n`) or updates its title; answers `pull: {number, url, branch}`; 422 `no_branch` `Push flowee/12 first; it does not exist on the tracker.` |
| `mergePull` | | merges the ticket's open pull request (`pullRequests.method`, subject ending with the commit suffix), deletes the branch (`deleteBranch`), records the merge commit; answers `merged`; 409 `not_mergeable` when the tracker refuses; no-op without an open pull request |
| `moveTag` | | moves `releases.testedTag` (also every cron run); answers `tested` when it moved |
| `markChecked` | | removes the `untrustedReports.label` |

## Options

| Field | Meaning |
|---|---|
| `roles` | `{role: {sign, who}}`: the comment signature (`{owner}` is the workspace's owner name) and the role in `wrong_role` sentences. |
| `commands` | `{command: {roles, read?, input?, state?}}`: every API command. `read` makes it a GET without body. `input` checks body fields in order: `required`, `optional`, `{required: [roles]}`, `card` (required + a valid card), `text` (the owner's answer), `body`, `title` (1-120 chars, optional), `sha` (40 hex), `gates` (`{sha, ok}`), `flag` (optional boolean). `state: false` leaves `state` out of the response. |
| `leaseHours` | A claim without heartbeat or command expires after this. |
| `reaper` | `{event, role}`: the cron fires `event` as `role` on a ticket whose claim expired, when its state has that event; the claim is dropped either way. |
| `inboxRoles` | Roles whose `queue` also lists the inbox. |
| `commitSuffix` | A ticket's commits end their subject with this (`{n}` = the ticket). |
| `ownerRole` | The role the chat answers and files as. |

`whoami`, `queue`, `show`, `next` and `file` are built into the service; every other command is a chart event.

Loading checks: the initial state exists; exactly one closed state; every state but the closed one has a unique
label; every target exists; every state is reachable; every guard and action (also inside `all`, `when`,
`entry`, `exit`) is registered; every role named exists; every event has a command (except the reaper's); every
command is a built-in or an event; input rules are known; `leaseHours > 0`; `commitSuffix` contains `{n}`. Each
problem is one sentence naming the state, event or option.

## Features: one chart, pruned per workspace

A preset can carry optional parts. States, transitions, roles, commands and ticks name the **feature terms** that must
all hold for them to exist: `meta.features` on a state or transition (Stately keeps `meta`, so the file stays
openable there), `features` on an options role, command or tick. A term is `samples` (on), `!samples` (off),
`pullRequests.merger=flow` (on, with that option), `releases.hold` (on, the option true). When a workspace is loaded,
`prune()` (`src/core/features.ts`) removes everything whose terms fail, then drops events that lost every transition,
commands whose event is gone, and the switched-off roles from the command lists. The pruned chart is what the loader
checks and the engine runs; `GET /v1/whoami`, `queue` and `wrong_state` only ever see it.

So the statechart of a workspace is the preset minus the parts of its switched-off features. A workspace may also
give its own complete statechart inline and tag it the same way. Guards and actions of a feature read its options
(`c.f.s.features`); used on a workspace without the feature they pass or do nothing.

**Ticks** (`options.ticks: [{event, role, features?}]`): the cron fires `event` as `role` on every open ticket whose
state has it, after the reaper; selector guards decide (e.g. `released` hands an `awaiting release` card to the owner
once `inRelease` holds). Tick events need no entry in `options.commands`.

**Input rule `paths`**: an optional array of non-empty strings (sample paths).

## Changing a flow for one workspace

1. Start from the nearest preset: copy `flows/<preset>.json` (the chart) and `flows/<preset>.options.json` from the
   Flowee repository. Both are long; change only what the project needs.
2. Edit: add a state (with a unique `meta.label`), its transitions (`on.<event>`) from and to it, the command in
   `options.commands` with its roles and `input`, a role in `options.roles` if needed. Every state must be
   reachable, every event needs a command (except the reaper's and tick events), every guard and action must be in
   the tables above.
3. Put both inline: `"flow": {"chart": {…}, "options": {…}}`; feature tags (`meta.features`, `features`) work the
   same as in a preset, and the workspace's `features` switch them.
4. `bun run validate` reports the first loading problem of the flow as `$.flow: <one sentence naming the state,
   event or option>`.
5. Optional: open the chart in Stately's editor to see it (only `meta` carries Flowee's extras).

`references/examples.md` has a complete small inline flow (four states, two roles) that validates.

# Flows: statecharts, guards and actions

A flow is two JSON files: a **statechart** in XState v5 JSON (`flows/<name>.json`, drawable and editable in
Stately's editor) and its **options** (`flows/<name>.options.json`). A workspace names a preset
(`"flow": {"preset": "trunk"}`) or carries both inline (`"flow": {"chart": {…}, "options": {…}}`).

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
XState: a test loads `flows/trunk.json` with xstate's `createMachine` and walks it with `transition()`.

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

## Actions

| Action | Params | Does |
|---|---|---|
| `setStatus` | | sets the board column of the target state (no-op without a board or when the state stays) |
| `comment` | `field` (`comment`), `text`, `append` | posts the field's text (or `text`) plus `append`, signed with the caller's role; nothing when empty. Templates: `{n}`, `{build}`, `{gates}`, `{commits}`, `{claim}`, `{lease}` |
| `setLabel` | `reason` (`completed`) | one tracker write: the target's label instead of any state label, the owner assigned or not, closed (with `reason`) or reopened |
| `updateBody` | | replaces the body (and the title when given) with the `body`/`title` fields |
| `claim` | | the caller's instance claims the ticket |
| `releaseClaim` | | drops the ticket's claim |
| `touchClaim` | | renews the claim's lease; answers `touched` |
| `recordOrigin` | `from` (the source state) | records who handed the ticket over and from where |
| `clearOrigin` | | forgets the origin (the trunk's `board review` exit) |
| `recordHanded` | | stores the commits `commitsOnMain` found; answers `commits` |
| `recordAnswer` | `field` (`text`) | stores the owner's answer; the chat card says answered |
| `sendCard` | `field` (`chat`) | the ticket becomes an inbox item and its card goes to the chat; answers `field: "sent" \| "queued"` |
| `dropInboxCard` | | the ticket's card leaves the owner's todo list |

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

## Writing a preset

1. Draw the chart (Stately or by hand) into `flows/<name>.json`; write `flows/<name>.options.json`.
2. Register it in `src/config/presets.ts` and run `bun run schema` (the preset name joins the schema's enum).
3. Add a test that walks it (see `test/engine.test.ts`) and, for behaviour, tests against the Worker as in
   `test/flow.test.ts`.

## Adding a guard or an action

Add it to `GUARDS` (`src/core/guards.ts`, with `kind`) or `ACTIONS` (`src/core/actions.ts`), document it in the
tables above (a test fails when a registered name is missing here) and give it a test. Guards and actions reach
the tracker, the store and the clock only through the service (`c.f`), never an adapter.

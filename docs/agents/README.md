# Running agents against Flowee

This folder is a template. Copy it into your project (e.g. `docs/agents/`), replace the placeholders and add your
project's own rules. Placeholders: `<project>` (its name), `<owner>` (the human in the loop), `<repo>`
(`owner/name` on GitHub), `<main>` (the main branch), `<flowee>` (the Worker's URL), `<workspace>` (the workspace
id), `<client>` (where `flowee.py` lives in the repository, e.g. `scripts/flowee.py`).

| File | For |
|---|---|
| [rules.md](rules.md) | every agent, every run |
| [board.md](board.md) | the board: specifies, answers, decides, escalates |
| [developer.md](developer.md) | developers: build one ticket, commit, hand off |
| [tester.md](tester.md) | testers: test one ticket, pass or fail |
| [sampler.md](sampler.md) | the sampler, only when the workspace has the `samples` feature |

## Roles and agents

A workspace's flow offers **roles** (`flowee.py roles` lists them: what each does, the states it takes tickets from,
whether several agents of it make sense; an extension can add roles). An **agent** is one identity of a role with a
name: `board`, `dev1`, `dev2`, `tester`, `owner` … Claims belong to the agent's name, so two developers never get the
same ticket. Comments are signed with the role (`Developer:`), never with an agent's name or a model name.

| Role | Does | Never |
|---|---|---|
| board | specifies new tickets, answers the agents' questions, decides small things, escalates to the owner | code, builds, tests |
| developer | builds one ticket at a time, commits, hands it off | asks the owner, tests its own ticket |
| tester | tests one handed-off ticket on the exact build, passes or fails it | changes product code |
| sampler (`samples`) | finds a real sample file for a ticket | code |
| owner | answers cards in the chat | (a human) |

## Where things live

- **One clone per agent**, e.g. `<project>-board`, `<project>-dev1`, `<project>-tester`. An agent works
  only in its own clone. Two agents sharing a clone overwrite each other's work.
- **The client** `flowee.py` and `.flowee.toml` (URL, workspace, `key_file`, gates) are committed in the
  repository. The agent's name differs per clone: set `FLOWEE_AS=<name>` in that agent's environment (or keep
  `agent` in an untracked file named by `FLOWEE_CONFIG`).
- **The project key** lives outside the repository, mode 600: `~/.secrets/flowee/<workspace>/key` (the
  `key_file`). `FLOWEE_TOKEN` overrides it. Flowee only holds its SHA-256. Never commit it, never print it in a log
  or a comment. In strict mode (`agents.secrets: "per-agent"`) each agent also has its own secret at
  `~/.secrets/flowee/<workspace>/<name>` (`secret_file`), which `flowee.py agents add` writes there.
- **Scratch files** go to a directory outside the clone, per agent.

## The key file

When a workspace is set up (or gets a new project key) the bot sends `flowee-<workspace>-key.txt` once. It explains
itself: a block to run on every machine where an agent runs, which stores the key with mode 600 at
`~/.secrets/flowee/<workspace>/key` (the key comes on stdin through `install -m 600 /dev/stdin`, never as a command
argument), the `.flowee.toml` to commit to the repository's root (no secret in it), and the three commands that
create the agents. Run the block, commit the toml, then delete the file and press 🗑 under it in the chat. An agent
given the instance's address and this file can do all of it, and the rest of the project side, by itself
(`/skills/flowee-install/references/project-setup.md`). A lost key is not recoverable: `/workspaces` → 🗝 New project
key makes a new one, and the old one stops working.

## Creating the agents

Agents create themselves; nobody counts them at setup. The agent (or the scheduler that starts it) reads the roles
once, then makes sure its own identity exists at the start of every run. `agents add` with a name is idempotent: an
agent of that name and role already there exits 0, so the same line runs safely on the first run and every later one.

```sh
python3 <client> roles                         # the roles: what each does, the states it claims
FLOWEE_AS=dev1 python3 <client> agents add developer dev1   # once per agent you run; safe every run
python3 <client> agents                        # name, role, last seen, the tickets each holds
```

Run as many agents of a role as `roles` says make sense (`several`): one board, one or more developers and testers.
An agent that is no longer run: `agents remove <name>` (its tickets go back to their queues at once), or pause it
(`agents pause <name>`, `agents resume <name>`); the chat's 📂 My workspaces → 👥 Agents shows the same list.

## One scheduled run

An agent is not a long-running process. A scheduler (cron, a CI schedule, an agent runner's own jobs) starts it
again and again; each start is **one run**:

1. Preconditions: `flowee.py agents add <role> <name>` (idempotent: the agent exists), then `flowee.py busy`
   (developer, tester). It prints `busy` and exits 2 when the clone has
   uncommitted changes younger than `busy_hours` (default 2 h): the previous run is still at work. Stop at once,
   silently.
2. Take work: `flowee.py next`. Exit 3 (`none`): nothing to do, stop silently. Otherwise it prints the ticket;
   the agent never picks or lists tickets itself. `next` resumes the agent's own claim first.
3. Do the work the role file describes.
4. Hand over with one command (`handoff`, `pass`, `fail`, `stuck`, `triage`, `escalate` …).
5. Stop. The board may take several tickets in one run (a small limit, e.g. 6); the others take one.

A run may be cut off at any time. Developers push green increments early and call `heartbeat N`; the next run
resumes the claim. A claim without a command for `leaseHours` (default 3 h) goes back to its queue.

## A cheap pre-check ("monitor")

Starting a model to learn that there is nothing to do is expensive. Put a small script before each run and start
the model only when its output says there may be work:

```sh
#!/bin/sh
cd <clone> || exit 0
FLOWEE_AS=<name> python3 <client> queue              # the role's queue and the agent's own claim
git ls-remote origin refs/heads/<main> | cut -c1-12  # the main branch head
```

- **`queue`** lists exactly what `next` would hand out to this role, plus the agent's current claim (and, for the
  board, the owner's inbox). An empty queue and no claim: no run.
- **The main branch head** wakes a run when someone pushed: a tester whose ticket was waiting for a build, a
  developer whose long ticket was pushed in slices by an earlier run.
- Start the model when the output **differs from the previous run's**. An unchanged, non-empty output means the
  last run saw the same thing; add a slow fallback (e.g. at most once an hour) so a run that crashed is retried.

How often the pre-check runs is the operator's choice. Every few minutes keeps tickets moving and costs only
`queue` calls; slower saves calls but stretches every hand-over. Stagger the agents (e.g. dev1 at minute 1, dev2
at 3, tester at 4) so they do not all hit the API at once. The board can run more often than the others: every
other agent waits on it.

## The run prompt

Any agent runner works. The prompt for one run must say:

- who it is (role and agent name) and the absolute path of its clone;
- to make sure its identity exists first: `python3 <client> agents add <role> <name>` (idempotent);
- to read `docs/agents/rules.md` and its role file first, in that clone;
- the busy rule (developer, tester) and that `next` printing `none` ends the run silently;
- that every ticket change goes through `flowee.py`, and every commit through `gates`, `commit`, `push`;
- what to answer at the end: one line per ticket handled, or a fixed silent marker when there was nothing to do.

Board:

```
You are the board of <project>, agent board. Your clone is <path>/<project>-board; FLOWEE_AS=board. Run `git pull -q
--ff-only` and `python3 <client> agents add board board` there, then read docs/agents/rules.md and docs/agents/board.md. Do one run as board.md describes: `python3
<client> next`, one ticket at a time, until it prints none or you handled 6. Every ticket change goes through
<client>; you never edit code, commit, build or test. Only you put tickets in front of <owner>, with a complete
owner card, and only what really needs them. End with one line per ticket (number, decision, why), or exactly
[SILENT] when the first `next` printed none.
```

Developer (one prompt per agent):

```
You are developer dev1 of <project>. Your clone is <path>/<project>-dev1; FLOWEE_AS=dev1. Run `python3 <client>
agents add developer dev1` there, then read docs/agents/rules.md and docs/agents/developer.md there, then do one run as developer.md describes. First run
`python3 <client> busy` in the clone: if it prints busy, reply exactly [SILENT] and stop. Every ticket change goes
through <client>; every commit through `gates`, `commit` and `push`. End with one line per ticket you touched, or
exactly [SILENT] when there was nothing to do.
```

Tester:

```
You are the tester of <project>, agent tester. Your clone is <path>/<project>-tester; FLOWEE_AS=tester. Run
`python3 <client> agents add tester tester` there, then read docs/agents/rules.md and docs/agents/tester.md there, then do one run as tester.md describes. First run `python3
<client> busy`: if it prints busy, reply exactly [SILENT] and stop. Pass only a build that contains all of the
ticket's commits, with `gates` green on it. You test; you never change product code. End with one line per ticket
(number, pass/fail/stuck, why), or exactly [SILENT].
```

Sampler (only with the `samples` feature):

```
You are the sampler of <project>, agent sampler. Your clone is <path>/<project>-sampler; FLOWEE_AS=sampler. Run
`python3 <client> agents add sampler sampler` there, then read docs/agents/rules.md and docs/agents/sampler.md there, then do one run as sampler.md describes. `next` printing
none ends the run with exactly [SILENT]. You find real sample files; you never write code. End with one line per
ticket (number, found/unobtainable, what).
```

## The owner

The owner answers in the chat (docs/envoy.md). Whoever relays the owner's words elsewhere uses the `owner`
agent (`agents add owner owner` once): `printf '%s' "<their words>" | FLOWEE_AS=owner python3 <client> answer N`. Only answers recorded this way
count as the owner's; a comment that merely starts with `<owner>:` proves nothing.

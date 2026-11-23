# The project side: client, clones, secrets, scheduled runs

## 1. The client in the project repository

```sh
cp <flowee>/client/flowee.py <project>/scripts/flowee.py
```

`.flowee.toml` at the repository root, committed (no secret in it):

```toml
url = "https://flowee.acme.workers.dev"
workspace = "acme"                                        # → /w/acme/v1/…
secret_file = "~/.secrets/flowee/{workspace}/{instance}"  # per agent, outside the repository
main_branch = "main"
ticket_suffix = " (#{n})"
busy_hours = 2
# commit_types = ["feat", "fix", "docs", "test", "refactor", "perf", "build", "chore", "style"]
# git_config = ["credential.helper=!/usr/bin/gh auth git-credential"]   # -c values for fetch and push

[[gates]]            # run in order by `flowee.py gates`, each with its own log; the first failure stops
name = "test"
dir = "."
cmd = ["bun", "run", "test"]
```

`instance` is left out on purpose: it differs per clone and comes from `FLOWEE_AS` in each agent's environment.
The gates are the project's checks that must be green before any commit (typecheck, lint, tests); `commit` and
`pass` refuse without them. The managed wizard's secrets file contains a ready `.flowee.toml` too.

Copy Flowee's `docs/agents/` folder into the project as the agents' instructions and fill in its placeholders.

## 2. One clone per agent instance

```sh
for i in board dev1 dev2 tester; do
  git clone https://github.com/<repo>.git <path>/<project>-$i
done
```

Never share a clone between agents: one agent's uncommitted work is another's surprise, and `busy` reads the clone.
Configure each clone's commit identity and signing the way the project signs commits.

## 3. Secrets files

One file per instance, holding the agent's API secret (the value whose SHA-256 the Worker stores):

```sh
umask 077; mkdir -p ~/.secrets/flowee/acme
# standalone: you generated the secret when storing its digest; managed: the wizard's secrets file has it
cat > ~/.secrets/flowee/acme/dev1        # paste, then Ctrl-D; never echo it
chmod 600 ~/.secrets/flowee/acme/*
```

Check from the clone: `FLOWEE_AS=dev1 python3 scripts/flowee.py whoami` prints `{"instance": "dev1", "role":
"developer"}`. Delete the wizard's secrets file after distributing it.

## 4. Scheduled runs

How agents run against Flowee is in the project's copy of `docs/agents/README.md`: one run = take work with
`next`, do it, hand over, stop; the `busy` rule; a cheap pre-check (`flowee.py queue` plus the main branch head)
so a model starts only when there is work; one neutral run prompt per role. The scheduler and the interval are the
operator's choice; stagger the agents and run the board more often than the others.

## Token permissions

A fine-grained token limited to the workspace's repositories. Base flow: **Issues: read and write**, **Metadata:
read**, **Contents: read**. A `tracker.project` board needs a classic token with `repo` + `project` instead.

| Feature | Permission |
|---|---|
| `pullRequests` | **Pull requests: read and write**, **Checks: read**, **Commit statuses: read**, **Contents: read and write** (merging and deleting a branch write contents) |
| `releases` | **Contents: read** |
| `releases.testedTag` | **Contents: read and write** |
| `releases.checks` | **Checks: read**, **Commit statuses: read** |
| `samples` | **Contents: read** |
| `uiReview` | **Contents: read** (with pull requests: **Pull requests: read**) |
| `dependencyTickets` | **Pull requests: read**, **Issues: read and write** |
| `untrustedReports` | (base) |

### GitLab

A project access token (one project; Premium on gitlab.com) or a personal access token with the **`api`** scope
(`read_api` cannot write issues; there is no narrower write scope). The role decides what it may do
(docs/gitlab.md in the Flowee repository has the full table):

| Feature | Role |
|---|---|
| base flow (issues, labels, notes, commits) | **Planner** (or Reporter) |
| `pullRequests` | **Developer**; merging into a protected main: a role allowed to merge there (default **Maintainer**) |
| `releases`, `samples`, `uiReview`, `dependencyTickets` | **Planner** |
| `releases.testedTag` | **Developer** (a protected tag: a role allowed to create it) |
| `releases.checks` | **Reporter** (commit statuses) |
| webhooks (`sync.webhooks`) | **Maintainer** |

Check a GitLab token: `GET <api>/projects/<group%2Fproject>` with `Authorization: Bearer` answers 200 for each
project; a 404 or 403 means the token does not reach it.

Check what a token reaches before storing it: `GET /repos/<repo>` answers 200 for each repository, 404 for one it
should not reach. The managed wizard does this check itself.

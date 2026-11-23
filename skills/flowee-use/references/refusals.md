# Refusals and what to do

A refusal is exit 2 with `refused: <code>: <one sentence>`. The sentence names the ticket and what is missing. A
local refusal (the client itself) has no code.

## From Flowee

| Code | Example | Do |
|---|---|---|
| `bad_request` | `build must be a 40-character commit sha.` / `#12 has no ## Acceptance section; add one with spec first.` / `n must be alias#number with an alias of app or lib.` | fix the input; with several repositories write `alias#n` |
| `wrong_role` | `Only the board may use escalate.` | not your command; hand the ticket on (`stuck`) |
| `not_found` | `#41 does not exist or is a pull request.` / `There is no POST /v1/found.` | wrong number, or the workspace's flow has no such command |
| `wrong_state` | `#12 is 'ready'; handoff needs 'in development'.` | the ticket moved on; `show N`, then `next` again |
| `not_claimed` / `claimed` | `#12 is not claimed by dev2.` / `#12 is claimed by dev1.` | someone else holds it; do not touch it |
| `two_states` | `#12 has two state labels (ready, testing); fix it by hand.` | `stuck` is impossible; tell the board in your run's final line |
| `comment_required` | `This step needs a comment.` | give the comment on stdin |
| `no_commits` | `No new commit on main ends with (#12); push first.` | commit with the suffix and `push`, then hand off |
| `not_in_build` | `Build 1a2b3c4 lacks 9f8e7d6 (#12); pull and test again.` | update the clone (or `branch N`), run the gates, test again |
| `gates_mismatch` | `The gates ran on 1a2b3c4, not on the build 5d6e7f8.` | run `gates` on the build you pass |
| `bad_card` | `The card has no Check: lines (needed for Kind: test).` | complete the owner card (heading, `Kind:`, the fields its kind needs) |
| `no_branch` | `Push flowee/12 first; it does not exist on the tracker.` | `branch N`, commit, then `pr N` (it pushes) |
| `no_pull_request` | `No open pull request for #12 from flowee/12; push the branch and run pr first.` | `pr N` |
| `checks_pending` | `Checks of 1a2b3c4 are not done yet: build (in progress); wait and try again.` | `heartbeat N`, end the run; the next run retries |
| `checks_failed` | `Checks failed on 1a2b3c4: build (failure); fix them first.` | fix, commit, push, `pr N` again |
| `not_merged` | `Pull request #1001 of #12 is not merged yet; merge it first.` | `merge N` once the checks are green |
| `not_mergeable` | `GitHub refused to merge pull request #1001 (405): it is not mergeable or its head moved.` | tester: `fail` (conflict) with the reason; developer: update the branch |
| `no_samples` | `#12 needs sample paths (or the 'not file related' label).` / `Not on main yet: Samples/a.png.` | give paths that are on the main branch; wait for them to land |
| `not_untrusted` | `#12 has no 'feedback' label.` | nothing to check |
| `unsupported` | `The tracker does not support pull requests.` | the workspace is misconfigured; tell the board |
| `unauthorized` (exit 1) | `Unknown or missing token.` | your secret file or `FLOWEE_AS` is wrong; stop and report |
| `paused` (exit 1, 503) | `The workspace 'acme' is paused; its owner resumes it with /workspaces.` | stop |
| `github` / `telegram` (exit 1, 502) | `GitHub answered 502 for the label change of #12.` | end the run; the next run repeats the command, which completes it (a `pass` whose merge already went through completes without merging twice) |

## From the client

| Message | Do |
|---|---|
| `set FLOWEE_AS or instance in .flowee.toml` / `set FLOWEE_URL …` / `missing <file> (or FLOWEE_TOKEN)` | the clone is not set up; stop and report |
| `the gates have not passed on this exact tree: run flowee.py gates first` | run `gates`, then `commit` without changing files in between |
| `pass needs green gates on a clean HEAD` | commit or stash local changes, run `gates`, pass again |
| `one line only` / `message must be type(scope): subject …` / `the message names #7, the ticket is #12` | fix the message |
| `nothing staged` | name the paths: `commit N MSG path…` |
| `the commit came out unsigned and was undone` | make the signing key available, commit again |
| `rebase onto main conflicts, nothing pushed` | resolve the conflict keeping both sides' intent, gates, push |
| `<sha> is unsigned, has a body or lacks ' (#N)'` | rewrite that commit (signed, one line, suffix) before pushing |
| `this workspace's flow has no pull requests: work on the main branch` | no `branch`/`pr`/`checks` here |
| `switch to flowee/12 first: flowee.py branch 12` | `branch N`, then `pr N` |
| `no [[gates]] in .flowee.toml` | the project has not set gates; tell the board |

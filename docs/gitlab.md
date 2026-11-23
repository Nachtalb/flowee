# GitLab

A repository with `"type": "gitlab"` (`tracker.type` for all of them, `tracker.repos[].type` for one) goes through
`src/adapters/tracker-gitlab.ts`: GitLab's REST API v4 on gitlab.com or a self-managed instance (`api`:
`https://gitlab.example.com/api/v4`). A workspace may mix GitHub and GitLab repositories; each ticket goes
through its own repository's tracker. The flow, its labels, commands, cards and the client are the same as on
GitHub; this page lists where GitLab differs and what Flowee does about it.

```json
{
  "flowee": 1,
  "id": "acme",
  "flow": { "preset": "pr-release" },
  "features": { "pullRequests": { "checks": ["pipeline"], "method": "squash" }, "releases": { "testedTag": "tested" } },
  "tracker": {
    "type": "gitlab",
    "repos": [{ "repo": "acme/platform/api", "alias": "api" }, { "repo": "acme/web", "alias": "web", "type": "github", "token": "ACME_GITHUB_TOKEN" }],
    "token": "ACME_GITLAB_TOKEN"
  },
  "roles": [{ "instance": "owner", "role": "owner", "secret": "ACME_OWNER" }],
  "owners": [{ "name": "Ann", "tracker": "ann" }]
}
```

## GitHub concept, GitLab concept, what Flowee does

| GitHub | GitLab | Flowee |
|---|---|---|
| `owner/name` | `group/subgroup/project` (any depth) | The path in `repo`; the API addresses it URL-encoded (`/projects/acme%2Fplatform%2Fapi`). The alias defaults to the last part. A pasted link (`https://gitlab.com/g/p/-/issues/3`, `git@gitlab.com:g/p.git`, a self-managed host from `api`) reads as the path. |
| Issue number | Issue `iid` (per project); `id` is global | The ticket number is the `iid` (`#3`, `api#3`, ` (#3)` in commits); the global `id` is kept as the issue's `ref`. |
| Issue types | `issue_type`: issue, incident, test case, task | Only `issue` is a ticket: `openIssues` lists `issue_type=issue`, any other type reads as `404 not_found` (`#n does not exist or is not an issue.`). |
| Confidential issues | `confidential` | Read and moved like any other; the token needs Planner or higher to see them. Flowee never sets it. |
| Labels (array) | Labels (comma-separated string; missing ones are created) | The flow's label names as configured, sent whole (`labels`) in the one update write. A label name containing a comma cannot exist on GitLab. Scoped labels (`state::ready`) work if the flow names them so. |
| Assignees by login | `assignee_ids` (user ids) | Logins are looked up once each (`GET /users?username=`); an unknown login is `502 gitlab` naming it. GitLab Free allows one assignee. |
| Close with `state_reason` (`completed`, `not_planned`) | `state_event: close` (no reason) | Both reasons close the issue; the flow's comment and labels say why. |
| Comments | Notes, including system notes (label changes, closing) | `comments` reads `activity_filter=only_comments`, oldest first, and drops any `system` note: cards and answers are only human notes. |
| Commits since, compare `base...head` | `repository/commits?ref_name&since`, `repository/merge_base` | `contains(base, head)`: base resolved to a sha (branch or tag names too), then the merge base of both equals base. |
| Pull request | Merge request (`iid`, written `!n`) | `pulls` = merge requests: open from the branch (`Closes #n` in the description: GitLab closes the issue on merge into the default branch), update, find by `source_branch`, the newest open one first, diffs. |
| Draft pull request | Draft merge request (`Draft:` title prefix) | The title is read without the prefix and a rename keeps it; GitLab refuses to merge a draft: `409 not_mergeable`. |
| Merge methods merge / squash / rebase | Project's merge method (merge commit, semi-linear, fast-forward) + `squash` | `squash` squashes with the ticket subject (`squash_commit_message`); `merge` and `rebase` merge with the project's method and the subject as `merge_commit_message`. For a linear history (GitHub's rebase) set the project to fast-forward. The merge commit is `merge_commit_sha`, else `squash_commit_sha`, else (fast-forward) the head. |
| Merge refusals (405/409/422) | 401/403 (role, protected branch), 405 (not mergeable: draft, conflicts, unresolved threads, missing approvals, pipeline required), 406, 409 (head moved: `sha` mismatch), 422 | All `409 not_mergeable`: `GitLab refused to merge merge request !n (403): it is not mergeable, its head moved or the branch is protected.` The merge is pinned to the head Flowee read (`sha`), which also satisfies "require a commit SHA on the merge requests API". |
| Approvals | Merge request approvals (rules, Premium) | Not given by Flowee: a missing approval is a refused merge (`not_mergeable`). Have a human approve, or have no required approvals. |
| Auto-merge, merge trains | `auto_merge`, merge trains | Never used: Flowee checked the pipeline itself and merges at once. A project whose merges must go through a train refuses that (`not_mergeable`); use `merger: "developer"` there and let the developer merge. |
| Branch protection | Protected branches (who may push and merge) | The token's role must be allowed to merge into the target branch (default: Maintainers). Flowee deletes the source branch itself after the merge (`deleteBranch`). |
| Check runs and commit statuses | The commit's pipeline and its jobs, external commit statuses | `checks` = the newest pipeline of the commit as a check named `pipeline`, plus every job and external status (the newest per name). Green = the pipeline and every required name passed; required names come from `pullRequests.checks` / `releases.checks` (`["pipeline"]` = the whole pipeline; empty = all of them). |
| Check states | `created`, `waiting_for_resource`, `preparing`, `pending`, `scheduled` | queued |
| | `running`, `canceling` | in progress |
| | `success` | success |
| | `failed` | failure; with `allow_failure`: neutral (passes) |
| | `canceled` | cancelled (fails); with `allow_failure`: neutral |
| | `skipped` | skipped (passes) |
| | `manual` | a blocking manual job (or a pipeline waiting on one): `action_required` (fails until someone plays it); an optional one (`allow_failure`): skipped |
| Releases (`/releases/latest`) | Releases, newest `released_at` first | The newest release that is not an upcoming one; `build from <sha>` in its description names the built commit, else its tag's commit. |
| Tags: create, move by force-updating the ref | Tags: create and delete; no move | `move` deletes and creates the tag (nothing when it already points there). A protected tag needs a role allowed to create it. |
| Projects (v2) board, Status field | Issue boards whose lists are labels; work-item Status (Premium, GraphQL only) | No `board` capability: a board with one label list per state label follows the flow with no write, because the state labels are the record. The work-item Status field has no REST endpoint, so it is not set; `tracker.project` (a GitHub board) needs a GitHub repository. |
| Webhooks (HMAC signature) | Project webhooks (`X-Gitlab-Token` secret token) | `src/adapters/hooks-gitlab.ts` (`sync.webhooks`, docs/configuration.md); registering the hook needs Maintainer. |
| Rate limit (403/429, `x-ratelimit-*`) | 429 with `Retry-After` (and `RateLimit-*`) | A `Retry-After` of up to 2 seconds is waited out once; a longer one is `503 rate_limited` (`GitLab is rate-limiting this token for <call>; try again in N seconds.`). The GitHub adapter does the same. |
| Link-header pages | Offset pages (`x-next-page`); keyset pages on a few endpoints | Every list follows `x-next-page` at 100 per page; merge request diffs stop at 3000 files like GitHub's. |

Endpoints the adapter calls (all under `/api/v4`): `GET/POST /projects/:id/issues`,
`GET/PUT /projects/:id/issues/:iid`, `GET/POST /projects/:id/issues/:iid/notes`, `GET /users?username=`,
`GET /projects/:id/repository/commits`, `…/commits/:sha`, `…/commits/:sha/diff`, `…/commits/:sha/statuses`,
`GET /projects/:id/repository/merge_base`, `GET/DELETE /projects/:id/repository/branches/:branch`,
`HEAD /projects/:id/repository/files/:path`, `GET /projects/:id/repository/tree`,
`GET/POST /projects/:id/merge_requests`, `GET/PUT /projects/:id/merge_requests/:iid`, `…/:iid/merge`, `…/:iid/diffs`,
`GET /projects/:id/pipelines?sha=`, `GET/DELETE /projects/:id/repository/tags/:tag`,
`POST /projects/:id/repository/tags`, `GET /projects/:id/releases`, and the hooks API for webhooks.

## Token: scopes and role per feature

A project access token (one project, its own bot user; Premium on gitlab.com, any self-managed tier) or a
personal access token, sent as `Authorization: Bearer` (GitLab accepts personal, project and group tokens that way
as well as in `PRIVATE-TOKEN`). Flowee writes issues, so the token needs the **`api`** scope: `read_api` is read-only
and there is no narrower write scope. What the scope may do is then limited by the token's **role** in the
project (https://docs.gitlab.com/user/permissions/):

| Feature | Calls | Role |
|---|---|---|
| base flow | read, file, label, assign, close and reopen issues; notes; commits and merge bases | **Planner** (edit issues, close, labels; Reporter works too) |
| `pullRequests` | branch heads, open and update merge requests, pipelines and statuses, merge, delete the branch | **Developer** (create merge requests, delete non-protected branches, view commit status); merging into a protected target branch needs a role it allows to merge (default **Maintainer**) |
| `releases` | the latest release, read a tag | **Planner** (view releases) |
| `releases.testedTag` | delete and create the tag | **Developer** (create and delete tags); a protected tag: a role allowed to create it |
| `releases.checks` | pipelines and statuses of main's commits | **Reporter** (view commit status) |
| `samples`, `uiReview` | files on main, a commit's diff | **Planner** (read the repository) |
| `dependencyTickets` | list open merge requests, read one, file a ticket | **Planner** |
| webhooks (`sync.webhooks`) | create, update, read and delete the project hook | **Maintainer** |

So: a trunk workspace needs `api` + Planner; a pr-release workspace with merges by the flow needs `api` +
Maintainer on a protected main (or Developer with "Allowed to merge: Developers + Maintainers").

## What is not supported, and why

- **Board column writes.** No `board` capability on GitLab (see the table): the label lists already follow the
  state, and the work-item Status field exists only in GraphQL (Premium). A workspace is not refused for this:
  states with a `meta.status` simply set nothing on GitLab.
- **Approvals, auto-merge and merge trains** are GitLab's to enforce; Flowee does not approve or queue. A merge
  GitLab will not do now is `409 not_mergeable`, and nothing in the flow changes.
- **Close reasons.** GitLab's REST API closes without a reason; `not_planned` and `completed` look the same there.
- **Several assignees** need GitLab Premium; on Free the flow assigns only one owner anyway.
- **The wizard** (managed mode) asks for GitHub repositories today; GitLab workspaces come as a document
  (`bun run validate`, then import or deploy). The GitLab link reader is `TRACKERS.gitlab.parseRepo(api)`.

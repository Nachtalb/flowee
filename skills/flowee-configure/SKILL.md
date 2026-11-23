---
name: flowee-configure
description: "Use when writing a Flowee config. Spec, validate, submit."
---

# Flowee: write a workspace configuration

Turn a description of a project into one complete, valid Flowee **workspace document** (JSON) that the user only has
to submit. The full specification is in `references/`:

| File | Holds |
|---|---|
| `references/fields.md` | every field of the workspace and the instance document: type, default, allowed values; secrets; invalid combinations |
| `references/features.md` | the flow presets, the six feature switches and every option, what each adds, the token permission each needs |
| `references/statecharts.md` | writing or changing a flow: states, events, guards, actions, `meta`, feature tags, options; the guard and action catalogue |
| `references/examples.md` | complete documents: a trunk project, pull requests + releases, several repositories, a group topic with its own bot, a custom flow, a managed instance |

## Rules

- **Ask only what the description cannot answer**: the repositories (`owner/name`), whether pull requests and
  releases are used (branching, versioning), how many developers, who the owner is (tracker login, Telegram user id), where the cards go.
  Default the rest from `references/fields.md`; a field at its default is left out.
- **Never put a secret in the document.** Every secret is a NAME matching `^[A-Z][A-Z0-9_]*$` (`ACME_GITHUB_TOKEN`).
  The values are set separately (`wrangler secret put`, the chat wizard, or `PUT /admin/workspaces/<id>/secrets`).
  An exported or shared document is therefore safe to paste anywhere. Use one prefix per workspace so names never
  collide on a shared instance.
- **Choose branching, versioning, more options** (`references/features.md`): Single branch (`pullRequests` off) or
  Feature branches (`pullRequests` on); Versioning (`releases`) with either; the other switches on their own. Name
  the starting point that matches (`trunk` or `pr-release`, the same chart) and write every switch in `features`.
  Write an inline statechart only when no preset plus switches fits (`references/statecharts.md`); it is long and
  every rule of the loader applies.
- **One role instance per agent**, with the flow's owner role always present (`{"instance": "owner", "role":
  "owner", …}`): without it the owner cannot answer through the API. The `sampler` role exists only with
  `features.samples`.
- **Name the tracker.** `tracker.type` is `github` (default) or `gitlab`; a repository on the other one gives its
  own `type`, `token` (required then) and, for self-managed GitLab or GitHub Enterprise, `api`. GitLab paths may be
  nested (`group/subgroup/project`); `tracker.project` (a GitHub board) needs a GitHub repository. What differs on
  GitLab (merge requests, pipelines as checks, tags moved by delete + create, no board writes): docs/gitlab.md.
- **A repository belongs to one workspace per instance.** Several repositories of one project go into one
  workspace (`tracker.repos`, tickets become `alias#n`), never into two.
- **Validate before handing over** (below). Hand over only a document that printed `ok`.

## Validate

In a clone of the Flowee repository (`git clone https://github.com/Nachtalb/flowee && cd flowee && bun install`):

```sh
bun run validate path/to/workspace.json   # also takes an instance document {"flowee": 1, "workspaces": [...]}
```

It runs the Worker's own validator. Output: `ok <file>: <ids>` and exit 0, or one problem per line, each one
sentence starting with its JSON path (`$.features.uiReview: name at least one of paths, addedFiles or addedLines.`), exit 1;
exit 2 when the file is no JSON. Fix every line and run it again. Without bun: the JSON Schema
`schema/workspace.schema.json` checks the shape only, not the cross-field rules.

Without a clone, against the instance that will run it (its own version; no token, nothing stored):

```sh
curl -fsS -H 'content-type: application/json' --data @workspace.json https://<instance>/validate
```

`{"ok": true, "kind": "workspace", "ids": ["acme"]}`, or `400` with the same sentences in `problems`
([docs/api.md](../../docs/api.md), "Public material and validation").

## How the user submits it

| Instance mode | Submit | Then |
|---|---|---|
| managed, in the chat | send the `.json` file to the instance bot in a private chat (or `/import`, then paste it) | the bot lists what it will create or replace; it asks only what is missing (the own bot when `chat.managed` is set and none exists yet, the GitHub token), then hands over the agents' secrets once |
| managed, over HTTP | `PUT /admin/workspaces/<id>` with the document, `Authorization: Bearer <FLOWEE_ADMIN_TOKEN>` | the answer lists `missing` secret names; `PUT /admin/workspaces/<id>/secrets` with `{"NAME": "value"}` (an agent's secret is given as the secret, only its SHA-256 is stored) |
| standalone | put it in `flowee.config.local.json` (git-ignored; `{"flowee": 1, "workspaces": [<doc>]}`) | `wrangler secret put` each name, `bun run deploy` (skill `flowee-install`) |

A document imported in the chat gets the workspace's own secret slot names (`W_<ID>_TRACKER`, `W_<ID>_BOT`,
`W_<ID>_HOOK`, `W_<ID>_<INSTANCE>`), whatever it named; the admin API keeps the names given.

When the chat id or topic id is unknown, leave `chat` out: the workspace runs API-only and the owner binds it later
in the chat (`/workspaces` → the workspace → ✏️ Where tickets appear → 👥 In a group, then 👥 Choose a group, or `/bind <id>` inside the topic).

## Pitfalls

- `chat` needs at least one `owners[].chat`; `files` needs `chat`; `profile` needs `chat.publicUrl`.
- In a standalone instance every workspace with a chat names the SAME `chat.token` and `chat.webhookSecret` (one
  bot); give `chat.publicUrl` in one workspace only.
- `roles[].secret` names the secret that holds the SHA-256 hex of the agent's API secret, never the secret itself.
- `features.releases.source: "tag"` needs `releases.tag`; `testedTag` must differ from `tag`.
- `features.uiReview` needs at least one of `paths`, `addedFiles`, `addedLines`.
- A GitHub Projects board (`tracker.project`) needs a classic token with `repo` + `project`: a fine-grained token
  cannot write a user-owned project. Leave `project` out for a narrow token.
- Two workspaces may not bind the same chat and topic, or share a repository, on one instance.

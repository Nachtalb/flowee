# Complete examples

Every block below is a complete document that `bun run validate` accepts (a test in the Flowee repository checks
each one). Copy the nearest, then change ids, repositories, people and secret names.

## 1. A trunk project: one repository, a private chat, a project board

Commits go straight to `main`; two developers; the owner's cards come to their private chat with the bot; files
the owner sends are uploaded to a paste service; a GitHub Projects board follows the states (this needs a classic
token with `repo` + `project`); the digest arrives between 08:00 and 11:00 Berlin time.

```json
{
  "flowee": 1,
  "id": "shop",
  "name": "Shop",
  "flow": { "preset": "trunk" },
  "tracker": {
    "type": "github",
    "repos": ["acme/shop"],
    "mainBranch": "main",
    "token": "SHOP_GITHUB_TOKEN",
    "project": { "owner": "ann", "number": 3 }
  },
  "roles": [
    { "instance": "board", "role": "board", "secret": "SHOP_BOARD" },
    { "instance": "dev1", "role": "developer", "secret": "SHOP_DEV1" },
    { "instance": "dev2", "role": "developer", "secret": "SHOP_DEV2" },
    { "instance": "tester", "role": "tester", "secret": "SHOP_TESTER" },
    { "instance": "owner", "role": "owner", "secret": "SHOP_OWNER" }
  ],
  "owners": [{ "name": "Ann", "tracker": "ann", "chat": "123456789" }],
  "chat": {
    "type": "telegram",
    "token": "TELEGRAM_BOT_TOKEN",
    "webhookSecret": "TG_WEBHOOK_SECRET",
    "username": "ShopEnvoyBot",
    "chatId": "123456789",
    "publicUrl": "https://flowee.acme.workers.dev"
  },
  "files": { "url": "https://paste.acme.example/", "token": "PASTE_TOKEN", "expire": "30d" },
  "texts": { "owner": "Ann", "cardHeading": "For Ann", "botName": "Shop Envoy", "project": "Shop" },
  "schedule": { "timezone": "Europe/Berlin", "digestFrom": 8, "digestTo": 11 },
  "profile": { "photo": "https://acme.example/shop-bot.png" }
}
```

## 2. Pull requests and releases

A branch `ticket/<n>` and a pull request per ticket with the checks `build` and `test` green before hand-off; the
tester's `pass` squash-merges it; test cards wait until a published GitHub release contains the ticket; a `tested`
tag moves forward over green commits; a pass that touches the UI goes past the owner; one ticket per Dependabot
pull request.

```json
{
  "flowee": 1,
  "id": "viewer",
  "name": "Viewer app",
  "flow": { "preset": "pr-release" },
  "features": {
    "pullRequests": { "branch": "ticket/{n}", "checks": ["build", "test"], "method": "squash", "merger": "flow", "deleteBranch": true },
    "releases": { "source": "release", "testedTag": "tested", "checks": ["build"], "skip": ["docs", "chore", "test"], "hold": true, "versionLine": true },
    "uiReview": { "paths": ["**/ui/**"], "addedFiles": ["**/views/**"], "addedLines": ["@Composable"], "ignore": ["**/test/**"] },
    "dependencyTickets": { "authors": ["dependabot[bot]"], "labels": ["dependencies"] }
  },
  "tracker": { "type": "github", "repos": ["acme/viewer"], "token": "VIEWER_GITHUB_TOKEN" },
  "roles": [
    { "instance": "board", "role": "board", "secret": "VIEWER_BOARD" },
    { "instance": "dev1", "role": "developer", "secret": "VIEWER_DEV1" },
    { "instance": "tester", "role": "tester", "secret": "VIEWER_TESTER" },
    { "instance": "owner", "role": "owner", "secret": "VIEWER_OWNER" }
  ],
  "owners": [{ "name": "Ann", "tracker": "ann", "chat": "123456789" }],
  "chat": { "type": "telegram", "token": "TELEGRAM_BOT_TOKEN", "webhookSecret": "TG_WEBHOOK_SECRET", "chatId": "123456789" }
}
```

## 3. Several repositories, one flow

Tickets are `web#12`, `api#7`, `sdk#3`. The API server's main branch is `master`; the SDK lives under another owner
and has its own token. Pull requests on with the defaults; releases without holding test cards; reports labelled
`user-report` go to the board only. Two owners answer in a group chat.

```json
{
  "flowee": 1,
  "id": "platform",
  "flow": { "preset": "pr-release" },
  "features": { "pullRequests": true, "releases": { "hold": false }, "untrustedReports": { "label": "user-report", "role": "board" } },
  "tracker": {
    "type": "github",
    "token": "PLATFORM_GITHUB_TOKEN",
    "repos": [
      { "repo": "acme/web", "alias": "web" },
      { "repo": "acme/api-server", "alias": "api", "mainBranch": "master" },
      { "repo": "partner/sdk", "alias": "sdk", "token": "PLATFORM_SDK_TOKEN" }
    ]
  },
  "roles": [
    { "instance": "board", "role": "board", "secret": "PLATFORM_BOARD" },
    { "instance": "dev1", "role": "developer", "secret": "PLATFORM_DEV1" },
    { "instance": "dev2", "role": "developer", "secret": "PLATFORM_DEV2" },
    { "instance": "tester", "role": "tester", "secret": "PLATFORM_TESTER" },
    { "instance": "owner", "role": "owner", "secret": "PLATFORM_OWNER" }
  ],
  "owners": [{ "name": "Ann", "tracker": "ann", "chat": "123456789" }, { "name": "Bo", "chat": "987654321" }],
  "chat": { "type": "telegram", "token": "TELEGRAM_BOT_TOKEN", "webhookSecret": "TG_WEBHOOK_SECRET", "chatId": "-1001234567890" }
}
```

## 4. One topic of a group, with the workspace's own bot (managed mode)

The cards go to topic 42 of a forum group, sent by a bot made just for this workspace (`chat.managed`). A sampler
finds real sample files before development; developers merge their own pull requests. The secret names are the
slots the chat import would give the workspace `game` anyway. Submit it to the instance bot: it creates the own bot
(the user taps one button), asks for the GitHub token and hands over the five agents' secrets. Then add the new bot to the group.

```json
{
  "flowee": 1,
  "id": "game",
  "name": "Game",
  "flow": { "preset": "pr-release" },
  "features": { "samples": { "root": "Samples/", "notNeededLabel": "no sample" }, "pullRequests": { "merger": "developer" } },
  "tracker": { "type": "github", "repos": ["acme/game"], "token": "W_GAME_TRACKER" },
  "roles": [
    { "instance": "board", "role": "board", "secret": "W_GAME_BOARD" },
    { "instance": "dev1", "role": "developer", "secret": "W_GAME_DEV1" },
    { "instance": "tester", "role": "tester", "secret": "W_GAME_TESTER" },
    { "instance": "sampler", "role": "sampler", "secret": "W_GAME_SAMPLER" },
    { "instance": "owner", "role": "owner", "secret": "W_GAME_OWNER" }
  ],
  "owners": [{ "name": "Ann", "tracker": "ann", "chat": "123456789" }],
  "chat": {
    "type": "telegram",
    "token": "W_GAME_BOT",
    "webhookSecret": "W_GAME_HOOK",
    "chatId": "-1001234567890",
    "topicId": 42,
    "managed": true,
    "publicUrl": "https://flowee.acme.workers.dev"
  },
  "texts": { "botName": "Game Envoy", "project": "Game" }
}
```

Group and topic ids are hard to find by hand. When they are unknown, leave `chat` out, submit, and bind later:
`/workspaces` → the workspace → ✏️ Where tickets appear → 👥 In a group → `/bind game` sent inside the topic.

## 5. A custom flow

A small flow of its own: workers take `todo` tickets, hand them off with a commit on `main`, the owner approves or
sends them back. Two roles, four states; the owner answers through the API (no chat).

```json
{
  "flowee": 1,
  "id": "notes",
  "name": "Notes site",
  "flow": {
    "chart": {
      "id": "lite",
      "initial": "todo",
      "states": {
        "todo": {
          "meta": { "label": "todo", "claimable": { "role": "worker", "rank": 1 } },
          "on": {
            "next": { "target": "doing", "guard": { "type": "roleIs", "params": { "roles": ["worker"] } }, "actions": ["setLabel", "claim"] },
            "answer": { "actions": [{ "type": "comment", "params": { "field": "text" } }, "recordAnswer"] }
          }
        },
        "doing": {
          "meta": { "label": "doing", "holder": "worker" },
          "on": {
            "heartbeat": { "guard": "holdsClaim", "actions": ["touchClaim"] },
            "handoff": {
              "target": "owner review",
              "guard": { "type": "all", "params": { "guards": ["holdsClaim", "commitsOnMain"] } },
              "actions": [{ "type": "comment", "params": { "append": "\n\nCommits: {commits}" } }, "setLabel", "releaseClaim", "recordHanded"]
            },
            "expire": { "target": "todo", "actions": [{ "type": "comment", "params": { "text": "The claim of {claim} expired after {lease} h." } }, "setLabel", "releaseClaim"] },
            "answer": { "actions": [{ "type": "comment", "params": { "field": "text" } }, "recordAnswer"] }
          }
        },
        "owner review": {
          "meta": { "label": "owner review", "inbox": true, "assignOwner": true },
          "on": {
            "approve": { "target": "done", "actions": ["comment", { "type": "setLabel", "params": { "reason": "completed" } }, "dropInboxCard"] },
            "rework": { "target": "todo", "actions": ["comment", "setLabel", "dropInboxCard"] },
            "answer": { "target": "todo", "actions": [{ "type": "comment", "params": { "field": "text" } }, "recordAnswer", "setLabel", "dropInboxCard"] }
          }
        },
        "done": {
          "meta": { "closed": true },
          "on": { "answer": { "target": "todo", "actions": [{ "type": "comment", "params": { "field": "text" } }, "recordAnswer", "setLabel"] } }
        }
      }
    },
    "options": {
      "roles": { "worker": { "sign": "Worker", "who": "a worker" }, "owner": { "sign": "{owner}", "who": "the owner" } },
      "commands": {
        "whoami": { "roles": ["worker", "owner"], "read": true },
        "queue": { "roles": ["worker", "owner"], "read": true },
        "show": { "roles": ["worker", "owner"], "read": true },
        "next": { "roles": ["worker"] },
        "file": { "roles": ["worker", "owner"] },
        "heartbeat": { "roles": ["worker"], "state": false },
        "handoff": { "roles": ["worker"], "input": { "comment": "required" } },
        "approve": { "roles": ["owner"], "input": { "comment": "optional" } },
        "rework": { "roles": ["owner"], "input": { "comment": "required" } },
        "answer": { "roles": ["owner"], "input": { "text": "text" } }
      },
      "leaseHours": 3,
      "reaper": { "event": "expire", "role": "worker" },
      "inboxRoles": ["owner"],
      "commitSuffix": " (#{n})",
      "ownerRole": "owner"
    }
  },
  "tracker": { "type": "github", "repos": ["acme/notes"], "token": "NOTES_GITHUB_TOKEN" },
  "roles": [
    { "instance": "worker1", "role": "worker", "secret": "NOTES_WORKER1" },
    { "instance": "owner", "role": "owner", "secret": "NOTES_OWNER" }
  ],
  "owners": [{ "name": "Ann", "tracker": "ann" }]
}
```

## 6. A managed instance

The instance document of a managed deployment (`flowee.config.local.json`, which `bun run deploy` uploads as the
`FLOWEE_CONFIG` secret; its `instance` section makes the deployment managed). Workspaces are created in the chat, so the list starts empty.

```json
{
  "flowee": 1,
  "instance": {
    "bot": { "token": "TELEGRAM_BOT_TOKEN", "webhookSecret": "TG_WEBHOOK_SECRET", "username": "AcmeFloweeBot" },
    "publicUrl": "https://flowee.acme.workers.dev",
    "owner": "123456789",
    "creators": ["123456789", "987654321"],
    "limits": { "workspacesPerUser": 3 },
    "profile": { "name": "Acme Flowee", "description": "Ticket flow for AI agent teams; set up a workspace with /setup.", "shortDescription": "Ticket flow for AI agent teams.", "photo": "https://acme.example/flowee.png" },
    "trackerApi": "https://api.github.com"
  },
  "workspaces": []
}
```

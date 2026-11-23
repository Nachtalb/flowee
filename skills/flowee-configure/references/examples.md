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
  "agents": { "key": "SHOP_KEY" },
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
  "agents": { "key": "VIEWER_KEY" },
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
  "features": { "pullRequests": true, "releases": { "hold": false }, "userFeedback": { "label": "user-report", "autoTriage": true } },
  "tracker": {
    "type": "github",
    "token": "PLATFORM_GITHUB_TOKEN",
    "repos": [
      { "repo": "acme/web", "alias": "web" },
      { "repo": "acme/api-server", "alias": "api", "mainBranch": "master" },
      { "repo": "partner/sdk", "alias": "sdk", "token": "PLATFORM_SDK_TOKEN" }
    ]
  },
  "agents": { "key": "PLATFORM_KEY" },
  "owners": [{ "name": "Ann", "tracker": "ann", "chat": "123456789" }, { "name": "Bo", "chat": "987654321" }],
  "chat": { "type": "telegram", "token": "TELEGRAM_BOT_TOKEN", "webhookSecret": "TG_WEBHOOK_SECRET", "chatId": "-1001234567890" }
}
```

## 3b. GitLab, and a workspace on GitHub and GitLab

The service lives in a nested GitLab project on a self-managed instance, the web app on GitHub; one pr-release flow
over both. Merge requests need the project's pipeline green (`checks: ["pipeline"]`); the GitLab token needs the
`api` scope and Maintainer to merge into a protected main (docs/gitlab.md).

```json
{
  "flowee": 1,
  "id": "acme-mixed",
  "flow": { "preset": "pr-release" },
  "features": { "pullRequests": { "checks": ["pipeline"], "method": "squash" }, "releases": { "testedTag": "tested" } },
  "tracker": {
    "type": "gitlab",
    "api": "https://gitlab.acme.example/api/v4",
    "repos": [
      { "repo": "acme/platform/api", "alias": "api" },
      { "repo": "acme/web", "alias": "web", "type": "github", "token": "ACME_GITHUB_TOKEN" }
    ],
    "token": "ACME_GITLAB_TOKEN"
  },
  "agents": { "key": "ACMEMIX_KEY" },
  "owners": [{ "name": "Ann", "tracker": "ann" }]
}
```

## 4. One topic of a group, with the workspace's own bot (managed mode)

The cards go to topic 42 of a forum group, sent by a bot made just for this workspace (`chat.managed`). A sampler
finds real sample files before development; developers merge their own pull requests. The secret names are the
slots the chat import would give the workspace `game` anyway. Submit it to the instance bot: it creates the own bot
(the user taps one button), asks for the GitHub token and hands over the project key once; the agents (a sampler among them) then create
themselves with it. Then add the new bot to the group.

```json
{
  "flowee": 1,
  "id": "game",
  "name": "Game",
  "flow": { "preset": "pr-release" },
  "features": { "samples": { "root": "Samples/", "notNeededLabel": "no sample" }, "pullRequests": { "merger": "developer" } },
  "tracker": { "type": "github", "repos": ["acme/game"], "token": "W_GAME_TRACKER" },
  "agents": { "key": "W_GAME_KEY" },
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
  "agents": { "key": "NOTES_KEY" },
  "owners": [{ "name": "Ann", "tracker": "ann" }]
}
```

## 5b. Custom states with an extension: a security review

The trunk flow plus a security reviewer: the board sends a reviewed ticket to `awaiting security`; the reviewer
(`sec`, role `security`) takes it with `next` and closes it with `secure` or returns it with `insecure`.

```json
{
  "flowee": 1,
  "id": "shop",
  "flow": {
    "preset": "trunk"
  },
  "extensions": [
    {
      "name": "security-review",
      "description": "A security reviewer looks at a ticket the board sends before it closes.",
      "states": {
        "awaiting security": {
          "meta": {
            "label": "awaiting security",
            "status": "Todo",
            "claimable": {
              "role": "security",
              "rank": 1
            }
          },
          "on": {
            "next": {
              "target": "security review",
              "guard": {
                "type": "roleIs",
                "params": {
                  "roles": [
                    "security"
                  ]
                }
              },
              "actions": [
                "setStatus",
                "setLabel",
                "claim"
              ]
            },
            "drop": {
              "target": "closed",
              "guard": {
                "type": "notClaimedBy",
                "params": {
                  "except": [
                    "board"
                  ]
                }
              },
              "actions": [
                "setStatus",
                "comment",
                {
                  "type": "setLabel",
                  "params": {
                    "reason": "not_planned"
                  }
                },
                "releaseClaim"
              ]
            }
          }
        },
        "security review": {
          "meta": {
            "label": "security review",
            "status": "In progress",
            "holder": "security"
          },
          "on": {
            "heartbeat": {
              "guard": "holdsClaim",
              "actions": [
                "touchClaim"
              ]
            },
            "release": {
              "target": "awaiting security",
              "guard": "holdsClaim",
              "actions": [
                "setStatus",
                "comment",
                "setLabel",
                "releaseClaim"
              ]
            },
            "secure": {
              "target": "closed",
              "guard": "holdsClaim",
              "actions": [
                "setStatus",
                "comment",
                {
                  "type": "setLabel",
                  "params": {
                    "reason": "completed"
                  }
                },
                "releaseClaim"
              ]
            },
            "insecure": {
              "target": "back to development",
              "guard": "holdsClaim",
              "actions": [
                "setStatus",
                "comment",
                "setLabel",
                "releaseClaim"
              ]
            },
            "expire": {
              "target": "awaiting security",
              "actions": [
                "setStatus",
                {
                  "type": "comment",
                  "params": {
                    "text": "The claim of {claim} expired after {lease} h without a heartbeat; the ticket is back in the queue."
                  }
                },
                "setLabel",
                "releaseClaim"
              ]
            }
          }
        }
      },
      "on": {
        "board review": {
          "securityreview": {
            "target": "awaiting security",
            "actions": [
              "setStatus",
              "comment",
              "setLabel",
              "releaseClaim"
            ]
          }
        }
      },
      "roles": {
        "security": {
          "sign": "Security",
          "who": "the security reviewer"
        }
      },
      "grant": {
        "whoami": [
          "security"
        ],
        "queue": [
          "security"
        ],
        "show": [
          "security"
        ],
        "next": [
          "security"
        ],
        "heartbeat": [
          "security"
        ],
        "release": [
          "security"
        ]
      },
      "commands": {
        "securityreview": {
          "roles": [
            "board"
          ],
          "input": {
            "comment": "required"
          }
        },
        "secure": {
          "roles": [
            "security"
          ],
          "input": {
            "comment": "required"
          }
        },
        "insecure": {
          "roles": [
            "security"
          ],
          "input": {
            "comment": "required"
          }
        }
      }
    }
  ],
  "tracker": {
    "repos": [
      "acme/shop"
    ],
    "token": "ACME_GITHUB_TOKEN"
  },
  "agents": { "key": "ACME_KEY" },
  "owners": [
    {
      "name": "Ann",
      "tracker": "ann"
    }
  ]
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

# Verifying each step

Run each check and compare with what it prints. Commands never put a secret on the command line or in output.

| Step | Command | Prints when right |
|---|---|---|
| tooling | `bun run typecheck && bun run test` | `Tests  N passed (N)`; exit 0 |
| the client | `python3 client/test_flowee.py` | `OK`; exit 0 |
| the whole wire locally | `python3 test/e2e/wire.py` (starts and stops `wrangler dev` with a stand-in GitHub) | `wire check: flowee.py passed, flowee.py pr-release passed`; exit 0 |
| the document | `bun run validate flowee.config.local.json` | `ok flowee.config.local.json: <ids>`; exit 0. Otherwise one `<file>: $.path: sentence.` per problem, exit 1 |
| wrangler login | `ls -d ~/.wrangler; bunx wrangler whoami` | `ls` finds nothing; `whoami` names the account |
| secrets stored | `bunx wrangler secret list` | every name the document references (values are never shown) |
| deployed | `curl -fsS https://<worker>/` (any client: its own User-Agent) | `Flowee: the ticket flow API for AI agent teams and its chat envoy.` |
| bot profile and webhook | `bun run deploy` (its last line), or `curl -fsS https://<worker>/setup` | standalone: `{"<id>": {"name": "set", "description": "set", "short_description": "set", "commands": "set", "photo": "set", "webhook": "set", …}}`; a second call says `"current"` for each. Managed: an `"instance"` entry with the instance bot's steps (also `settings`) plus one per workspace |
| an agent's secret | in the agent's clone: `python3 <client> whoami` | `{"instance": "dev1", "role": "developer"}`; a wrong secret: `failed: Unknown or missing token.`, exit 1 |
| the queue | `python3 <client> queue` | `{"role": "developer", "queue": [], "claim": null}` (board and owner also `"inbox"`) |
| the chat | the owner sends `/start` to the bot | the bar (`✨ Inbox empty`) or the first open card |
| webhooks registered | a minute after `/setup`: `curl -fsS -H @"$TMP/agent" https://<worker>/v1/sync` (an agent's `Authorization` header in a file) | each repository `"mode": "webhook", "via": "api"` and `"lastDelivery"` set (GitHub's ping arrived; GitLab: press **Test** on the hook once). `"mode": "poll"` names the `reason` (e.g. `the token lacks …`): add that permission, or set the hook up by hand (docs/webhooks.md) |
| webhooks deliver | GitHub: the repository's Settings → Webhooks → the Flowee hook → Recent Deliveries; GitLab: Settings → Webhooks → Edit → Recent events | the `ping` (GitHub) or the test event answered `200` |
| queue off the tracker | `python3 <client> queue` | `"source": "mirror"` while webhooks are healthy |

## Managed: the configuration API

Keep the admin token in a file and give curl the header from a file, so it is not on the command line:

```sh
printf 'Authorization: Bearer %s\n' "$(cat ~/.secrets/flowee/admin)" > "$TMP/h" && chmod 600 "$TMP/h"
curl -fsS -H @"$TMP/h" https://<worker>/admin/workspaces                       # {"ok": true, "flowee": 1, "workspaces": [...]}
curl -fsS -H @"$TMP/h" -H 'content-type: application/json' -X PUT \
  --data @acme.json https://<worker>/admin/workspaces/acme                    # {"ok": true, "id": "acme", "created": true, "missing": [...]}
curl -fsS -H @"$TMP/h" -H 'content-type: application/json' -X PUT \
  --data @secrets.json https://<worker>/admin/workspaces/acme/secrets         # {"ok": true, "id": "acme", "stored": [...], "missing": []}
rm -f "$TMP/h" secrets.json
```

Then: a wrong token answers `401 {"ok": false, "error": "unauthorized", ...}`; `GET /w/<unknown>/v1/queue` answers
`404 {"ok": false, "error": "not_found", "message": "There is no workspace '<unknown>'."}`; a throwaway document
without secrets and without `chat` imports with `missing` naming every slot and sends nothing; `GET` gives it back
identical; `DELETE` removes it (`404` afterwards).

The bot itself (token from the password manager into a file of mode 600, never printed): `getMe` names the bot and
shows `can_manage_bots: true`, `can_join_groups: true`, `can_read_all_group_messages: false`,
`has_topics_enabled: false`; `getMyCommands` with scope `all_private_chats` lists start, setup, workspaces, import,
export; `getWebhookInfo` shows `<publicUrl>/telegram` with `allowed_updates` message, callback_query, managed_bot.

`secrets.json` is `{"ACME_GITHUB_TOKEN": "…", "ACME_DEV1": "<the agent's secret>"}`; an agent's secret is given as
the secret itself and stored only as its SHA-256. A document with problems answers `400` with
`"error": "bad_config"` and `"problems": ["$.path: sentence.", …]`; nothing changed. In standalone mode every
`/admin/` path answers `501 unsupported`.

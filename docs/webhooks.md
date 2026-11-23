# Webhooks: the tracker tells Flowee what changed

Without webhooks Flowee asks the tracker every minute for every open ticket (the envoy's sync, the housekeeping),
and every agent's `queue` lists them again. Almost all of those calls find nothing new. With webhooks the tracker
sends a short signed message (a delivery) when something changes, and Flowee re-reads only what that message names.
The tracker stays the record: a delivery is a hint that something changed, never the reason for a transition. Every
command (`next`, `handoff`, `pass`, …) still reads the ticket from the tracker before it decides.

`sync.webhooks` (docs/configuration.md) is `auto` by default: nothing to set up when the token may manage webhooks.

## How it works

1. **Registration.** The first scheduled pass after a workspace is created, imported or its `sync` options or
   repositories change, Flowee generates a random secret per repository (32 bytes, stored sealed with `FLOWEE_KEY`
   in the workspace's Durable Object, never in a document or an export) and registers the repository's webhook
   through the tracker's API: `POST /repos/{owner}/{repo}/hooks` (GitHub) or `POST /projects/:id/hooks` (GitLab),
   or updates the one already there for the same address. The address is
   `<public URL>/hooks/<workspace>/<repository alias>`. The public URL is `instance.publicUrl` (managed), else the
   origin the deploy called `/setup` on, else `chat.publicUrl`.
2. **A delivery.** `POST /hooks/<workspace>/<alias>` is open to anyone; the workspace's Durable Object checks the
   tracker's proof against the repository's secret (GitHub: HMAC SHA-256 of the raw body in `X-Hub-Signature-256`,
   verified with WebCrypto's constant-time `verify`; GitLab: `X-Gitlab-Token`, compared through digests in constant
   time). Wrong or missing proof, an unknown workspace or alias: `401` with an empty body. A delivery id seen before
   (GitHub `X-GitHub-Delivery`, GitLab `Idempotency-Key` / `webhook-id`, kept 7 days) answers `200` and does nothing,
   so the tracker's redeliveries and retries are harmless. The events are queued in the workspace's store and the
   response returns at once; the workspace's alarm does the work, serialised with every command (the workspace lock).
   A paused workspace (managed mode) acknowledges every delivery with `200` and ignores it.
3. **Targeted work.** Each queued event becomes the work that concerns it (below), and the envoy's minute (inbox,
   queued cards, menu counts) runs once after the batch, from the mirror.
4. **The mirror.** Flowee keeps its own copy of the open tickets of each repository, rebuilt by a full listing when a
   repository starts using webhooks, after any gap and on every reconcile, and kept current by re-reading the ticket
   each event names. The agents' `queue` answers from it while the repository's webhook is healthy
   (`"source": "mirror"`); otherwise `queue` reads the tracker (`"source": "tracker"`). `next` and every other
   command always read the tracker.
5. **Reconcile.** With healthy webhooks a full listing runs every `sync.reconcileMinutes` (30) to catch a lost
   delivery, together with the tracker's own report of the hook (GitHub `last_response`, GitLab `alert_status`).

## Events and what each one does

| Event (GitHub / GitLab) | Normalised | Work |
|---|---|---|
| `issues` / `Issue Hook` | ticket changed (labels, state, title, assignees, body) | re-read that ticket into the mirror; the chart's ticks on it (`released`); the envoy: a ticket entering the owner's inbox gets its card (its comments are read once for the card), one leaving it goes; a ticket leaving an untested state moves the `tested` tag (`releases.testedTag`) |
| `issue_comment` / `Note Hook` on an issue | ticket commented | the same for that ticket |
| `push` / `Push Hook` | branch head moved | on the main branch: the `tested` tag (`releases.testedTag`) |
| `create`, `delete`, `push` of a tag / `Tag Push Hook` | tag moved | the ticks of every open ticket of that repository (`releases.source: tag`), the `tested` tag |
| `release` / `Release Hook` | release published | the ticks (a card held in `awaiting release` is released when the release has its code), the `tested` tag |
| `pull_request` / `Merge Request Hook` | pull request opened, updated, merged, closed | opened by a `dependencyTickets` author: the pull request is read once and becomes a ticket |
| `check_suite`, `status` (and `check_run`) / `Pipeline Hook`, `Job Hook` | checks finished for a commit | with `releases.checks`: the `tested` tag |
| `ping` (GitHub sends one when the hook is created) | ping | marks the hook alive |

Events Flowee has no work for (a push to another branch, checks without `releases.checks`, a pull request of
someone else) cost no tracker call. Flowee's own writes come back as deliveries too; each is one re-read.

## Tracker calls (from the counting tests in `test/hooks.test.ts`)

| | before (polling) | with healthy webhooks |
|---|---|---|
| cron, per repository and hour, idle | 60 listings (trunk; more with ticks, dependency tickets, the tested tag) | 2 reconciles × (1 listing + 1 hook status) = 4 |
| an agent's `queue` | 1 listing (each repository) | 0 |
| a ticket event | (seen at the next minute's listing) | 1 (the ticket), +1 (its comments) when it enters the owner's inbox |
| `next` and every command | unchanged | unchanged |

## Health and fallback

A repository is on webhooks while Flowee registered its hook (or the owner did, and a delivery arrived) and nothing
says it is broken. It falls back to polling, exactly as without webhooks (a listing every `sync.pollMinutes`, the
cron every minute; `queue` reads the tracker), when:

- the token may not manage webhooks (the reason names the permission);
- the reconcile finds a change older than two minutes that no delivery brought (deliveries stopped or were lost: the
  tracker cannot reach the Worker, a firewall, an outage);
- the tracker reports the hook failing (GitHub: the last delivery answered something else than 2xx; GitLab: the hook
  is disabled or temporarily disabled) or the hook is gone.

A delivery arriving after at least ten minutes of polling turns webhooks back on and rebuilds the mirror at once.
The owner gets one quiet line in the chat when a repository falls back and one when it is back (docs/envoy.md,
row 54); the first state after setup is not announced, the menu shows it. With `sync.webhooks: required` a
repository never polls: it keeps the reconcile and reports the failure. `off` polls always and removes a hook
Flowee registered.

Where to see it: the management menu's workspace screen (`⚡ Instant updates: on` or `off for <alias> (<reason>)`),
`GET /v1/sync` (any agent of the workspace), and in the managed mode `GET /w/<id>/config` (`sync`).

## Permissions

| Tracker | To register the hook itself | Without it |
|---|---|---|
| GitHub | fine-grained token: repository permission **Webhooks: read and write** (`repository_hooks=write`; the wizard's token link asks for it); classic token: `admin:repo_hook` | the workspace polls; the menu offers the manual setup |
| GitLab | the **Maintainer** role on the project and a token with the `api` scope | the same |

Receiving deliveries needs no permission: only the secret.

## Setting it up by hand

Management menu → the workspace → **⚡ Turn on instant updates**: it names the permission the token lacks (give the
token that permission and Flowee registers the hook itself at the next try, within `sync.reconcileMinutes`), and
offers the manual way per repository: the address and a new secret, **shown once**. Paste them into the repository's
Settings → Webhooks (GitHub: content type `application/json`, "Send me everything" or the events above; GitLab: a
secret token, not a signing token, and the triggers above). Webhooks count as on from the first delivery (GitHub's
ping, GitLab's "Test"). Showing the secret again makes a new one: the old hook stops verifying.

Another front end (or the supervisor) gets the same from the Workspace object: `syncStatus()` and
`manualHook(alias)`, and `instantUpdates(status)` in `src/wizard/manage.ts` gives the line and whether to offer the
button.

## Removing

A hook Flowee registered is removed when the workspace is deleted, when a repository leaves the workspace (managed
mode: the old document's trackers do it) and when `sync.webhooks` becomes `off`. A standalone deployment that drops
a repository from its document leaves that repository's hook in place: remove it in the tracker's settings.

## Scheduled work: alarms and the cron

What has a known due time runs on the workspace's Durable Object alarm, set after every cron pass and alarm run to
the earliest of: queued events (at once), the earliest claim's lease expiry (the reaper), the next reconcile, and the
next full hour (the digest window, pruning). The alarm runs the same pass as the cron without forcing a poll. The
cron stays every minute (`wrangler.toml`): it is what polls the repositories without healthy webhooks, and it is the
safety net that wakes an object whose alarm was never set (a fresh deploy) or failed. For a healthy webhook
workspace its visit makes no tracker call. Trade-off: alarms are per workspace and exact; a cron is one global tick
that reaches every workspace. Making the cron rarer would slow the polling fallback by the same factor.

## Security

- The route is unauthenticated; only the tracker's proof against a per-repository random secret lets a delivery in.
  Nothing in a refusal says why.
- A captured delivery replayed with the same id does nothing. Replayed with a forged id it only queues the same
  hints again: Flowee re-reads the tracker, so a replay can cost calls but cannot change a ticket.
- An event about another repository than the hook's is ignored. Bodies over 5 MB are refused (`413`).
- The secrets are sealed with `FLOWEE_KEY` (AES-GCM) in the workspace's own storage, gone with the workspace.
  A standalone deployment needs the Worker secret `FLOWEE_KEY` for webhooks; without it every repository polls and
  the status says so.

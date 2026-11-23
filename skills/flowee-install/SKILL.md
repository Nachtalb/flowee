---
name: flowee-install
description: "Use when setting Flowee up. Deploy, secrets, clones, verify."
---

# Flowee: install and set up

The procedure is [INSTALL.md](../../INSTALL.md) (repository root; every instance serves it at `<url>/INSTALL.md`).
Follow it literally; this skill only says when and points to the parts.

## When

- "Install / set up / self-host / deploy Flowee", "use Flowee for this project", a Flowee instance URL or a Flowee
  bot's name given to you, a `flowee-<workspace>-key.txt` file handed to you.
- Given an instance URL: read `<url>/` first (that instance's facts: mode, bot, who may create workspaces); it wins
  where it differs from INSTALL.md.

## The order INSTALL.md prescribes

1. Detect what the machine has (container runtimes, Compose, bun, python3, SELinux, the port): section 2.1.
2. Ask every question in ONE message, each with its default; never choose a container runtime for the user when
   more than one is installed: 2.2.
3. The variant's procedure, all setup before the first start: 4 (a hosted instance through its Telegram bot),
   5 (the published image `ghcr.io/nachtalb/flowee` under Docker, Compose, Podman, Quadlet or `wslc`),
   6 (one executable or a clone), 9 (an own Cloudflare deployment).
4. The project side (7) and the checks with what they print (8); report what they printed, not what should happen.

## Where the details are

| What | Where |
|---|---|
| the workspace document | skill [flowee-configure](../flowee-configure/SKILL.md) |
| the client, `.flowee.toml`, clones, the project key, agents, scheduled runs, token permissions | [references/project-setup.md](references/project-setup.md) |
| every check and its expected output (webhooks, the managed configuration API, the bot's profile) | [references/verify.md](references/verify.md) |
| the agents' daily use | skill [flowee-use](../flowee-use/SKILL.md) |
| the self-hosted runtime's settings, data directory, polling or webhooks | [docs/self-hosting.md](../../docs/self-hosting.md) |
| the managed mode and its wizard | [docs/managed.md](../../docs/managed.md) |
| what fails and why | INSTALL.md, section 11 |

These files read the same from a clone and from an instance: every relative link resolves in both.

## Rules (INSTALL.md, section 10, in full)

- Never print a secret, never pass one as an argument or put it in a document; secrets are files of mode 600.
- Validate before the first start or deploy (`flowee validate`, `bun run validate` or `POST <url>/validate`).
- Ask before deploying to the user's Cloudflare account. Never message the user's chat or a real tracker to test:
  `bun run test` and `test/e2e/*.py` use stand-ins.

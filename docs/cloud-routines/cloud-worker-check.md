# Cloud worker daily check, one firing

Read by the "Cloud worker daily check" routine each morning (~08:41 Berlin).
It checks that the board workers (the "Board workers: Claude + Codex" routine
and the Codex runner it starts, see docs/cloud-routines/board-workers.md) are
doing their job, and files one Linear card when they are not. It has no Mac
predecessor; it watches the cloud replacement for the Mac's dispatch loop.

No human is watching. Read-only apart from at most one Linear card. Never
message the owner except through that card, and never change a routine.

## 0. Setup

In /home/user/Broadwayscore: `git fetch origin main '+refs/heads/codex-runner-lock:refs/remotes/origin/codex-runner-lock'`
(retry with backoff; the lock ref may not exist, which is fine).

## 1. Is the routine firing?

Call `list_triggers` (claude-code-remote MCP; load with ToolSearch) and find the
routine whose name starts with "Board workers". Record `enabled`,
`last_fired_at` and `last_run.status`. Unhealthy if it is disabled without an
`ended_reason` a person set, if `last_fired_at` is more than 5 hours old, or if
`last_run.status` is FAILED.

## 2. Is work landing?

    git log origin/main --since='24 hours ago' --oneline | grep -cE 'BRO-[0-9]+'

and the Linear issues completed in the last 24 hours
(`issues(filter: { team: { key: { eq: "BRO" } }, completedAt: { gte: "<24h ago ISO>" } })`
via `scripts/lib/linear-client`). Zero landed card commits AND zero completed
issues in 24 hours while open Todo P0-P2 cards exist is unhealthy.

## 3. Is the Codex lock stuck?

If `origin/codex-runner-lock` exists, read its commit time
(`git log -1 --format=%cI origin/codex-runner-lock`). Older than 4 hours means a
runner died holding it: unhealthy.

## 4. Record

If everything is healthy, make no changes. If anything is unhealthy, first
search for an open card about it
(`node scripts/linear-brain.js find "Board workers unhealthy"`); comment on it if
one exists, otherwise create one:

    node scripts/linear-brain.js create "Board workers unhealthy: <what>" --priority 2 --park "routine health finding" --notes "<evidence: trigger fields, counts, lock age>\n\n## Acceptance criteria\nVERIFY: <safe-form command that shows it healthy>"

## 5. Reply

One line per check (healthy / unhealthy and why), the card URL if one was
filed, then `SAFE TO EXIT`.

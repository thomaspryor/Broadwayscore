---
name: dispatching-session-owns-landing
description: "A session that dispatches child jobs/workspaces owns them until it verifies they landed. CLOSE ME/IDLE needs a LANDED: line per DISPATCHED: ref (backed by a terminal dispatch-ledger row) or an OWNED BY: handoff to a live non-watchdog tab; a fresh watchdog heartbeat is not ownership. Hook Gate O v2, owner escalation 2026-09-16."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 1b8e216e-b214-4b9e-b18a-f2019d09e761
  modified: 2026-09-16T15:22:27.508Z
---

## Rule
If I dispatched anything this session (`linear-next.js --id`, `bsc-next.js --id`, `cmux-launch.js`, `launchCmuxSession`, or I wrote a `DISPATCHED:` line), I own those dispatches until I have verified the landing myself. `THIS SESSION: CLOSE ME` / `IDLE` is invalid until every `DISPATCHED:` ref is covered by one of:

1. `LANDED: <ref> — <the acceptance command I re-ran and what it showed>` in the final message, AND the dispatch ledger (`data/audit/dispatch-ledger.jsonl`) shows that ref's newest row is terminal-and-landed: `job-done` (headless path) or `prune-closed` with ✅ in the tab title (tab path), with no later `job-orphaned` / `job-failed` / `job-stopped-short` / `dead` / `vanished` / re-dispatch row.
2. `OWNED BY: workspace:N ("exact title")` naming a LIVE cmux session that is not the 👑 watchdog dashboard.

Enforced by `~/.claude/hooks/exit-status-gate.sh` Gate O v2 (fixtures: `hooks/tests/exit-status-gate/fixtures/gate-o-v2-*`). The watchdog heartbeat no longer satisfies the gate; the kill switches (`~/.claude/state/dispatch-watchdog-off`, `DISPATCH_WATCHDOG_DISABLED=1`) are unchanged.

## Why
Owner escalation 2026-09-16: "our system can't work as randomly distributed small sessions without an owning session supervising and directing." Two sessions that day each dispatched 3 jobs, wrote `CLOSE ME`, and nobody verified the children landed; the owner: "sick of it." Gate O v1 (2026-08-06) only checked that the dispatch-watchdog heartbeat was fresh, but the watchdog is a narrating dashboard, not an owner, so a fresh heartbeat never proved anyone was supervising.

## How to apply
Supervise in-session (default): end the turn `THIS SESSION: KEEP OPEN`, wait for each ref's terminal ledger row (`grep '"taskId":"linear:BRO-N"' data/audit/dispatch-ledger.jsonl | tail -3`, or the tab pruned with ✅), re-run each card's acceptance command / `VERIFY:` line myself, then write one `LANDED:` line per ref and only then `CLOSE ME`. Detached/headless jobs count exactly the same. If I genuinely cannot stay (owner decision pending elsewhere, out of budget), hand off with `OWNED BY:` to a named live session that has actually taken it, never to the watchdog tab.

Companion rule (folded in from the old index line): never end a turn while a deploy, rebuild, or dispatched workflow is still in progress, see `feedback_always_wait_async.md`.

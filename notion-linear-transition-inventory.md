# Notion → Linear transition inventory — component dispositions

Source: BRO-280 issue body (filed 2026-08-12, "every old-system component has a
disposition"). That document itself was later flagged **incomplete** by its
own author (comment 2026-08-12: "roughly a third of the surface") and
superseded as the execution driver by `sprint-plan-notion-linear-cutover.md`
(owner-approved 2026-08-16, currently mid-flight). This file exists only to
give the four component groups BRO-280's acceptance criteria names — the BSC
Daily email, the two/three intake channels, the ~20 background jobs, and the
session rituals — one explicit, machine-checkable disposition row each, with
the disposition current as of the date below rather than frozen at filing
time. It is not a substitute for the sprint plan and is not re-litigating
scope the sprint plan already owns.

Disposition values used below:
- `migrated` — repointed to Linear, verified in code/live state
- `retired` — deliberately turned off, nothing replaces it
- `carried:BRO-NNN` — work item moved to a named Linear issue, not yet closed
- `pending:BRO-NNN` — not yet actioned, tracked under a named Linear issue
- `keep` — unaffected by the migration, no action needed

Last verified: 2026-08-17/18 (grep/launchctl/Linear API checks run directly,
not copied from the original issue body).

## BSC Daily email

| Component | Disposition | Evidence |
| --- | --- | --- |
| BSC Daily digest email (7:30am, `com.broadwayscore.morning-digest`) | keep | Send logic untouched by design (BRO-280 §3); only the alert rows' link targets change as `dispatchCard()` repoints (done, see Alert router below). launchd job still loaded. |

## Intake channels

| Component | Disposition | Evidence |
| --- | --- | --- |
| Email worker (`~/.claude-email-worker/poll.py`, launchd `com.broadwayscore.claude-email-worker`) | pending:BRO-277 | `grep -li notion ~/.claude-email-worker/poll.py` still matches; `grep -li linear` matches nothing. Not repointed. Carry-over backlog items tracked in BRO-277. |
| Notion action poller (`scripts/notion-action-poll.js`, launchd `com.bwsc.action-dispatcher`) | pending | 52 Notion references (`grep -c -i notion scripts/notion-action-poll.js`); `launchctl list | grep com.bwsc.action-dispatcher` shows it still loaded. Not yet repointed or retired. |
| Alert router `dispatchCard()` (`scripts/lib/owner-alert-router.js`) | migrated | Files a Linear issue via `linear-brain.js`, not `notion-brain.js` (verified: `grep -n "linear-brain.js" scripts/lib/owner-alert-router.js` matches at the `execFileSync` call inside `dispatchCard()`). Tracked BRO-286, state In Review. |

## Background jobs

| Component | Disposition | Evidence |
| --- | --- | --- |
| `com.bwsc.action-dispatcher` (notion-action-poll.js) | pending | See intake channels above — same job. |
| `com.broadwayscore.bsc-reconcile` | pending | Still loaded (`launchctl list`); Notion-writing, not yet rewritten against Linear. |
| `com.broadwayscore.reconcile-dead-completions` | pending | Still loaded; Notion-writing, not yet rewritten. |
| `com.broadwayscore.newsletter-sunday-review` (autonomous-run.js) | retired | Autonomous loop retired 2026-07-27 per `autonomous-loop-schedule` memory; job body is a no-op guard even though the launchd plist is still loaded. |
| `com.broadwayscore.backlog-drain` | pending | Still loaded; Notion-writing, queue now lives in Linear per plan but job not yet retired. |
| `com.broadwayscore.bsc-autoprune` | pending | Still loaded; Notion-writing, not yet retired. |
| `com.broadwayscore.morning-digest` | keep | See BSC Daily email above — 2 Notion refs are link-target only, repointed alongside `dispatchCard()`. |
| `com.broadwayscore.dispatch-watchdog-health` | pending | Currently disarmed via `~/.claude/state/dispatch-watchdog-off`; decision deferred to Phase 3 of the sprint plan. |
| `com.broadwayscore.task-store-archive` | keep | No Notion references; unaffected by the board switch. |
| 16 other unaffected jobs (deploy heartbeat, hook liveness, cookie refresh, opening-night monitor, worktree GC, …) | keep | Bucketed per BRO-280 §4 — none reference Notion; grepping the full launchd job list for `notion` returns only the 9 rows enumerated above. |
| Stale plists (`.bak-20260628`, `.disabled-*`) | pending | Cleanup deferred to Phase 3 per BRO-280 §4 — not yet removed. |

## Session rituals

| Component | Disposition | Evidence |
| --- | --- | --- |
| CLAUDE.md rule 6 ("Notion is the single source of truth") | pending:BRO-266 | Rule 6 text in the live repo CLAUDE.md is unchanged as of this file's last-verified date — still mandates a Notion card at session start. Folded into BRO-266 ("Rules & memory overhaul for the Linear world"), state Backlog. |
| `session-start` skill | pending:BRO-266 | References `bsc-next`/Notion card creation; not yet rewritten. |
| `wrap-up` skill | pending:BRO-266 | References Notion Outcome/close flow; not yet rewritten. |
| `done` skill | pending:BRO-266 | References Notion card update; not yet rewritten. |
| `did-it-work` skill | pending:BRO-266 | References `bsc-next`; not yet rewritten. |
| `ship-check` skill | pending:BRO-266 | References Notion card context; not yet rewritten. |
| `what-else` skill | pending:BRO-266 | References Notion card creation for discoveries; not yet rewritten. |
| `second-opinion` skill | pending:BRO-266 | References Notion card context; not yet rewritten. |
| `notion-sweep` skill | pending:BRO-266 | Entirely Notion-shaped by name; disposition (rewrite vs retire) deferred to BRO-266. |
| `morning-briefing` skill | pending:BRO-266 | References Notion/bsc-next state; not yet rewritten. |
| `triage-feedback` skill | pending:BRO-266 | References Notion card promotion flow; not yet rewritten. |
| 5 repo-scoped skills referencing Notion/`bsc-next` | pending:BRO-266 | Bucketed per BRO-280 §5; individually enumerated when BRO-266 lands. |

## Out of scope for this file (BRO-280's acceptance criteria does not name these individually)

The backlog reconciliation (§1), the "everything else" table (§6: local task
mirror, iOS repo, cmux fleet, Cyrus, Codex, Notion workspace itself), and the
Cyrus evidence (§8) are tracked in the BRO-280 issue's comment history and the
carry-over issues BRO-274 through BRO-279, not re-tabulated here — this file's
job is only the four groups the acceptance criteria names.

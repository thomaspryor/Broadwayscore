# Handoff: BRO-2959 — cmux socket auth outage (shipped, verification tail open)

You own this end-to-end. Everything below is fact from the prior session; verify
independently where it says VERIFY.

## What happened and what shipped

cmux 0.64.22 ran a security migration that set `automation.socketControlMode = "cmuxOnly"`
in `~/.config/cmux/cmux.json` (the only change to that file since Aug 2, alongside
`socketControlPasswordMigrationVersion = 1` in `defaults read com.cmuxterm.app`).
That mode admits ONLY processes whose ancestry is inside cmux, so every launchd-run
automation was denied with:

    ERROR: Access denied - only processes started inside cmux can connect

Three recovery layers died at the same instant and stayed dead ~2h with zero alert:
bsc-reconcile's cmux tab-lane self-heal, bsc-prune (hard-crashed on the uncaught
exception), dispatch-watchdog (fell to degraded report-only).

Fixed in two layers:

1. **Config (non-repo, already applied on this Mac):** `socketControlMode` → `"password"`
   with a generated `socketPassword`. Backup at `~/.config/cmux/cmux.json.bak-20260907-201629`.
   `CMUX_SOCKET_PASSWORD` was also added to 3 LaunchAgent plists
   (com.broadwayscore.bsc-reconcile, .bsc-autoprune, .dispatch-watchdog-health), each
   backed up as `<plist>.bak-20260907-2016`. These plist entries are now REDUNDANT with
   the code fix but harmless — the code prefers an already-set env var.
2. **Code (merged to origin/main):** new `scripts/lib/cmux-socket-auth.js` carries the
   credential at the spawn boundary for all 8 direct cmux spawn sites plus
   `cmux-workspaces.run()`; an error taxonomy (auth-denied / unavailable / timeout /
   not-found / empty / unknown); a 3-attempt retry ladder firing ONLY on auth-denied;
   escalation via routeAlert on the first auth-denied or unclassifiable failure.

## The issue's own premise was WRONG — do not re-adopt it

BRO-2959 claimed ~33% trouble in BOTH lanes. That was an artifact: all 9 `job-orphaned`
tasks were counted in the cmux AND headless columns, because each has both a cmux
`launch` row and a headless `job-spawned` row. `job-orphaned`/`job-retried` are
headless-only (they carry `jobId`); `dead` is tab-lane only. The lanes were never
comparable that way. This correction is recorded on BRO-486 and in the BRO-2959 outcome.

## Commits (all on origin/main)

Nine commits, `git log --oneline --grep="BRO-2959"`. Final one: `0cbac0a1094`
("classifier disagreed with itself on the only shape production uses"), which is
`1de9caae81a` merged. Key files:
`scripts/lib/cmux-socket-auth.js`, `scripts/lib/cmux-workspaces.js`,
`scripts/bsc-reconcile.js`, `scripts/lib/overnight-digest.js`,
`scripts/lib/cmux-launch.js`, `scripts/lib/cmux-terminal-capacity.js`,
`scripts/lib/revive-session.js`, `scripts/message-dispatched-workspace.js`,
`scripts/probe-cmux-launch.js`, plus tests
`scripts/lib/cmux-socket-auth.test.mjs` and `scripts/lib/cmux-run-retry.test.mjs`
(both registered in `tests/unit-test-manifest.txt` — that manifest is an explicit
mapfile list, NOT a glob, so an unregistered colocated test runs nowhere).

## OPEN THREAD 1 — CI has never been confirmed green (the main one)

No CI run containing these commits has ever returned a verdict in-session. THREE
waiters timed out still in progress:
* run 34174030829 (SHA 53814d36a) — 20 min timeout
* run 34174997336 (SHA 8aa747201d6) — 25 min timeout
* run 34175675996 (SHA 3aa3b0cfd) — 25 min timeout
* run 34176204532 (SHA 3aa3b0cfd) — waiter bqu5xq2rz, result never read

This repo's Test Suite genuinely runs longer than 25 min, and main is never idle
(~20 parallel sessions push continuously), so "wait for CI to be clean" is not a
reachable state. VERIFY: pick the newest test.yml run whose SHA contains
`0cbac0a1094` and wait on it with `scripts/lib/wait-for-run.sh <id> 40`.
**Poll ceiling: 6 `gh run view`/`gh run list` calls per 10 min, hook-enforced.**

If it is RED, determine whether the failure is in MY files (listed above) or a
parallel session's work before touching anything — the same commit range carries
other sessions' merges, and one reviewer already misattributed their
crown-fanout findings to this change.

## RESOLVED since this brief was written

* The audit of `1de9caae81a` came back with ONE P1 and it is FIXED and pushed
  (`604273ff5b7`): the attempt-3 short circuit made the ladder host-dependent and
  would have failed three EXISTING tests on any runner without
  `~/.config/cmux/cmux.json` — i.e. every CI runner. Reverted. Verified on a
  simulated no-config host (HOME pointed at an empty dir): 42 pass / 0 fail,
  identical to a real-host run; before the revert that simulation failed 3.
  The audit's other three answers were clean: the strip regex is not too greedy
  (a real reason is always on a later line), `firstAuthError` cannot be unset at
  attempt 3, and nothing else consumes the `task-sweep-error` kind.
* **Latest commit on origin/main: `604273ff5b7`.** Use that, not the SHAs below.

## OPEN THREAD 2 (RESOLVED — kept for context) — the audit agent

A general-purpose agent was auditing commit `1de9caae81a` when the prior session
handed off. Its four questions: (a) is the `Command failed:` strip regex too greedy —
can it eat a line containing the real reason; (b) can `throw firstAuthError` throw
null/undefined if attempt 3 is reachable with it unset; (c) does anything else in the
repo consume the kind `task-sweep-error` that the rename to `wrapper-probe-error`
would break (grep it); (d) any test asserting behaviour the code no longer has.
Re-run that audit yourself rather than assume it passed.

## OPEN THREAD 3 — the ✅ mark on this tab

workspace:122 ("🤖🔮 Data·BRO-2959 cmux socket auth outage fixed") was ✅-marked and
VERIFIED by reading `cmux list-workspaces` back. Note: the FIRST rename returned
`OK` while the mark did not apply — always read the title back, never trust the
return code. More commits landed after that mark; re-apply and re-verify if you
want the tab prunable.

## Verification already done (re-verify anything you rely on)

* Launchd-run `bsc-reconcile` now logs `tasks checked=N dead=0 redispatched=0`; every
  sweep threw before. Launchd-run `bsc-prune` exits 0; it was crashing.
* Zero sweep errors in `data/audit/reconcile-report.jsonl` since the fix (was ~2 every
  5 min, 508 in 7 days).
* Ladder against the live daemon: `CMUX_SOCKET_PASSWORD=stale-wrong-value` recovers and
  returns the workspace list, with exactly ONE warning across 4 calls.
* 249 unit tests pass across the 8 cmux/reconcile suites.
* Escalation validated by replaying real history, not reasoning: all 2600 recorded cmux
  sweep failures classify as unavailable 2241 / timeout 312 / auth-denied 47 / unknown 1,
  and tick-by-tick only 24 of 1389 failure-ticks page (1.7%) — all the genuine outage,
  collapsed to one card by routeAlert's 168h cooldown.

## Board state

* **BRO-2959** — In Review (correct: its own acceptance criterion needs a live multi-day
  dispatch window to re-measure; do NOT mark Done without that). Outcome already posted
  via `linear-session.js report`, which is what `reportedOutcomeGuard` reads.
* **BRO-486** — Canceled. It was an auto-filed CI artifact: health-check.js:2862 emits
  "(unmeasurable here)" when the gitignored, Mac-local dispatch ledger is absent, which
  is always true on ubuntu-latest. Not a stale cmux-only claim.
* **BRO-2978** — Backlog, parked. Per-lane trouble-rate metric. Blocked on an owner
  judgment call: per-attempt vs per-task numerator. Note `audit-headless-outcome-rate.js:31`
  resolves the ledger `__dirname`-relative while `audit-dispatch-dead-rate.js:38`
  hardcodes REPO precisely because worktrees made the relative form read empty.
* **BRO-2992** — dispatched to workspace:135 ("🤖⚡ Data·BRO-2992 No check asserts cmux
  socket REACHABILITY"). Prose-independent reachability sentinel.
* **BRO-2993** — dispatched to workspace:134 ("🤖⚡ Data·BRO-2993 bsc-reconcile's
  untracked sweep loses its"). At bsc-reconcile.js:675 an empty workspace list makes the
  live-tab guard a no-op, so a task whose tab is alive can be flipped to pending.
  Both run independently of this chat; you are not required to babysit them, but check
  they did not stall.

## Hard-won gotchas

* Nine review rounds, and each of the first eight found a real defect — several in the
  PREVIOUS round's fix. A credential retry ladder has far more silent failure modes than
  its size suggests. Specific traps already fixed, do not reintroduce: a commented-out
  password selected from JSONC (cmux ships a commented template; only whole-line `//`
  may be stripped, because `$schema`'s URL contains `//` mid-line); `err.stdout` feeding
  the classifier (command OUTPUT can contain "Access denied"); argv inside
  `err.message` forging an auth verdict and replaying a mutating `send`; a refresh retry
  that was a byte-identical no-op; the ladder discarding the auth diagnosis on the final
  throw AND on attempt 2.
* The classifier keys on ENGLISH PROSE. If cmux rewords its errors, rejections become
  'unknown'. That now escalates deliberately (measured: 1 in 2600 all-time, so no noise),
  but BRO-2992's sentinel is the real structural answer.
* Production never passes an `Error` to `classifyCmuxError` — bsc-reconcile's sweep
  sites report `cmux listing failed: ${e.message}` as a STRING. Any future change to
  that function must treat both shapes identically or the two silently diverge.
* Worktree isolation blocks many compound bash forms (`HOME=`, computed vars near
  `git`/`node`). Split into plain commands.
* `~/.claude/hooks/cmux-destructive-guard.sh` blocks any bash command whose TEXT
  contains the workspace-closing verb — even inside a heredoc or a review prompt.
  Write such text to a file with the Write tool instead of inlining it.

## Your mandate

Confirm CI green (or fix what is genuinely mine), close out threads 2 and 3, and
report ONE verdict. Do not re-open the design — it has been reviewed nine times.

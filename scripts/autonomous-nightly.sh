#!/usr/bin/env bash
# autonomous-nightly.sh — the Mac Studio launchd entrypoint for the
# autonomous loop (S2-T8). Slot: 07:30 UTC (03:30 ET) nightly — chosen in
# memory/autonomous-loop-schedule.md with ≥30min clearance from other crons.
#
#   triage (live: stamps Auto=queued/failed)
#   → executor (claim → branch → implement → verify → push → needs-approval
#     → morning email, owner-only transactional, rule 17)
#
# The morning email is sent BY the executor itself (scripts/autonomous-run.js
# live()'s `finally`), not by this wrapper — night-2 fix: when email lived
# only here, a manual `node scripts/autonomous-run.js --live` (no wrapper)
# finished silently with no breakdown email. Every `--live` invocation now
# gets the email regardless of trigger source, scheduled or ad-hoc. The
# executor's pidfile singleton makes accidental double-fires exit clean.
# Kill switch:
#   launchctl bootout gui/$(id -u)/com.broadwayscore.autonomous-nightly
set -uo pipefail

REPO="/Users/tompryor/Broadwayscore"
LOG_DIR="$HOME/Library/Logs/broadwayscore"
mkdir -p "$LOG_DIR"
exec >> "$LOG_DIR/autonomous-nightly.log" 2>&1

echo "=== autonomous night $(date -u +%FT%TZ) ==="
cd "$REPO" || exit 1

# Opening-night yield (2026-07-24, plan review of the opening-night monitor):
# the 03:30 ET slot lands INSIDE a Broadway opening-night monitor window, and
# both would do git operations in this same tree (index.lock contention +
# the stale-checkout clobber class). When a monitor session holds a FRESH
# lock, skip only the EXECUTOR (the git-touching step) — triage, the morning
# email, and the workspace sweep are API/ledger-only and still run, so the
# owner still gets an email and the deadman doesn't false-alarm (2026-07-25:
# the old whole-night `exit 0` left the ledger silent and tripped deadman).
# A lock whose meta.json launchedAt is older than 20h is STALE — its monitor
# window is long over (locks are per-night by design, so >20h can only be an
# orphan) — log loudly and run the full night.
#
# #476 (2026-07-26): this used to check the LOCK DIR's mtime, but any process
# that merely touches the directory (an unrelated smoketest/crashtest doing a
# `find`/`ls` sweep) resets mtime without the monitor session doing anything
# — the 07-26 incident: a lock launched 2026-07-24 (46h old) got its dir
# mtime refreshed hours before this tick ran, read as "fresh", and silently
# skipped 5 planned tier-3 attempts with no explanation in the morning email.
# meta.json's launchedAt is written once, by the launcher, and never touched
# again — it is the only trustworthy clock here.
SKIP_EXECUTOR=0
LOCK="$REPO/data/opening-night-monitor/monitor.lock"
if [ -d "$LOCK" ]; then
  # Decision logic lives in scripts/lib/monitor-lock-staleness.js
  # (isLockFresh), unit-tested there — not duplicated here.
  # ship-check (codex): the ONLY case that may skip the executor is a
  # confirmed "FRESH" read — anything else (node missing/crashing,
  # unexpected stdout noise, an empty string) must fall through to "run
  # the full night". An earlier draft tested `= "STALE"` and defaulted the
  # `else` branch to skip-executor, which is backwards: any non-"STALE"
  # output (not just a real FRESH read) would have silently reintroduced
  # the exact skip bug this fix exists to close.
  LOCK_FRESH=$(node "$REPO/scripts/lib/monitor-lock-staleness.js" "$LOCK" 2>/dev/null)
  if [ "$LOCK_FRESH" = "FRESH" ]; then
    echo "[nightly] opening-night monitor active (fresh monitor.lock per meta.json launchedAt) — skipping the executor only; triage/email/sweep still run"
    SKIP_EXECUTOR=1
  else
    echo "[nightly] monitor.lock is STALE (meta.json launchedAt >20h old, missing/corrupt, or the staleness check itself failed — owning monitor window is over or unverifiable) — ignoring it and running the full night"
  fi
fi

# Fresh main — the executor branches worktrees off origin/main, and triage
# reads the freshest card mirror. Never fatal: a fetch hiccup shouldn't
# skip the night, worktrees fetch again themselves.
git fetch origin main || echo "[nightly] WARN git fetch failed"
# Card #364 ship-check finding: fetch alone updates refs/remotes/origin/main
# but NOT this checkout's working tree — autonomous-email.js reads
# data/audit/health-digest-snapshot.json (committed by data-health-check.yml,
# a DIFFERENT machine — GitHub Actions) straight off this tree, so without a
# fast-forward here it would silently read yesterday's file, or none. --ff-only
# is a no-op success if this checkout has no local commits ahead of origin/main
# (the normal case — the executor does its work in separate worktrees), and
# harmlessly fails (never fatal) if it ever does diverge.
git merge --ff-only origin/main || echo "[nightly] WARN could not fast-forward to origin/main (local checkout diverged? investigate) — health digest / other CI-committed files may read stale tonight"

echo "--- triage ---"
node scripts/autonomous-triage.js --limit 30 || echo "[nightly] WARN triage failed (executor will use yesterday's queue only if <12h old)"

# Acceptance recheck (Sprint 3, S3-T3) and the workspace sweep BOTH run before
# the executor, because the executor SENDS THE MORNING EMAIL as its last act
# (autonomous-run.js live()'s finally). Anything that wants to appear in
# tonight's email has to be in the ledger before that. Running them after —
# the obvious-looking order — silently shipped yesterday's recheck results and
# yesterday's closed-tab count every morning (ship-check finding, 2026-07-25).
#
# The recheck runs on EVERY night including monitor-lock nights: it works in
# its own disposable detached worktree and never touches this checkout's
# branch state, so the index.lock contention that makes us skip the executor
# does not apply to it. Shadow mode — it reports, it never reopens a card.
echo "--- acceptance recheck (shadow) ---"
node scripts/autonomous-acceptance-recheck.js || echo "[nightly] WARN acceptance recheck failed (non-fatal)"

# Mornings start visually clean: close ✅-marked cmux workspaces left over from
# finished sessions. Closes ONLY ✅-marked workspaces with no live claude
# (scripts/lib/cmux-workspaces.js pruneDone treats any liveness error as
# alive), so it cannot close a session that is still working. Never fatal.
echo "--- workspace sweep ---"
node scripts/bsc-prune.js || echo "[nightly] WARN bsc-prune failed (non-fatal)"

if [ "$SKIP_EXECUTOR" = "1" ]; then
  echo "--- executor SKIPPED (monitor night) — sending the morning email directly ---"
  # autonomous-email.js refuses without an explicit --send-to (rule 17);
  # resolve the owner address the same way the executor does (.env fallback).
  OWNER_EMAIL_RESOLVED="${OWNER_EMAIL:-$(grep -m1 '^OWNER_EMAIL=' "$REPO/.env" 2>/dev/null | cut -d= -f2-)}"
  if [ -n "$OWNER_EMAIL_RESOLVED" ]; then
    # #476: say so in the email — otherwise a monitor night that deferred
    # real planned work reads identically to a genuine do-nothing night.
    node scripts/autonomous-email.js --send-to "$OWNER_EMAIL_RESOLVED" --executor-skipped "monitor night" || echo "[nightly] WARN morning email failed on monitor night"
  else
    echo "[nightly] WARN no OWNER_EMAIL resolvable — monitor-night email skipped"
  fi
else
  echo "--- executor (sends the morning email itself) ---"
  node scripts/autonomous-run.js --live || echo "[nightly] WARN executor failed"
fi

echo "=== night done $(date -u +%FT%TZ) ==="

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
# A lock older than 20h is STALE — its monitor window is long over (the
# 2026-07-25 incident: a lock whose workspace had died skipped a full night;
# locks are per-night by design, so >20h can only be an orphan) — log loudly
# and run the full night.
SKIP_EXECUTOR=0
LOCK="$REPO/data/opening-night-monitor/monitor.lock"
if [ -d "$LOCK" ]; then
  if [ -n "$(find "$LOCK" -maxdepth 0 -mmin +1200 2>/dev/null)" ]; then
    echo "[nightly] monitor.lock is STALE (>20h old — owning monitor window is over) — ignoring it and running the full night"
  else
    echo "[nightly] opening-night monitor active (fresh monitor.lock) — skipping the executor only; triage/email/sweep still run"
    SKIP_EXECUTOR=1
  fi
fi

# Fresh main — the executor branches worktrees off origin/main, and triage
# reads the freshest card mirror. Never fatal: a fetch hiccup shouldn't
# skip the night, worktrees fetch again themselves.
git fetch origin main || echo "[nightly] WARN git fetch failed"

echo "--- triage ---"
node scripts/autonomous-triage.js --limit 30 || echo "[nightly] WARN triage failed (executor will use yesterday's queue only if <12h old)"

if [ "$SKIP_EXECUTOR" = "1" ]; then
  echo "--- executor SKIPPED (monitor night) — sending the morning email directly ---"
  # autonomous-email.js refuses without an explicit --send-to (rule 17);
  # resolve the owner address the same way the executor does (.env fallback).
  OWNER_EMAIL_RESOLVED="${OWNER_EMAIL:-$(grep -m1 '^OWNER_EMAIL=' "$REPO/.env" 2>/dev/null | cut -d= -f2-)}"
  if [ -n "$OWNER_EMAIL_RESOLVED" ]; then
    node scripts/autonomous-email.js --send-to "$OWNER_EMAIL_RESOLVED" || echo "[nightly] WARN morning email failed on monitor night"
  else
    echo "[nightly] WARN no OWNER_EMAIL resolvable — monitor-night email skipped"
  fi
else
  echo "--- executor (sends the morning email itself) ---"
  node scripts/autonomous-run.js --live || echo "[nightly] WARN executor failed"
fi

# Acceptance recheck (Sprint 3, S3-T3). Runs on EVERY night including
# monitor-lock nights: it uses its own disposable detached worktree and never
# touches this checkout's branch state, so the index.lock contention that
# makes us skip the executor does not apply to it. Shadow mode — it reports
# into the ledger and the morning email, it never reopens a card. Placed
# BEFORE the email so tonight's results are in the ledger when the email
# (sent by the executor, or directly below on monitor nights) renders.
echo "--- acceptance recheck (shadow) ---"
node scripts/autonomous-acceptance-recheck.js || echo "[nightly] WARN acceptance recheck failed (non-fatal)"

# Mornings start visually clean (Sprint 3 setup item): close ✅-marked cmux
# workspaces left over from finished sessions. Never fatal — a missing cmux
# CLI or a bad night must not fail the loop.
echo "--- workspace sweep ---"
node scripts/bsc-prune.js || echo "[nightly] WARN bsc-prune failed (non-fatal)"

echo "=== night done $(date -u +%FT%TZ) ==="

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

# Fresh main — the executor branches worktrees off origin/main, and triage
# reads the freshest card mirror. Never fatal: a fetch hiccup shouldn't
# skip the night, worktrees fetch again themselves.
git fetch origin main || echo "[nightly] WARN git fetch failed"

echo "--- triage ---"
node scripts/autonomous-triage.js --limit 30 || echo "[nightly] WARN triage failed (executor will use yesterday's queue only if <12h old)"

echo "--- executor (sends the morning email itself) ---"
node scripts/autonomous-run.js --live || echo "[nightly] WARN executor failed"

# Mornings start visually clean (Sprint 3 setup item): close ✅-marked cmux
# workspaces left over from finished sessions. Never fatal — a missing cmux
# CLI or a bad night must not fail the loop.
echo "--- workspace sweep ---"
node scripts/bsc-prune.js || echo "[nightly] WARN bsc-prune failed (non-fatal)"

echo "=== night done $(date -u +%FT%TZ) ==="

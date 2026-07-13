#!/usr/bin/env bash
# autonomous-nightly.sh — the Mac Studio launchd entrypoint for the
# autonomous loop (S2-T8). Slot: 07:30 UTC (03:30 ET) nightly — chosen in
# memory/autonomous-loop-schedule.md with ≥30min clearance from other crons.
#
#   triage (live: stamps Auto=queued/failed)
#   → executor (claim → branch → implement → verify → push → needs-approval)
#   → morning email (owner-only transactional, rule 17)
#
# Every stage failure still advances to the email so the owner hears about
# broken nights FROM the night itself. The executor's pidfile singleton
# makes accidental double-fires exit clean. Kill switch:
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

# Owner address: config override, else OWNER_EMAIL from .env (kept out of
# the committed config — this repo is public).
OWNER_EMAIL=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('.claude/autonomous-config.json','utf8')).ownerEmail||'')}catch{console.log('')}")
if [ -z "$OWNER_EMAIL" ] && [ -f .env ]; then
  OWNER_EMAIL=$(grep '^OWNER_EMAIL=' .env | head -1 | cut -d= -f2)
fi
if [ -z "$OWNER_EMAIL" ]; then
  echo "[nightly] FATAL no ownerEmail (config) or OWNER_EMAIL (.env)"
  exit 1
fi

echo "--- triage ---"
node scripts/autonomous-triage.js --limit 30 || echo "[nightly] WARN triage failed (executor will use yesterday's queue only if <12h old)"

echo "--- executor ---"
node scripts/autonomous-run.js --live || echo "[nightly] WARN executor failed"

echo "--- morning email ---"
node scripts/autonomous-email.js --send-to "$OWNER_EMAIL" || echo "[nightly] WARN email failed"

echo "=== night done $(date -u +%FT%TZ) ==="

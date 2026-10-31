#!/bin/bash
# One-shot: dispatch overhaul sprint S3 (#856) at ~09:30 ET 2026-08-04, honoring
# the plan's one-enforcement-change-per-day pacing (S2 landed 8/3).
# Fallback: if the cmux launcher fails, run the seed headless (never paste-prompt the owner).
set -u
TARGET=$(date -j -f "%Y-%m-%d %H:%M" "2026-08-04 09:30" +%s)
NOW=$(date +%s)
[ "$NOW" -lt "$TARGET" ] && sleep $((TARGET - NOW))
cd "$HOME/Broadwayscore" || exit 1
LOG="$HOME/Broadwayscore/data/audit/dispatch-s3-morning.log"
{
  echo "=== $(date) dispatching #856 (S3) ==="
  OUT=$(node scripts/bsc-next.js --id 856 2>&1)
  echo "$OUT"
  if echo "$OUT" | grep -q "command that should have run"; then
    SEED=$(echo "$OUT" | grep -oE '/var/folders/[^")]*bsc-seed-856\.txt' | head -1)
    if [ -n "$SEED" ] && [ -s "$SEED" ]; then
      echo "cmux launcher failed — running S3 headless"
      nohup claude --model sonnet --dangerously-skip-permissions "$(cat "$SEED")" >> "$LOG.headless" 2>&1 &
      echo "headless S3 started pid $!"
    else
      echo "ERROR: no seed file found; S3 NOT dispatched — will surface as pending P1 in bsc-next --list"
    fi
  fi
} >> "$LOG" 2>&1

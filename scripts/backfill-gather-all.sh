#!/bin/bash
# Broadway backfill: gather ALL batches sequentially.
# Dispatches one batch, waits for completion, then dispatches next.
# Safe to run in background — handles failures gracefully.
#
# Usage: nohup ./scripts/backfill-gather-all.sh &

set -euo pipefail

REPO="thomaspryor/Broadwayscore"
BATCHES_FILE="/Users/tompryor/Broadwayscore/scripts/backfill-batches.json"
LOG="/tmp/backfill-gather.log"
TOTAL_BATCHES=$(node -e "console.log(require('$BATCHES_FILE').length)")

echo "$(date): Starting backfill of $TOTAL_BATCHES batches" >> "$LOG"

for BATCH_IDX in $(seq 0 $((TOTAL_BATCHES - 1))); do
  SHOWS=$(node -e "console.log(require('$BATCHES_FILE')[$BATCH_IDX].join(','))")
  SHOW_COUNT=$(node -e "console.log(require('$BATCHES_FILE')[$BATCH_IDX].length)")

  echo "$(date): Batch $BATCH_IDX/$((TOTAL_BATCHES-1)) ($SHOW_COUNT shows)" >> "$LOG"

  # Dispatch
  RUN_URL=$(gh workflow run "Gather Review Data" -R "$REPO" \
    -f shows="$SHOWS" \
    -f parallel_jobs=3 \
    -f max_tier=2 2>&1)

  echo "$(date): Dispatched: $RUN_URL" >> "$LOG"

  # Wait for the run to appear
  sleep 15

  # Find the run ID (most recent gather run)
  RUN_ID=$(gh run list --workflow="Gather Review Data" --limit 1 --json databaseId -q '.[0].databaseId' -R "$REPO")
  echo "$(date): Run ID: $RUN_ID" >> "$LOG"

  # Wait for completion (up to 45 min)
  TIMEOUT=2700
  ELAPSED=0
  while [ $ELAPSED -lt $TIMEOUT ]; do
    STATUS=$(gh run view "$RUN_ID" --json status,conclusion -q '.status + " " + (.conclusion // "")' -R "$REPO" 2>/dev/null || echo "unknown")
    if echo "$STATUS" | grep -q "completed"; then
      echo "$(date): Batch $BATCH_IDX finished: $STATUS" >> "$LOG"
      break
    fi
    sleep 60
    ELAPSED=$((ELAPSED + 60))
  done

  if [ $ELAPSED -ge $TIMEOUT ]; then
    echo "$(date): Batch $BATCH_IDX timed out after ${TIMEOUT}s" >> "$LOG"
  fi

  # Small delay between batches to avoid rate limits
  sleep 10
done

echo "$(date): All $TOTAL_BATCHES batches complete" >> "$LOG"

# Disable the daily launchd job since we're done
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.broadwayscore.backfill-gather.plist 2>/dev/null || true

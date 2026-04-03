#!/bin/bash
# Broadway backfill: gather reviews for shows that lost wrongShow slot-blockers.
# Runs one batch per day (~100 shows). Tracks progress in a state file.
# Scheduled via launchd to run daily at 4 AM local time.
#
# Usage: ./scripts/backfill-gather-batch.sh
# State: /tmp/backfill-gather-state.txt (current batch index)

set -euo pipefail

REPO="thomaspryor/Broadwayscore"
STATE_FILE="/tmp/backfill-gather-state.txt"
BATCHES_FILE="/Users/tompryor/Broadwayscore/scripts/backfill-batches.json"

# Read current batch index
if [ -f "$STATE_FILE" ]; then
  BATCH_IDX=$(cat "$STATE_FILE")
else
  BATCH_IDX=0
fi

# Read total batches
TOTAL_BATCHES=$(node -e "console.log(require('$BATCHES_FILE').length)")

if [ "$BATCH_IDX" -ge "$TOTAL_BATCHES" ]; then
  echo "$(date): All $TOTAL_BATCHES batches complete. Backfill done."
  # Disable the launchd job
  launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.broadwayscore.backfill-gather.plist 2>/dev/null || true
  exit 0
fi

# Get show IDs for this batch
SHOWS=$(node -e "console.log(require('$BATCHES_FILE')[$BATCH_IDX].join(','))")
SHOW_COUNT=$(node -e "console.log(require('$BATCHES_FILE')[$BATCH_IDX].length)")

echo "$(date): Starting batch $BATCH_IDX of $TOTAL_BATCHES ($SHOW_COUNT shows)"

# Trigger gather workflow
gh workflow run "Gather Review Data" -R "$REPO" \
  -f shows="$SHOWS" \
  -f parallel_jobs=3 \
  -f max_tier=2

echo "$(date): Batch $BATCH_IDX dispatched"

# Increment state
echo $((BATCH_IDX + 1)) > "$STATE_FILE"

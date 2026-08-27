#!/usr/bin/env bash
# Cron-driven rotation of data/audit/stage-latency.jsonl.
#
# emitStage() (scripts/lib/stage-latency.js) already self-rotates the log at
# MAX_LOG_BYTES (40MB) on every write, but that only fires from inside a
# pipeline run that happens to append a line. If no pipeline writes for a
# while — or a burst of writes lands the file just over the threshold right
# before the last emitStage() call of a run — the oversized file can sit
# committed until the next append. This script is the independent safety
# net: run on a schedule, rotate unconditionally if oversized, commit and
# push. Belt-and-suspenders for the incident that blocked
# llm-ensemble-score.yml for ~30min on 2026-04-29 (BRO-54).
#
# Usage: bash scripts/stage-latency-rotation.sh
# Exits 0 whether or not rotation was needed. Exits 1 only on an actual
# rotation/commit/push failure.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

LOG_FILE="data/audit/stage-latency.jsonl"

if [ ! -f "$LOG_FILE" ]; then
  echo "[stage-latency-rotation] $LOG_FILE does not exist yet — nothing to rotate"
  exit 0
fi

SIZE_BEFORE=$(stat --format=%s "$LOG_FILE" 2>/dev/null || stat -f%z "$LOG_FILE" 2>/dev/null)
echo "[stage-latency-rotation] $LOG_FILE is ${SIZE_BEFORE} bytes"

ROTATE_STATUS=0
node -e "
  const { rotateIfNeeded } = require('./scripts/lib/stage-latency.js');
  const rotated = rotateIfNeeded('$LOG_FILE');
  process.exit(rotated ? 0 : 3);
" || ROTATE_STATUS=$?

if [ "$ROTATE_STATUS" -eq 3 ]; then
  echo "[stage-latency-rotation] below rotation threshold — no changes"
  exit 0
elif [ "$ROTATE_STATUS" -ne 0 ]; then
  echo "[stage-latency-rotation] rotateIfNeeded failed (exit $ROTATE_STATUS)" >&2
  exit 1
fi

if git diff --quiet -- "$LOG_FILE"; then
  echo "[stage-latency-rotation] rotation ran but produced no diff — nothing to commit"
  exit 0
fi

SIZE_AFTER=$(stat --format=%s "$LOG_FILE" 2>/dev/null || stat -f%z "$LOG_FILE" 2>/dev/null)
echo "[stage-latency-rotation] rotated: ${SIZE_BEFORE} -> ${SIZE_AFTER} bytes"

git add "$LOG_FILE"
git commit -m "chore: Rotate stage-latency.jsonl (${SIZE_BEFORE} -> ${SIZE_AFTER} bytes) [skip ci]"

bash scripts/lib/push-with-retry.sh

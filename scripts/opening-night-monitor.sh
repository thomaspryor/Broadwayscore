#!/usr/bin/env bash
# Opening Night Monitor — runs via launchd at key overnight times.
# Usage: ./scripts/opening-night-monitor.sh <phase> <show_id>

set -euo pipefail

PHASE="${1:-1}"
SHOW_ID="${2:-dog-day-afternoon-2026}"
REPO_DIR="/Users/tompryor/Broadwayscore"
LOG_DIR="$REPO_DIR/data/opening-night-monitor"
PROMPT_DIR="$REPO_DIR/scripts/opening-night-prompts"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/${SHOW_ID}-phase${PHASE}-$(date +%Y%m%d-%H%M).log"

cd "$REPO_DIR"

export PATH="/Users/tompryor/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export HOME="/Users/tompryor"
[ -f "$REPO_DIR/.env" ] && source "$REPO_DIR/.env"

PROMPT_FILE="$PROMPT_DIR/phase${PHASE}.md"
if [ ! -f "$PROMPT_FILE" ]; then
  echo "ERROR: Prompt file not found: $PROMPT_FILE" | tee "$LOG_FILE"
  exit 1
fi

# Substitute SHOW_ID into prompt
PROMPT=$(sed "s/{{SHOW_ID}}/$SHOW_ID/g" "$PROMPT_FILE")

echo "$(date): Starting opening night monitor phase $PHASE for $SHOW_ID" | tee "$LOG_FILE"

claude -p "$PROMPT" \
  --allowedTools "Bash,Read,Write,Edit,Glob,Grep" \
  --max-turns 45 \
  2>&1 | tee -a "$LOG_FILE"

echo "$(date): Phase $PHASE complete" | tee -a "$LOG_FILE"

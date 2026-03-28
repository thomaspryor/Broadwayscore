#!/bin/bash
# Weekly Retro — local replacement for RemoteTrigger trig_01DWdK9u9Bbng5QMy4meFNbd
# Spawns a Claude session to review the week's work and update Notion.
# Scheduled Sundays at 10 AM ET via launchd.

set -euo pipefail
cd /Users/tompryor/Broadwayscore

# Source env vars
set -a
source .env
set +a

LOG="/Users/tompryor/Library/Logs/bwsc-weekly-retro.log"
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Running weekly retro..." >> "$LOG"

# Pull latest
git pull --ff-only origin main >> "$LOG" 2>&1 || true

# Build prompt with this week's context
WEEK_START=$(date -v-7d +%Y-%m-%d)
TODAY=$(date +%Y-%m-%d)
GIT_LOG=$(git log --oneline --since="$WEEK_START" --until="$TODAY" | head -50)
WORKFLOW_RUNS=$(gh run list --limit 20 --json name,conclusion,createdAt --jq '.[] | "\(.createdAt) \(.name): \(.conclusion)"' 2>/dev/null || echo "(gh not available)")

PROMPT="You are an automated weekly retro session for Broadway Scorecard.

## Context
- Week: $WEEK_START to $TODAY
- Repo: /Users/tompryor/Broadwayscore

## Recent commits this week:
$GIT_LOG

## Recent workflow runs:
$WORKFLOW_RUNS

## Instructions
1. Search the Notion BWSC Roadmap for cards completed this week (Status=Done, Completed Date in range).
2. Search for cards still In Progress or Paused — flag any that look stale.
3. Check cron health: run \`gh run list --workflow=check-cron-health.yml --limit 1\` and report status.
4. Check deploy health: verify the latest deploy succeeded.
5. Summarize findings in a brief weekly report.
6. Create a new Notion card titled 'Weekly Retro $TODAY' with the summary in Outcome, Status=Done, Tags=[infra].

Output your report between markers:
===ACTION_RESULT_START===
[Report here]
===ACTION_RESULT_END==="

echo "$PROMPT" | claude --print --dangerously-skip-permissions >> "$LOG" 2>&1
EXIT_CODE=$?

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Weekly retro finished (exit $EXIT_CODE)." >> "$LOG"

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

WEEK_START=$(date -v-7d +%Y-%m-%d)
TODAY=$(date +%Y-%m-%d)

# Write prompt to temp file to avoid shell escaping issues
PROMPT_FILE=$(mktemp /tmp/weekly-retro-prompt.XXXXXX)
cat > "$PROMPT_FILE" <<PROMPT
You are the BWSC Weekly Retrospective agent running locally on the Mac Studio.

## Steps

### 1. Find This Week's Daily Digests
Search the Notion BWSC Roadmap (data source: collection://fa7b3ff2-c073-4097-b54c-0a78e56e06b6) for cards with Name containing 'Daily Digest' created in the last 7 days. Fetch each one and read the Outcome field.

### 2. Find All Completed Cards This Week
Search for cards with Status='Done' that have a Completed Date between $WEEK_START and $TODAY. Count them. Categorize by Type (Fix, New Feature, Data Quality, Market Expansion).

### 3. Recurring Issue Detection
From the completed Fix cards this week, extract all Tags. If any Tag appears in 3 or more Fix cards, flag it as a potential systemic issue:
'Tag [X] appeared in N fix cards this week: [card names]. Consider a systemic fix.'

### 4. Git Activity Summary
Run: git log --oneline --since='7 days ago' | wc -l for commit count.
Run: git log --since='7 days ago' --pretty=format: --name-only | sort | uniq -c | sort -rn | head -20 for most-changed files.

### 5. Stale Items Check
Search for cards with Status='Not started' and Priority='P0 Now'. Flag any that have been P0 for over 7 days without progress.
Search for cards with Status='In progress'. Flag any that look stale (created >24h ago).

### 6. Workflow & Deploy Health
Run: gh run list --limit 20 --json workflowName,conclusion,status,createdAt
Report failures in the last 7 days. Check cron health: gh run list --workflow=check-cron-health.yml --limit 1.

### 7. Outcome Quality Audit
For each completed card this week, check the Outcome field. Flag any card where the Outcome is missing section headers: 'What changed', 'Why this approach', 'Gotchas', 'Discovered work'.

### 8. Create Week in Review Card
Create a new Notion card in the BWSC Roadmap database (data source: collection://fa7b3ff2-c073-4097-b54c-0a78e56e06b6) with:
- Name: 'Week in Review — $WEEK_START to $TODAY'
- Status: 'Done'
- Category: 'Admin'
- Type: 'Fix'
- Priority: 'P2 Later'
- Tags: '["infra"]'
- Completed Date: $TODAY
- Outcome: The full retro formatted as:
  ## Week in Review — $WEEK_START to $TODAY
  ### Velocity
  [N cards completed: X fixes, Y features, Z data quality. N total commits.]
  ### Key Accomplishments
  [Top 3-5 most impactful completed cards with 1-line summaries]
  ### Recurring Issues
  [Tags appearing in 3+ Fix cards, or 'No recurring patterns']
  ### Stale P0s
  [P0 items that haven't moved, or 'All P0s are progressing']
  ### Outcome Quality
  [Cards with thin outcomes, or 'All outcomes complete']
  ### Most Active Areas
  [Top 5 most-changed files/directories]
  ### Priorities for Next Week
  [Based on current P0/P1 backlog and patterns observed]

If Notion MCP fails, write the retro to stdout so it's captured in the run logs.

### 9. Done
Output the card URL. Do not take any other actions.
PROMPT

cat "$PROMPT_FILE" | claude --print --dangerously-skip-permissions >> "$LOG" 2>&1
EXIT_CODE=$?
rm -f "$PROMPT_FILE"

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Weekly retro finished (exit $EXIT_CODE)." >> "$LOG"

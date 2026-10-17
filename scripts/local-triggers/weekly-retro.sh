#!/bin/bash
# Weekly Retro — local replacement for RemoteTrigger trig_01DWdK9u9Bbng5QMy4meFNbd
# Spawns a Claude session to review the week's work and file it on the Linear board
# (Notion retired as the board, BRO-4274).
# Scheduled Sundays at 10 AM ET via launchd.

set -euo pipefail
cd /Users/tompryor/Broadwayscore

# Source env vars
set -a
source .env
set +a

LOG="/Users/tompryor/Library/Logs/bwsc-weekly-retro.log"
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Running weekly retro..." >> "$LOG"

# Auth preflight (task #1107): this job's plist used to embed a session OAuth
# token snapshot that rotates out from under automation on the next `/login` —
# the job kept firing on schedule and accomplishing nothing. Abort loudly
# instead of spawning `claude` blind. Stdout is exactly one MODE= line on
# success (diagnostics go to $LOG via stderr); on MODE=oauth, ANTHROPIC_API_KEY
# from the `source .env` above must be unset before the real spawn below, or
# claude silently switches from the free subscription to pay-per-token
# (ship-check adversarial finding 2026-08-06 — see claude-auth-preflight.js header).
if ! AUTH_MODE=$(node scripts/claude-auth-preflight.js 2>>"$LOG"); then
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] ABORTING: claude auth preflight failed — see above" >> "$LOG"
  exit 1
fi
echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] auth preflight: $AUTH_MODE" >> "$LOG"
if [ "$AUTH_MODE" = "MODE=oauth" ]; then
  unset ANTHROPIC_API_KEY
fi

# Sync to latest before running (BRO-1794): a bare `git pull --ff-only || true`
# silently ran the retro on stale code whenever data/audit/* had local edits
# (the same class of bug fixed for autonomous-shadow/morning-digest/backlog-
# drain by task #732). sync-audit-checkout.sh resets regenerable audit
# snapshots and retries; if it still can't fast-forward it exits non-zero,
# and `set -e` above aborts this job loudly instead of running it stale.
SYNC_TAG=weekly-retro bash scripts/lib/sync-audit-checkout.sh >> "$LOG" 2>&1

WEEK_START=$(date -v-7d +%Y-%m-%d)
TODAY=$(date +%Y-%m-%d)

# Write prompt to temp file to avoid shell escaping issues
PROMPT_FILE=$(mktemp /tmp/weekly-retro-prompt.XXXXXX)
cat > "$PROMPT_FILE" <<PROMPT
You are the BWSC Weekly Retrospective agent running locally on the Mac Studio.

## Steps

The board is Linear (team BRO). Notion is retired: never use Notion or notion-brain.js.
Query Linear with the repo's client, e.g.:
  node -e "require('./scripts/lib/linear-client').graphql(process.argv[1],{}).then(d=>console.log(JSON.stringify(d,null,1)))" '<GraphQL query>'
using issues(filter: { team: { key: { eq: "BRO" } }, ... }, first: 100) with fields identifier title state { name } priority completedAt createdAt labels { nodes { name } } description.

### 1. Find This Week's Daily Digests
Find issues whose title contains 'Daily Digest' created since $WEEK_START (filter title: { containsIgnoreCase: "Daily Digest" }, createdAt: { gte: "$WEEK_START" }). Read each description and its comments.

### 2. Find All Completed Issues This Week
Find issues with completedAt between $WEEK_START and $TODAY. Count them. Categorize by kind (fix, feature, data quality, market expansion) from labels and titles.

### 3. Recurring Issue Detection
From the completed fix issues this week, extract all labels. If any label appears on 3 or more fix issues, flag it as a potential systemic issue:
'Label [X] appeared on N fix issues this week: [identifiers + titles]. Consider a systemic fix.'

### 4. Git Activity Summary
Run: git log --oneline --since='7 days ago' | wc -l for commit count.
Run: git log --since='7 days ago' --pretty=format: --name-only | sort | uniq -c | sort -rn | head -20 for most-changed files.

### 5. Stale Items Check
Find open issues with priority 1 (Urgent/P0) whose state is not started (Todo/Backlog). Flag any that have been P0 for over 7 days without progress.
Find issues in state 'In Progress'. Flag any that look stale (created >24h ago, no comment in 24h).

### 6. Workflow & Deploy Health
Run: gh run list --limit 20 --json workflowName,conclusion,status,createdAt
Report failures in the last 7 days. Check cron health: gh run list --workflow=check-cron-health.yml --limit 1.

### 7. Outcome Quality Audit
For each issue completed this week, check its Outcome comment. Flag any issue where the Outcome is missing section headers: 'What changed', 'Why this approach', 'Gotchas', 'Discovered work'.

### 8. File the Week in Review Issue
Write the retro to a temp file, then file it on Linear:
  node scripts/linear-brain.js create "Week in Review — $WEEK_START to $TODAY" --priority 4 --park "weekly retro record" --notes "\$(cat <file>)"
then close it (a record, nothing to verify):
  node scripts/linear-brain.js update BRO-N --state Done --force "weekly retro record, no code change to verify"
The retro is formatted as:
  ## Week in Review — $WEEK_START to $TODAY
  ### Velocity
  [N issues completed: X fixes, Y features, Z data quality. N total commits.]
  ### Key Accomplishments
  [Top 3-5 most impactful completed issues with 1-line summaries]
  ### Recurring Issues
  [Labels appearing on 3+ fix issues, or 'No recurring patterns']
  ### Stale P0s
  [P0 items that haven't moved, or 'All P0s are progressing']
  ### Outcome Quality
  [Issues with thin outcomes, or 'All outcomes complete']
  ### Most Active Areas
  [Top 5 most-changed files/directories]
  ### Priorities for Next Week
  [Based on current P0/P1 backlog and patterns observed]

If Linear is unreachable, write the retro to stdout so it's captured in the run logs. Do not fall back to Notion.

### 9. Done
Output the issue URL. Do not take any other actions.
PROMPT

cat "$PROMPT_FILE" | claude --print --dangerously-skip-permissions >> "$LOG" 2>&1
EXIT_CODE=$?
rm -f "$PROMPT_FILE"

echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] Weekly retro finished (exit $EXIT_CODE)." >> "$LOG"

#!/usr/bin/env bash
# sunday-review-launch.sh — launchd entrypoint for the Sunday 9am ET
# pre-owner-look newsletter content review (#507).
#
# Headless `claude --dangerously-skip-permissions -p ...` under launchd
# authenticates via ANTHROPIC_API_KEY (sourced from .env below) — the same
# mechanism scripts/autonomous-run.js's implementer already uses in
# production, NOT CLAUDE_CODE_OAUTH_TOKEN (that's the vestigial path tracked
# as broken in task #457; don't copy it here).
#
# "Already ran today" lock: keyed off meta.ranAt (America/New_York calendar
# day), written once by THIS script after a run completes — never off file
# mtime. Same #476 lesson as scripts/lib/monitor-lock-staleness.js: an
# unrelated process touching the lock file must never be able to fake
# freshness. See scripts/lib/sunday-review-lock.js for the decision logic.
#
# Kill switch: create data/newsletter-drafts/SUNDAY_REVIEW_DISABLED.

set -uo pipefail

REPO_DIR="/Users/tompryor/Broadwayscore"
LOG_DIR="$REPO_DIR/data/newsletter-drafts"
LOCK_META="$LOG_DIR/sunday-review-lock.json"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/sunday-review-$(date +%Y%m%d-%H%M).log"
exec >> "$LOG_FILE" 2>&1

cd "$REPO_DIR" || exit 1

export PATH="/Users/tompryor/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"
export HOME="/Users/tompryor"

if [ -f "$REPO_DIR/data/newsletter-drafts/SUNDAY_REVIEW_DISABLED" ]; then
  echo "$(date -u +%FT%TZ): SUNDAY_REVIEW_DISABLED present — skipping"
  exit 0
fi

if [ ! -f "$REPO_DIR/.env" ]; then
  echo "$(date -u +%FT%TZ): no .env at $REPO_DIR — cannot source ANTHROPIC_API_KEY/RESEND_API_KEY, aborting"
  exit 1
fi
set -a; source "$REPO_DIR/.env"; set +a

STATUS=$(node "$REPO_DIR/scripts/lib/sunday-review-lock.js" "$LOCK_META" 2>/dev/null || echo PENDING)
if [ "$STATUS" = "ALREADY_RAN" ]; then
  echo "$(date -u +%FT%TZ): already ran today (ET, per $LOCK_META) — skipping"
  exit 0
fi

# Cheap pre-check (a GET, no LLM cost) before paying for an Opus session:
# skip the whole review if both editions are already sent for the current
# week. Any non-3 exit (0 = a draft is pending, 1 = the check itself failed)
# falls through to running the review — the Opus session re-checks this in
# its own step 1 as a second, self-contained gate, so a flaky pre-check here
# fails toward "run it" rather than toward a silent skip.
DRAFTS_STATUS=$(node "$REPO_DIR/scripts/newsletter/check-drafts-status.mjs" 2>&1)
DRAFTS_EXIT=$?
echo "$(date -u +%FT%TZ): draft status check: $DRAFTS_STATUS (exit $DRAFTS_EXIT)"
if [ "$DRAFTS_EXIT" -eq 3 ]; then
  echo "$(date -u +%FT%TZ): both editions already sent — nothing to review, skipping (no Opus session, no email)"
  node -e "
const fs = require('fs');
fs.writeFileSync('$LOCK_META', JSON.stringify({ ranAt: new Date().toISOString(), skipped: 'already-sent' }, null, 2));
"
  exit 0
fi

echo "$(date -u +%FT%TZ): starting Sunday newsletter content review"

PROMPT_FILE="$REPO_DIR/scripts/newsletter/sunday-review-prompt.md"
if [ ! -f "$PROMPT_FILE" ]; then
  echo "$(date -u +%FT%TZ): ERROR prompt file not found: $PROMPT_FILE"
  exit 1
fi

claude --dangerously-skip-permissions --model opus -p "$(cat "$PROMPT_FILE")" --output-format json

CLAUDE_EXIT=$?
echo "$(date -u +%FT%TZ): claude exited $CLAUDE_EXIT"

# Stamp the lock regardless of claude's exit code — a failed run still
# "ran today"; the intent is at-most-once-per-Sunday, not retry-until-success.
# A stuck/crashing job should surface via the log, not fire repeatedly.
node -e "
const fs = require('fs');
fs.writeFileSync('$LOCK_META', JSON.stringify({ ranAt: new Date().toISOString(), exitCode: $CLAUDE_EXIT }, null, 2));
"

echo "$(date -u +%FT%TZ): Sunday newsletter content review complete"
exit 0

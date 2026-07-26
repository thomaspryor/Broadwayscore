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
# Two separate guards, ship-check (codex) required both:
#  - CONCURRENCY LOCK (LOCK_DIR, mkdir atomic test-and-set + trap release):
#    a double-fire (sleep/wake retrigger, manual `launchctl kickstart` while
#    a run is still in flight) must not launch two overlapping Opus sessions
#    against the same shared checkout. Without this, two check-then-act
#    readers of the "already ran today" meta could both read PENDING before
#    either writes it back.
#  - "ALREADY RAN TODAY" (LOCK_META, ranAt in America/New_York calendar day,
#    written once at the end of a run): same #476 lesson as
#    scripts/lib/monitor-lock-staleness.js — keyed off a written-once
#    timestamp, never off file/dir mtime, so an unrelated process touching
#    the lock can't fake freshness. See scripts/lib/sunday-review-lock.js.
#
# The claude invocation is wall-clock bounded via `perl -e 'alarm N; exec...'`
# (same pattern already used by ~/.claude/hooks/notion-card-required-commit.sh
# for a timeout-safe subprocess on macOS, which has no `timeout` builtin) —
# a wedged session must not block every subsequent Sunday indefinitely.
#
# Kill switch: create data/newsletter-drafts/SUNDAY_REVIEW_DISABLED.

set -uo pipefail

REPO_DIR="/Users/tompryor/Broadwayscore"
LOG_DIR="$REPO_DIR/data/newsletter-drafts"
LOCK_DIR="$LOG_DIR/sunday-review.lock"
LOCK_META="$LOG_DIR/sunday-review-lock.json"
CLAUDE_TIMEOUT_SEC=1800
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

# Atomic test-and-set: mkdir fails if another instance already holds the
# lock. A concurrent tick loses the race here and exits clean rather than
# launching a second overlapping Opus session against the same checkout.
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "$(date -u +%FT%TZ): lock held (another run already in flight) — skipping"
  exit 0
fi
trap 'rmdir "$LOCK_DIR" 2>/dev/null' EXIT

# Cheap pre-check (a GET, no LLM cost) before paying for an Opus session:
# skip the whole review only when EVERY edition is confirmed sent/scheduled
# for the current week (exit 3). Exit 0 covers both "a draft is pending" and
# "an edition hasn't been drafted yet" (refresh-drafts.sh can still create
# it) — exit 1 (the check itself failed) also falls through to running the
# review, so a flaky pre-check fails toward "run it", never toward a silent
# skip; the Opus session re-derives this in its own step 1 regardless.
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

perl -e "alarm $CLAUDE_TIMEOUT_SEC; exec @ARGV" \
  claude --dangerously-skip-permissions --model opus -p "$(cat "$PROMPT_FILE")" --output-format json

CLAUDE_EXIT=$?
echo "$(date -u +%FT%TZ): claude exited $CLAUDE_EXIT"

# Stamp the lock regardless of claude's exit code — a failed/timed-out run
# still "ran today"; the intent is at-most-once-per-Sunday, not
# retry-until-success. A stuck/crashing job surfaces via CLAUDE_EXIT in this
# log and the script's own (non-forced) exit code below, not via a retry.
node -e "
const fs = require('fs');
fs.writeFileSync('$LOCK_META', JSON.stringify({ ranAt: new Date().toISOString(), exitCode: $CLAUDE_EXIT }, null, 2));
"

echo "$(date -u +%FT%TZ): Sunday newsletter content review complete (exit $CLAUDE_EXIT)"
exit "$CLAUDE_EXIT"

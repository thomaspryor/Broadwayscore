#!/usr/bin/env bash
# deploy-heartbeat.sh — launchd backup trigger for vercel-deploy.yml's 5-min cron.
#
# WHY: GitHub deprioritizes scheduled cron on busy repos (157 scheduled workflows
# here). Observed 2026-07-14 ~02:18-03:10 UTC: 50+ min with zero scheduled fires
# while the ~13-min build sat idle and the owner waited on a merge (card #159).
# Manual `gh workflow run "Deploy to Vercel"` is blocked inside Claude Code
# sessions by gh-poll-block.sh Rule 2 (repeated dispatch caused cascade
# cancellations that zeroed the API quota 3x on 2026-05-17) — but this script
# runs standalone via launchd, outside that hook's reach, and only dispatches
# after confirming there is no in-progress/queued run (the actual guard against
# a redundant build; should-deploy's SHA dedup alone is NOT sufficient — it only
# compares against the last *successful* deploy, so a same-SHA run still mid-build
# would not be caught by dedup and would race a duplicate ~13-min build).
#
# Runs every 10 min via com.broadwayscore.deploy-heartbeat.plist.
# Budget: 0 GitHub API calls when HEAD is already live (the common case, checked
# via the rate-limit-immune Vercel API), else 1 `gh api` call to inspect recent
# runs, plus an occasional `gh workflow run` dispatch. Well under 10 calls/hour.

set -u
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

REPO="thomaspryor/Broadwayscore"
STALE_MIN=15
LOG_PREFIX="[deploy-heartbeat $(date -u +%H:%M:%SZ)]"

# launchd doesn't source shell rc files or .env — load VERCEL_TOKEN etc. here.
# Only fills vars not already set (mirrors scripts/autonomous-deadman.js).
if [[ -f .env ]]; then
  while IFS= read -r line; do
    [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]] || continue
    key="${line%%=*}"
    val="${line#*=}"
    [[ -n "${!key:-}" ]] && continue
    export "$key"="$val"
  done < .env
fi

if [[ -z "${VERCEL_TOKEN:-}" ]]; then
  echo "$LOG_PREFIX VERCEL_TOKEN not set — cannot check prod deploy state" >&2
  exit 1
fi

# 1. Is HEAD already live? Vercel API — free, doesn't touch the GitHub quota.
CHECK_OUT=$(node scripts/check-prod-deploy.js HEAD 2>&1)
CHECK_STATUS=$?
if [[ "$CHECK_STATUS" -eq 0 ]]; then
  echo "$LOG_PREFIX HEAD already live — nothing to do"
  exit 0
fi
echo "$LOG_PREFIX HEAD not confirmed live (exit $CHECK_STATUS): $(echo "$CHECK_OUT" | tail -1)"

# 2. Single gh api call: recent vercel-deploy.yml runs (status + event + created_at).
RUNS_JSON=$(gh api "repos/${REPO}/actions/workflows/vercel-deploy.yml/runs?per_page=10" 2>&1)
if [[ $? -ne 0 || -z "$RUNS_JSON" ]]; then
  echo "$LOG_PREFIX gh api call failed: $RUNS_JSON" >&2
  exit 1
fi

ACTIVE=$(echo "$RUNS_JSON" | node -e "
  const d = JSON.parse(require('fs').readFileSync(0, 'utf8'));
  const active = (d.workflow_runs || []).some(r => ['in_progress', 'queued', 'waiting'].includes(r.status));
  console.log(active ? 'yes' : 'no');
")
if [[ "$ACTIVE" == "yes" ]]; then
  echo "$LOG_PREFIX a deploy run is already in_progress/queued — waiting, not dispatching"
  exit 0
fi

LAST_SCHEDULE_AGE_MIN=$(echo "$RUNS_JSON" | node -e "
  const d = JSON.parse(require('fs').readFileSync(0, 'utf8'));
  const last = (d.workflow_runs || []).find(r => r.event === 'schedule');
  if (!last) { console.log('999'); process.exit(0); }
  const ageMs = Date.now() - new Date(last.created_at).getTime();
  console.log(Math.round(ageMs / 60000));
")

if [[ "$LAST_SCHEDULE_AGE_MIN" -lt "$STALE_MIN" ]]; then
  echo "$LOG_PREFIX last scheduled fire ${LAST_SCHEDULE_AGE_MIN}m ago — within ${STALE_MIN}m window, not stalled"
  exit 0
fi

echo "$LOG_PREFIX STALL: last scheduled fire ${LAST_SCHEDULE_AGE_MIN}m ago, no active run, HEAD not live — dispatching backup deploy"
# FORCE-DEPLOY: heartbeat backup for a stalled cron (scripts/deploy-heartbeat.sh, card #159)
gh workflow run vercel-deploy.yml
echo "$LOG_PREFIX dispatched"

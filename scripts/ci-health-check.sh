#!/usr/bin/env bash
# ci-health-check.sh — empirically verifies test.yml runs on main are no
# longer disproportionately cancelled before validating (BRO-34).
#
# Historical baseline (pre-fix): ~75% of test.yml runs on main were
# cancelled mid-setup — jobs:[], no job ever produced a pass/fail signal —
# because the workflow's concurrency group was shared across every push to
# main with cancel-in-progress:true, so each new commit killed the prior
# run before it validated anything. Fixed 2026-07-12 (commit ac457773f89b):
# main now uses a PER-SHA concurrency group, so no push can ever supersede
# another's run. The structural regression is caught statically by
# `node scripts/audit-workflow-concurrency.js` (part of the lint-workflows
# CI job). This script is the empirical companion check: pull the last N
# real runs from the GitHub API and confirm the mid-setup-cancel rate is
# actually low in practice, not just structurally impossible in theory.
#
# "Mid-setup cancelled" = conclusion=cancelled AND no job in the run
# reached success or failure (nothing validated before the cancel). A run
# where e.g. Unit Tests=failure and Lint Workflows=cancelled (that job hit
# its own timeout mid-checkout) is NOT mid-setup-cancelled — it validated.
#
# Usage: scripts/ci-health-check.sh [run_count] [threshold_pct]
#   run_count      how many recent main push runs of test.yml to sample (default 20)
#   threshold_pct  max acceptable mid-setup-cancel rate, whole percent (default 30)
#
# Exit codes:
#   0  healthy — mid-setup-cancel rate <= threshold
#   1  unhealthy — rate exceeds threshold (investigate the concurrency block)
#   2  usage/API error

set -euo pipefail

RUN_COUNT="${1:-20}"
THRESHOLD_PCT="${2:-30}"

if ! command -v gh >/dev/null 2>&1; then
  echo "::error::gh CLI not found" >&2
  exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "::error::jq not found" >&2
  exit 2
fi

echo "Fetching last ${RUN_COUNT} test.yml push runs on main..."
RUNS_JSON=$(gh run list --workflow=test.yml --branch=main --event=push --limit="${RUN_COUNT}" --json databaseId,conclusion,status)

RUN_IDS=$(echo "${RUNS_JSON}" | jq -r '.[] | select(.status=="completed") | .databaseId')

TOTAL=0
CANCELLED_MID_SETUP=0
CANCELLED_VALIDATED=0
OTHER=0

for id in ${RUN_IDS}; do
  TOTAL=$((TOTAL + 1))
  RUN_DETAIL=$(gh run view "${id}" --json conclusion,jobs)
  CONCLUSION=$(echo "${RUN_DETAIL}" | jq -r '.conclusion')

  if [ "${CONCLUSION}" != "cancelled" ]; then
    OTHER=$((OTHER + 1))
    continue
  fi

  VALIDATED=$(echo "${RUN_DETAIL}" | jq '[.jobs[] | select(.conclusion == "success" or .conclusion == "failure")] | length')
  if [ "${VALIDATED}" -eq 0 ]; then
    CANCELLED_MID_SETUP=$((CANCELLED_MID_SETUP + 1))
  else
    CANCELLED_VALIDATED=$((CANCELLED_VALIDATED + 1))
  fi
done

if [ "${TOTAL}" -eq 0 ]; then
  echo "::error::No completed test.yml runs found on main to sample" >&2
  exit 2
fi

RATE_PCT=$((CANCELLED_MID_SETUP * 100 / TOTAL))

echo ""
echo "=== CI Health: test.yml on main (last ${TOTAL} completed runs) ==="
echo "  Mid-setup cancelled (never validated):        ${CANCELLED_MID_SETUP} (${RATE_PCT}%)"
echo "  Cancelled after validating (e.g. job timeout): ${CANCELLED_VALIDATED}"
echo "  Other (success/failure):                       ${OTHER}"
echo ""

if [ "${RATE_PCT}" -gt "${THRESHOLD_PCT}" ]; then
  echo "::error::${RATE_PCT}% of runs cancelled before validating anything — exceeds the ${THRESHOLD_PCT}% threshold. Check .github/workflows/test.yml's concurrency block (should be per-sha on main) and run 'node scripts/audit-workflow-concurrency.js'." >&2
  exit 1
fi

echo "Healthy: ${RATE_PCT}% mid-setup-cancel rate is within the ${THRESHOLD_PCT}% threshold (historical baseline before the 2026-07-12 per-sha fix was ~75%)."
exit 0

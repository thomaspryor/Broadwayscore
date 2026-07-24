#!/usr/bin/env bash
# wait-for-run.sh — rate-limit-cheap replacement for `gh run watch`.
#
# Usage: scripts/lib/wait-for-run.sh <run-id> [timeout-min]   (timeout default 45)
#
# Why: `gh run watch` re-fetches the run AND its jobs every REFRESH seconds
# (default 3s = ~1200 core-API calls/hr per watch; the 5000/hr user quota was
# zeroed twice on 2026-07-11 by concurrent default-interval watches). This
# script makes ONE `gh run view --json status,conclusion` call per 60-90s
# iteration (no jobs expansion) and consults the free rate_limit endpoint
# before the first poll and every 10th poll, backing off when quota is low.
# A 20-min run costs ~15-20 API calls instead of ~400.
#
# Runs against the repo of the current working directory (same as gh run watch).
#
# Exit codes:
#   0  run completed with conclusion "success"
#   1  run completed with any other conclusion (failure, cancelled, ...)
#   2  timed out waiting (run still in progress)
#   3  usage error / run not found / persistent gh failure
#
# Gotcha (2026-07-24): when invoked via Bash run_in_background:true, the
# harness itself killed several 70-100min backgrounded calls to this script
# around the ~25-30min mark, well before the requested timeout — the run
# was fine, only the background wrapper died. Windows of ~25min ran to
# their own exit code every time. If a long CI wait keeps showing status
# "killed" instead of a real exit code, re-issue with a shorter timeout-min
# and re-check the run directly (gh run view) rather than assuming failure.

set -u

RUN_ID="${1:-}"
TIMEOUT_MIN="${2:-45}"

if [[ -z "$RUN_ID" || ! "$RUN_ID" =~ ^[0-9]+$ ]]; then
  echo "usage: wait-for-run.sh <run-id> [timeout-min]" >&2
  exit 3
fi
if [[ ! "$TIMEOUT_MIN" =~ ^[0-9]+$ || "$TIMEOUT_MIN" -eq 0 ]]; then
  echo "wait-for-run.sh: timeout-min must be a positive integer (got: $TIMEOUT_MIN)" >&2
  exit 3
fi

BASE_INTERVAL=60          # seconds; each sleep adds 0-30s of jitter
INTERVAL=$BASE_INTERVAL
DEADLINE=$(( $(date +%s) + TIMEOUT_MIN * 60 ))
POLLS=0
ERRORS=0

fmt_epoch() {
  # BSD (macOS) date first, GNU date fallback.
  date -r "$1" '+%H:%M:%S %Z' 2>/dev/null || date -d "@$1" '+%H:%M:%S %Z' 2>/dev/null || echo "epoch $1"
}

check_quota() {
  # rate_limit is a free endpoint — it does not count against the quota.
  local out remaining reset
  out=$(gh api rate_limit --jq '.resources.core | "\(.remaining) \(.reset)"' 2>/dev/null) || return 0
  remaining="${out%% *}"
  reset="${out##* }"
  [[ "$remaining" =~ ^[0-9]+$ ]] || return 0
  if (( remaining < 100 )); then
    INTERVAL=300
    echo "⚠️  core API quota critical: ${remaining} left, resets $(fmt_epoch "$reset") — polling every 5 min" >&2
  elif (( remaining < 500 )); then
    INTERVAL=$(( BASE_INTERVAL * 2 ))
    echo "⚠️  core API quota low: ${remaining} left — poll interval ${INTERVAL}s" >&2
  else
    INTERVAL=$BASE_INTERVAL
  fi
}

check_quota

while :; do
  POLLS=$(( POLLS + 1 ))
  if (( POLLS % 10 == 0 )); then
    check_quota
  fi

  if OUT=$(gh run view "$RUN_ID" --json status,conclusion --jq '"\(.status) \(.conclusion)"' 2>&1); then
    ERRORS=0
    # stderr is folded into OUT for error diagnosis; gh warnings can precede
    # the jq line, so parse only the last line.
    LINE=$(printf '%s\n' "$OUT" | tail -n 1 | tr -d '\r')
    STATUS="${LINE%% *}"
    CONCLUSION="${LINE##* }"
    if [[ "$STATUS" == "completed" ]]; then
      echo "run $RUN_ID: $CONCLUSION"
      [[ "$CONCLUSION" == "success" ]] && exit 0
      exit 1
    fi
    echo "run $RUN_ID: $STATUS (poll $POLLS, next check in ~${INTERVAL}s)"
  else
    ERRORS=$(( ERRORS + 1 ))
    if echo "$OUT" | grep -qiE 'could not find|not found|no run'; then
      # A 404 in the first couple of polls can be list→view eventual
      # consistency right after dispatch — keep polling briefly.
      if (( POLLS >= 3 )); then
        echo "run $RUN_ID: not found — $OUT" >&2
        exit 3
      fi
    fi
    if echo "$OUT" | grep -qiE 'rate limit|HTTP 403'; then
      # Never hammer a rate-limited API — read the reset time and back way off.
      check_quota
      INTERVAL=300
    fi
    if (( ERRORS >= 5 )); then
      echo "run $RUN_ID: giving up after $ERRORS consecutive gh errors — last: $OUT" >&2
      exit 3
    fi
    echo "⚠️  gh run view error ($ERRORS/5): $OUT" >&2
  fi

  if (( $(date +%s) + INTERVAL > DEADLINE )); then
    echo "run $RUN_ID: timed out after ${TIMEOUT_MIN} min (still in progress)" >&2
    exit 2
  fi
  sleep $(( INTERVAL + RANDOM % 31 ))
done

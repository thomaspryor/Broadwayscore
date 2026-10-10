#!/bin/bash
# Retry `gh workflow run` on GitHub API rate-limit errors (HTTP 403/429,
# secondary rate limits). The bare command aborts the calling step under
# `set -e`, silently losing the downstream dispatch.
#
# Source this script from any workflow step that auto-triggers a downstream
# workflow, then use `dispatch_with_retry`:
#
#   source scripts/lib/dispatch-with-retry.sh
#   dispatch_with_retry collect-review-texts.yml \
#     -f show_filter="$SHOWS" \
#     -f max_reviews=300 \
#     || true   # safety-net cron will retry within 4h
#
# Defaults: 4 attempts, exponential backoff (5s, 15s, 45s). On final failure
# emits `::warning::` and returns 1; callers should use `|| true` so the step
# doesn't fail the run — the 4-hourly rebuild-fast cron is the safety net.
#
# Why a shared script: this bug class hit twice on 2026-05-16
# (llm-ensemble-score.yml then scrape-bww-reviews.yml, both via the same
# Auto-trigger pattern). 30+ workflows in this repo do `gh workflow run`;
# rather than inline the retry loop everywhere, source this once per file.

dispatch_with_retry() {
  local workflow="$1"; shift
  local attempt=0
  local max_attempts="${DISPATCH_MAX_ATTEMPTS:-4}"
  local backoff="${DISPATCH_INITIAL_BACKOFF:-5}"
  local err_output exit_code

  while [ "$attempt" -lt "$max_attempts" ]; do
    attempt=$((attempt + 1))
    err_output=$(gh workflow run "$workflow" "$@" 2>&1) && exit_code=0 || exit_code=$?
    if [ "$exit_code" -eq 0 ]; then
      [ -n "$err_output" ] && echo "$err_output"
      echo "Dispatched $workflow on attempt $attempt."
      return 0
    fi

    echo "Attempt $attempt/$max_attempts to dispatch $workflow failed (exit $exit_code):"
    echo "$err_output"

    if echo "$err_output" | grep -qiE 'rate.?limit|HTTP 403|HTTP 429|secondary'; then
      if [ "$attempt" -lt "$max_attempts" ]; then
        echo "Rate-limit detected, sleeping ${backoff}s before retry..."
        sleep "$backoff"
        backoff=$((backoff * 3))
        continue
      fi
    fi
    break
  done

  echo "::warning::Failed to dispatch $workflow after $attempt attempt(s). The 4-hourly rebuild-fast.yml cron (or the next scheduled rebuild) will pick up unrebuilt work within 4 hours."
  return 1
}

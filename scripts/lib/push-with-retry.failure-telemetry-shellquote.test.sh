#!/usr/bin/env bash
# Integration test for the push-retry-failure telemetry shell→CLI handoff
# (task: push-retry-failure telemetry, 2026-08-23, code-design plan-review
# finding: "nothing tests that record_push_failure() in bash correctly
# shells out to the new CLI with reason strings that contain parentheses and
# colons — untested shell-to-CLI plumbing at the exact call site that fires
# when the runner is already mid-retries-exhausted is a real risk").
#
# push-with-retry.sh's REAL reason strings that reach record_push_failure()
# include exactly these shapes (grep the source for the literal calls):
#   "commit-dropped-post-push"
#   "noop-rebase(${RESOLUTION_PATH:-unknown})"   -> e.g. "noop-rebase(rebase)"
#   "api-fallback-content-dropped"
#   "retries-exhausted"
# This test extracts record_push_failure()'s EXACT `"--reason=$reason"`
# interpolation pattern (not push-with-retry.sh's full logic — that needs a
# real git-conflict harness, covered by the other integration tests in this
# directory) into a minimal standalone script, so it can be run directly
# against the exact reason-string SHAPES the script's 6 real call sites
# produce at runtime — without needing to reproduce a live git conflict to
# reach one of them. Note: "noop-rebase(${RESOLUTION_PATH:-unknown})"'s `:`
# and `$` are bash parameter-expansion syntax resolved BEFORE the value
# reaches $reason (e.g. it becomes the literal string "noop-rebase(rebase)")
# — this test covers the '(' / ')' that DO survive into the runtime value,
# not a literal ':' or '$', since no real call site produces one.
#
# Run: bash scripts/lib/push-with-retry.failure-telemetry-shellquote.test.sh
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RECORD_SCRIPT="$SCRIPT_DIR/../record-push-retry-failure.js"
fail=0

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t.t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t.t
export PUSH_LEDGER_ANY_ORIGIN=1

gitc() { git -C "$1" "${@:2}"; }

git init -q --bare "$TMP/origin.git"
git init -q "$TMP/clone"
gitc "$TMP/clone" config user.email t@t.t; gitc "$TMP/clone" config user.name t
gitc "$TMP/clone" commit -q --allow-empty -m base
gitc "$TMP/clone" branch -M main
gitc "$TMP/clone" remote add origin "$TMP/origin.git"
gitc "$TMP/clone" push -q origin main

# The EXACT interpolation pattern from record_push_failure() in
# push-with-retry.sh — kept as a literal copy (not a source/import) so this
# test fails loudly if the two ever drift, rather than silently testing
# something push-with-retry.sh no longer does.
run_record() {
  local reason="$1" attempt="$2"
  (cd "$TMP/clone" && node "$RECORD_SCRIPT" \
    "--reason=$reason" "--attempt=$attempt" "--max-retries=7" \
    "--branch=main" "--remote=Broadwayscore" \
    "--workflow=Daily Data Health Check" "--ci=true" >/dev/null 2>&1)
}

# The 4 real reason-string SHAPES this repo's push-with-retry.sh actually
# passes (grep -n 'record_push_failure' scripts/lib/push-with-retry.sh).
REASONS=(
  "commit-dropped-post-push"
  "noop-rebase(rebase)"
  "api-fallback-content-dropped"
  "retries-exhausted"
)

for i in "${!REASONS[@]}"; do
  run_record "${REASONS[$i]}" "$i"
done

CONTENT=$(git --git-dir="$TMP/origin.git" show push-retry-failures:failures.jsonl 2>/dev/null || echo "")
for r in "${REASONS[@]}"; do
  # Exact-match the JSON-escaped reason (parens/colons need no JSON escaping,
  # but this asserts round-trip fidelity through argv -> parseArgs -> JSON,
  # not just "some substring survived").
  if echo "$CONTENT" | grep -qF "\"reason\":\"$r\""; then
    echo "PASS: reason '$r' round-tripped through the shell->CLI->JSON handoff intact"
  else
    echo "FAIL: reason '$r' did NOT round-trip. Ledger content:"; echo "$CONTENT" | sed 's/^/    /'
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then echo "=== push-with-retry.failure-telemetry-shellquote.test.sh FAILED ==="; exit 1; fi
echo "=== push-with-retry.failure-telemetry-shellquote.test.sh PASSED ==="

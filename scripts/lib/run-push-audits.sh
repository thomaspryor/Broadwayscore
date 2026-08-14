#!/usr/bin/env bash
#
# run-push-audits.sh — shared range-scoped CI-parity audit dispatch.
#
# Extracted from scripts/hooks/pre-push (card #835) so scripts/merge-worktree-to-main.sh
# can run the SAME gates instead of none. Before this, a worktree branch could
# merge straight onto local main with zero audits, and the violation only
# surfaced later when an unrelated session's `git push` hit the pre-push hook
# — blocking the wrong person, who never sees the actual fix needed. Now both
# the hook (at push time) and the merge script (at merge time) call this one
# runner, so they can't drift apart on which gates exist or how they're scoped.
#
# USAGE
#   printf '%s\n' "${CHANGED_FILES[@]}" | scripts/lib/run-push-audits.sh
#   scripts/lib/run-push-audits.sh file1.js file2.ts ...   # argv form
#
#   --list   print the labels of audits that WOULD run, one per line, without
#            running them. Must be the first argument. Used by
#            run-push-audits.test.mjs to assert selection logic fast and
#            deterministically, without paying for real (slow, repo-state-
#            dependent) audit runs.
#
# An empty file list (no argv, empty stdin) selects no audits and exits 0 —
# there's nothing to check when nothing changed.
#
# Exit 0 = all applicable audits passed (or none applied).
# Exit 1 = an audit failed; failure detail already printed.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$REPO_ROOT"

LIST_ONLY=0
if [ "${1:-}" = "--list" ]; then
  LIST_ONLY=1
  shift
fi

if [ "$#" -gt 0 ]; then
  CHANGED_FILES="$(printf '%s\n' "$@")"
else
  CHANGED_FILES="$(cat)"
fi

# Nothing changed — nothing to audit.
if [ -z "$(echo "$CHANGED_FILES" | tr -d '[:space:]')" ]; then
  exit 0
fi

FAIL=0

run_audit() {
  local label="$1"
  local script="$2"
  shift 2
  # Remaining args ("$@") are passed straight through to `node "$script"` —
  # e.g. audit-orphan-tests.js's --scope-stdin (card #1488). Existing callers
  # that pass no extra args are unaffected.
  if [ "$LIST_ONLY" = "1" ]; then
    echo "$label"
    return 0
  fi
  # PID+random-scoped, not a fixed filename: this repo commonly has many
  # concurrent local invocations (parallel worktree sessions), and a shared
  # /tmp path let one process's rm -f race another's still-in-flight cat,
  # corrupting/blanking the error output it prints (same fix as pre-push's
  # original run_audit()).
  local AUDIT_OUT="/tmp/push-audit.$$.$RANDOM.out"
  if ! node "$script" "$@" >"$AUDIT_OUT" 2>&1; then
    echo ""
    echo "=== AUDIT BLOCKED: $label failed ==="
    echo ""
    cat "$AUDIT_OUT"
    rm -f "$AUDIT_OUT"
    return 1
  fi
  rm -f "$AUDIT_OUT"
  return 0
}

# Unbounded git fetch on a shallow-checkout path (task #420).
if echo "$CHANGED_FILES" | grep -qE "^scripts/.*\.(js|mjs|cjs|ts|sh)$|^\.github/(workflows|actions)/.*\.ya?ml$"; then
  run_audit "unbounded-fetch" "scripts/audit-unbounded-fetch.js" || FAIL=1
fi

# Orphan/unregistered test detection.
if echo "$CHANGED_FILES" | grep -qE "^tests/unit/.*\.test\.(mjs|ts|js)$|^\.github/workflows/test\.yml$|^scripts/audit-(tests-vs-derived-data|orphan-tests)\.js$"; then
  run_audit "tests-vs-derived-data" "scripts/audit-tests-vs-derived-data.js" || FAIL=1
  # --scope-stdin (card #1488): only orphans among THIS push's changed files
  # are blocking; pre-existing orphans elsewhere print informational and
  # don't fail an unrelated push. CI's own direct calls to
  # audit-orphan-tests.js (test.yml) never pass this flag, so they keep
  # doing the full-repo check as the safety net.
  printf '%s\n' "$CHANGED_FILES" | run_audit "orphan-tests" "scripts/audit-orphan-tests.js" --scope-stdin || FAIL=1
fi

# Playwright evaluate-click anti-pattern.
if echo "$CHANGED_FILES" | grep -qE "^tests/e2e/.*\.(ts|tsx|mjs|js)$|^scripts/audit-playwright-evaluate-click\.js$"; then
  run_audit "playwright-evaluate-click" "scripts/audit-playwright-evaluate-click.js" || FAIL=1
fi

# Write-routing lint (same script CI runs in test.yml's Lint Workflows job).
if echo "$CHANGED_FILES" | grep -qE "^scripts/[^/]+\.js$|^scripts/lint-write-routing\.sh$|^\.review-write-guard-exempt\.txt$|^\.reviews-json-write-exempt\.txt$|^\.shows-json-write-exempt\.txt$|^\.commercial-json-write-exempt\.txt$|^\.audience-buzz-json-write-exempt\.txt$"; then
  if [ "$LIST_ONLY" = "1" ]; then
    echo "write-routing"
  elif [ -f scripts/lint-write-routing.sh ]; then
    ROUTING_OUT="/tmp/push-audit-routing.$$.$RANDOM.out"
    if ! bash scripts/lint-write-routing.sh all >"$ROUTING_OUT" 2>&1; then
      echo ""
      echo "=== AUDIT BLOCKED: write-routing lint failed (CI would go red) ==="
      echo ""
      cat "$ROUTING_OUT"
      FAIL=1
    fi
    rm -f "$ROUTING_OUT"
  fi
fi

exit $FAIL

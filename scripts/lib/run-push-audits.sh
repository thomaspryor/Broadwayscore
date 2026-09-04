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

# Workflow-subject guards (BRO-2785). tests/unit/workflow-line-length.test.mjs
# (500-char cap on .github/workflows/*.yml lines) and
# scripts/audit-workflow-concurrency.js (cancel-in-progress guard) both assert
# properties of workflow file CONTENT but were never wired into a push-time
# gate — only CI (test.yml) ran them, and Lint Workflows' actionlint doesn't
# cover either check. Reproduced live 2026-09-04 landing BRO-2771: a workflow
# edit pushed a hint string to 504 chars, this script's caller (merge-worktree-
# to-main.sh) reported success, and the 500-char cap failed in CI on main
# minutes later. Both call sites of THIS file (scripts/hooks/pre-push and
# scripts/merge-worktree-to-main.sh) get the fix for free with zero changes to
# either caller — that's the whole point of this shared runner (see header).
# actionlint itself runs via the run-actionlint-if-present.js wrapper (skips
# rather than blocks when the binary isn't on PATH — CI installs it fresh
# every run; a local checkout may not have it).
#
# scripts/audit-workflow-concurrency.js already also runs from pre-push's own
# separate inline "Node workflow audits" block — the small (<1s) duplicate run
# on a plain `git push` is accepted rather than touching that unrelated block
# in this shared-infra change (CLAUDE.md rule 18 scope discipline).
if echo "$CHANGED_FILES" | grep -qE "^\.github/workflows/.*\.ya?ml$|^tests/unit/workflow-line-length\.test\.mjs$|^scripts/lib/workflow-line-length\.js$|^scripts/audit-workflow-concurrency\.js$|^scripts/lib/ci-cancellation-guard\.js$|^scripts/lib/run-actionlint-if-present\.js$"; then
  run_audit "workflow-line-length" "tests/unit/workflow-line-length.test.mjs" || FAIL=1
  run_audit "workflow-concurrency" "scripts/audit-workflow-concurrency.js" || FAIL=1
  run_audit "workflow-actionlint" "scripts/lib/run-actionlint-if-present.js" || FAIL=1
fi

# Orphan/unregistered test detection.
#
# BRO-2751: this pattern was a THIRD hand-maintained copy of the test-file
# extension list, and it had already drifted — `(mjs|ts|js)` while
# audit-orphan-tests.js scans `(mjs|ts|js|cjs|sh)` — and was scoped to
# ^tests/unit/ while that audit also scans scripts/ top level. A push adding
# scripts/foo.test.sh or tests/unit/foo.test.cjs therefore skipped this local
# gate entirely: exactly the drift that let two bash tests run in zero CI jobs.
# CI still runs the audit unconditionally (test.yml, "Audit — no orphan unit
# tests"), so this was a local-gate hole, not a coverage hole — but the local
# gate exists to catch it BEFORE the push. Extensions and both scanned roots
# now match audit-orphan-tests.js. The canonical list lives in
# scripts/lib/test-manifest.js (TEST_FILE_EXTENSIONS); this file is shell, so
# it cannot require() it — scripts/lib/colocated-test-ci-coverage.test.mjs
# asserts the two stay in sync.
if echo "$CHANGED_FILES" | grep -qE "^(tests/unit|scripts)/[^/]*\.test\.(mjs|ts|js|cjs|sh)$|^\.github/workflows/test\.yml$|^scripts/audit-(tests-vs-derived-data|orphan-tests)\.js$"; then
  run_audit "tests-vs-derived-data" "scripts/audit-tests-vs-derived-data.js" || FAIL=1
  # --scope-stdin (card #1488): only orphans among THIS push's changed files
  # are blocking; pre-existing orphans elsewhere print informational and
  # don't fail an unrelated push. CI's own direct calls to
  # audit-orphan-tests.js (test.yml) never pass this flag, so they keep
  # doing the full-repo check as the safety net.
  #
  # LIST_ONLY must skip the pipe entirely, not just let run_audit's early
  # return not-read it: with `set -o pipefail` (line 27), a $CHANGED_FILES
  # payload larger than the pipe buffer would make printf block on a full
  # buffer with nobody draining it (run_audit's LIST_ONLY branch returns
  # before touching stdin), get SIGPIPE, and fail the pipeline's exit status
  # even though the (never-run) audit itself didn't fail — silently flipping
  # `--list` mode to exit 1 on a large diff (found in ship-check review).
  if [ "$LIST_ONLY" = "1" ]; then
    run_audit "orphan-tests" "scripts/audit-orphan-tests.js" --scope-stdin || FAIL=1
  else
    printf '%s\n' "$CHANGED_FILES" | run_audit "orphan-tests" "scripts/audit-orphan-tests.js" --scope-stdin || FAIL=1
  fi
fi

# Playwright evaluate-click anti-pattern.
if echo "$CHANGED_FILES" | grep -qE "^tests/e2e/.*\.(ts|tsx|mjs|js)$|^scripts/audit-playwright-evaluate-click\.js$"; then
  run_audit "playwright-evaluate-click" "scripts/audit-playwright-evaluate-click.js" || FAIL=1
fi

# Write-routing lint (same script CI runs in test.yml's Lint Workflows job).
#
# --scope-stdin (card #1826): this repo's main checkout is shared by 20+
# concurrent worktree/cmux sessions, so an unscoped full-tree scan here picks
# up ANY session's stray/untracked scripts/*.js file — not just files this
# push/merge actually touches — and blocks an unrelated push on a violation
# it never introduced. CI's own direct calls to lint-write-routing.sh
# (test.yml) don't pass this flag and keep scanning the whole checkout —
# correct there, since CI's checkout IS the branch under test. Scoping still
# falls back to a full scan when an allowlist or the lint script itself is in
# CHANGED_FILES (lint-write-routing.sh's own candidate_files() handles that).
#
# Trigger matches .mjs/.ts too (not just .js): lint-write-routing.sh's
# shows-json/commercial-json/audience-buzz-json checks cover all three
# extensions (candidate_files "$ALLOWLIST" js mjs ts), so a top-level
# scripts/*.mjs or scripts/*.ts writer must be able to trigger this audit
# locally the same way a .js one does — otherwise it silently skips the local
# gate and only gets caught later in CI (task #1826 review finding).
if echo "$CHANGED_FILES" | grep -qE "^scripts/[^/]+\.(js|mjs|ts)$|^scripts/lint-write-routing\.sh$|^\.review-write-guard-exempt\.txt$|^\.reviews-json-write-exempt\.txt$|^\.shows-json-write-exempt\.txt$|^\.commercial-json-write-exempt\.txt$|^\.audience-buzz-json-write-exempt\.txt$"; then
  if [ "$LIST_ONLY" = "1" ]; then
    echo "write-routing"
  elif [ -f scripts/lint-write-routing.sh ]; then
    ROUTING_OUT="/tmp/push-audit-routing.$$.$RANDOM.out"
    if ! printf '%s\n' "$CHANGED_FILES" | bash scripts/lint-write-routing.sh --scope-stdin all >"$ROUTING_OUT" 2>&1; then
      echo ""
      echo "=== AUDIT BLOCKED: write-routing lint failed (CI would go red) ==="
      echo ""
      cat "$ROUTING_OUT"
      FAIL=1
    fi
    rm -f "$ROUTING_OUT"
  fi
fi

# Help-flag safety — scripts that do REAL work on `--help` (task #498 class).
# Same script CI runs in test.yml's "Audit — help-flag safety" step.
#
# Why this gate moved from CI-only to push-time: it is the single most frequent
# recurring cause of a red main in this repo (25+ separate "add the missing
# --help guard" fix commits since June, three of them on the single night of
# 2026-08-14, when audit-sibling-title-misroute.js and cyrus-webhook-drain.js
# reddened run 31863276943 hours after landing). Detecting it in CI puts the cost
# on whoever pushes NEXT — they inherit a red main they did not cause and cannot
# fix from their own diff — which is exactly the cost-transfer this shared runner
# was extracted to stop (card #835, see the header). The author is the only
# person who can fix it cheaply, and push time is the last moment they still
# hold it.
#
# Affordable to run in full: ~0.7s for all 917 scripts, no network, no repo
# state, so there is no reason to scope it to the changed files (and scoping it
# would miss a guard DELETED from a file the push doesn't otherwise touch).
# Fires on the same `scripts/*.js` shape as the write-routing lint above, plus
# the audit's own baseline file.
if echo "$CHANGED_FILES" | grep -qE "^scripts/[^/]+\.js$|^scripts/\.help-flag-safety-baseline\.json$"; then
  run_audit "help-flag-safety" "scripts/audit-help-flag-safety.js" || FAIL=1
fi

exit $FAIL

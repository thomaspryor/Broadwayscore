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

# Committed merge-conflict markers (BRO-6687). push-with-retry.sh ran this
# detector for CI pushes only, so a land/<name> push from a session carried a
# stash-apply conflict straight to the Land run. Any changed file; deleted
# files are skipped (--list keeps every path so selection stays deterministic).
# Intentional fixtures: PUSH_SKIP_CONFLICT_CHECK=1, as in push-with-retry.sh.
if [ "${PUSH_SKIP_CONFLICT_CHECK:-}" != "1" ]; then
  CM_FILES=()
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if [ "$LIST_ONLY" = "1" ] || [ -f "$f" ]; then CM_FILES+=("$f"); fi
  done <<<"$CHANGED_FILES"
  if [ ${#CM_FILES[@]} -gt 0 ]; then
    run_audit "conflict-markers" "scripts/lib/conflict-markers.js" "${CM_FILES[@]}" || FAIL=1
  fi
fi

# Unbounded git fetch on a shallow-checkout path (task #420).
if grep -qE "^scripts/.*\.(js|mjs|cjs|ts|sh)$|^\.github/(workflows|actions)/.*\.ya?ml$" <<<"$CHANGED_FILES"; then
  run_audit "unbounded-fetch" "scripts/audit-unbounded-fetch.js" || FAIL=1
fi

# Cheap CI-parity unit tests (BRO-5621). Two landings were refused by Land CI
# for failures these tests catch before the push: a new scoring-watchlists
# entry not mirrored in autonomous-eligibility EXCLUDED_FILES, a new top-level
# script missing from test.yml on.push.paths, and a new scripts/lib matcher
# without foldDiacritics. Each cost a 25-30 min land cycle. The two ~1s tests
# run on any scripts/ source edit; the ~10s top-level coverage test only for a
# new/changed top-level non-test script, and only when the test-registration
# block below has not already run it (TOPLEVEL_RAN).
TOPLEVEL_RAN=0
if grep -qE "^scripts/.*\.(js|mjs|cjs|ts)$" <<<"$CHANGED_FILES"; then
  run_audit "ci-parity-autonomous-eligibility" "scripts/lib/autonomous-eligibility.test.mjs" || FAIL=1
  run_audit "ci-parity-sibling-matchers-diacritics" "tests/unit/sibling-matchers-diacritics.test.mjs" || FAIL=1
fi

# Direct cmux spawns with no socket credential (BRO-3001). Push-time, not
# CI-only, on purpose: the two sites this caught were merged to main and ran
# for hours before anyone looked, and the failure mode is silent — the call is
# simply denied and the caller degrades. Same trigger as unbounded-fetch since
# a new spawn site can appear in any script.
#
# --scope-stdin for the same reason lint-write-routing uses it (see the block
# below): the main checkout is shared by 20+ concurrent sessions, so an
# unscoped scan here blocks whoever pushes next on someone else's violation.
# Out-of-scope violations are still printed, just not fatal. CI's own call in
# test.yml passes no flag and scans the whole tree, which is right there.
# LIST_ONLY must skip the pipe entirely — same reason as orphan-tests below:
# run_audit returns before reading stdin, leaving a writer with no reader.
if grep -qE "^scripts/.*\.(js|mjs|cjs|ts)$" <<<"$CHANGED_FILES"; then
  if [ "$LIST_ONLY" = "1" ]; then
    run_audit "cmux-spawn-credential" "scripts/audit-cmux-spawn-credential.js" --scope-stdin || FAIL=1
  else
    printf '%s\n' "$CHANGED_FILES" | run_audit "cmux-spawn-credential" "scripts/audit-cmux-spawn-credential.js" --scope-stdin || FAIL=1
  fi
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
if grep -qE "^\.github/workflows/.*\.ya?ml$|^tests/unit/workflow-line-length\.test\.mjs$|^scripts/lib/workflow-line-length\.js$|^scripts/audit-workflow-concurrency\.js$|^scripts/lib/ci-cancellation-guard\.js$|^scripts/lib/run-actionlint-if-present\.js$" <<<"$CHANGED_FILES"; then
  run_audit "workflow-line-length" "tests/unit/workflow-line-length.test.mjs" || FAIL=1
  run_audit "workflow-concurrency" "scripts/audit-workflow-concurrency.js" || FAIL=1
  run_audit "workflow-actionlint" "scripts/lib/run-actionlint-if-present.js" || FAIL=1
fi

# Orphan/unregistered test detection, and CI-registration coverage generally.
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
#
# BRO-3239: the trigger above stayed EXTENSION-synced but not DEPTH-synced —
# `[^/]*` matches only a file directly under tests/unit/ or scripts/, never
# scripts/lib/**, so scripts/lib/push-with-retry.stall-diagnostics.test.sh
# (BRO-3213) never fired this block at all. And even when triggered, this
# block only ran audit-tests-vs-derived-data.js and audit-orphan-tests.js —
# neither of which covers scripts/lib/ (colocated-test-ci-coverage.test.mjs's
# own header explains why audit-orphan-tests.js excludes it) or the
# manifest-vs-push-path / top-level-script-vs-push-path gap classes that
# actually caught BRO-3219 and BRO-3127. Three main-red incidents in one day
# (2026-09-13) all fell through this exact seam. Added below, same block
# (they all answer "is this test file actually wired into CI"), each already
# a plain node:test file that runs clean via a bare `node <file>` the same way
# workflow-line-length below does — confirmed ~1.4s combined added runtime,
# same order of magnitude as the help-flag-safety block's ~0.7s.
#
# Self-trigger list also covers scripts/lib/test-manifest.js and
# scripts/lib/test-yml-push-paths.js (adversarial review, BRO-3239): every one
# of the 3 new audits require()s one or both as its canonical source of truth
# (TEST_FILE_EXTENSIONS, MANIFESTS, push-path glob translation), so editing
# either alone must still re-run the audits that depend on it, or a broken
# change to the canonical list ships without its own gate firing.
# BRO-2483: scripts/lib/unit-test-collection.js joined it (it now decides the
# node unit batch, which test-manifest.js resolves through).
if grep -qE "^(tests/unit|scripts)/[^/]*\.test\.(mjs|ts|js|cjs|sh)$|^scripts/lib/.*\.test\.(mjs|ts|js|cjs|sh)$|^\.github/workflows/test\.yml$|^scripts/audit-(tests-vs-derived-data|orphan-tests|toplevel-script-test-yml-coverage)\.js$|^scripts/lib/(test-yml-manifest-paths|test-manifest|test-yml-push-paths|unit-test-collection)\.js$|^tests/(unit-test-manifest(-tsx)?|e2e-unit-test-manifest)\.txt$" <<<"$CHANGED_FILES"; then
  run_audit "tests-vs-derived-data" "scripts/audit-tests-vs-derived-data.js" || FAIL=1
  # scripts/lib/ colocated-test coverage (BRO-2749/BRO-3239): is every
  # scripts/lib/*.test.* file actually invoked by a workflow run: body?
  # audit-orphan-tests.js structurally cannot see this (glob-blind, see its
  # own header) — this is the only push-time check that can.
  run_audit "colocated-test-ci-coverage" "scripts/lib/colocated-test-ci-coverage.test.mjs" || FAIL=1
  # Manifest <-> push-path reachability (BRO-3239): a test registered in a
  # manifest that no on.push.paths glob reaches runs in CI but a push
  # touching only it triggers zero CI — the BRO-3219 shape.
  run_audit "test-yml-manifest-paths" "scripts/lib/test-yml-manifest-paths.test.mjs" || FAIL=1
  # Top-level scripts/*.test.* source coverage (BRO-3239): a manifest-
  # registered tests/**/*.test.* whose required top-level scripts/ SOURCE has
  # no push-path entry — the BRO-3219/BRO-3127 shape.
  run_audit "toplevel-script-test-yml-coverage" "scripts/audit-toplevel-script-test-yml-coverage.test.mjs" || FAIL=1
  TOPLEVEL_RAN=1
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

if [ "$TOPLEVEL_RAN" = "0" ] && grep -qE "^scripts/[^/]+\.(js|mjs|ts)$" <<<"$CHANGED_FILES"; then
  run_audit "ci-parity-toplevel-script-test-yml" "scripts/audit-toplevel-script-test-yml-coverage.test.mjs" || FAIL=1
fi

# Playwright evaluate-click anti-pattern.
if grep -qE "^tests/e2e/.*\.(ts|tsx|mjs|js)$|^scripts/audit-playwright-evaluate-click\.js$" <<<"$CHANGED_FILES"; then
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
if grep -qE "^scripts/[^/]+\.(js|mjs|ts)$|^scripts/lint-write-routing\.sh$|^\.review-write-guard-exempt\.txt$|^\.reviews-json-write-exempt\.txt$|^\.shows-json-write-exempt\.txt$|^\.commercial-json-write-exempt\.txt$|^\.audience-buzz-json-write-exempt\.txt$" <<<"$CHANGED_FILES"; then
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
if grep -qE "^scripts/[^/]+\.js$|^scripts/\.help-flag-safety-baseline\.json$" <<<"$CHANGED_FILES"; then
  run_audit "help-flag-safety" "scripts/audit-help-flag-safety.js" || FAIL=1
fi

# BRO-3014: blocking CI audits that were missing from this lane. Each one
# was checked to be blocking in test.yml, deterministic, independent of the
# private data clones, and fast (0.02-1.7s on the full tree). Each fires only
# when its own inputs change, so an unrelated push pays nothing.
#
# Not wired, on purpose (full list with reasons on BRO-3014):
#   - text-quality --gate: needs the private data/review-texts clone.
#   - new-gate-arming: diffs against the push's before-SHA, which this lane
#     does not have (CI passes github.event.before).
#   - linear-issuecreate-chokepoint, digest-clip-safety, alert-senders,
#     invisible-verification, direct-provider-calls, venue-write-guard: they
#     scan all of scripts/**, so they would run on nearly every push from ~20
#     concurrent sessions and, with no --scope-stdin mode, block the pusher on
#     someone else's violation in a shared checkout. CI-only until they can
#     be scoped like cmux-spawn-credential above. (nft-excluded-runtime-reads
#     is also a whole-tree scan, but of src/ only, at 0.1s, and CI keeps main
#     clean for it, so a hit almost always comes from the pusher's own diff.)
#
# workflow-hygiene and cron-health-coverage also run in scripts/hooks/pre-push's
# inline workflow block; here they reach merge-worktree-to-main.sh too. The
# sub-2s duplicate on a plain push is accepted, same as workflow-concurrency.
WF_RE='^\.github/workflows/.*\.ya?ml$'
if grep -qE "$WF_RE|^\.github/actions/.*\.ya?ml$|^scripts/audit-workflow-hygiene\.js$|^scripts/lib/(workflow-run-coverage|audit-workflow-hygiene-rules|paid-provider-push-scan|github-api-budget)\.js$" <<<"$CHANGED_FILES"; then
  run_audit "workflow-hygiene" "scripts/audit-workflow-hygiene.js" || FAIL=1
fi
if grep -qE "$WF_RE|^scripts/audit-cron-health-coverage\.js$|^scripts/lib/(cron-coverage|health-digest-crons|cron-ordering)\.js$" <<<"$CHANGED_FILES"; then
  # Same escape hatch CI honours (test.yml): a [skip-cron-audit] tag in the
  # tip commit message skips it, so the lane never blocks what CI allows.
  # PUSH_AUDITS_TIP_MESSAGE overrides the message (tests pin it, so selection
  # never depends on whatever commit happens to be HEAD).
  # A pattern match, not `| grep -q`: under pipefail an early grep exit can
  # SIGPIPE the writer and turn a match into a miss.
  _tip_msg="${PUSH_AUDITS_TIP_MESSAGE-$(git log -1 --format=%B 2>/dev/null)}"
  # A line of its own, exactly as test.yml requires: a message that merely
  # mentions the tag in prose must not skip the audit.
  if grep -Fxq "[skip-cron-audit]" <<<"$_tip_msg"; then
    [ "$LIST_ONLY" = "1" ] || echo "run-push-audits: cron-health-coverage skipped via [skip-cron-audit]"
  else
    run_audit "cron-health-coverage" "scripts/audit-cron-health-coverage.js" || FAIL=1
  fi
fi
if grep -qE "$WF_RE|^scripts/(lib/)?(audit-)?data-gate-heal-paths\.js$" <<<"$CHANGED_FILES"; then
  run_audit "data-gate-heal-paths" "scripts/audit-data-gate-heal-paths.js" || FAIL=1
fi
if grep -qE "$WF_RE|^scripts/(lib/)?(audit-)?reconcile-coverage\.js$" <<<"$CHANGED_FILES"; then
  run_audit "reconcile-coverage" "scripts/audit-reconcile-coverage.js" || FAIL=1
fi
if grep -qE "$WF_RE|^scripts/lib/push-with-retry\.sh$|^scripts/(lib/)?audit-push-retry-budgets\.js$" <<<"$CHANGED_FILES"; then
  run_audit "push-retry-budgets" "scripts/audit-push-retry-budgets.js" --fail-on-job-timeout || FAIL=1
fi
if grep -qE "$WF_RE|^scripts/lib/stage-data-changes\.sh$|^scripts/(lib/)?audit-blanket-sweep-audit-writes\.js$" <<<"$CHANGED_FILES"; then
  run_audit "blanket-sweep-audit-writes" "scripts/audit-blanket-sweep-audit-writes.js" || FAIL=1
fi
# Reads test.yml's --gate/--strict steps and the audit scripts they run.
if grep -qE "^\.github/workflows/test\.yml$|^scripts/audit-[^/]+\.js$|^scripts/lib/(gate-corpus-guard-coverage|corpus-scan-guard)\.js$" <<<"$CHANGED_FILES"; then
  run_audit "gate-corpus-guard-coverage" "scripts/audit-gate-corpus-guard-coverage.js" || FAIL=1
fi
if grep -qE "^scripts/(launchd|local-triggers)/|^scripts/autonomous-nightly\.sh$|^scripts/(lib/)?(audit-)?launchd-stale-sync-guard\.js$" <<<"$CHANGED_FILES"; then
  run_audit "launchd-stale-sync-guard" "scripts/audit-launchd-stale-sync-guard.js" || FAIL=1
fi
if grep -qE "^scripts/(audit-duplicate-of-(floor|url-mismatch)\.js|\.duplicate-of-floor\.json|lib/duplicate-of-gate\.js)$" <<<"$CHANGED_FILES"; then
  run_audit "duplicate-of-floor" "scripts/audit-duplicate-of-floor.js" || FAIL=1
fi
if grep -qE "^scripts/(sweep-we-aggregators|scrape-stagedoor-critics|audit-verifier-wiring)\.js$|^scripts/lib/show-match-verifier\.js$" <<<"$CHANGED_FILES"; then
  run_audit "verifier-wiring" "scripts/audit-verifier-wiring.js" || FAIL=1
fi
if grep -qE "^next\.config\.js$|^src/|^scripts/audit-nft-excluded-runtime-reads\.js$" <<<"$CHANGED_FILES"; then
  run_audit "nft-excluded-runtime-reads" "scripts/audit-nft-excluded-runtime-reads.js" || FAIL=1
fi

exit $FAIL

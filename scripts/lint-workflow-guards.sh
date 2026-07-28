#!/usr/bin/env bash
# Shared workflow-guard lints — single source of truth for the inline guard
# steps in .github/workflows/test.yml's Lint Workflows job that fire on files
# sessions edit constantly (.github/workflows/*, src/). Companion to
# scripts/lint-write-routing.sh (same pattern, 2026-07-12: CI-only lints let
# violations redden main for hours; running the identical script from the
# local pre-push hook blocks them at push time instead).
#
# Called from BOTH:
#   - CI: .github/workflows/test.yml (Lint Workflows job, one step per check)
#   - local: scripts/hooks/pre-push (scoped by the push's changed paths)
#
# Usage: lint-workflow-guards.sh <check>[,<check>...]
#   Checks: prebuild | core-data-pairing | private-git-add | merge-drivers
#         | scraping-fallback | theatr-token | demo-flags | snapshot-overwrite
#         | alert-ledger-commit
#   Groups: workflows (all .github/workflows-scoped checks) | all

set -uo pipefail
cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)"

FAILED=0

check_prebuild() {
  # `npx next build` (or bare `next build`) in a workflow step skips the npm
  # `prebuild` lifecycle hook (scripts/prebuild.sh), which is the only thing
  # that generates the gitignored data/cast-manifest.json and
  # data/actor-slugs.json. Without those, `next build` fails with
  #   Module not found: '../../data/cast-manifest.json'.
  # (2026-05-26 Test UGC Features failure, test-ugc.yml.)
  local VIOLATIONS="" f
  for f in .github/workflows/*.yml; do
    # Match `npx next build` and `npx --no-install next build`; tolerate extra
    # flags after. Avoid matching `npm run build` (which is fine).
    if grep -E '^[[:space:]]*(run:[[:space:]]*)?(npx([[:space:]]+--[a-z-]+)*[[:space:]]+next[[:space:]]+build|next[[:space:]]+build)([[:space:]]|$)' "$f" >/dev/null 2>&1; then
      VIOLATIONS="$VIOLATIONS $(basename "$f")"
    fi
  done
  if [ -n "$VIOLATIONS" ]; then
    echo "::error::Workflows invoke 'next build' directly (bypasses npm prebuild):$VIOLATIONS"
    echo "Fix: change 'npx next build' to 'npm run build'. The prebuild hook"
    echo "generates data/cast-manifest.json + data/actor-slugs.json (both gitignored)"
    echo "which next build imports at compile time."
    FAILED=1
  else
    echo "All workflows use 'npm run build' (prebuild lifecycle preserved)"
  fi
}

check_core_data_pairing() {
  # v2 (2026-07-12): workflows that invoke a KNOWN core-data-writing script
  # must also push-core-data, or the writes are silently discarded at job end
  # (core files are gitignored in this repo — only push-core-data persists
  # them to the private broadway-scorecard-data repo).
  #
  # History: v1 matched checkout-core-data + contents:write + no push-core-data
  # and was a dead no-op since birth ($(grep -c ... || echo 0) yields "0\n0" on
  # no match, silently erroring every integer test). With the arithmetic fixed
  # it flagged ~50 workflows, nearly all read-only. The 2026-07-12 audit traced
  # every script invoked by all 50 (Notion 39b637c5-416f-8127): exactly three
  # scripts write core files, so v2 keys on those. Add to CORE_WRITER_SCRIPTS
  # when a new script gains a core-file write (the write-routing lint's
  # reviews.json check catches new direct writers at PR time).
  #
  # validate-data.js    — unconditional shows.json auto-fixes (:585,:636,:776,:830)
  # pre-deploy-check.js — shows.json self-heal before build (:215)
  # rebuild-all-reviews.js — reviews.json (:4405) + outlet-registry.json (:4999)
  local CORE_WRITER_SCRIPTS="validate-data.js pre-deploy-check.js rebuild-all-reviews.js"
  # Exemptions — audited 2026-07-12, every entry verified benign:
  #   test.yml                        CI validation; writes never meant to persist
  #   vercel-deploy/demo/preview.yml  pre-deploy-check self-heal is build-local by design
  #   update-deploy-watermark.yml     reads counts for the watermark; self-heal incidental
  #   collect-review-texts.yml        validate-data auto-fix incidental; canonical
  #   collect-we-ob-reviews.yml       persistence happens in update-show-status /
  #   sweep-we-aggregators.yml        gather-reviews / rebuild-reviews (all push)
  #   generate-theater-tips.yml       same validate-data-incidental class
  #   scoring-audit.yml               rebuild is audit-only (commits data/audit/* only)
  #   opening-night-stage-alert.yml   mentions rebuild in alert runbook TEXT, not an invocation
  local EXEMPT="test.yml vercel-deploy.yml vercel-demo.yml vercel-preview.yml update-deploy-watermark.yml collect-review-texts.yml collect-we-ob-reviews.yml sweep-we-aggregators.yml generate-theater-tips.yml scoring-audit.yml opening-night-stage-alert.yml"
  local MISSING="" f name s
  for f in .github/workflows/*.yml; do
    name=$(basename "$f")
    # -Fx exact-name match (grep -qw would let vercel-demo.yml exempt a future
    # foo-vercel-demo.yml — '-' and '.' are non-word chars to grep)
    if echo "$EXEMPT" | tr ' ' '\n' | grep -Fxq "$name"; then continue; fi
    # Require an actual `uses: .../push-core-data` step, not a mere text
    # mention in a comment or heredoc.
    if grep -qE '^[[:space:]]*uses:.*push-core-data' "$f"; then continue; fi
    for s in $CORE_WRITER_SCRIPTS; do
      if grep -q "scripts/$s" "$f"; then
        MISSING="$MISSING $name($s)"
        break
      fi
    done
  done
  if [ -n "$MISSING" ]; then
    echo "::error::Workflows invoke a core-data-writing script but never push-core-data (writes silently discarded at job end):$MISSING"
    echo "Core files are gitignored in this repo — only the push-core-data action persists them."
    echo "Fix: add the push-core-data step (see gather-reviews.yml), or if the write is"
    echo "genuinely build-local/audit-only, add the workflow to EXEMPT in"
    echo "scripts/lint-workflow-guards.sh with a one-line reason."
    FAILED=1
  else
    echo "All workflows invoking core-data writers have push-core-data (or are audited exemptions)"
  fi
}

check_private_git_add() {
  # Core data files live in the private broadway-scorecard-data repo and are
  # gitignored here; they sync via push-core-data. Any `git add data/<core>`
  # here is a silent no-op or a hard failure (2026-04-14:
  # update-lottery-rush.yml; 5 other workflows silently broken for weeks).
  # The authoritative list is in push-core-data/action.yml — keep in sync.
  # Force-adds (`git add -f`) are allowed (explicit overrides,
  # e.g. opening-night-sent.json).
  local CORE_FILES="shows.json reviews.json grosses.json grosses-history.json commercial.json audience-buzz.json critic-consensus.json critic-registry.json outlet-registry.json diary-shows.json audience-reviews-lbo.json followers.json subscribers.json subscribers-westend.json"
  local VIOLATIONS="" f core
  for f in .github/workflows/*.yml; do
    for core in $CORE_FILES; do
      # Match `git add` (no -f/--force) then data/<core>. Reject both
      # `git add data/shows.json` and `git add a b data/shows.json c`.
      if grep -E "^[[:space:]]*git add([[:space:]]+[^-][^[:space:]]*)*[[:space:]]+data/$core([[:space:]]|$)" "$f" >/dev/null 2>&1; then
        VIOLATIONS="$VIOLATIONS $(basename "$f"):$core"
      fi
    done
  done
  if [ -n "$VIOLATIONS" ]; then
    echo "::error::Workflows git-add private core data files:$VIOLATIONS"
    echo "These files are gitignored and synced via push-core-data."
    echo "Remove them from git-add lines. See .github/workflows/CLAUDE.md §Data Sync Architecture."
    FAILED=1
  else
    echo "No workflows git-add private core data files"
  fi
}

check_merge_drivers() {
  # A custom `merge=<name>` driver in .gitattributes silently NO-OPS unless
  # `git config merge.<name>.driver ...` is registered (feature-flags.ts
  # merge=ours sat broken this way until 830c1f5b48). Canonical registration
  # point is setup-local-data.sh (CI bots use push-with-retry.sh strategy
  # options, not per-path drivers). Built-in drivers need no registration.
  local BUILTIN="union text binary"
  local REG_FILE="scripts/setup-local-data.sh"
  local MISSING="" DRIVERS d
  DRIVERS=$(grep -oE 'merge=[A-Za-z0-9_.-]+' .gitattributes | sed 's/^merge=//' | sort -u)
  for d in $DRIVERS; do
    if echo "$BUILTIN" | grep -qw "$d"; then continue; fi
    # Tolerant match: `git config [--global] merge.<d>.driver ...`
    if ! grep -qE "merge\.$d\.driver" "$REG_FILE"; then
      MISSING="$MISSING $d"
    fi
  done
  if [ -n "$MISSING" ]; then
    echo "::error::Custom .gitattributes merge driver(s) not registered in $REG_FILE:$MISSING"
    echo "::error::Unregistered drivers silently no-op and let these files CONFLICT on a human git merge."
    echo "Fix: add a line like 'git config --global merge.<name>.driver <command>' to $REG_FILE,"
    echo "or, if <name> is actually a git built-in, add it to the BUILTIN allowlist in lint-workflow-guards.sh."
    FAILED=1
  else
    echo "All custom merge drivers registered:${DRIVERS:+ }$DRIVERS"
  fi
}

check_scraping_fallback() {
  # Any workflow that uses SCRAPINGBEE_API_KEY for actual scraping must also
  # have BRIGHTDATA_TOKEN so there's always a fallback. Exemptions:
  # (A) health checks / credential validators — SB key checked for validity
  # (B) scripts require JS rendering — correct fallback is SB → Playwright,
  #     already implemented in the scripts themselves
  local EXEMPT="
    check-secrets-health.yml
    opening-night-orchestrator.yml
    check-cookie-health.yml
    data-health-check.yml
    backfill-historical-metadata.yml
    check-show-freshness.yml
    scrape-alltime-grosses.yml
    weekly-grosses.yml
    reddit-engagement-digest.yml
    scrape-dtli-show-score.yml
    scraper-cost-report.yml
    btc-results-preview.yml
    verify-reviews.yml
  "
  local VIOLATIONS="" f name
  for f in .github/workflows/*.yml; do
    name=$(basename "$f")
    if echo "$EXEMPT" | grep -qw "$name"; then continue; fi
    if grep -q "SCRAPINGBEE_API_KEY" "$f" && ! grep -q "BRIGHTDATA_TOKEN" "$f"; then
      VIOLATIONS="$VIOLATIONS $name"
    fi
  done
  if [ -n "$VIOLATIONS" ]; then
    echo "::error::Scraping workflows must use scraper.js with BD+SB fallback, not a single service."
    echo "::error::Missing BRIGHTDATA_TOKEN in:$VIOLATIONS"
    echo "Fix: add BRIGHTDATA_TOKEN: \${{ secrets.BRIGHTDATA_TOKEN }} to the scraping step's env block."
    echo "If this workflow legitimately uses only SB (health check, etc), add it to the EXEMPT list in scripts/lint-workflow-guards.sh."
    FAILED=1
  else
    echo "All scraping workflows have multi-service fallback"
  fi
}

check_theatr_token() {
  # THEATR_REFRESH_TOKEN burns on use (Theatr rotates refresh tokens). Only
  # update-theatr.yml and rotate-theatr-token.yml may use it — any other
  # caller races the rotation and burns the token chain
  # (fetch-all-image-formats.yml did this for 2 weeks, April 2026).
  local ALLOWED="update-theatr.yml rotate-theatr-token.yml"
  local VIOLATIONS="" f name
  for f in .github/workflows/*.yml; do
    name=$(basename "$f")
    if echo "$ALLOWED" | grep -qw "$name"; then continue; fi
    # Match actual secret usage, not comments
    if grep -E '^\s+THEATR_REFRESH_TOKEN:\s+\$\{\{' "$f" >/dev/null 2>&1; then
      VIOLATIONS="$VIOLATIONS $name"
    fi
  done
  if [ -n "$VIOLATIONS" ]; then
    echo "::error::THEATR_REFRESH_TOKEN must only be used by update-theatr.yml and rotate-theatr-token.yml"
    echo "::error::Unauthorized usage in:$VIOLATIONS"
    echo "Theatr rotates refresh tokens on every use. Multiple callers race and burn the token chain."
    echo "Use data/theatr-image-cache.json (populated by update-theatr.yml) instead of calling the API directly."
    FAILED=1
  else
    echo "Theatr token restricted to authorized workflows only"
  fi
}

check_demo_flags() {
  # Demo feature flags require window (runtime) and MUST be checked inside
  # 'use client' components. In server components / SSR pages, isDemo()
  # returns false and the feature silently disappears (fix 7770e1b567).
  # Emergency escape hatch (opening-night hotfixes only): commit message
  # containing "[skip-demo-flag-check]" skips this gate.
  if git log -1 --format=%B | grep -Fq "[skip-demo-flag-check]"; then
    echo "::warning::demo-flag check skipped via [skip-demo-flag-check] commit-message tag"
    return
  fi
  # Keep in sync with DEMO_FEATURES in src/config/feature-flags.ts.
  # awards/awardScoreV2 launched 2026-05-17 — removed now that their getters
  # return true unconditionally. Re-add any flag here if you put it back in
  # DEMO_FEATURES.
  local DEMO_FLAGS="theaterScorecard|showPageRedesign|userAccounts|showtimes"
  local VIOLATIONS="" f
  for f in $(grep -rlE "featureFlags\.(${DEMO_FLAGS})" src/ 2>/dev/null || true); do
    # Check if file has 'use client' directive
    if ! head -3 "$f" | grep -q "'use client'"; then
      VIOLATIONS="$VIOLATIONS $f"
    fi
  done
  if [ -n "$VIOLATIONS" ]; then
    echo "::error::Demo feature flags used in server components (will always be false during SSR):"
    echo "::error::$VIOLATIONS"
    echo "Move the featureFlags check inside a 'use client' component."
    echo "Emergency bypass (opening-night hotfix only): include [skip-demo-flag-check] in the commit message."
    FAILED=1
  else
    echo "All demo feature flag checks are in client components"
  fi
}

check_snapshot_overwrite() {
  # /tmp/core-data-snapshot is the CHECKOUT-TIME baseline push-core-data diffs
  # data/ against (a file identical to its snapshot is treated as untouched
  # and skipped). ONLY checkout-core-data may write it. Workflows that copied
  # their own freshly-written files into the snapshot silently disabled their
  # core-data pushes for a week (2026-07-12..19: rebuild-reviews stopped
  # pushing reviews.json; caught via a newsletter with stale scores). Six
  # workflows had this pattern removed on 2026-07-19 — this lint keeps it out.
  # Only writes INTO the snapshot are violations — the snapshot as cp/rsync
  # DESTINATION (final argument). Reading FROM it (e.g. commercial-weekly.yml
  # restoring the pristine baseline on failure) is legitimate.
  local VIOLATIONS="" f
  for f in .github/workflows/*.yml; do
    if grep -E '(cp|rsync)[^#]*[[:space:]]"?/tmp/core-data-snapshot/?"?[[:space:]]*$' "$f" >/dev/null 2>&1; then
      VIOLATIONS="$VIOLATIONS $(basename "$f")"
    fi
  done
  if [ -n "$VIOLATIONS" ]; then
    echo "::error::Workflows write into /tmp/core-data-snapshot (breaks push-core-data change detection — files matching the snapshot are treated as untouched and never pushed):$VIOLATIONS"
    echo "Fix: delete the snapshot-copy step. The snapshot is the checkout-time baseline; overwriting it makes your workflow's own output read as 'unchanged'. See push-core-data/action.yml + 2026-07-19 incident."
    FAILED=1
  else
    echo "No workflow writes into /tmp/core-data-snapshot"
  fi
}

check_alert_ledger_commit() {
  # Any job calling routeAlert()/resolveCondition() (owner-alert-router.js)
  # must stage data/audit/alert-ledger.json for commit in the SAME job, or
  # the cooldown/dedup ledger resets every run (5th recurrence of this class
  # after audit-aggregator-gap.yml, test-ugc-roundtrip.yml, ux-walkthrough.yml,
  # check-cron-health.yml — card #618). Pure-function check lives in
  # scripts/lib/alert-ledger-commit-check.js (colocated test:
  # scripts/lib/alert-ledger-commit-check.test.mjs).
  local VIOLATIONS="" f name out
  for f in .github/workflows/*.yml; do
    name=$(basename "$f")
    out=$(node -e "
      const { findMissingLedgerCommits } = require('./scripts/lib/alert-ledger-commit-check.js');
      const fs = require('fs');
      const violations = findMissingLedgerCommits(fs.readFileSync(process.argv[1], 'utf8'));
      violations.forEach(v => console.log(v));
    " "$f")
    if [ -n "$out" ]; then
      VIOLATIONS="$VIOLATIONS\n$name: $out"
    fi
  done
  if [ -n "$VIOLATIONS" ]; then
    echo "::error::Workflows call routeAlert()/resolveCondition() without committing data/audit/alert-ledger.json in the same job:"
    echo -e "$VIOLATIONS"
    echo "Fix: stage data/audit/alert-ledger.json (git add, or scripts/lib/git-add-existing.sh) before the job's commit step."
    echo "See scripts/lib/owner-alert-router.js header comment + check-cron-health.yml for a working example."
    FAILED=1
  else
    echo "All routeAlert()/resolveCondition() callers commit data/audit/alert-ledger.json in the same job"
  fi
}

run_check() {
  case "$1" in
    prebuild)          check_prebuild ;;
    core-data-pairing) check_core_data_pairing ;;
    private-git-add)   check_private_git_add ;;
    merge-drivers)     check_merge_drivers ;;
    scraping-fallback) check_scraping_fallback ;;
    theatr-token)      check_theatr_token ;;
    demo-flags)        check_demo_flags ;;
    snapshot-overwrite) check_snapshot_overwrite ;;
    alert-ledger-commit) check_alert_ledger_commit ;;
    workflows)
      check_prebuild; check_core_data_pairing; check_private_git_add
      check_merge_drivers; check_scraping_fallback; check_theatr_token
      check_snapshot_overwrite; check_alert_ledger_commit ;;
    all)
      check_prebuild; check_core_data_pairing; check_private_git_add
      check_merge_drivers; check_scraping_fallback; check_theatr_token
      check_demo_flags; check_snapshot_overwrite; check_alert_ledger_commit ;;
    *) echo "usage: $0 <prebuild|core-data-pairing|private-git-add|merge-drivers|scraping-fallback|theatr-token|demo-flags|snapshot-overwrite|alert-ledger-commit|workflows|all>[,...]" >&2; exit 2 ;;
  esac
}

if [ $# -eq 0 ]; then
  run_check all
elif [ $# -gt 1 ]; then
  # Space-separated args would silently run only $1 — force the comma form.
  echo "usage: $0 <check>[,<check>...]  (comma-separated, not space-separated)" >&2
  exit 2
else
  IFS=',' read -ra CHECKS <<< "$1"
  for c in "${CHECKS[@]}"; do
    run_check "$c"
  done
fi

exit "$FAILED"

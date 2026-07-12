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
#         | scraping-fallback | theatr-token | demo-flags
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
  # Workflows that checkout core data AND have write permissions must also
  # push-core-data, or changes get lost on next deploy.
  local MISSING="" f HAS_CHECKOUT HAS_WRITE HAS_PUSH
  for f in .github/workflows/*.yml; do
    # `|| true`, not `|| echo 0`: grep -c already prints "0" on no match (and
    # exits 1), so `|| echo 0` would yield "0\n0" and break the -gt test. The
    # old inline test.yml version had exactly that latent bug.
    HAS_CHECKOUT=$(grep -c 'checkout-core-data' "$f" 2>/dev/null || true)
    HAS_WRITE=$(grep -c 'contents: write' "$f" 2>/dev/null || true)
    HAS_PUSH=$(grep -c 'push-core-data' "$f" 2>/dev/null || true)
    if [ "$HAS_CHECKOUT" -gt 0 ] && [ "$HAS_WRITE" -gt 0 ] && [ "$HAS_PUSH" -eq 0 ]; then
      MISSING="$MISSING $(basename $f)"
    fi
  done
  if [ -n "$MISSING" ]; then
    # WARNING-ONLY, deliberately. The original inline test.yml version of this
    # check was a dead no-op since birth: the "0\n0" grep-c bug above made the
    # integer tests error out silently, so it never flagged anything. With the
    # arithmetic fixed it matches ~50 workflows, most of them false positives
    # (read-only audits; workflows that push via push-review-texts or dispatch
    # a rebuild instead). Blocking on it now would redden CI repo-wide. The
    # heuristic needs a redesign (detect workflows that WRITE core files, not
    # ones that merely check them out) before it can gate again.
    echo "::warning::Workflows using checkout-core-data with write permissions but no push-core-data (heuristic — many are read-only false positives):$MISSING"
  else
    echo "All writable workflows with checkout-core-data have matching push-core-data"
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

run_check() {
  case "$1" in
    prebuild)          check_prebuild ;;
    core-data-pairing) check_core_data_pairing ;;
    private-git-add)   check_private_git_add ;;
    merge-drivers)     check_merge_drivers ;;
    scraping-fallback) check_scraping_fallback ;;
    theatr-token)      check_theatr_token ;;
    demo-flags)        check_demo_flags ;;
    workflows)
      check_prebuild; check_core_data_pairing; check_private_git_add
      check_merge_drivers; check_scraping_fallback; check_theatr_token ;;
    all)
      check_prebuild; check_core_data_pairing; check_private_git_add
      check_merge_drivers; check_scraping_fallback; check_theatr_token
      check_demo_flags ;;
    *) echo "usage: $0 <prebuild|core-data-pairing|private-git-add|merge-drivers|scraping-fallback|theatr-token|demo-flags|workflows|all>[,...]" >&2; exit 2 ;;
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

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
#         | scraping-fallback | scrapingdog-pairing | theatr-token | demo-flags
#         | snapshot-overwrite | alert-ledger-commit | ledger-coverage | reset-soft-partial-commit
#         | dry-run-flag-setter | swallowed-audit-writers
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

check_scrapingdog_pairing() {
  # Scraping v2 Sprint 1 T9: fetchPage()'s SD tier is ~3x cheaper than BD and
  # runs before it in the fallback chain, but only when SCRAPINGDOG_API_KEY is
  # actually wired into the workflow's env block — 5 scraping workflows
  # (discover-regional-serp-reviews, scrape-theatre-reviews, update-lbo,
  # update-ltd, update-seatplan) were missing it entirely, silently paying BD
  # rates for every fetch. Same pairing pattern as check_scraping_fallback:
  # any workflow using BD or SB for real scraping must also carry SD.
  local EXEMPT="
    check-secrets-health.yml
    check-cookie-health.yml
    test.yml
    verify-reviews.yml
  "
  # verify-reviews.yml: also exempt from check_scraping_fallback (SB-only by
  # design, not a bulk fetchPage() scraper) — same rationale here.
  local VIOLATIONS="" f name
  for f in .github/workflows/*.yml; do
    name=$(basename "$f")
    if echo "$EXEMPT" | grep -qw "$name"; then continue; fi
    if (grep -q "BRIGHTDATA_TOKEN" "$f" || grep -q "SCRAPINGBEE_API_KEY" "$f") && ! grep -q "SCRAPINGDOG_API_KEY" "$f"; then
      VIOLATIONS="$VIOLATIONS $name"
    fi
  done
  if [ -n "$VIOLATIONS" ]; then
    echo "::error::Scraping workflows must also carry SCRAPINGDOG_API_KEY (fetchPage()'s cheapest tier, ~3x less than BD)."
    echo "::error::Missing SCRAPINGDOG_API_KEY in:$VIOLATIONS"
    echo "Fix: add SCRAPINGDOG_API_KEY: \${{ secrets.SCRAPINGDOG_API_KEY }} to the scraping step's env block."
    echo "If this workflow legitimately never calls fetchPage() (health check, CI, etc), add it to the EXEMPT list in scripts/lint-workflow-guards.sh."
    FAILED=1
  else
    echo "All scraping workflows have SCRAPINGDOG_API_KEY wired in"
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

check_ledger_coverage() {
  # Card 3b1637c5 / task #996: any workflow job that runs a script calling
  # url-discovery.js's serpQuery()/discoverCorrectUrl() (SERP path) must also
  # stage data/audit/scraper-spend-ledger.jsonl for commit in the SAME job,
  # or that job's SERP telemetry is silently discarded when the runner exits
  # (19/~40 SERP-calling workflows had this gap; 18 fixed by hand in
  # 436f4a24092/943bd4a9327, the remaining ~39 by BRO-163, 2026-08-15).
  # Logic lives in scripts/lib/ledger-coverage-check.js (real acorn AST walk
  # — not text regex — because "requires url-discovery.js" != "calls its
  # SERP function"; see that file's header comment for the false-positive it
  # avoids). A single Node process handles every workflow file — the AST
  # walk over scripts/**/*.js is the expensive part and must run once, not
  # once per workflow.
  #
  # scripts/lib/ledger-coverage-exemptions.js now lists exactly one entry —
  # a documented detector false positive, not a real gap (see that file's
  # header). Remove a real-gap entry there the moment its workflow is fixed
  # — a STALE exemption (one that no longer matches a real violation) is
  # itself a failure below, so fixing a workflow without removing its
  # exemption entry doesn't silently rot forever (ship-check finding,
  # 2026-08-04).
  #
  # Fails loudly (not silently-clean) if acorn is unavailable — ledgerScripts
  # would otherwise come back empty and every workflow would read as
  # violation-free, which is the wrong failure mode for a cost-control gate.
  local OUT
  OUT=$(node -e "
    let acorn;
    try { acorn = require('acorn'); } catch { acorn = null; }
    if (!acorn) {
      console.log('__ACORN_MISSING__');
      process.exit(0);
    }
    const fs = require('fs');
    const path = require('path');
    const { findLedgerScripts, findMissingLedgerCommits } = require('./scripts/lib/ledger-coverage-check.js');
    const { EXEMPTIONS, isExempt } = require('./scripts/lib/ledger-coverage-exemptions.js');
    const ledgerScripts = findLedgerScripts('scripts');
    const dir = '.github/workflows';
    const usedExemptions = new Set();
    let any = false;
    for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.yml'))) {
      const text = fs.readFileSync(path.join(dir, name), 'utf8');
      for (const v of findMissingLedgerCommits(text, ledgerScripts)) {
        if (isExempt(name, v.job)) {
          usedExemptions.add(name + '#' + v.job);
        } else {
          any = true;
          console.log(name + ': ' + v.message);
        }
      }
    }
    for (const e of EXEMPTIONS) {
      if (!usedExemptions.has(e.file + '#' + e.job)) {
        any = true;
        console.log('STALE EXEMPTION: ' + e.file + \" job '\" + e.job + \"' is listed in ledger-coverage-exemptions.js but is no longer a violation — remove the entry.\");
      }
    }
    if (!any) console.log('__CLEAN__');
  " 2>&1)
  if echo "$OUT" | grep -qF '__ACORN_MISSING__'; then
    echo "::error::ledger-coverage check could not run — acorn is not installed (run 'npm ci' first). This gate fails closed rather than silently reporting clean."
    FAILED=1
  elif echo "$OUT" | grep -qF '__CLEAN__' && ! echo "$OUT" | grep -qvF '__CLEAN__'; then
    echo "All SERP-calling (url-discovery.js serpQuery/discoverCorrectUrl) workflows commit data/audit/scraper-spend-ledger.jsonl in the same job (or are documented, non-stale exemptions)"
  else
    echo "::error::Workflows call url-discovery.js's serpQuery()/discoverCorrectUrl() but no step stages data/audit/scraper-spend-ledger.jsonl for commit in the same job (or an exemption entry has gone stale):"
    echo "$OUT" | grep -vF '__CLEAN__'
    echo "Fix: add a 'Commit scraper-spend ledger' step (see audit-closing-dates.yml for the pattern) to the violating job."
    echo "If this is a known, tracked gap, add it to scripts/lib/ledger-coverage-exemptions.js with a dated reason."
    echo "If a STALE EXEMPTION is listed, remove that entry from ledger-coverage-exemptions.js — its workflow is already fixed."
    FAILED=1
  fi
}

check_dry_run_flag_setter() {
  # Task #653 ship-check finding: scripts/flag-wrong-production-by-date.js is
  # DRY_RUN unless --apply (flag-wrong-production-by-date.js:43). rebuild-fast.yml
  # invoked it WITHOUT --apply from the day its opening-night contamination guard
  # shipped, so that guard wrote zero flags and the "rebuild-fast runs the sweeps,
  # review-refresh doesn't" asymmetry was never real — nothing but the daily
  # rebuild-reviews.yml ever re-applied a cleared wrongProduction flag. A dry-run
  # flag-setter in a persistence workflow is silent, not loud: the step is green.
  local VIOLATIONS=""
  for f in .github/workflows/*.yml; do
    while IFS= read -r line; do
      case "$line" in
        *"flag-wrong-production-by-date.js --apply"*) ;;
        *"flag-wrong-production-by-date.js"*)
          VIOLATIONS="$VIOLATIONS$(basename "$f"): $(echo "$line" | sed 's/^[[:space:]]*//')"$'\n' ;;
      esac
    # Only executable run: lines — comments mentioning the script are fine.
    done < <(grep -E '^[[:space:]]*(run:|[[:space:]]+)?[^#]*node[[:space:]]+scripts/flag-wrong-production-by-date\.js' "$f" 2>/dev/null)
  done
  if [ -n "$VIOLATIONS" ]; then
    echo "::error::flag-wrong-production-by-date.js invoked without --apply (DRY RUN — writes nothing, step still passes):"
    echo "$VIOLATIONS"
    FAILED=1
  else
    echo "flag-wrong-production-by-date.js always invoked with --apply"
  fi
}

check_reset_soft_partial_commit() {
  # Flags the "phantom-staged-revert" bug class (card #687, generalized from
  # task #677's ship-check finding, fixed in record-push-ledger.js commit
  # 613c6bd8eeb): a script that does `git reset --soft <ref>` to fast-forward
  # local HEAD, then stages ONLY a specific path (a scoped `git add`, not
  # `-A`/`.`/`--all`) and commits. --soft leaves the INDEX frozen at the
  # pre-reset tree, so if <ref> moved past that point (routine under
  # concurrent CI pushes), the whole stale index — not just the one path
  # actually `git add`ed — gets committed, silently reverting concurrent
  # commits' real content. Pure-function detector lives in
  # scripts/lib/reset-soft-partial-commit-check.js (colocated test:
  # scripts/lib/reset-soft-partial-commit-check.test.mjs). Scans top-level
  # scripts/*.js (same scope as lint-write-routing.sh's writer checks) —
  # that's where every git-operating CI script in this repo lives.
  # Single node process for the whole scripts/*.js set (not one spawn per
  # file, ~200x faster) — this runs from the local pre-push hook on every
  # push touching scripts/*.js, which promises "a few seconds total".
  local VIOLATIONS
  VIOLATIONS=$(node -e "
    const { findResetSoftPartialCommitIssues } = require('./scripts/lib/reset-soft-partial-commit-check.js');
    const fs = require('fs');
    for (const f of process.argv.slice(1)) {
      const issues = findResetSoftPartialCommitIssues(fs.readFileSync(f, 'utf8'));
      if (issues.length) console.log(require('path').basename(f) + ': ' + issues.join('; '));
    }
  " scripts/*.js)
  if [ -n "$VIOLATIONS" ]; then
    VIOLATIONS=$'\n'"$VIOLATIONS"
    echo "::error::Scripts use a dangerous reset --soft + scoped-add + commit pattern (phantom-staged-revert risk):"
    echo -e "$VIOLATIONS"
    echo "Fix: use 'git reset --mixed' instead of '--soft' before staging+committing a single path."
    echo "See fastForwardHeadToOrigin() in scripts/record-push-ledger.js for the fixed pattern."
    FAILED=1
  else
    echo "No scripts use the reset --soft + scoped-add + commit phantom-staged-revert pattern"
  fi
}

check_swallowed_audit_writers() {
  # Task #1073 W5.1: a workflow step that (a) runs `node scripts/X.js` where
  # X.js writes to data/audit/ (heuristic: grep the script file for the
  # literal string 'data/audit/' — same loose/over-inclusive style as
  # check_core_data_pairing()'s CORE_WRITER_SCRIPTS grep above), AND (b) that
  # step swallows its own failure via `continue-on-error: true` or `|| true`
  # anywhere in the step body, silently discards audit-ledger writes with
  # zero signal anywhere. This is exactly the bug class that let
  # opening-night-checklist.yml's history append fail invisibly for 100+ days
  # (2026-04-26 -> 2026-08-05 — see the diagnosis comment above
  # appendToHistory() in scripts/opening-night-checklist.js). Inline
  # `# lint-allow-swallow: <reason>` anywhere in a step suppresses a specific,
  # reviewed exemption for that step.
  # Pure-function detector: scripts/lib/swallowed-audit-writer-check.js
  # (colocated test: scripts/lib/swallowed-audit-writer-check.test.mjs).
  local OUT
  OUT=$(node -e "
    const fs = require('fs');
    const path = require('path');
    const { findSwallowedAuditWriters } = require('./scripts/lib/swallowed-audit-writer-check.js');

    const auditWriterCache = new Map();
    function isAuditWriterScript(scriptPath) {
      if (auditWriterCache.has(scriptPath)) return auditWriterCache.get(scriptPath);
      let result = false;
      try {
        result = fs.readFileSync(scriptPath, 'utf8').includes('data/audit/');
      } catch { result = false; }
      auditWriterCache.set(scriptPath, result);
      return result;
    }

    const dir = '.github/workflows';
    let any = false;
    for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.yml'))) {
      const text = fs.readFileSync(path.join(dir, name), 'utf8');
      for (const v of findSwallowedAuditWriters(text, isAuditWriterScript)) {
        any = true;
        console.log(name + ': ' + v);
      }
    }
    if (!any) console.log('__CLEAN__');
  " 2>&1)
  if echo "$OUT" | grep -qF '__CLEAN__' && ! echo "$OUT" | grep -qvF '__CLEAN__'; then
    echo "No workflow step swallows a data/audit/-writing script's failure via continue-on-error/|| true (or all are documented lint-allow-swallow exemptions)"
  else
    echo "::error::Workflow step(s) swallow a data/audit/-writing script's failure (continue-on-error: true or '|| true'), discarding writes with no signal anywhere:"
    echo "$OUT" | grep -vF '__CLEAN__'
    echo "Fix: remove continue-on-error/|| true and handle the script's real exit code explicitly (see opening-night-checklist.yml's 'Run opening night checklist' step for the pattern), or if this step's failure genuinely is optional, add '# lint-allow-swallow: <reason>' to the step."
    FAILED=1
  fi
}

run_check() {
  case "$1" in
    prebuild)          check_prebuild ;;
    core-data-pairing) check_core_data_pairing ;;
    private-git-add)   check_private_git_add ;;
    merge-drivers)     check_merge_drivers ;;
    scraping-fallback) check_scraping_fallback ;;
    scrapingdog-pairing) check_scrapingdog_pairing ;;
    theatr-token)      check_theatr_token ;;
    demo-flags)        check_demo_flags ;;
    snapshot-overwrite) check_snapshot_overwrite ;;
    alert-ledger-commit) check_alert_ledger_commit ;;
    ledger-coverage)    check_ledger_coverage ;;
    reset-soft-partial-commit) check_reset_soft_partial_commit ;;
    dry-run-flag-setter) check_dry_run_flag_setter ;;
    swallowed-audit-writers) check_swallowed_audit_writers ;;
    workflows)
      # check_swallowed_audit_writers is deliberately NOT in this composite yet:
      # the pre-push hook runs `workflows`, and the check has ~70 pre-existing
      # violations (task #1073 follow-up card) — including it here would block
      # every push repo-wide until the triage lands. Run it standalone
      # (`swallowed-audit-writers`) or via `all`.
      check_prebuild; check_core_data_pairing; check_private_git_add
      check_merge_drivers; check_scraping_fallback; check_scrapingdog_pairing; check_theatr_token
      check_snapshot_overwrite; check_alert_ledger_commit; check_ledger_coverage; check_dry_run_flag_setter ;;
    all)
      check_prebuild; check_core_data_pairing; check_private_git_add
      check_merge_drivers; check_scraping_fallback; check_scrapingdog_pairing; check_theatr_token
      check_demo_flags; check_snapshot_overwrite; check_alert_ledger_commit; check_ledger_coverage
      check_reset_soft_partial_commit; check_dry_run_flag_setter; check_swallowed_audit_writers ;;
    *) echo "usage: $0 <prebuild|core-data-pairing|private-git-add|merge-drivers|scraping-fallback|scrapingdog-pairing|theatr-token|demo-flags|snapshot-overwrite|alert-ledger-commit|ledger-coverage|reset-soft-partial-commit|dry-run-flag-setter|swallowed-audit-writers|workflows|all>[,...]" >&2; exit 2 ;;
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

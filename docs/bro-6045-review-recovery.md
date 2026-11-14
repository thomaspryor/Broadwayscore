# BRO-6045 verification

The recovery verifier missed two gates enforced by the rebuild: invalid relative URLs and UK outlets reviewing NYC shows. The latter is independent of a production manual clear. Both gates now live in scripts/lib/recovery-exclusions.js and are called by the rebuild and verifier. The scoring and missing-review checks both consume the verifier's resulting includable list.

## Real-data evidence

The three show directories contain 156 records. Exactly these three verifier decisions change:

| Review file | Previous verifier result | Correct exclusion |
| --- | --- | --- |
| uncle-vanya-2024/london-theatre--unknown.json | Unscored and includable | crossMarket |
| junk-2017/njcom--christopher-kelly.json | Scored but missing | invalidUrl |
| therese-raquin-2015/britishtheatrecom--stephen-collins.json | Scored but missing | crossMarket |

The actual rebuild on origin/main and the changed rebuild produce identical exclusions and counts for all three complete show directories: 29 Uncle Vanya, 39 Junk, and 46 Thérèse Raquin reviews. Executing the two original gate blocks from origin/main against the extracted functions on all 59,475 records found zero inclusion or URL-normalization changes.

BritishTheatre.com has region=london and is not dual-market in data/outlet-registry.json. The stored article discusses the Studio 54 production, Evan Cabnet, Knightley and Judith Light. The reverse-market guard excludes it as skippedCrossMarket even though wrongProductionManualClear and wrongProductionOverride are true. The public pending-fix plan data/pending-fixes/bro-6045.json sets only allowCrossMarket=true. Applying that field on a scratch copy changes exactly one exclusion and raises the rebuild count from 46 to 47, leaving the other two shows unchanged. The private review-texts files and aggregate reviews.json were not modified.

## Verification commands

- Before changes: node --test scripts/verify-review-recovery.test.mjs failed because the file did not exist. git ls-tree origin/main scripts/verify-review-recovery.test.mjs also returned no path. git log -S 'wrongProduction' --oneline -5 -- scripts/verify-review-recovery.js showed the prior canonical-predicate change, but real-data checks still reproduced both false positives.
- After changes: node --test scripts/verify-review-recovery.test.mjs: 11 passed, 0 failed.
- CI=1 node scripts/verify-review-recovery.js --show=uncle-vanya-2024 --file=london-theatre--unknown.json: 0 failures (previously 1).
- CI=1 node scripts/verify-review-recovery.js --show=junk-2017 --file=njcom--christopher-kelly.json: 0 failures (previously 1).
- CI=1 node scripts/verify-review-recovery.js --show=therese-raquin-2015 --production: 0 failures; the BritishTheatre.com exclusion is explicitly reported. CI=1 avoids fetching refs in the read-only private clone. This is evidence for the documented exclusion, not evidence that the pending publication has deployed.
- REVIEW_TEXTS_DIR="$PWD/data/review-texts" node scripts/lib/preflight-review-fix-plan.js data/pending-fixes/bro-6045.json: 1/1 applied cleanly on a throwaway copy.
- node scripts/scoring-delta.js: 59,447 processed, 0 newly excluded, 0 newly included, 0 T1 flips. It also reports CANNOT AUTO-VERIFY for rebuild-loop edits; the direct 59,475-record comparison above addresses that limitation.
- node scripts/test-temporal-override-regression.js: OVERALL PASS, both suites green.
- GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh /tmp/gauntlet: exit 0, lint-workflows: all gates green. The complete /tmp/gauntlet/lint-workflows.log was inspected; actionlint is unavailable here and is left to CI.
- git diff --check: passed. Final git status showed only the eight intended files; scratch directories were removed.
- node scripts/lib/unit-test-collection.js includes scripts/verify-review-recovery.test.mjs, so the acceptance test runs in the existing CI unit batch.

The exact dependent-test invocation below passed all 1,300 tests across 71 files:

~~~sh
node --test --test-timeout 300000 scripts/audit-orphan-tests.test.mjs scripts/audit-test-file-extensions.test.mjs scripts/autonomous-acceptance-recheck.test.mjs scripts/domain-filters.test.mjs scripts/enrich-card-acceptance.test.mjs scripts/lib/autonomous-data-verify.test.mjs scripts/lib/autonomous-eligibility.test.mjs scripts/lib/autonomous-triage-core.test.mjs scripts/lib/autonomous-verify-cmd.test.mjs scripts/lib/classifier-partial-text.test.mjs scripts/lib/colocated-test-ci-coverage.test.mjs scripts/lib/deploy-watermark-regression-guard.test.mjs scripts/lib/multi-show-review-fanout.test.mjs scripts/lib/named-non-review-url-rebuild.test.mjs scripts/lib/notion-outcome-history.test.mjs scripts/lib/pull-quote-contiguity.test.mjs scripts/lib/rebuild-helpers.published-rating-gate.test.mjs scripts/lib/rebuild-helpers.thumb-adjudication.test.mjs scripts/lib/rebuild-includability-parity.test.mjs scripts/lib/run-push-audits.test.mjs scripts/lib/test-yml-manifest-paths.test.mjs scripts/lib/verify-gate.test.mjs scripts/opening-night-tools-data-dir.test.mjs scripts/poll-loureviews.test.mjs scripts/rebuild-all-reviews.test.mjs scripts/scoring-delta-autoclear-coverage.test.mjs scripts/tests/dedupe-survivor-exclusion.test.mjs scripts/tests/duplicate-text-cycle.test.mjs scripts/verify-review-recovery.test.mjs scripts/workflow-run-hints.test.mjs scripts/wrong-production-exclusion-analysis.test.mjs tests/unit/aggregator-canon-wiring.test.mjs tests/unit/audit-same-job-breadcrumb-coverage.test.mjs tests/unit/canonical-duplicate-pointers.test.mjs tests/unit/check-corpus-drift.test.mjs tests/unit/ci-manifest-no-dated-probes.test.mjs tests/unit/cross-market-null-url.test.mjs tests/unit/duplicate-of-copy-reference.test.mjs tests/unit/enrich-card-acceptance-drafting.test.mjs tests/unit/exclusion-logger.test.mjs tests/unit/explain-exclusion-mirror-inventory.test.mjs tests/unit/git-race-fix.test.mjs tests/unit/glob-based-manifest.test.mjs tests/unit/human-clear-survives-merge.test.mjs tests/unit/in-window-slug-veto.test.mjs tests/unit/land-preflight.test.mjs tests/unit/merge-review-fields.test.mjs tests/unit/opening-night-lane-lease-wiring.test.mjs tests/unit/opening-night-lane-rebuild-inclusion.test.mjs tests/unit/opening-night-sla.test.mjs tests/unit/outlet-host-mismatch.test.mjs tests/unit/outlet-registry-display-names.test.mjs tests/unit/preview-article-tier-gate.test.mjs tests/unit/rebuild-all-reviews.test.mjs tests/unit/rebuild-display-critic-name-call-site.test.mjs tests/unit/rebuild-fast-contamination-guard.test.mjs tests/unit/rebuild-score-source-stats.test.mjs tests/unit/rescore-flagging.test.mjs tests/unit/review-pullquotes.test.mjs tests/unit/revival-promo-salesman-saigon-woolf-muchado.test.mjs tests/unit/same-outlet-bylineless-twin.test.mjs tests/unit/send-daily-digest.test.mjs tests/unit/sibling-matchers-diacritics.test.mjs tests/unit/syndication-pairs-shared.test.mjs tests/unit/syndication-primary-scan.test.mjs tests/unit/test-file-locations.test.mjs tests/unit/test-manifest-integrity.test.mjs tests/unit/validate-data-unscored-review-texts.test.mjs tests/unit/verify-gate-comment-correction.test.mjs tests/unit/wrong-production-autoclear.test.mjs tests/unit/wrong-production-setters-honor-manual-clear.test.mjs
~~~

## Wiring and cost

resolveRelativeReviewUrl and reverseCrossMarketExclusion are called by scripts/rebuild-all-reviews.js. explainRecoveryExclusion is called by scripts/verify-review-recovery.js and uses those same functions. The existing execute-approved-fix.yml reads data/pending-fixes/<issue_number>.json and consumes this plan after it lands. No new command-line flags, paid fetches, LLM calls, API calls or cron jobs were added. Existing rebuild automation gains only local predicate calls.

## Remaining publication step

After the runner lands the changes, apply the pending plan through the existing approved-fix workflow, rebuild the reviews, and verify the added review in production. This worker cannot publish an unlanded plan or write to the private review-texts clone.

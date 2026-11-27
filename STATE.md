# BRO-8393 state (headless session, time budget reached)

Done on branch job/linear-BRO-8393-mwyytmud (ship-check PASS recorded, receipt on HEAD):
- timeout-sydney outlet (T2, timeout.com) in data/outlet-registry.json + src/config/outlet-tiers.json; EDITION_PAIRS timeout group.
- review-normalization.js: TIMEOUT_CITY_OUTLETS, timeoutEditionMismatch() class guard; wired into url-discovery validateUrlDomain + SERP filter, review-file-writer (skip 'timeout-edition-mismatch'), gather-reviews saveReview, outlet-domain-validation (unregistered city only), discover-outlet-reviews-serp.
- Byline root cause: gather-reviews stamped legacy critic-outlets.json one-name lists (Guardian=Alexis Soloski, BWW=Richard Sasanow, Time Out=Adam Feldman) for regional/tour shows. Now scripts/lib/gather-default-critic.js; only registry, non-multiAuthor defaults.
- data/pending-fixes/bro-8393.json: 13 criticName corrections (WJ Guardian -> Steve Dow, etc.) + delete 2 phantom Sasanow BWW copies.
- Tests: tests/unit/au-regional-country.test.mjs (run: node --import tsx --test tests/unit/au-regional-country.test.mjs, 10/10; red with fix reverted).

Remaining:
1. Land: `bash scripts/merge-worktree-to-main.sh job/linear-BRO-8393-mwyytmud` blocked by post-merge test floor (13 fails in full suite, no baseline: disk space). Known non-regressions: critic-spelling-duplicates-live-data (fails on main), 2 corpus asserts (cleared by rebuild heal; proven on healed copy), check-corpus-drift/corpus-not-scanned (pass when node_modules is present). Triage the rest, then land (MERGE_SKIP_POST_MERGE_TEST_GATE=1 only if all pre-existing).
2. After land: node scripts/cloud-dispatch.js execute-approved-fix.yml -f issue_number=bro-8393 -f plan_id=b34f3f4d-f726-4123-b317-7785c901b0ca -f mode=apply --wait
3. Next rebuild heals timeout.com/sydney files (11) to timeout-sydney (heal-outlet-mismatch.js dry run: 11 fixes, 0 errors).
4. Verify live https://broadwayscorecard.com/show/whispering-jack-regional-2026 lists Time Out Sydney + Steve Dow.
Known not fixed: and-juliet-tour-2024/broadwayworld--richard-sasanow.json is really Jeffrey Kare but a jeffrey-kare file (different tour stop URL) already exists.

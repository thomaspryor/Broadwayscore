# BRO-8110 state (headless job, 2026-11-23)

## Done (committed on job/linear-BRO-8110-mwtd8y7f)
- Hook half (planning-tier symlinked /tmp) and mexodus data half were already landed by an earlier run (a4be985, review-texts 998d5c7 + 24e698f). Both tests pass on main.
- Root cause of the land-floor blocks: the local post-merge floor's origin/main baseline checkout has no gitignored data dirs (data/review-texts), so a corpus test red on main skipped green on the baseline and read as NEW.
- Fix in scripts/lib/merge-post-merge-test-gate.js: baseline run gets REVIEW_TEXTS_DIR = merged tree's corpus (honouring corpus tests judged fairly; regressions still block); other LIVE-DATA-LANE files are reported, not blocking, only when the trees' gitignored data differ. land.yml unaffected (no corpus either side).
- Tests: merge-post-merge-test-gate.test.mjs 110/110 (6 BRO-8110 cases, 2 red on origin/main), bash harness 10/10, land-preflight-refusals 2/2.
- E2E: real gate CLI on pre-settlement mexodus corpus: origin/main gate EXIT=1 "1 new"; branch gate EXIT=0 "0 new, 1 pre-existing".
- Land attempt 1 refused by the floor for audit-unsafe-show-dir-listing (statSync().isDirectory() on one line); fixed in the last commit, land-preflight-refusals passes.

## Remaining
1. From this worktree: `bash scripts/merge-worktree-to-main.sh` (full floor ~15 min), follow the Land run to green.
2. On main: `node --test scripts/tests/planning-tier.test.mjs` and `node --test scripts/lib/merge-post-merge-test-gate.test.mjs`.
3. `node scripts/linear-session.js report --issue=BRO-8110 --status=done ...`

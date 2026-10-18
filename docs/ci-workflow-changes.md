# CI workflow changes: ending "main is always red" (BRO-3425)

## Problem (measured 2026-09-15)
Test Suite was green on 7 of 150 main runs (4.7%). One binary summary covered ~110 steps, 54 of them
data-state audits against a corpus that bots rewrite ~190x/day, on a branch with no required checks.
201 fix-CI commits in 90 days restored single gates while 55 new gates landed in August alone.

## Chosen option: A (then C), per owner approval
- **A. Data-state audits leave the code-CI verdict.** Live-corpus assertions moved out of `test.yml`
  into `check-corpus-drift.yml` (scheduled, post-rebuild, with heal paths such as
  `--update-baseline` / `--fix`). Examples landed under this card: venue-complex live-corpus checks,
  live outlet-registry and image-presence assertions, moved live-data tests.
- **C. New blocking gates land advisory first** (CLAUDE.md rule 19, enforced by
  `audit-new-gate-arming.js`), which caps the growth of strict data gates.
- **Streak alert keys on the newly-red step**, not the aggregate summary.
- **Landing hardening:** the landing script waits for the server-side Land re-trigger instead of racing it.
- **B (ruleset requiring tsc/unit/lint on PR merges)** stays deferred; landing goes through `land/**`.

## Rationale
Code CI must answer "did this commit break code?". Corpus state changes without commits, so it
cannot share that verdict. Scheduled audits with self-heal keep data health visible without
turning every bot write into a red main.

## Measuring
`node scripts/ci-green-rate.js --days 7 --min 80` (recorded nightly by health-check.js).
Reading 2026-10-18: 7d rate 69.7% (window includes pre-fix 10-11..10-13 at 40-70%);
since 10-14 days run 91-98% green, current streak green x20.
Remaining reds on 10-16/17 were genuine code/unit-test regressions in the pushed commits
(scripts/lib and unit batches), not data-gate flaps; each was followed by a green fix.
Acceptance: 14 consecutive days at >=80%, checked by `scripts/autonomous-acceptance-recheck.js`.

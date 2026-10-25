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

## Reading 2026-10-20
7d rate 75.8% (486 green / 155 red of 642), current streak green x66, 10-20 at 52/52 green.
The 10-19 dip (74 reds, 04:00Z to 21:50Z) was one class-A hit in `audit-review-contamination.js --gate`
(west-end re-opening folders such as into-the-woods-noel-coward-west-end-2026 holding reviews dated at the
2025 sibling's opening) plus a parallel unit-test regression; both were corrected by data/code fixes and the
branch has been green since. The class-A gate stays blocking by design: it flags real mis-filed reviews that
need a human call (marked heal-exempt in test.yml). The 7d window will clear 80% once 10-19 ages out
(10-27); `autonomous-acceptance-recheck.js` owns the 14-day confirmation.

## Reading 2026-10-24
7d rate 40.8% (278 green / 403 red of 681); the window still holds 10-21 and 10-22 (0 green, 102 and 104 reds)
plus 10-19. Failing steps on those days were a mix: unit-test batches (code regressions), the
BRO-1397 former-cast sweep and "Audit non-review content" (data-state), and "Audit review contamination"
(class-A, blocking by design). Main has been green continuously since ~16:00Z on 10-24 (10+ consecutive
completed runs). The 7d rate cannot reach 80% until 10-21/22 age out (~10-29); the 14-day confirmation
stays with `scripts/autonomous-acceptance-recheck.js`. Open follow-up: the BRO-1397 sweep and the
non-review-content audit still sit in the blocking Data Validation path and are candidates for the next
move into `check-corpus-drift.yml` if they red again.

# BRO-2834 — Session state (2026-09-07, headless, 10-min budget)

## Done (merged + pushed to origin/main)
- `scripts/lib/content-verifier.js`: `shouldDeferCvWrongShow` now short-circuits
  `return false` when `contentTier === 'invalid'`, before the outlet-style /
  word-count / opinion-language checks. Commit 7e525bd39c3.
- `tests/unit/should-defer-cv-wrong-show.test.mjs`: added 2 tests (invalid-tier
  → no defer, complete-tier same predicate → still defers). Confirmed test
  fails if the new check is removed. 10/10 pass.
- Second-opinion agent review (2 passes) found one real follow-up: the one-shot
  migration `scripts/migrations/sweep-cv-promoted-fps-2026-05.js:187` hand-picked
  fields into a new object literal and omitted `contentTier`, so a future re-run
  of that script would silently revert to pre-fix permissive behavior. Fixed by
  passing `contentTier: data.contentTier`. Commit 9cadefa52bc.
- Both commits merged into main (30260fa96df) and pushed via
  `scripts/lib/push-with-retry.sh` (confirmed file survives on origin/main).
- Linear BRO-2834 moved to Done with outcome comment via
  `node scripts/linear-session.js report --issue=BRO-2834 --status=done ...`.
- Review-gate ledger has recorded `pass` entries for this branch/head
  (`.claude/review-verdicts.jsonl`).
- `/what-else` ran: 5 lenses checked, no actionable non-obvious sparks found
  (checked for cousin "should-defer" guards — none exist; checked
  `audit-outlet-registry.js`'s existing cvStyle armament audit — already
  structurally sound, no new monitoring needed since this fix is structural).

## Not done / in flight at session end
- GitHub Actions "Test Suite" and "Deploy to Vercel" were `in_progress` as of
  2026-09-07T22:00Z (triggered by the merge push to main). Session hit its
  10-minute hard kill budget before these could be waited out — did NOT want
  to risk a mid-wait kill leaving no summary.

## Exact next command for a resumed/follow-up session
```
gh run list --limit 5 --json workflowName,status,conclusion,createdAt
# If Test Suite conclusion != success: investigate and fix on a new branch/worktree.
# If Deploy to Vercel: node scripts/check-prod-deploy.js HEAD --wait
```
No code changes are expected to be needed — this is verification-only. The
underlying fix is small (2 files, ~35 lines), locally tested, and reviewed
twice by an independent agent with no blockers found.

## Worktree state
Clean, `job/linear-BRO-2834-mtrrvc6o` fully merged into `origin/main`. Safe to
remove.

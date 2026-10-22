# feedback-overnight branch disposition (BRO-3015), 2026-10-21

Tool: `node scripts/audit-feedback-overnight-branches.js [--json]` (test: `node --test scripts/audit-feedback-overnight-branches.test.mjs`).
It reverse-applies each branch's commit to `origin/main` in a temp index (`git apply --cached --check -R`): success means main already contains the change (superseded). Forward success means it merges cleanly; otherwise it conflicts. Verified on a throwaway repo covering all four outcomes.

**Status update, same day:** the numbers below are the snapshot taken before porting started. Porting is now owned by BRO-5900, whose worker is merging each branch into app main (merge commits titled "fixes already present on main by behaviour" record superseded batches). After those merges the script reports a branch as `merged` (ancestor of origin/main) without saying whether its changes were taken or recorded as superseded; read the merge commit message for that. Re-run the script for current counts.

## Result (iOS repo `~/BroadwayScorecard-app`, origin/main 71dd1f3)

37 `worktree-feedback-overnight-*` branches: 14 already ancestors of origin/main (merged; includes the BRO-270, visual-diff and LC_ALL batches), 23 not.

The 23 unmerged: 22 TestFlight batches, plus 1 (2026-08-09T20-06-52) that is an ancestor, so 22 real. Of the 22:

- 1 merges cleanly: `2026-08-12T06-15-03` (1 item, 2 files).
- 21 conflict with main in 1 to 5 files each (the rest of each patch applies). These need hand porting, newest first.
- 0 are superseded wholesale. No branch's full diff is already present on main, so none can be dropped as superseded at file granularity. Partial supersession inside conflicting hunks is decided during porting.

The original card counted 16 branches from 2026-09-08; 6 more batches landed 2026-09-09 to 09-16.

## Nightly job decision

`com.broadwayscorecard.feedback-overnight` (launchd, 02:00, `scripts/feedback/overnight-launchd.sh`) is still loaded. Last exit status is 2 (last run 2026-10-20 02:15, empty logs) and the newest branch is 2026-09-16, so output stopped growing about five weeks ago. Decision: keep the job (it turns real TestFlight reports into fixes), but it must not leave branches stranded. Required before re-enabling normal operation: each night rebases onto origin/main, then merges its own clean batch or files a card if it conflicts; the audit script above is the disposition check (non-zero unmerged TestFlight batches older than 3 days = alert). Diagnosing the exit-2 failure and adding the rebase/auto-merge step live in the app repo and are tracked on the porting card.

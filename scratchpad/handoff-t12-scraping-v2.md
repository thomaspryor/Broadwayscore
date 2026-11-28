# Handoff: Scraping v2 Sprint 2+3 (task #684) — finish + own T13 gate

## What this session did (all verified, some CLOBBERED by concurrent churn — see below)

1. **T12 shipped** (commit `63bce962d57`, merged to main): `scripts/audit-direct-provider-calls.js` +
   `scripts/lib/direct-provider-detector.js` — advisory-first lint flagging scripts that call
   ScrapingBee/BrightData/Scrapingdog content-fetch endpoints directly instead of routing through
   `fetchPage()` in `scripts/lib/scraper.js`. Baseline at `data/audit/direct-provider-calls-baseline.json`
   freezes known debt; `--strict` only fails on a genuinely NEW site. Allowlist at
   `scripts/config/direct-provider-calls-allowlist.json`. Migrated 2 cron-reachable callers to
   `fetchPage()`: `scripts/scrape-playbill-verdict.js`, `scripts/auto-fix-show-data.js` — both verified
   live against real endpoints (playbill.com resolved via Scrapingdog instead of paying SB; TodayTix
   now free via Playwright-first instead of paying SB render credits).

2. **Ship-check found 2 real bugs** (Codex adversarial review + a real CI failure):
   - `audit-help-flag-safety.js` false-flagged `audit-direct-provider-calls.js` itself — its own USAGE
     help text contains the literal string `fetchPage(` as prose, which the risky-call heuristic reads
     as a call appearing before the `--help` gate. Fixed with a `hygiene-help-flag-ok:` exemption comment
     (the tool's own documented escape hatch).
   - The file walk only matched `*.js`, silently missing 3 real direct-ScrapingBee `.ts` scripts:
     `scripts/scrape-grosses.ts`, `scripts/scrape-alltime.ts` (both cron-reachable, task #328's original
     grosses-scraper incident), `scripts/verify-reviews.ts`. Fixed by extending the walk to `.ts`.
   - Fix committed as `cbf20f18163`, merged to main via `merge-worktree-to-main.sh`, script reported
     verified-on-origin.

3. **THE FIX WAS SILENTLY DROPPED.** Some time after `cbf20f18163` landed and was verified present on
   origin/main, a LATER concurrent merge on main reverted `scripts/audit-direct-provider-calls.js` back
   to the pre-fix state (confirmed via `git show origin/main:scripts/audit-direct-provider-calls.js` —
   no `hygiene-help-flag-ok` comment, no `.ts` support, `.js`-only walk). This matches the documented bug
   class in tasks **#819** ("merge-worktree-to-main.sh exits 0 after 'could not checkout main', stash-then-
   abort silent failure" — marked completed) and **#835/#863** ("merge-worktree-to-main.sh skips the
   pre-push audits, so violations land on main and block EVERY session's push" — #835 completed, #863
   still in_progress). This repo currently has **80+ concurrent auto-dispatched sessions** pushing to the
   same main branch; the merge/push safety script apparently still has races under this load level even
   after #819/#835's fixes.

4. **Reapplied the fix a second time** as commit on branch `worktree-t12-reapply-fix` (local commit
   `e1562e6dbb0`, message: "fix(scraping-v2): reapply T12 ship-check fixes (silently dropped by
   concurrent merge churn)"). Ran `bash scripts/merge-worktree-to-main.sh worktree-t12-reapply-fix` —
   this was STILL RUNNING (backgrounded past 120s, likely queued on the push mutex given system load)
   when this session's context ran out. **You need to check whether that merge completed and — critically
   — whether the content survived this time**, not just whether the script reported success.

## YOUR FIRST JOB: verify + re-verify (don't trust prior "done" claims, including this session's)

```bash
cd ~/Broadwayscore
git fetch origin main
git show origin/main:scripts/audit-direct-provider-calls.js | grep -c "hygiene-help-flag-ok\|SOURCE_FILE_RE"
# MUST be 2. If 0, the fix got dropped again — see "if it drops a third time" below.
git show origin/main:.github/workflows/test.yml | grep -c "Audit — direct provider calls"
# MUST be >=1.
node scripts/audit-direct-provider-calls.js --strict; echo "exit:$?"
# MUST be 0. If baseline is stale (new violators appear as diff files), a concurrent session may have
# added a new direct-provider-call site since — check whether it's legitimate cron-debt (rebaseline) or
# a genuine new violation worth flagging to that session's owner.
```

If the worktree `~/Broadwayscore/.claude/worktrees/t12-reapply-fix` still exists with uncommitted state,
check `git -C ~/Broadwayscore/.claude/worktrees/t12-reapply-fix log --oneline -3` and
`git -C ~/Broadwayscore/.claude/worktrees/t12-reapply-fix status` first — the commit may already be
sitting there ready to re-push if the merge script never got the mutex.

## If it drops a THIRD time

This is no longer a one-off — it's a real, reproducible instance of the #863 bug class actively hurting
delivery under current concurrency. Don't just keep re-applying by hand:
1. Card it clearly (if not already covered by #863) with this session's concrete repro: two independent
   drops of the same small, isolated 2-file diff within ~1 hour, under high concurrent-session load.
2. Consider whether `scripts/lib/push-mutex.sh` (used by `merge-worktree-to-main.sh`) is actually
   serializing writers correctly at this session count, or whether the "delayed re-verify (+2m/+8m/+15m)"
   step the script logs is itself racing against a NEWER commit that also touches the same file (i.e. the
   re-verify checks presence of the file, not presence of YOUR specific diff inside it — a later commit
   touching the same file can satisfy "file exists" while still reverting your lines). That's a plausible
   root cause worth checking in `scripts/merge-worktree-to-main.sh`'s verify step.
3. Once genuinely landed and STABLE (verified via a git fetch + grep AFTER waiting ~15 min with no new
   commits touching that file, not just immediately after push), mark task #684 outcome updated in Notion
   (card `3af637c5-416f-8158-ad8d-cd7ce2aea384`) — it's currently marked Done but doesn't reflect this
   drop/reapply saga. Update its Outcome field with what actually happened.

## T13 (BB cap step-down 250→100→60) — do NOT start yet

Explicitly gated in the original task #684 card on ≥3 billed days under the Sprint-1 (T4) cost target.
T4 landed 2026-07-31; first fully clean billed day was 2026-08-01. Check
`data/audit/provider-spend-daily.jsonl` for how many consecutive days have been within threshold
(Browserbase <$4/day, BrightData <$2.50/day per the related RECHECK-AFTER card) — if ≥3 clean days have
now accumulated, T13 is unblocked: single exported BB cap constant, step down 250→100→60, poller yml
injects the env, runbook + digest cap-exhausted line. If not yet at 3 days, leave it — don't start early.

## Other loose threads from this session (lower priority, FYI only)

- Task #684's Notion card (`3af637c5-416f-8158-ad8d-cd7ce2aea384`) claims "Done" based on the FIRST
  (later-reverted) landing. Needs its outcome corrected once the fix is confirmed stably landed per above.
- 20 remaining baselined direct-provider-call files (18 cron-reachable, minus the 2 already migrated)
  are tracked debt for a future migration pass — NOT this session's job unless T13 gate opens and a
  natural continuation makes sense.

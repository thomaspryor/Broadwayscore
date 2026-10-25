# BRO-6008 state (2026-10-22 16:30 ET)
Done (committed on job/linear-BRO-6008-mvjwjxh3, tip 046c0287e94, ship-check verdict recorded):
- fetchPage options tiers/wait/countryCode (scripts/lib/scraper.js), BD-only helper (scripts/lib/audience-page-fetch.js)
- LBO/LTD/SeatPlan/ShowScore/WE-sweep migrated off direct BD/SB calls; baseline 13 -> 10; allowlist entries removed
- tests/unit/scrapingbee-direct-calls.test.mjs (VERIFY) passes 10/10 on the branch; parity run on live data OK
Remaining: LAND. origin/land/job/linear-BRO-6008-mvjwjxh3 is at the tip; land.yml run was cancelled while pending (busy queue), server-side retry pending.
Next command (from the worktree): bash scripts/merge-worktree-to-main.sh
Then on main: node --test tests/unit/scrapingbee-direct-calls.test.mjs ; then linear-session.js report --status=done.
Not done: scripts/collect-review-texts.js (BRO-2964, still baselined), "Requires: SCRAPINGBEE" docs (still accurate: those scripts gate on the SB key).

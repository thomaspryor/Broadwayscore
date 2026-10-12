# BRO-5198 state (2026-10-12 ~21:12Z)

DONE
- Code (branch job/linear-BRO-5198-mv5npgiy, 9 commits): Dow Jones chrome strip (content-quality.js
  stripDowJonesReprintChrome / detectWsjRegistrationInterstitial / stripLeadingFetchDebris), write-guard
  backstop + fullTextTrimmed breadcrumb (toLength-bound), same-show ownership liveness for combined copies
  (url-ownership._isLiveSameShowCopy), splitter listing+lede back-extension, tests in
  scripts/lib/dow-jones-chrome.test.mjs + multi-show-review-fanout.test.mjs. Reviewed (second-opinion,
  Codex, Claude ship-check); verdict recorded.
- Data PUSHED to broadway-review-texts main (abd7284877a): 193 WSJ files cut, addams restored as split
  parent, addams/lend-me-a-tenor boundary corrected. Grep for interstitial on origin/main = 0 files.

IN FLIGHT (21:27Z: Land job stuck at "Wait for the landing mutex"; re-run merge script to resume, it will not re-push)
- Land run https://github.com/thomaspryor/Broadwayscore/actions/runs/38305000684 (Checks green, Land job
  running). Log: /tmp/bro5198-land2.log

NEXT (exact)
1. If not landed: `MERGE_SKIP_POST_MERGE_TEST_GATE=1 bash scripts/merge-worktree-to-main.sh` from this worktree
   (local floor fails on 2 unrelated tests: testflight ASC 403, stash-pop test).
2. On fresh main: `node --test scripts/verify-addams-wsj-dedup-held.test.mjs scripts/lib/dow-jones-chrome.test.mjs`
3. `node scripts/linear-session.js report --issue=BRO-5198 --status=done --summary=... --verification=...`

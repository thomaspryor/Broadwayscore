# BRO-6956 state (headless job, stopped 2026-11-27 10:20 UTC at time budget)
Done: fix on branch job/linear-BRO-6956-mwyq869q (pushed to origin). Full 180-critic audit on final code ran EXIT 0: blind critics 18/180 (was 156/181), total gaps 3256 (was 89), 0 Browserbase-unavailable, 0 blocked-this-run latch trips. --limit=3 VERIFY passed locally; tsc clean; 15 new tests pass.
Remaining: ship-check record refuses GAP 1/4 because the full audit ran backgrounded. Next command (foreground, ~65 min):
  timeout 4800 node scripts/audit-critic-coverage.js > /tmp/audit-full.log 2>&1; echo EXIT:$?
then: node scripts/lib/review-coverage.mjs --record --answer='GAP 1: ran timeout 4800 node scripts/audit-critic-coverage.js' --answer='GAP 2: ran node --test tests/unit/opening-night-lane-browserbase-warmup.test.mjs tests/unit/opening-night-lane-inline-score.test.mjs' --answer='GAP 4: ran timeout 4800 node scripts/audit-critic-coverage.js'
then: git checkout -- data/audit/ ; git rm STATE.md ; bash scripts/merge-worktree-to-main.sh ; on main: node scripts/audit-critic-coverage.js --limit=3 && npx tsc --noEmit ; gh workflow run audit-critic-coverage.yml
Remaining 18 blind critics are per-critic "no Muck Rack profile at this slug" (UK critics, David Cote, Victor Gluck): add muckrack overrides in data/critic-author-pages.json.
Side card: BRO-8396 (stagebuddy lane source gap, pre-existing red test), dispatch refused on disk pressure.

# BRO-6833 state
Done: registry data/city-hubs.json drives menu/footer/stats/local-market/tic-cities/feed cy; wiring test; runbook memory/add-us-city-hub.md; LA staged launched:false (dry run: 6 shows). App side already on app main (c63f7bb).
Remaining: land. Branch pushed to land/job/linear-BRO-6833-mvzhipmo; earlier land runs failed on a stale test (fixed) and a footer rebase conflict (merged, fixed). Wait for the Land run (scripts/lib/wait-for-run.sh <id>), then on main:
  npx tsx --test tests/unit/city-hub-wiring.test.ts
Then: node scripts/linear-session.js report --issue=BRO-6833 --status=done ...

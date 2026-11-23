# BRO-7391 state (headless session, 2026-11-23)

Done on branch job/linear-BRO-7391-mwtcmjl2 (4 commits, ship-check recorded):
- audit-cross-outlet-attributions.js: homes = buildEvidencedDefaultHomes (default-critic-home.js), homeless registry defaults ignored and logged.
- cross-outlet-triage.js: approved criticName plans count as verified triage; review-field-edit.js binds criticName plans to content.
- detect-syndicated-duplicates.js + trigram-similarity.js containmentSyndication: truncated syndicated copies (Romeo Tribune/Variety Stasio).
- Tests: scripts/lib/cross-outlet-triage.test.mjs, scripts/lib/trigram-similarity.test.mjs.

Remaining: land. `bash scripts/merge-worktree-to-main.sh > /tmp/land.log 2>&1` ; first attempt failed the
post-merge colocated test floor (baseline fetch race, log truncated). Check /tmp/bro7391-land2.log for the failing test.
Then: node scripts/linear-session.js report --issue=BRO-7391 --status=paused (RECHECK-AFTER 21 days after landing).

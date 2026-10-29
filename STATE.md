# BRO-6519 state
Done: code + tests + review fixes committed (680e5ab0f81), pushed to land/job/linear-BRO-6519-mvtd0m0a. Land run 40854899780 queued >90 min behind other land runs.
Remains: land run to go green and fast-forward main, then re-run the VERIFY on main and re-measure rejected pushes/lock-hold p90 (baseline p90 6.4 min, 250/276 rejected).
Next: scripts/lib/wait-for-run.sh 40854899780 9; then git fetch && git merge-base --is-ancestor 680e5ab0f81 origin/main; then node --test scripts/lib/tsc-stamp.test.mjs scripts/lib/land-branch.test.mjs; then linear-session.js report --issue=BRO-6519 --status=done.

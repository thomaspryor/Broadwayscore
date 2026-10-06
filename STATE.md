# BRO-4786 state
Done: lease CAS store, guard, CLI, six workflow syncs, push-review-texts enforce, script skips, 13 passing tests (tests/unit/opening-night-lane-lease-wiring.test.mjs). ship-check recorded pass.
Landing: land run 37487992073 went red on one test (rmSync without maxRetries in my test) — fixed in the last commit; needs re-land.
Next: `bash scripts/merge-worktree-to-main.sh job/linear-BRO-4786-muwt2lon`, wait for green land run, then on main `node --test tests/unit/opening-night-lane-lease-wiring.test.mjs`, then `node scripts/linear-session.js report --issue=BRO-4786 --status=done ...`.

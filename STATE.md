# BRO-236 state
Done: tests/unit/predictions-page.test.mjs (7 tests, passes; fails if nominees redirect removed); newsletter dump-tony-predictions.ts fixed (wrong import -> catch returned true -> fake 100% picks; now empty picks pre-nominations).
Remaining: land on main. land.yml runs for origin/land/job/linear-BRO-236-muujrqqt were cancelled while pending (37250772285, 37254063747).
Next: bash scripts/merge-worktree-to-main.sh (resumable); then on main: node --test tests/unit/predictions-page.test.mjs

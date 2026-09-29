# BRO-3941 state
Done: scripts/tests/sweep-open-backlog-acceptance-scheduled.test.mjs (9 tests, mutation-checked), registered in tests/unit-test-manifest.txt + test.yml paths. Workflow steps already existed (BRO-4135). ship-check recorded pass.
Remaining: land on main (land run 36621059619 was in progress; earlier run 36616780211 was cancelled/superseded, nothing reached main), then `node scripts/linear-session.js report --issue=BRO-3941 --status=done ...`.
Next command: `bash scripts/merge-worktree-to-main.sh` (add an empty commit first if the previous land run was cancelled).

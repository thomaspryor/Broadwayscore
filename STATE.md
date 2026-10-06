# BRO-4786 state
Done: lease CAS store, guard, CLI, six workflow syncs, push-review-texts enforce, script skips, 13 passing tests (tests/unit/opening-night-lane-lease-wiring.test.mjs). ship-check recorded pass.
Landing: land run 37487992073 went red on one test (rmSync without maxRetries in my test) — fixed in the last commit; needs re-land.
Next: `bash scripts/merge-worktree-to-main.sh job/linear-BRO-4786-muwt2lon`, wait for green land run, then on main `node --test tests/unit/opening-night-lane-lease-wiring.test.mjs`, then `node scripts/linear-session.js report --issue=BRO-4786 --status=done ...`.
# BRO-4196 state
Done: tests/unit/image-presence.test.mjs live imageless sweep -> t.diagnostic (fatal only with IMAGE_PRESENCE_STRICT=1) + deterministic fixture test for findImagelessScoredShows. Committed (2131dcc2e28), /second-opinion pass recorded.
Root cause: newly scored shows are imageless until image self-heal lands (hours); a live-data assert turned main red each time.
Remaining: land run 36623320088 (land/job/linear-BRO-4196-mun0ydst) must finish; verify `git merge-base --is-ancestor 2131dcc2e28 origin/main`. If cancelled: empty commit + bash scripts/merge-worktree-to-main.sh.
Then: node scripts/linear-session.js report --issue=BRO-4196 --status=done --summary="..."
Local run-unit-tests has 27 env failures (missing review-texts private repo, worktree/hook tests) unrelated to this change.

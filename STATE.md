# BRO-4196 state
Done: tests/unit/image-presence.test.mjs live imageless sweep -> t.diagnostic (fatal only with IMAGE_PRESENCE_STRICT=1) + deterministic fixture test for findImagelessScoredShows. Committed (2131dcc2e28), /second-opinion pass recorded.
Root cause: newly scored shows are imageless until image self-heal lands (hours); a live-data assert turned main red each time.
Remaining: land run 36623320088 (land/job/linear-BRO-4196-mun0ydst) must finish; verify `git merge-base --is-ancestor 2131dcc2e28 origin/main`. If cancelled: empty commit + bash scripts/merge-worktree-to-main.sh.
Then: node scripts/linear-session.js report --issue=BRO-4196 --status=done --summary="..."
Local run-unit-tests has 27 env failures (missing review-texts private repo, worktree/hook tests) unrelated to this change.

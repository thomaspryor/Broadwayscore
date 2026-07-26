---
name: feedback_pr_merge_fallback_for_bursty_ci_push_race
description: "When direct pushes to main keep losing the race to bursty CI (even push-with-retry.sh exhausts its retries), push to a branch and merge server-side via gh pr merge --squash --admin — atomic, race-free."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 43c4c14a-0cfe-4b0f-8f19-cab97ea2e3d0
  modified: 2026-07-26T16:08:03.783Z
---

When main is being hammered by clustered CI commits (LLM ensemble scoring + deploy-watermark + audit/health workflows landing several commits within seconds, then a 2-3 min gap), a local `fetch → merge → push` loop loses the race every time: origin advances during the push's network round-trip. On 2026-07-12 this beat a naive tight loop 8/8 AND `scripts/lib/push-with-retry.sh 8` (its 14-20s random backoff still landed inside bursts), across ~25 attempts, while piling merge commits onto local main.

**Fix:** stop racing. Push your HEAD to a NEW branch (`git push origin HEAD:refs/heads/<branch>` — a fresh ref is always a fast-forward, succeeds instantly regardless of main's movement), then `gh pr create` + `gh pr merge <n> --squash --admin --delete-branch`. GitHub performs the merge server-side, atomically, so there is no local race. `--admin` (owner has it) bypasses the "waiting for checks" gate; `--squash` also collapses the merge-commit spam a failed local loop leaves behind into one clean commit.

**Why:** the local push race is unwinnable when commit cadence < your fetch-merge-push latency; the only reliable path is to let the server do the merge. push-with-retry.sh is still correct for the common case (occasional single CI commit) — reach for the PR fallback only when it has actually exhausted its retries.

**How to apply:** direct push to main fails 3+ times in a row against a visibly bursty `git log origin/main` → don't keep looping. Branch + PR + `--squash --admin` merge. Then sync local: `git reset --hard origin/main`. Verify the merge landed by checking `git cat-file -p origin/main:<changed-file>` for your change (a rate-limit-immune check), not the PR API alone.

Related: [[feedback_github_polling_rate_limit.md]] (don't loop gh on 403), [[feedback_data_repos_clobber_uncommitted.md]] (gh api PUT fallback when local git is broken). Separate data repos (review-texts) are less contended — push-with-retry.sh usually wins there first try.

**Squash-merge false-positives the worktree exit-status-gate hook (2026-07-26).** After `gh pr merge --squash`, the merge commit on origin/main has a NEW sha — your worktree branch's original commit will never show as an ancestor, so `git cherry origin/main HEAD` and the exit-status-gate hook's "N unmerged commits vs main" check both flag it as unmerged even though the content is fully landed. Don't skip verification on the assumption it's just noise, and don't `git reset --hard origin/main` reflexively either (fine if you truly have nothing else pending, but not required for the check to pass). Verify per-file: `git show origin/main:<path> | diff - <(git show HEAD:<path>)` for every file the PR touched (or grep for a distinctive line) — that proves origin/main actually has your change, independent of SHA ancestry. State that verification explicitly in the wrap-up message; "0 unmerged" from `git cherry` alone is not proof after a squash merge, and "1 unmerged commit" alone is not proof of loss either.

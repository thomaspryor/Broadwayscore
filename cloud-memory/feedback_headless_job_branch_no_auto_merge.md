---
name: feedback-headless-job-branch-no-auto-merge
description: job/linear-BRO-*-mu* worktree branches are NOT auto-merged by any supervisor — the dispatching session must merge+push to main itself before ending
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 2acc6a13-1ef9-41e4-bfd8-c65668d5cebb
  modified: 2026-09-18T12:52:42.773Z
---

Headless `job/linear-BRO-N-*` worktree branches (dispatched Linear-issue sessions) are never landed on `main` by an external process. The presence of `scripts/autonomous-merge.js` and dozens of concurrently-open `job/*` branches in `git worktree list` looks like evidence of an auto-merge pipeline — it is not; those are just other sessions' unmerged work sitting the same way yours would.

**Why:** A session assumed a "fleet dispatcher" would land its branch and ended the turn after only pushing to the feature branch, reporting Linear status=done. The `exit-status-gate.sh` hook caught it: `git log origin/main..HEAD` was non-empty. The corrected flow (confirmed working): from inside the worktree, `git fetch origin main && git merge origin/main --no-edit` (no conflicts expected for small diffs), rerun tests, then `bash scripts/lib/push-with-retry.sh 7 main` — this pushes current HEAD to `origin/main` directly (the script normalizes the plain branch name `main` to a `HEAD:main` refspec), no need to `git checkout main` or touch the primary repo checkout at `~/Broadwayscore`. Verify with `git log origin/main..HEAD` (must be empty) before claiming done.

**How to apply:** For any headless/dispatched session ending work on a `job/linear-BRO-*` branch, always merge origin/main in and push to main yourself via `push-with-retry.sh` before reporting done — never assume a supervisor will land it, even when many sibling `job/*` branches are visible unmerged (that's normal steady-state, not evidence of a queue). See [[feedback_worktree_code_changes.md]] for the worktree-first rule this pairs with.

**Update 2026-09-18 (BRO-3716):** a `gh pr create` from a `job/linear-BRO-*` branch DID auto-merge without any `gh pr merge` call — twice in one session (`gh pr view <N> --json state` read `MERGED` before I'd taken any merge action; a later explicit `gh pr merge` on a second PR returned "already merged"). This is real GitHub auto-merge behavior on this repo, not a hallucinated supervisor — it fires once required checks go green. It does NOT contradict the direct-push path above (still valid, still needed if you skip the PR step or checks are slow) — it means `gh pr create` + wait-for-CI-green + `gh pr view --json state` is now a *verified alternative* to the manual `git merge origin/main && push-with-retry.sh` dance, and is simpler when you want a PR record anyway. Don't assume it every time — confirm with `gh pr view --json state` (or `git log origin/main..HEAD` empty) before reporting done either way.

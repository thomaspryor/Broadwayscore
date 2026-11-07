---
name: feedback_worktree_branch_stays_unmerged_after_retry_rebase
description: "after scripts/lib/push-with-retry.sh lands your worktree branch on main via rebase/cherry-pick (new SHAs, same content), the WORKTREE branch itself still shows commits ahead of origin/main by SHA — exit-status-gate's WORKTREE line reads that as unmerged even though the content landed"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: a1366593-7f73-4834-ad73-42cc05ee3220
  modified: 2026-09-15T23:56:46.587Z
---

Landed BRO-3487 by merging a worktree branch into the shared main checkout (`git -C <main> merge <branch> --no-edit`) then pushing via `bash scripts/lib/push-with-retry.sh`, which hit a conflict and resolved it via rebase — so the commits that landed on `origin/main` have different SHAs than the ones still sitting on my worktree branch, even though the file content is identical. `exit-status-gate.sh`'s WORKTREE check (`git log origin/main..HEAD` in the worktree) still reported "3 unmerged commit(s)" after this, because it compares commit ancestry, not content.

**What actually fixed it:** `git diff origin/main -- <changed files>` in the worktree (zero output confirmed content-identical) to prove nothing was lost, THEN `git fetch origin && git reset --hard origin/main` **in the worktree itself** (not just the main checkout) to fast-forward the branch pointer onto the now-equivalent commits. Only after that did `git log origin/main..HEAD` in the worktree come back empty.

**How to apply:** whenever you land a worktree branch via `push-with-retry.sh` (or any path that can rebase/cherry-pick rather than fast-forward), don't just verify the main checkout — go back to the WORKTREE and diff-then-reset it against `origin/main` too, before declaring the session's WORKTREE line clean. Content-diff first (never `reset --hard` on unverified content), reset second. See [[feedback_push_with_retry_scary_error_verify_dont_reset]] (same "verify before destructive git ops" discipline, different trigger) and [[feedback_parallel_worktree_race]] (why rebase-not-merge is common here: 40+ concurrent worktrees on one shared main).

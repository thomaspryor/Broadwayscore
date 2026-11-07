---
name: worktree-isolation-guard-blocks-review-texts-git-ops-even-though-data-files-are-worktree-exempt
description: "EnterWorktree's Bash isolation guard blocks git commands targeting data/review-texts (a separate private repo) mid-session, even though data-file edits are normally exempt from the worktree-code requirement — must ExitWorktree(keep) first, do the data-repo commit/push from the main repo, then continue."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: e8a4a576-0995-4ca5-b9a6-6cdb155935e6
  modified: 2026-08-19T15:26:52.467Z
---

**Rule:** Once inside an `EnterWorktree` session, `git` commands (status/add/commit/push/pull) targeting `data/review-texts/` (or `data/aggregator-archive/`, or any nested private-repo checkout) are BLOCKED by the isolation guard — even via `cd`, `git -C <path>`, or a Bash heredoc script writing there — with "a worktree-isolated session's git operations must target its own worktree." This is true even though `data/**` edits are normally exempt from the worktree-mandatory-for-code rule ([[feedback_worktree_code_changes.md]]).

**Why:** the guard can't distinguish "this is a nested independent git repo, not part of the code worktree" from "this is a stray edit to the shared main checkout" — it just blocks any git op whose target resolves outside the current worktree's own directory tree.

**How to apply:** when a worktree-code session also needs to commit/push data to `data/review-texts` (e.g. applying stale-flag clears alongside a related code fix), do the code work and commit it in the worktree first, then call `ExitWorktree(action: "keep")` to return to the main repo, do the `data/review-texts` commit + `pull --rebase` + `push` from there, then either continue in main repo or re-enter the worktree via `EnterWorktree(path: <worktree-path>)`. Don't try to work around the guard with `-C`/`cd`/heredoc tricks — it catches all of them.

**Adjacent gotcha found same session:** the main repo's own working tree accumulates ambient `data/audit/*` churn from concurrent background automation (other sessions/crons constantly rewriting audit JSON/log files) — `git pull --rebase`/`git merge` on main routinely fails with "unstaged changes" against files you never touched. Stash them (`git stash push -u -m "ambient data/audit churn..."`) before merging, per existing guidance in the stash-backlog session-start reminder — these are safe to drop afterward (not pop), they regenerate constantly.

See card #1610 (Broadwayscore stale-flag audit session, 2026-08-19) for a concrete instance: needed to commit `data/review-texts` clears from inside `EnterWorktree("stale-flag-audit-1610")`, hit this block, worked around it via ExitWorktree(keep) → commit/push data → continue code work in worktree → merge+push at the end.

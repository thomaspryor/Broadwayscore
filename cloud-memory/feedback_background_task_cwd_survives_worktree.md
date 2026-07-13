---
name: background-task-cwd-survives-worktree
description: "Background Bash tasks and waiters keep their launch cwd — removing the worktree they started from kills them with \"Unable to read current working directory\"; anchor waiters in the main repo path"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 97a4bc9a-29b7-4f90-8a44-371e69f1aa89
---

Background Bash tasks (`run_in_background`), Monitors, and `wait-for-run.sh` waiters inherit the cwd they were launched from. Removing that worktree (ExitWorktree remove / `git worktree remove`) makes every subsequent command in the still-running task fail with `fatal: Unable to read current working directory: No such file or directory` — gh then errors with "failed to determine base repo".

**Why:** bit twice on 2026-07-12: two CI waiters launched from worktrees died mid-wait after the worktrees were cleaned up; the dispatches had succeeded so the failures looked like CI problems.

**How to apply:** before starting any background task that will outlive the current worktree, prefix it with `cd /Users/tompryor/Broadwayscore &&` (main repo absolute path) — or don't remove the worktree until its background tasks complete.

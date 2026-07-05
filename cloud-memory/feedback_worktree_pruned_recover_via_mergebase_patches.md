---
name: feedback_worktree_pruned_recover_via_mergebase_patches
description: "Worktree pruned mid-session → recover from WIP branch via merge-base patches, never merge the stale branch"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 1efa968d-4314-4743-acfb-6d145b9862b2
---

A worktree can vanish mid-session (a gc/cleanup process, e.g. `scripts/gc-merged-worktrees.sh`, or external tooling). If the work was auto-committed to its branch first, the **branch survives** — `git branch --list <name>` shows it even when `git worktree list` no longer does. The directory may be left as a near-empty shell of symlinks.

**Recovery — do NOT merge or check out the stale long-lived branch directly.** If it forked from an old `origin/main`, `git diff main..branch` is dominated by main's *forward* progress showing up as deletions (one incident: 83k "deletions", 208 files) — merging it would revert main. The branch is a backup of your edits, not a mergeable state.

Instead, extract only your changes and replay them onto fresh main:
```bash
BASE=$(git merge-base origin/main <BRANCH>)
# new files: copy verbatim
git show <BRANCH>:path/to/new-file > /tmp/recover/new-file
# edited files: per-file patch of ONLY your changes
git diff $BASE..<BRANCH> -- path/to/edited-file > /tmp/recover/edited.patch
```
Then: create a **fresh** worktree from current `origin/main`, copy the new files, `git apply --check` each patch before `git apply`, verify the diff is exactly your work, run tests, and **commit immediately**.

**Why:** worktrees are not durable; uncommitted work has no recovery path at all, and a stale branch that forked days ago is a trap (direct merge reverts main), not a clean backup. Pairs with [[feedback_worktree_code_changes.md]] (commit early in worktrees) — this is the recovery half. High-churn repos make the merge-base patch approach mandatory: `main` moved ~4000 commits in 5 days, so the stale branch diverged enormously while the actual edits stayed tiny and clean.

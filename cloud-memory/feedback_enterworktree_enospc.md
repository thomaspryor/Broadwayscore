---
name: feedback_enterworktree_enospc
description: "EnterWorktree fails with \"No space left on device\" — the self-heal script already exists, just run it directly"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 1fbcaf93-5341-4da4-8af6-9a4447a75833
  modified: 2026-08-15T03:14:54.047Z
---

`EnterWorktree` has no disk-floor preflight of its own — it can fail outright with ENOSPC ("error: unable to create file ... No space left on device") before any repo script gets a chance to self-heal. This happened 2026-08-15 at 856Mi free / 94% capacity with 101 worktrees on disk.

Don't hand-audit worktrees for safe removal from scratch. `scripts/gc-merged-worktrees.sh` already exists (added for task #968, sourced by `scripts/lib/disk-floor-check.sh` inside `push-with-retry.sh`/`merge-worktree-to-main.sh`) and does exactly this safely — merged-into-origin/main branches, unlocked, only throwaway `data/audit/**` dirt. It just isn't invoked before `EnterWorktree` itself.

**Why:** the disk-floor self-heal (task #968) only fires inside push/merge scripts, not at worktree-creation time — a session can hit ENOSPC on its very first `EnterWorktree` call with no repo script in the loop yet to self-heal.

**How to apply:** if `EnterWorktree` fails with "No space left on device" (or `df -h /` shows <2GB free before calling it), run `bash scripts/gc-merged-worktrees.sh` from the main repo checkout first, then retry `EnterWorktree`. Don't manually `git worktree remove` candidates one-by-one — the script already encodes the merged+unlocked+clean-dirt safety check.

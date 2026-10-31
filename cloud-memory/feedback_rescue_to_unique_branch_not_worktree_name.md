---
name: feedback_rescue_to_unique_branch_not_worktree_name
description: "When rescuing uncommitted worktree work, commit to a rescue/* branch — not the auto-generated worktree-* name a parallel session can reuse and reset"
metadata: 
  node_type: memory
  type: feedback
  originSessionId: a500a505-0f50-4405-9be0-73c5ab2b19d4
---

When triaging/removing `.claude/worktrees/*`, rescuing uncommitted work by committing it to the worktree's **own** `worktree-<name>` branch is NOT safe preservation. `EnterWorktree` auto-generates branch names from the worktree name, so a parallel session that later creates a worktree with the same name **resets that branch to origin/main**, orphaning your rescued commits (dangling → lost at git's next `gc`).

Incident (2026-06-16): rescued the notable-OB homepage feature onto `worktree-notable-ob-homepage`; a parallel session reused the name and reset it. `git cherry origin/main worktree-notable-ob-homepage` then showed it "fully merged" while commits `afc1f0a365`/`14f9015ff0` were dangling. Caught only because `/ship-check` re-ran the gc dry-run and the branch read as merged when it shouldn't have.

**Why:** worktree-* branch names are a shared, reusable namespace owned by the EnterWorktree workflow, not by your rescue. Committing there ≠ durable.

**How to apply:** Rescue to a uniquely-named branch no worktree session will touch: `git branch rescue/<descriptive-name> <sha>`. Verify durability with `git branch --contains <sha> | grep rescue/`. A commit reachable only as "<no branch! dangling>" is at risk — anchor it immediately. Removing a worktree always keeps its branch, but only if nothing later reuses that branch name. Related: [[feedback_parallel_worktree_race]], [[feedback_data_repos_clobber_uncommitted]]. The weekly GC (`scripts/gc-merged-worktrees.sh`) uses `git cherry` (not `--is-ancestor`) so it catches squash-merges; it skips `action-*` worktrees owned by notion-action-poll.js.

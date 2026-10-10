---
name: enterworktree-sibling-repo-scope
description: "EnterWorktree only creates worktrees in the session's primary repo — it can't target a sibling repo (e.g. a Broadwayscore session doing iOS work in BroadwayScorecard-app); use a manual `git worktree add` in the other repo instead, and prefix every Bash command with `cd <path> &&` since the harness resets shell cwd back to the primary repo between calls"
metadata:
  type: feedback
  originSessionId: 5539f0e9-172e-487d-9366-9ed37b97bebd
  modified: 2026-07-26T04:33:43.395Z
---

`EnterWorktree` (and `ExitWorktree`) are scoped to whatever repo the session's primary working directory is in. Calling `EnterWorktree({name: "..."})` from a session launched in `~/Broadwayscore` silently creates the worktree inside `~/Broadwayscore/.claude/worktrees/`, even when the actual task is in the sibling repo `~/BroadwayScorecard-app` — it does not error, it just worktrees the wrong repo. `EnterWorktree({path: "..."})` then rejects the sibling-repo path outright: "is not a registered worktree of <primary repo>".

**Fix:** for any tracked-code edit in a sibling repo, skip `EnterWorktree` entirely and do it by hand:
```bash
cd ~/BroadwayScorecard-app && git worktree add .claude/worktrees/<name> -b worktree-<name>
```
Then do all further work by prefixing every Bash call with `cd /full/path/to/the/worktree && ...` — the harness resets the shell's cwd back to the session's primary directory after each Bash call, so a bare `cd` in one call does not carry over to the next. `ExitWorktree` also won't manage a manually-created worktree; clean it up manually: `git worktree remove <path> --force && git branch -D worktree-<name>` after merging.

**Why it matters:** [[feedback_worktree_code_changes.md]] mandates a worktree before any tracked-code edit, but doesn't cover the cross-repo case — a session that blindly trusts `EnterWorktree` here either edits the wrong repo's worktree or gets a confusing rejection error and may be tempted to skip the worktree requirement altogether.

**How to apply:** before calling `EnterWorktree` in any session, check whether the target files live in the session's primary repo or a sibling one (`~/Broadwayscore` vs `~/BroadwayScorecard-app` are the two in this project). If sibling, go straight to the manual `git worktree add` path.

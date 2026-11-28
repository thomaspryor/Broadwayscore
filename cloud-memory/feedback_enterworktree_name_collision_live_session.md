---
name: enterworktree-name-collision-live-session
description: "EnterWorktree with a name matching another session's existing worktree can attach you to that session's LIVE, locked worktree — you see (and could clobber) its uncommitted WIP. Check `git worktree list` before entering; pick a unique name."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: dcbf62dc-a512-40f3-8a86-246585d883c8
  modified: 2026-07-27T04:40:38.327Z
---

On 2026-07-11, `EnterWorktree(name: "cross-show-url-ownership")` reported "Created worktree ... on branch worktree-cross-show-url-ownership" — but that worktree already existed, was **locked**, and belonged to a parallel session actively editing files in it (mtimes updating minute-by-minute; HEAD was that session's un-pushed-round commit, not a fresh branch from origin/main). Result: `git status` showed 3 modified `scripts/lib/` files I never touched (the other session's in-flight round-3 ship-check fixes).

**Why:** Sessions working the same Notion card naturally pick the same worktree name. The tool does not refuse or warn on collision with a live worktree, and "Created" reads as fresh isolation when it isn't. Any edit, checkout, or reset I ran there would have clobbered the other session's WIP — the exact race worktrees exist to prevent ([[feedback_parallel_worktree_race]]).

**How to apply:**
- Before EnterWorktree, run `git worktree list` and check the intended name. If it exists (especially marked `locked`), pick a different name (suffix with a distinguishing word) — never share it.
- If you find yourself in a worktree with modified files you didn't create and fresh mtimes: another session is live there. ExitWorktree(keep) immediately; do not commit, reset, or edit anything in it.
- Verify isolation after entry: `git log origin/main..HEAD` should be empty and `git status` clean for a genuinely fresh worktree.
- **2026-07-27 update (task #542):** this collision recurred and produced real concurrent-write damage. Code-level prevention now exists — `.claude/hooks/enterworktree-guard.sh` (PreToolUse on EnterWorktree) automatically refuses a same-name resume when the existing worktree is locked or dirty, via `scripts/check-worktree-collision.js` + the tested predicate in `scripts/lib/duplicate-dispatch-guard.js`. Manually running `git worktree list` first is now a backup, not the only defense. Also: EnterWorktree's own docs say a KNOWN existing worktree should be re-entered via `path`, not `name` — passing `name` for a worktree you already know exists is the anti-pattern that caused both this incident and #542; use `path` to resume your own work.

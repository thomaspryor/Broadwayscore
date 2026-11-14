---
name: Edit tool path resolution in worktrees
description: "/Users/tompryor/Broadwayscore/... resolves to MAIN; prefix with .claude/worktrees/."
type: feedback
originSessionId: f92fe8b2-d15d-4d53-9af6-06a1dd9d85c4
---
When working in a Claude worktree (`/Users/tompryor/Broadwayscore/.claude/worktrees/<name>/`), Edit and Write tool calls that pass an absolute path starting with `/Users/tompryor/Broadwayscore/scripts/...` write to the **main repo**, NOT the worktree — even though the shell cwd is the worktree.

**Why:** The path is just a filesystem absolute path; the tool has no awareness of which worktree the session is "in". Main and worktree are two separate checked-out copies of the repo at different paths.

**How to apply:**
- When in a worktree, ALWAYS prefix Edit/Write paths with `/Users/tompryor/Broadwayscore/.claude/worktrees/<name>/`
- After any Edit, run `git status` in the worktree to confirm the file shows as modified there
- If the file is modified in main repo instead, you can `cp` it to the worktree as a recovery — but verify main wasn't dirty before
- Discovered 2026-04-10 during the Theatr fix session — 10 edits all landed in main, none in the worktree, took 30+ min to detect because the Edit tool reports success unconditionally

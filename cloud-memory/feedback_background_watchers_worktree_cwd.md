---
name: background-watchers-worktree-cwd
description: "Background tasks (gh run watch, wait-for-run.sh, monitors) spawned from a worktree cwd die with \"Unable to read current working directory\" when the worktree is removed — always launch long watchers from the main repo path."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 56ac3d36-3035-4725-b6b7-71a362e8f0d0
---

Background Bash tasks inherit the cwd they were launched from. If that cwd is a
`.claude/worktrees/*` checkout and the session later runs ExitWorktree(remove),
every still-running watcher in it starts failing with
`fatal: Unable to read current working directory: No such file or directory` —
`gh` then can't resolve the repo and the watch dies looking like a CI failure.
Hit 4 separate times on 2026-07-10→13 (regional pipeline sessions).

**Why:** worktree removal deletes the directory out from under the child
process; gh resolves the repo from cwd on every poll.

**How to apply:**
- Launch any long-running background watcher (`gh run watch`,
  `scripts/lib/wait-for-run.sh`, Monitor loops, `check-prod-deploy.js --wait`)
  with an explicit main-repo cwd: `cd /Users/tompryor/Broadwayscore && ...`
  or `git -C /Users/tompryor/Broadwayscore ...` — never from inside a worktree
  you plan to remove.
- If a watcher notification reports `Unable to read current working directory`,
  it's this artifact, not a CI result — re-check the run directly from the main
  repo before diagnosing anything as failed.

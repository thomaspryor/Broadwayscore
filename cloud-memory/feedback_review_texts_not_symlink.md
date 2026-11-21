---
name: data-review-texts-symlink-status
description: "Main checkout's data/review-texts IS now a symlink to ~/broadway-review-texts (seen 2026-11-04); worktrees have none, so scoring-delta fails there until you symlink it."
metadata:
  node_type: memory
  type: feedback
  originSessionId: 4be16883-52c4-43d6-b0c5-209bee0215c9
  modified: 2026-11-05T02:02:27.878Z
---

Corrected 2026-11-04: `~/Broadwayscore/data/review-texts` is a symlink to `~/broadway-review-texts` (it used to be a separate directory). Worktrees don't get one, so `scoring-delta.js` exits 1 with "review-texts dir not found". Fix it with `ln -s ~/broadway-review-texts data/review-texts` inside the worktree (the path is gitignored).

**Why:** An older note said it was NOT a symlink, so writes there would not reach the private repo. That is out of date and pointed sessions the wrong way.

**How to apply:**
- Writes to review-text files land in the private repo's working tree. Commit and push them there right away ([[feedback_data_repos_clobber_uncommitted]]).
- CI clones the REMOTE private repo, so an unpushed local fix still fails in CI. Check what CI reads with `git -C ~/broadway-review-texts show origin/main:SHOW/FILE.json`.

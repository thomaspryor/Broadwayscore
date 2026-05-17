---
name: Worktree scripts can't read main's data symlinks
description: "Scripts crash on shows.json/review-texts because main's symlinks don't carry."
type: feedback
originSessionId: 9d267f5d-b0d8-44f9-ad26-e0d3090bc86b
archived: true
---
**Rule:** When testing scripts that read `data/shows.json` or `data/review-texts/` from a worktree, either (a) run them from the main repo directory with an absolute script path, or (b) add temporary symlinks in the worktree's `data/` directory pointing back to main's symlink targets.

**Why:**
- `data/shows.json` is a symlink to `~/broadway-scorecard-data/shows.json` (private repo)
- `data/review-texts/` is the actual on-disk path in main; in worktrees it doesn't exist
- Scripts use `path.join(__dirname, '..', 'data', '...')` which resolves to the worktree's `data/` — not main's
- Running `cd /Users/tompryor/Broadwayscore && node /path/to/worktree/scripts/foo.js` does NOT help because `__dirname` is module-relative, not cwd-relative
- Tests of rebuild-all-reviews silently reported zero exclusions for hours during the verbose-logging session because the script crashed at the data-loading step, not at my new code

**How to apply:**
- Before testing a worktree script that reads data files, set up symlinks:
  ```
  ln -sf /Users/tompryor/broadway-scorecard-data/shows.json <worktree>/data/shows.json
  ln -sf /Users/tompryor/Broadwayscore/data/review-texts <worktree>/data/review-texts
  ```
- Always check the script's exit code AND tail the log — silent crashes look like "no exclusions" or "no output"
- Don't assume "0 lines emitted" means "feature doesn't trigger" — verify the script actually ran to completion

---
name: Shows.json data races — stale local data re-introduces bugs
description: "Data edits in worktrees get overwritten by CI; commit on main or merge fast."
type: feedback
archived: true
---

Data file edits get silently reverted when local shows.json is stale. This happens in TWO ways:

1. **Worktree race:** Changes in a worktree get overwritten when CI updates the same file between your change and the merge.

2. **Long-session race (NEW):** Even on main, if you edit shows.json based on a stale local copy and then `git pull --rebase`, the rebase can silently re-introduce entries you deleted earlier in the session. This happened with Dracula/ITW duplicates — removed them, then a later commit based on stale data re-added them.

**Why:** CI pipelines (discover-new-shows, enrich-west-end-dates, rebuild, update-show-status) commit to shows.json frequently — sometimes every 30 minutes. In a 4+ hour session, your local shows.json can be dozens of commits behind.

**How to apply:**
- **Always `git pull origin main` immediately before reading shows.json for edits** — not just at session start
- For data file changes (shows.json, reviews.json), prefer committing directly on main rather than via worktree
- After every `git pull --rebase`, verify your fix survived: `grep 'the-thing-you-removed' data/shows.json` should return nothing
- If you edited shows.json 2+ hours ago without pulling, assume it's stale

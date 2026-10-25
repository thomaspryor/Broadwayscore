---
name: feedback_scoring_delta_worktree_and_phaseb_artifact
description: "Running scoring-delta in a worktree needs gitignored data symlinks (review-texts is NOT gitignored — never git add -A); Phase B always reports the same 4 NY Post flips — pre-existing sandbox artifact, not your diff"
metadata: 
  node_type: memory
  type: project
  originSessionId: b576daaf-6606-4fb7-9e0a-3d1702e06e29
---

Two gotchas from running the mandatory scoring-delta gate inside a worktree (2026-07-11, url-change-invariant session):

1. **Worktrees lack private data files.** scoring-delta needs `data/review-texts/`, `data/shows.json`, `data/reviews.json`. Symlink them from the main clone (`ln -s /Users/tompryor/Broadwayscore/data/X data/X`). `shows.json`/`reviews.json` are gitignored (safe), but **`data/review-texts` is NOT gitignored** — the symlink shows as untracked and would commit as a dangling absolute-path symlink ([[feedback_stray_symlink_crashes_pipeline]]). Always `git add` explicit paths, and `rm` the symlinks before committing.

2. **Phase B (score-source) reports 4 phantom flips on EVERY run:** NY Post / Johnny Oleksinski on back-to-the-future-2023, betrayal-2019, little-shop-of-horrors-off-broadway-2019, slave-play-2021 — baseline 80→working 100 / 40→50 (a 4-star vs 5-star scale disagreement between the baseline lib sandbox and the working tree). Verified 2026-07-11 by stashing all changes and triggering Phase B with a comment-only edit: identical 4 flips. **They are a pre-existing replay artifact, not caused by your diff** — a "4 flips, 0 T1" result on a watchlist edit means your true delta is zero. If the count is ever ≠4 or includes other reviews/shows, those ARE yours — investigate.

**How to apply:** `node scripts/scoring-delta.js --json` now emits `flipDetails` (capped at 100/category, added 2026-07-11) — dump it to identify exactly which reviews moved instead of guessing from per-show counts.

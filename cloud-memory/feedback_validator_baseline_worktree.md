---
name: Validator corrupts baseline in worktrees
description: Running validate-data.js from a worktree writes a corrupted baseline (reviews=0); always git checkout before committing
type: feedback
originSessionId: 0f0d3e56-8294-4a70-bd77-dc0c7d00966d
archived: true
---
`scripts/validate-data.js` writes `data/audit/validation-baseline.json` with stats like `totalReviews`. When run from a git worktree that does NOT have the private `broadway-scorecard-data` / review-text repo cloned, it computes `totalReviews: 0` and writes it to the baseline. Committing that baseline clobbers the real numbers and breaks future drift detection.

**Why:** Review text data lives in a private repo that's cloned alongside the main repo at a known path. Worktrees don't inherit that clone — they're isolated filesystems. The validator silently falls back to "no reviews found" instead of erroring.

**How to apply:**
- After running `node scripts/validate-data.js` from a worktree, always `git checkout -- data/audit/validation-baseline.json` before staging/committing
- Or: don't run validator from worktrees at all; run it from the main repo dir where the private repo is cloned
- Long-term fix: validator should detect missing review-text repo and either error loudly or skip baseline writes instead of silently using 0

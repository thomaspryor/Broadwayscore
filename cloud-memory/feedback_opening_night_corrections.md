---
name: feedback_opening_night_corrections
description: "Disable orchestrator first; humanReviewScore is the ONLY override."
type: feedback
---

Opening night corrections playbook (learned from Dog Day Afternoon 2026-03-30):

1. **Disable orchestrator FIRST:** `gh variable set ORCHESTRATOR_PAUSED --body true`. Re-enable after: `gh variable delete ORCHESTRATOR_PAUSED`. Without this, automated rebuilds cancel fix rebuilds.

2. **Audit FIRST, fix ONCE:** Read every review file, compile all issues, make ALL corrections in ONE commit. Don't fix-push-rebuild iteratively — each cycle takes ~25 min and cascades.

3. **humanReviewScore is the ONLY score override the rebuild respects.** `assignedScore` gets recalculated from `llmScore`. Setting it directly does nothing.

4. **Clear ALL score fields when fixing CSS extraction:** `originalScore`, `originalScoreNormalized`, AND `originalScoreSource` must all be cleared. Missing any one leaves the wrong score active.

5. **Verify on the LIVE site JSON** (`curl broadwayscorecard.com/data/shows/{id}.json`), not local files. Local `reviews.json` and `mobile-shows.json` are frequently stale.

6. **Use batch-correct-reviews.js** for multiple corrections: `node scripts/batch-correct-reviews.js --show=ID --corrections='outlet:score,outlet:score'`. Auto-commits, pushes, triggers rebuild.

**Why:** Dog Day corrections took 6+ hours because of iterative fix cycles, wrong override fields, stale data verification, and orchestrator cascade interference.

**How to apply:** Any time manual score/data corrections are needed on opening night or after.

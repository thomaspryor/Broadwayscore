---
name: Opening night manual scoring gotchas
description: Lessons from Cats opening night on manual GPT-4o scoring, contentTier, and CI data races
type: feedback
archived: true
---

When manually scoring reviews on opening night:

1. **Never set `contentTier: complete` from a manual fetch.** Let the collector pipeline determine tier. Bright Data returns truncated NYT text that looks complete. ScrapingBee `premium_proxy=true` gets full NYT text.

2. **Use `humanReviewScore` (not `assignedScore`) for manual overrides.** Rebuild overwrites `assignedScore` — it's an OUTPUT, not an INPUT. `humanReviewScore` is P0 priority and survives rebuild.

3. **Use `designation: "Critics_Pick"` (not `isCriticsPick`).** The rebuild checks `designation` field, not `isCriticsPick`. The +3 bump applies at composite calculation time, not in assignedScore.

4. **Don't push to review-texts repo while CI scoring is running.** The `push-review-texts` action does `git pull --rebase` which silently drops locally-written scores.

5. **Flag manual GPT-4o scores with `needsRescore: true`.** Then trigger `gh workflow run llm-ensemble-score.yml -f show=SHOW_ID -f needs_rescore=true`. Don't wait for the 4:30 AM daily run.

6. **Verify the review IS a review before scoring.** Cats Playbill was a feature article scored 88. Read the text first.

**Why:** All six of these caused regressions or wasted time during Cats opening night (Apr 7, 2026).

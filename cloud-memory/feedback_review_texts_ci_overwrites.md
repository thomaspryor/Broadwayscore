---
name: Review-texts CI overwrites local changes
description: "CI pushes overwrite local changes; commit to review-texts first."
type: feedback
archived: true
---

Commit and push changes to the `broadway-review-texts` private repo IMMEDIATELY after modifying review files. Do not wait to batch them with a rebuild.

**Why:** CI pipelines (fetch-guardian-reviews, rebuild-reviews, opening-night-poller) actively push to the review-texts repo. A session that modifies review files locally but only commits to the data repo (reviews.json) will lose the source-file changes when CI syncs. This happened 2026-04-01: Guardian API scores and humanReviewScore removals were overwritten by CI and had to be re-applied twice.

**How to apply:** After any batch of review-text file modifications:
1. `cd data/review-texts && git add -A && git commit -m "..." && git push origin main`
2. THEN rebuild reviews.json
3. THEN push to broadway-scorecard-data

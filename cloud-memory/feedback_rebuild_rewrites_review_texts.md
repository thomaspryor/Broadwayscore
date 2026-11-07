---
name: feedback_rebuild_rewrites_review_texts
description: rebuild-all-reviews.js rewrites review-text files catalog-wide (strips designation/wrongProduction) — revert out-of-scope before committing
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 1c1bfed9-71e6-4247-8a81-a0ba690028c9
---

Running `scripts/rebuild-all-reviews.js` locally **rewrites review-text JSON files across the entire catalog** as a side effect — it strips fields like `designation: "Critics_Pick"` → null and removes `wrongProduction: true` from shows you never touched. Seen 2026-06-04: a rebuild left 65–83 out-of-scope review-text files dirty (mary-jane lost Critics_Pick, present-laughter's 2019 reviews lost their wrongProduction flag).

**Why:** CI discards this churn (it only commits reviews.json, or runs in a mode that doesn't persist the review-text rewrites), so it never corrupts production. But a local rebuild + naive `git add` would ship the corruption to the private review-texts repo.

**How to apply:** After any local `rebuild-all-reviews.js`, before committing review-texts:
1. `cd data/review-texts && git diff --name-only | grep -v "<your-target-shows>"` — anything else dirty is churn.
2. `git checkout HEAD -- <those out-of-scope files>` (or `git checkout HEAD -- .` then re-apply only your intended edits).
3. Commit ONLY your target shows. reviews.json (derived) is safe to commit — the corruption is only in the review-TEXT rewrites.

Related: [[feedback_reviews_json_dual_repo_push]] (reviews.json lives in broadway-scorecard-data; rebuild from CLEAN review-texts so the derived file is correct). canonical-critic-scores.ts reads slim files (`public/data/shows/*.json` `.cs`), NOT reviews.json — a fresh rebuild shows `null` until `generate-mobile-show-details.js` regenerates the slim files.

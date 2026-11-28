---
name: feedback_reviews_json_dual_repo_push
description: "Flag + rebuild + push data repo + redeploy; review-texts alone isn't enough."
type: feedback
originSessionId: 747c75e1-9427-44c4-8db1-cb4d9c076eb5
---
**Pushing wrongProduction/wrongShow flags to broadway-review-texts is only half the fix.** The deploy workflow reads reviews.json from broadway-scorecard-data (private core data repo), NOT from review-texts. Must also: (1) run rebuild-all-reviews.js locally (writes to symlinked reviews.json), (2) push the result to broadway-scorecard-data, (3) trigger a new deploy. First deploy after flagging reviews showed old data because reviews.json in the core data repo was stale.

**Why:** The deploy workflow does `Checkout core data` → copies reviews.json from broadway-scorecard-data → runs `generate-mobile-show-details.js` (prebuild) which reads reviews.json. It does NOT run `rebuild-all-reviews.js` from review-texts.

**How to apply:** Any time you flag reviews as wrongProduction/wrongShow/wrongArticle in review-texts files, follow up with: rebuild → push to core data → deploy.

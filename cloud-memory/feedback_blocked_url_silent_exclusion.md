---
name: Blocked URL silently excludes reviews from rebuild
description: "AGGREGATOR_DOMAINS hides reviews; check isBlockedReviewUrl() FIRST."
type: feedback
archived: true
---

When a review passes all guards (wrongProduction, wrongShow, scoring, dedup) but still doesn't appear in reviews.json, check `isBlockedReviewUrl()` in `scripts/lib/domain-filters.js`. The `AGGREGATOR_DOMAINS` set silently blocks URLs from domains it considers aggregators, not review sources.

**Why:** NYTG (newyorktheatreguide.com) was in AGGREGATOR_DOMAINS despite publishing original reviews. This caused 7 hours of debugging on Becky Shaw opening night (2026-04-07) — every other guard was checked and passed, but the URL block at rebuild line ~1540 silently returned before reaching allReviews.push.

**How to apply:**
1. When a review is mysteriously excluded from rebuild: run `node -e "const {isBlockedReviewUrl} = require('./scripts/lib/domain-filters'); console.log(isBlockedReviewUrl('THE_URL'))"`
2. If blocked: check if the domain is in AGGREGATOR_DOMAINS, REFERENCE_DOMAINS, or TICKET_DOMAINS and remove if it's actually a review source
3. Audit AGGREGATOR_DOMAINS periodically for misclassified outlets

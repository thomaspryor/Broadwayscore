---
name: Tour review contamination detection
description: Broadway shows get tour reviews from regional BWW and local papers via SERP; must detect and flag at ingestion
type: feedback
archived: true
---

Regional BWW URLs (broadwayworld.com/{city}/article/) and local paper tour reviews get discovered via SERP and attributed to Broadway original productions. The `isLikelyTourReview()` guard in `review-guards.js` blocks these at ingestion. validate-data.js has a tour contamination check that catches unflagged ones.

**Why:** 85 tour reviews were live on the site inflating scores for Life of Pi (49→32), Shucked (51→39), A Beautiful Noise (39→29). User caught it from the daily digest.

**How to apply:** When adding new scraping sources or expanding SERP queries, verify the guard covers the new patterns. When a show has a national tour, expect regional reviews to appear in SERP results — the guard should catch them automatically.

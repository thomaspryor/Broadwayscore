---
name: theatre.reviews aggregator provides scores without URLs
description: Reviews discovered via TR aggregator lack URL field; text collection doesn't backfill the URL
type: feedback
archived: true
---

The `theatre.reviews` (TR) aggregator provides critic name + star rating but not the review URL. When `gather-reviews.js` creates source files from TR data, they have no `url` field. `collect-review-texts.js` may later fetch text via search but doesn't store where it fetched from.

**Why:** TR scrapes star ratings from multiple outlets as a roundup — it links to its own roundup page, not individual reviews.

**How to apply:** When auditing WE reviews with missing URLs, check `scoreSource: theatre-reviews-star-rating` — these are TR-sourced. URLs must be manually found and added. Only 4 out of 352 WE source files were affected (2026-03-30).

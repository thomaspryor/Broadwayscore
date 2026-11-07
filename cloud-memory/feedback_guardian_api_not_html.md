---
name: Guardian stars come from API not HTML
description: "Stars in Content API starRating; use recover-explicit-ratings.js."
type: feedback
archived: true
---

Guardian star ratings are NOT in the page HTML. They come from the Guardian Content API's `starRating` field.

**Why:** `recollect-for-scores.js` fetches HTML and runs extractors — but Guardian pages don't embed star ratings in the DOM (no ratingValue in JSON-LD, no star CSS classes). The stars are only available via `https://content.guardianapis.com/{articleId}?api-key=test&show-fields=starRating`. The free `test` API key works.

**How to apply:** For Guardian score recovery, use `scripts/recover-explicit-ratings.js` (which calls the API) or direct API calls. Never use `recollect-for-scores.js --outlet=guardian` — it will fetch 50 pages and find 0 scores.

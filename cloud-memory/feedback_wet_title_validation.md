---
name: WET WP API returns wrong shows
description: "WET WP API false-positives on short titles; validate with word overlap."
type: feedback
archived: true
---

WET roundup page finder must validate WP API search results against the show title. The WP search is fuzzy and returns wrong shows — "Operation Mincemeat" returned "American Psycho" because WordPress matched on common words.

**Why:** Op Mincemeat's WET archive was corrupted with American Psycho's data for months, causing 0 aggregator reviews.

**How to apply:** Both gather-reviews.js and opening-night-poller.js now use 60% word-overlap validation. If adding new WP API-based scrapers, always validate the returned post title matches the target show.

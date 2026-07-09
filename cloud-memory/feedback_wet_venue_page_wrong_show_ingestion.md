---
name: feedback_wet_venue_page_wrong_show_ingestion
description: WET sweep attached 13 Hello Dolly reviews to JCS Palladium 2026 — self-title tautology in match loop + venue-body corroboration accepts same-venue wrong-show posts; star stubs then score via aggregatorStars with no wrong-show content check
metadata: 
  node_type: memory
  type: feedback
  originSessionId: babb7f9a-e929-4c7f-ae30-97d1163008bf
---

On JCS Palladium 2026's opening day (2026-07-07), 5 of its 7 live reviews were Hello, Dolly! (Palladium 2024) reviews — prod cs 79.72 was built from the wrong show.

**Failure chain (each link needed):**
1. `sweep-we-aggregators.js` WET match loop tried `[cleaned, wpTitle, show.title]` — `matchTitleToShow(show.title, [show])` is a tautology, so EVERY post from the WP search passed the title gate. (Fixed 2026-07-08, commit c4a92b50ce: show.title removed.)
2. `verifyPage`/`verifyAggregatorUrl` accepts URL-slug mismatch when the venue appears in the body — both shows at the London Palladium, so venue corroboration passed. Venue-sharing successor/predecessor shows are the standing hazard.
3. The sweep CACHED the wrong reviews (`aggregator-archive/westendtheatre/<show>.json`) and serves the cache on later runs with NO verification — a poisoned cache re-contaminates after any file-level cleanup. Delete the cache file when cleaning up.
4. Star-rating stubs (wordCount 0) score via the aggregatorStars fallback; content-quality noticed mismatch (`url_content_mismatch`, `scraper_garbage`) but only downgraded to stub, which still scores. Wrong-show detection never ran on them.

**Why:** venue-based corroboration is designed for WE shows (London venues expected) but is exactly wrong for the previous/next show at the same venue; a self-match in a candidate list turns a gate into a no-op ("must match X" cousin: passing X itself).

**How to apply:**
- When a show has wrong-show aggregator reviews: flag files `wrongShow: true` AND set `wrongShowReason` (bare wrongShow on UK-outlet URLs is auto-cleared by rebuild-all-reviews.js "UK/major outlet URL on London show"), delete the WET cache file, rebuild via `gh workflow run rebuild-reviews.yml -f skip_enrichment=true`.
- Never put the show's own title in a candidate list matched against that show.
- Suspect same-venue contamination whenever a not-yet-opened show has T1 reviews: check `rv` URLs on the prod JSON first — slugs name the real show.
- Related: [[feedback_stale_flag_collision_drops_current_production]] (flagged-file collisions on the write path — fixed via opening-window date check), [[feedback_paywalled_star_outlets_not_gaps]] (star-stub scoring is by design; the gap is wrong-show checks skip stubs).

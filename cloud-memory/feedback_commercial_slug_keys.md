---
name: Commercial data must be keyed by slug, not show ID
description: commercial.json and pending-review must use show.slug (no year suffix), not show.id — the site looks up by slug
type: feedback
---

Commercial.json entries must be keyed by show.slug (e.g., "glengarry-glen-ross"), NOT show.id (e.g., "glengarry-glen-ross-2025"). The site's getShowCommercial() looks up by slug.

**Why:** 17 shows had invisible commercial data on the live site because backfill-commercial-o4mini.js used show.id as the key. Fixed Mar 2026.

**How to apply:** When writing to commercial.json or commercial-pending-review.json, always use `show.slug || show.id` as the key. When reading, try both slug and id as fallback.

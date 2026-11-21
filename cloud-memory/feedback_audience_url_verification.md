---
name: Audience platform URLs must be verified, not generated
description: Slug-based URL generation for WE audience platforms (SeatPlan, LBO, LTD) had ~27% 404 rate — store verified URLs only
type: feedback
archived: true
---

Never generate audience platform URLs from show title slugs at render time. Each platform uses different slug conventions (LBO aggressively shortens, SeatPlan drops "the-" inconsistently, LTD varies by category). The fallback generator caused ~27% broken links.

**Why:** Slug conventions differ per platform. "Cabaret at the Kit Kat Club" → LBO uses `cabaret`, SeatPlan uses `cabaret`, LTD uses `kit-kat-club`. No single slug function works for all.

**How to apply:** Store verified URLs in `audience-buzz.json` source entries (populated by scrapers + backfill script). The `getAudiencePlatformUrl()` function reads stored URLs only. When adding a new audience platform, ensure the scraper stores `url` in its write path. Run `scripts/backfill-audience-urls.js` to populate URLs for existing data.

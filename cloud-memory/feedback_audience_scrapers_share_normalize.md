---
name: Audience scrapers share normalize via title-match.js
description: All audience scrapers (Mezzanine, Theatr) MUST use scripts/lib/title-match.js — never copy normalize() inline. Drift is how the What Happened Was bug shipped.
type: feedback
originSessionId: 9cb6ee03-e41c-46e3-b43e-b296f9746e73
---
When adding or modifying an audience scraper that matches external titles to shows.json (Mezzanine, Theatr, Show Score, etc.), import `normalizeTitle` from `scripts/lib/title-match.js` instead of writing a local `function normalize()`.

**Why:** The 2026-04-28 "What Happened Was" incident was caused by Mezzanine's normalize() missing `…` (ellipsis) while Theatr's had a different bug. Each scraper had its own slightly-different copy of the same regex. One source of truth + fixture tests at `scripts/lib/title-match.test.js` is the only way to keep these aligned.

**How to apply:**
- New scraper: `const { normalizeTitle, titleTokens, jaccard } = require('./lib/title-match');`
- Modifying existing: if you find `function normalize(s)` in a scraper, replace it with the lib import. Don't fix the bug locally.
- Adding a new edge case: add a fixture to `scripts/lib/title-match.test.js`, fix the lib once, all scrapers benefit.
- Show Score (`scripts/scrape-show-score-audience.js`) intentionally uses its own match logic (URL-slug + JSON-LD + region-stripping) and is NOT a candidate for migration unless its strategy changes.

**Daily monitoring:** `data/audit/mezzanine-coverage.json` is rendered in the daily email digest by `scripts/health-check.js`. Color thresholds: gray <5, orange 5-9, red ≥10. If the count grows without a corresponding shows.json or override change, that's title-match drift — fix the lib, not the scraper.

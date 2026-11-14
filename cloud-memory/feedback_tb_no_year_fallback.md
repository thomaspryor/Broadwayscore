---
name: TB no-year URL fallback accepts wrong production
description: Talkin' Broadway fallback tries Schmigadoon.html (no year) after Schmigadoon2026/Schmigadoon26 fail; accepts prior-production review
type: feedback
originSessionId: 059fcd51-c17e-4a91-8e17-cc34bafd046b
archived: true
---
`opening-night-poller.js` TB discovery tries four URL patterns per title: `{slug}{year}.html`, `{slug}{yy}.html`, `{slug}.html`, and a fourth variant. The no-year fallback (`{slug}.html`) silently accepts a prior production's page.

**Why:** Incident 2026-04-20 Schmigadoon — poller fetched `https://www.talkinbroadway.com/page/world/Schmigadoon.html` and logged `Talkin' Broadway: verified`. That URL was a prior TB piece on the 2021 Apple TV+ series, not tonight's Broadway opening. The by-line was missing, so the scored review routed to `_pending/schmigadoon-2026/talkinbroadway--5405d81a.json` — didn't reach reviews.json, but it still burned a scoring credit and contaminated pending.

**How to apply:** When adding new title-slug fallbacks for TB/BWW/DTLI, enforce that the page's own metadata (publish date, byline, H1) match the current production before accepting. The `rejected: title mismatch` log exists and works — extend it with a publishDate check (page publishDate within 6 months of show openingDate). See memory/feedback_tb_camelcase_slugs.md for the slug variant list.

**Status:** Not yet fixed. Log flagged for tomorrow's systematic pass. Low-severity because by-line gate correctly routed the bad file to _pending instead of reviews.json.

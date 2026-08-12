---
name: URL year-only date fallback is too imprecise
description: YYYY-only URL extraction defaults to July 1st, causing 74 false positives in pre-opening guard; removed from rebuild
type: feedback
originSessionId: f8e72ad5-e524-4973-9c2e-c712526afa5a
---
Never use a YYYY-only URL extraction as a review date for date-based guards. When only a year is extractable, `new Date('2025-07-01')` is the default — too imprecise for a 90-day threshold. Only YYYYMMDD URL patterns are reliable.

**Why:** 74 Class B false positives in the 2026-04-12 audit. Reviews with real publishDate "October 28, 2025" were matched as "2025-07-01" from the URL, triggering the pre-opening guard incorrectly.

**How to apply:** If you're writing any date guard or date comparison, check the date source. URL-extracted dates should require month+day (YYYYMMDD pattern), not just year. publishDate from the file is always preferred over URL extraction.

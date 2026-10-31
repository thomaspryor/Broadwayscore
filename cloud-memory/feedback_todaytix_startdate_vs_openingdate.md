---
name: TodayTix startDate differs from openingDate for long-running shows
description: "startDate is re-listing date; year gap >2 false-triggered isMultiProduction."
type: feedback
archived: true
---

TodayTix `startDate` for long-running shows is the re-listing or revival date, NOT the original opening night. For Harry Potter: TodayTix returned 2021-11-12, existing openingDate was 2018-04-22. The 3-year gap triggered `isMultiProduction` to return true (thinking different production), bypassing duplicate detection.

**Why:** `isMultiProduction` line 268 checked `Math.abs(newYear - existYear) > 2` without considering venue. Long-running shows (Wicked since 2003, Lion King since 1997, Phantom since 1988) all have huge year gaps vs their TodayTix startDates.

**How to apply:** When writing dedup logic that compares dates, never assume same-title + year-gap = different production. Always check venue first. The same-venue guard in `isMultiProduction` (deduplication.js:264-278) now handles this — if existing show is open + same venue, it's the same production regardless of year gap. Closed historical entries are exempted.

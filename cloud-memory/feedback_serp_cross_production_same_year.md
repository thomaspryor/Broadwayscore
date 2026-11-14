---
name: SERP-discovered URLs need magnitude guard for same-year cross-production false-matches
description: URL year filter alone (±1 yr) doesn't prevent two productions of the same title in the same year at different venues — add a date-shift magnitude cap and force audit-only on large shifts. Caught 2026-04-29 in enrich-off-broadway-dates Phase 3.
type: feedback
originSessionId: df836823-4d37-402f-ac52-ba37ca107be8
archived: true
---
When SERP-discovering a Playbill (or analogous third-party) production page for a show, **two filters aren't enough**:

1. URL must contain `/production/` and the right market token (e.g. `off-broadway`)
2. URL trailing year within ±1 of expected show year

**Why these miss real false-matches**: two distinct productions of the same title can run in the SAME year at different venues. Music City 2026 in shows.json is at "Music City" venue; SERP returned Playbill's `music-city-off-broadway-st-lukes-theatre-2026` page (also 2026) for an unrelated 93-day-later production. Year filter passed; page-title validation passed (contains "Music City" and "off-broadway"); the proposed date shift was 93 days — provably wrong.

**Fix**: Add a magnitude cap on the proposed change. For an IBDB-conflated same-date correction, opening shifts > 60 days are highly suspicious — likely a wrong-production match. Force those to audit-only with explicit shift-too-large reason. The cap is permissive enough for legitimate corrections (Adding Machine = 21d, Masquerade = 60d) but tight enough to catch obvious cross-production errors.

**Why:** Year filter + page-title-contains-show-name aren't enough to disambiguate same-year-same-title productions. Magnitude is a 3rd-axis sanity check that's cheap and reliable.

**How to apply:** Whenever auto-applying a single-source date correction, compute `shiftDays = abs(new - old)` and force audit-only if it exceeds a magnitude cap chosen for the data class. For IBDB-conflated OB same-date corrections, 60 days. For other correction classes, calibrate to the realistic max for that bug.

**Code reference**: `scripts/enrich-off-broadway-dates.js` `SAME_DATE_FIX_MAX_SHIFT_DAYS`.

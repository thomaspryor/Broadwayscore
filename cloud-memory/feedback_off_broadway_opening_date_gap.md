---
name: Off-Broadway openingDate==previewsStartDate silently skips opening-night orchestrator
description: 23/30 recent open OB shows have openingDate identical to previewsStartDate, causing the 2-day-lookback orchestrator to miss real opening nights weeks later. KENREX 2026-04-28 root cause.
type: feedback
originSessionId: beeab90a-2eb2-4817-b850-1b6881564dde
---
When `openingDate == previewsStartDate` in shows.json (or both pulled from the same source like IBDB without distinguishing previews vs press night), the opening-night-orchestrator's 2-day lookback window will fire on previews-start day with zero reviews available, then never again — even though the real press night may be 1-3 weeks later.

**Why:** `opening-night-orchestrator.yml` filter is `openingDate >= now-2days` (Broadway) or `now-4days` (West End). Off-Broadway shares the Broadway path. So a show with previews-start=2026-04-15 and real-opening=2026-04-26 but stored opening=2026-04-15 will be polled on Apr 15 (no reviews exist), then skipped Apr 17-30 (out of window). The real opening-night reviews on Apr 27 never get the SERP-discovery + outlet-polling treatment.

**How to apply:**
1. **Pre-opening sanity check:** When auditing opening-night readiness for an OB show, verify shows.json `openingDate ≠ previewsStartDate` — if equal, treat as unverified and cross-check Playbill/Lortel.org/show site before relying on orchestrator.
2. **When investigating "missing reviews" on an OB show:** First diff `shows.json` `openingDate` against actual opening from Playbill/show site. If wrong, fix the date AND manually trigger `gh workflow run opening-night-orchestrator.yml -f show_id=X -f market=broadway`.
3. **Bulk audit query:** `node -e "const s=require('./data/shows.json').shows; s.filter(x=>x.status==='open' && x.category==='off-broadway' && x.openingDate===x.previewsStartDate).forEach(x=>console.log(x.id))"`. As of 2026-04-28 this returns 23 shows.
4. **Source field clue:** `openingDateSource: 'ibdb'` on an off-Broadway show is suspect — IBDB historically lists previews-start as opening for OB; trust playbill.com/<show>'s "Officially Opens" date instead.
5. **Class fix candidates (not yet implemented):** widen orchestrator lookback for off-Broadway, or have update-show-status detect "status flipped to open recently but openingDate is N days old" and re-enrich from a non-IBDB source. See `memory/feedback_admin_ingest_opening_night_2026-04-26.md` and `feedback_recurring_backfill_means_broken_creator.md` for the broader anti-pattern.

KENREX 2026-04-28: previews-start=Apr 16, opening=Apr 26; shows.json had both as Apr 15 (IBDB). Orchestrator never fired post-opening; system had 4 reviews when 11+ existed. Manual aggregator scrape (BWW Roundup + Playbill Verdict) recovered NYT/Vulture/NYSR×2/CultureSauce/TheWrap/T2C.

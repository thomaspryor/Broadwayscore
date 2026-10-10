---
name: ob-venue-historical-backfill
description: Open work — past 4-5 months historical OB show backfill from Atlantic / Vineyard / Signature / MCC archive pages
metadata: 
  node_type: memory
  type: project
  originSessionId: f614bb18-b7c3-4fc0-8969-fe0774c404d4
---

User asked 2026-05-25 to "trigger collection for shows from the past four or five months from these theaters" after the venue discovery pipeline shipped.

Status as of 2026-05-26: PARTIAL.
- Signature past 9 productions auto-captured by `/productions/` scrape (Sunset Baby 2014, Orlando 2024, Bad Kreyòl 2024, Eurydice 2024-25, etc.) — venue page lists both upcoming and past on the same URL. These are in shows.json with status=closed + proper dates.
- Atlantic/Vineyard/MCC: only CURRENT season scraped. Past 4-5 months from these venues (Jan-May 2026) is NOT explicitly backfilled.

**Why:** The new `scripts/lib/venue-listing-discover.js` scrapes the season-landing URL only. Atlantic's `/productions/` page = current season. To get past, need separate archive URLs.

**Approach for next session:**
- Atlantic: probe `atlantictheater.org/past-productions/`, `atlantictheater.org/archive/` — venue likely has one
- Vineyard: probe `vineyardtheatre.org/past-seasons/`
- MCC: probe `mcctheater.org/past-seasons/`, `mcctheater.org/our-2024-25-season/` (previous-year)
- Build a new venue config variant: `{archive: true, yearsBack: 5}` so the lib scrapes archive URL and limits to last N years
- Promote via existing `scripts/promote-ob-venue-candidates.js --admin-promote-all` after validation
- Then gather-reviews on each for scoring

**Why:** [[ob-discovery-expansion]] shipped 15 venue-discovered shows but Signature past prods + a few MCC/Atlantic current productions are the only "past 4-5 months" presence so far for these companies.

**How to apply:** Run from `~/Broadwayscore/` (or worktree) with the existing venue lib; just extend OB_VENUE_CONFIGS with archive entries OR write a one-time `scripts/discover-ob-historical.js`.

Related: [[ob-discovery-expansion]] (the venue pipeline this builds on).

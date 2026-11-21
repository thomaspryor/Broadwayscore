---
name: Aggregator & outlet pages are published AFTER opening, not before
description: "BWW RR / DTLI / TB / Playbill / WET / TR / SD / TS — never pre-stage."
type: feedback
originSessionId: 3e952697-7e33-4405-9335-a300ecadb2d3
---
Every aggregator/outlet review page for Broadway and WE openings is **published as the reviews post, not before**. This applies to:

- BWW Review Roundup (Broadway + occasional WE)
- DTLI (Did They Like It) — Broadway only
- Talkin' Broadway outlet reviews
- Playbill Verdict
- NYC Theatre Roundups
- Show Score
- WestEndTheatre.com (WET)
- theatre.reviews (TR)
- Stagedoor (SD)
- The Stage roundups (TS)

**Why:** These aren't pre-built directories; they're editorial products assembled once the embargo lifts. A 404 (or a DTLI slug-map miss, or a TB SERP that returns forum posts) **the day before opening is normal**. The page will exist after the first wave of reviews lands.

**How to apply:**
- Never offer to "pre-stage" or "pre-find" these URLs before opening night. It's impossible and wastes the user's time.
- Never flag missing DTLI slug / missing BWW RR URL / missing TB URL as a pre-opening gap when asked "is opening night ready?"
- The orchestrator / opening-night-poller is designed to discover these URLs at poll time, after publication.
- The ONLY pre-opening data gate for these outlets is: make sure any pre-existing review files from prior productions (London → Broadway transfers, OB → Broadway, regional tour) are flagged `wrongProduction: true` so SERP doesn't mis-route.
- Revisit the aggregator checklist items (CLAUDE.md §14 items 6/8/9) only AFTER the first Broadway reviews have landed in `reviews.json`.

**Incident trail:** Multiple sessions have tried to pre-stage BWW RR URLs, add DTLI slugs for un-opened shows, and guess TB URL patterns. The user has called this out repeatedly (2026-04-14 Fear of 13 session being the trigger for this memory). CLAUDE.md §14 header now has the timing rule inline.

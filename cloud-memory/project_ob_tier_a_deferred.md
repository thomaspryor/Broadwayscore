---
name: ob-tier-a-deferred
description: "Two Tier A venues couldn't ship in 2026-05-27 session — TFANA (SSL outage) and Second Stage Uptown (dormant season). Add later."
metadata: 
  node_type: memory
  type: project
  originSessionId: f614bb18-b7c3-4fc0-8969-fe0774c404d4
---

Session 2026-05-26→27 added Soho Rep, The New Group, Irish Rep (3 of the 5 planned Tier A venues). Two deferred:

## TFANA (Theatre for a New Audience)
- All URLs return Cloudflare 526 ("Invalid SSL certificate")
- Tried: `/`, `/season/2025-26`, `/whats-on` + Playwright tier
- Origin server cert problem on their side — not a scraping issue we can solve
- **Action when revisiting:** check site status first (`curl -I https://www.tfana.org/`). If it's back, add `{name: 'TFANA', url: 'https://www.tfana.org/season/...', strategy: 'selector', selector: TBD, ...}` to OB_VENUE_CONFIGS in `scripts/lib/venue-listing-discover.js`. Capture fixture. Add EXPECTED band. canonicalVenue('Theatre for a New Audience') → 'tfana' alias already in place.

## Second Stage Uptown
- 2st.com/uptown, /current-season, /shows-and-events all 404
- /shows lists only their CURRENT Broadway production (Becky Shaw at Hayes)
- Their Uptown stream is dormant — they don't currently have an OB production scheduled
- **Action when revisiting:** wait until Second Stage announces their next Uptown season (typically summer). Their season page might use a year-suffix URL like `2st.com/2026-uptown` or similar. Verify before scraping. canonicalVenue('Second Stage Uptown') → 'second stage uptown' (distinct from 'second stage hayes' for their B'way).

Pattern: same as the 3 shipped. Each ~25 min when their site is reachable.

Related: [[ob-discovery-expansion]] (the venue pipeline this builds on).

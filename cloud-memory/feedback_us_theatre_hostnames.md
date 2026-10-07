---
name: US outlets with 'theatre' in hostname
description: "theatrely/MTR/NYSR trigger false UK detection; US_THEATRE_HOSTNAMES blocklist."
type: feedback
archived: true
---

US outlets like theatrely.com, musicaltheatrereview.com, nystagereview.com contain "theatre" in their hostnames, triggering the UK hostname heuristic in isUkOutletUrl() and the rebuild's wrongProduction auto-clear.

**Why:** This caused 10+ Broadway reviews to leak into WE show pages, corrupting scores. The auto-clear silently removed wrongProduction flags on every rebuild.

**How to apply:** When adding new outlets or modifying UK hostname detection in venue-classification.js or rebuild-all-reviews.js, check if the hostname would match US outlets. Add any new US "theatre" outlets to the US_THEATRE_HOSTNAMES set in venue-classification.js and US_ONLY_OUTLETS in flag-we-cross-production.js.

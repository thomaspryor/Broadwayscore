---
name: Dual-market outlets bypass cross-market guard
description: "isDualMarket bypasses cross-market guard; URL-path guard now catches."
type: feedback
archived: true
---

Dual-market outlets (NYTG, Guardian, NYT) are marked `isDualMarket: true` in outlet-registry.json. The cross-market guard auto-clears `wrongProduction` for these outlets. But a NYTG "broadway-review" URL is still reviewing Broadway, not WE.

**Why:** The outlet covers both markets, but individual reviews target specific productions. The auto-clear is too aggressive.

**How to apply:** The URL-path cross-market guard in `rebuild-all-reviews.js` (added 2026-03-30) catches this pattern by inspecting URL paths for "broadway-review", "on-broadway", "chicago", "national-tour". When investigating wrong-production reviews, check dual-market outlets first — they're the most likely source of leakage.

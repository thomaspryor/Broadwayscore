---
name: Always scope recover-explicit-ratings by market
description: "Always --market= with recover-explicit-ratings; all-markets takes hours."
type: feedback
archived: true
---

Always use `--market=west-end` (or other market filter) when running recover-explicit-ratings.js for a specific market. Without it, the script processes all 15K+ review files across Broadway, WE, and OB. The all-markets Phase 3 run took 3+ hours and was killed; the WE-only run took 15 min and recovered 65 ratings.

**Why:** Phase 3 scrapes each URL individually (2-10s per URL, longer for paywalled archive.org fallbacks). 1,320 Broadway URLs × 5s avg = ~2 hours just for Broadway, which wasn't the target.

**How to apply:** Always pass `--market=west-end` or `--market=broadway` unless intentionally running cross-market. For the full 20-year TR pipeline: `recover --phase=0,3 --market=west-end --source=theatre-record`.

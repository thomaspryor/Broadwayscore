---
name: isbroadwaycategory-takes-show-object-not-a-string
description: "scripts/lib/venue-classification.js isBroadwayCategory(show) reads show.category — passing a string returns true silently for any truthy value, including \"west-end\""
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 9b61d0d3-99ec-4008-8d50-41e963b67f53
---

`scripts/lib/venue-classification.js:57` — `isBroadwayCategory(show)` expects a show object and reads `.category` off it. The implementation is `!show || (!show.category || show.category === 'broadway')`.

If you pass a string by accident:
- `isBroadwayCategory('west-end')` → reads `'west-end'.category` (undefined) → `!undefined` is true → returns `true`
- `isBroadwayCategory(null)` → `!show` → returns `false` ✓
- `isBroadwayCategory('broadway')` → returns `true` ✓ (works by accident)

**Why:** This is a Liberation-class bug source. On 2026-05-26, `scripts/validate-data.js:593` had `isBroadwayCategory(show.category)` — the West End gate was dead code. London "Palace Theatre" / "Lyceum" venues could have had NYC addresses force-written by the validateTheaterAddress autofix. Caught in ship-check #3 adversarial review, fixed in commit 5546775db3.

**How to apply:** Always pass the show object: `isBroadwayCategory(show)`. If you only have a category string in scope, wrap it: `isBroadwayCategory({ category })` (this pattern is used at `validate-data.js:4018`).

The TS counterpart in `src/lib/data-core.ts` (`isBroadwayShow`) takes a show object too — same convention.

Related: [[feedback_broadway_filter_convention]] (the predicate itself).

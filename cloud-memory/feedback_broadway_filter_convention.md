---
name: Broadway filter convention — null category counts as Broadway
description: Use `!s.category || s.category === 'broadway'` for any Broadway filter. Strict equality excludes ~94% of the historical corpus.
type: feedback
originSessionId: 2d722423-f057-4215-b171-f837bf5ca9ab
archived: true
---
When filtering shows.json for Broadway, **always** use the canonical predicate — never `s.category === 'broadway'` directly.

```js
// TS (live site): src/lib/data-core.ts:64
function isBroadwayShow(show) {
  return !show.category || show.category === 'broadway';
}

// JS (scripts): scripts/lib/venue-classification.js
const { isBroadwayCategory } = require('./lib/venue-classification');
list.filter(isBroadwayCategory);
```

**Why:** Before the 2026-04-24 backfill (private-repo commit `96a145b4`), 1967/2449 shows had `category: null`. Strict `=== 'broadway'` matched only 42 — 94% miss rate. After the backfill, strict matches 2000 and canonical matches 2009 (delta of 9 is TBA + Criterion Center Stage Right, a historical theater). **The convention still applies going forward** — any new show created by a script that bypasses `classifyShow()` will have null category, and that should still count as Broadway.

Same convention used in `scripts/lib/dtli-slug-discover.js:132` (`!show.category || show.category === 'broadway'`). Breaking the convention to go "strict" would regress `/rankings`, `/beat-the-critics`, `/audience-buzz`, `/rush`, `/box-office`, rss.xml, llms.txt, and sitemap generation simultaneously.

**Debugging tell:** If an ad-hoc query on Broadway returns ~40 shows when you expect ~2000, the bug is strict-equality on `category`. Don't spend time questioning the data — check the filter first.

**How to apply:**
- Writing any ad-hoc query on shows.json → require `isBroadwayCategory` from `scripts/lib/venue-classification.js`
- Writing new TS code → call `getBroadwayShows()` from `src/lib/data-core.ts` instead of re-filtering
- Writing a historical-import creator → always `Object.assign(show, classifyShow(show))` from `scripts/lib/classify-show.js` to stamp category+market at push time. Two historical creator scripts (`discover-historical-shows.js`, `add-historical-2023-2024.js`) were fixed 2026-04-23 to use this pattern; `discover-new-shows.js` was fixed 2026-04-22.
- Opening-night query on today's shows only? Still use the helper — shows created mid-pipeline may have null category until their first CI run sets it.
- Never backfill the historical nulls "just to clean it up" without confirming every caller treats null correctly. 7 reactive backfills in 2026-03/04 proved this pattern is fragile. See `memory/feedback_recurring_backfill_means_broken_creator.md`.

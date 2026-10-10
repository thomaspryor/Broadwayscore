---
name: Positive-match category, never negate
description: Market-gated thresholds must use `category === 'broadway'` not `!isLondonMarket() && category !== 'off-broadway'` — negation inherits thresholds on unknown categories.
type: feedback
originSessionId: f0a48ef0-6fe0-4d83-919f-0d6df8b5922d
archived: true
---
When applying market-specific thresholds (review floors, score windows, outlet lists), **positive-match the category** rather than negating other categories. Regional, off-off-broadway, typos, and null category all silently inherit whichever branch is the "default" of the negation.

Example of the trap (caught in audit-opening-night-coverage.js, 2026-04-20):
```js
// WRONG — 'regional', 'off-off-broadway', null, typos all get Broadway floor
const isBroadway = !isLondonMarket(category) && category !== 'off-broadway';

// RIGHT — only actual Broadway shows trip the Broadway floor
const isBroadway = category === 'broadway';
```

**Why:** Shows with malformed category values (e.g. a typo, or an unmigrated legacy value) would inherit Broadway's floor of 10 reviews and false-breach. The Broadway audit is tightest of any market; defaulting to it on unknown data produces noise the night of every opening.

**How to apply:**
- Every category-gated const/threshold in scripts/* and src/* must be `=== 'broadway'` / `=== 'west-end'` / `=== 'off-broadway'`.
- If you need "all London markets" use the helper `isLondonMarket()` from scripts/lib/venue-classification.js — that's an allowlist helper, not a negation.
- Reviewer flag: if you see `!isLondonMarket()` or `category !== 'X'` in threshold logic, it's a bug.

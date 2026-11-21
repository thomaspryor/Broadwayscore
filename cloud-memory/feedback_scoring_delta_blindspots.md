---
name: scoring-delta.js blind spots — rebuild-helpers and score-extractors not monitored
description: scripts/scoring-delta.js only diffs 5 files and silently reports "no-diff" for edits to rebuild-helpers.js (getBestScore lives here) or score-extractors.js (KNOWN_STAR_OUTLETS lives here). Write a custom simulation when editing those.
type: feedback
originSessionId: 24964f07-d908-475f-9084-67e6b214d465
archived: true
---
`scripts/scoring-delta.js` is the mandatory per-CLAUDE-md §12 verification for scoring-logic edits. It monitors exactly 5 files (line 255):

```
scripts/lib/review-guards.js
scripts/rebuild-all-reviews.js
src/lib/scoring.ts
src/lib/engine.ts
src/lib/data-core.ts
```

**Why:** When you edit `scripts/lib/rebuild-helpers.js` (where `getBestScore` lives — the actual score-selection pipeline) or `scripts/lib/score-extractors.js` (where `KNOWN_STAR_OUTLETS`, `OUTLET_STAR_AUTHORITATIVE`, and extractor functions live), scoring-delta returns "no-diff" and exits 0. The gate appears to pass — but your change is completely unaudited by the tool.

**How to apply:** If your change touches `rebuild-helpers.js` or `score-extractors.js`, write a custom simulation. Pattern:

```js
const { getBestScore } = require('./scripts/lib/rebuild-helpers.js');
const fs = require('fs'), path = require('path');
const TARGET_OUTLETS = new Set([/* outlets affected by the change */]);
let shifts = 0;
for (const show of fs.readdirSync('data/review-texts')) {
  const d = 'data/review-texts/' + show;
  for (const f of fs.readdirSync(d)) {
    const outlet = f.split('--')[0];
    if (!TARGET_OUTLETS.has(outlet)) continue;
    const data = JSON.parse(fs.readFileSync(d + '/' + f, 'utf8'));
    // Optionally: if (data.originalScore != null) continue; for P0.75-surface-only
    data._showCategory = 'broadway';
    const r = getBestScore(data, { stats: {}, flagForHumanReview: () => {} });
    // Compare r.score / r.source vs the file's stored assignedScore
  }
}
console.log('shifts:', shifts);
```

Then compare before/after by git-stashing, re-running, and popping.

**Additional blind spot:** scoring-delta also only counts T1 flips. NY Post / LA Times / Washington Post are T2 (weight 0.75). Large T2 shifts can stay under the T1-only gate silently. Your custom simulation should count T2 flips too, with a separate threshold.

**Fix the tool (nice-to-have, not blocking):** extend `SCORING_FILES` in scoring-delta.js:255 to include `scripts/lib/rebuild-helpers.js` and `scripts/lib/score-extractors.js`. This is a separate follow-up — not every change needs the full delta, but the tool's "no-diff" response should only mean "guards unchanged", not "scoring logic unchanged".

Session that hit this: 2026-04-22 (KNOWN_STAR_OUTLETS unification, commits fc73e8cb13 + de8a5c3786). Tool returned no-diff despite editing both rebuild-helpers.js and score-extractors.js with scoring-impact changes.

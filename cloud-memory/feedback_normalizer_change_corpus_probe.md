---
name: Probe corpus impact when changing a hot-path normalizer
description: For any change to a URL/string normalizer used by dedup/collision/comparison code, write a probe that diffs old-vs-new normalization across the full corpus before declaring the change safe.
type: feedback
originSessionId: c94c6d1f-859a-445e-a3b1-eb02130cb761
archived: true
---
When you change a hot-path normalizer that feeds `===` comparisons (URL dedup,
content collision, byline matching), the unit tests will pass — but the
corpus-wide impact may be much larger than your tests reveal.

**Why:** Unit tests cover behavior change in isolation. The real signal is
"how many EXISTING file pairs collapse from distinct → equal under the new
normalizer?" That can range from 0 (your change is too narrow) to thousands
(your change is too aggressive and false-collisions are about to ship).

**The probe pattern:**

```js
// Inline both normalizers (old as a copy, new via require)
function oldNormalize(url) { /* paste pre-change code */ }
const { normalizeUrl: newNormalize } = require('/abs/path/to/changed-file');

// Walk the corpus, build records with both norms
for (const file of corpus) {
  records.push({ file, oldNorm: oldNormalize(url), newNorm: newNormalize(url) });
}

// Pairwise: same newNorm but DIFFERENT oldNorm = NEW collision (only this change)
// Same newNorm AND same oldNorm = previously-detectable (existing dedup)
let newOnly = 0, known = 0;
for (let i = 0; i < records.length; i++) {
  for (let j = i + 1; j < records.length; j++) {
    const a = records[i], b = records[j];
    if (a.newNorm === b.newNorm) {
      if (a.oldNorm !== b.oldNorm) newOnly++;
      else known++;
    }
  }
}
console.log({ newOnly, known });
// Sample 25 newOnly pairs — verify each is a real duplicate (good) vs FP (bad)
```

**Decision rule:**
- `newOnly === 0` AND change targeted a real pattern → your change isn't firing,
  unit tests are wrong (tested a path the corpus doesn't exercise) — fix tests
- `newOnly > 0` AND sample of 25 are all real duplicates → change is correct,
  ship; document the count in commit message
- `newOnly > 0` AND ANY sampled pair is a false collision → STOP; tighten the
  normalizer or scope the change narrower

**Origin (2026-04-29):** AMP-strip in `normalizeUrl()` was Item 3 of the
systematic CI plan. Unit tests passed (5 new). Probe found 206 newOnly
collisions but 0 of 25 sampled pairs were AMP — they were http/https + `_r=0`
variants caught by the broader tracking-param strip. Real AMP cases were
absent from the sample, meaning the AMP regex was unproven against corpus.
Probe also caught a latent ordering bug: `/amp$` ran before tracking-strip,
so `/foo/amp?utm=x` left `/amp` un-stripped. Fixed in f5873face4.

**Probe file:** `/tmp/probe-amp-collisions.js` (pattern, not a permanent
script). Reusable for any normalizer change.

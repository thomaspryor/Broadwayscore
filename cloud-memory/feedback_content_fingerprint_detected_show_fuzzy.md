---
name: Content-fingerprint audits — detected-show is approximate when source is junk
description: Cross-attribution audit's wrongShow flag is correct, but its "detectedShowId" guess is fuzzy when source content is scrape navigation chrome or unrelated reviews. Verify before acting on the detected ID.
type: feedback
originSessionId: fc510036-1890-49fb-85b7-10136f917e1d
archived: true
---
`scripts/audit-cross-attribution-by-critic.js` flags files whose content fingerprint doesn't match the filed-under show. When the source content is genuinely a different show's review, the detected ID is reliable. When the source is **junk** — captured navigation chrome, boilerplate footer, an unrelated press release — the detected show is whatever happens to share a few weak tokens with the noise. The wrongShow flag is still correct (the file IS misattributed), but the `detectedShowId` field is essentially noise.

**Why:** the algorithm picks the highest-IDF-weighted token-overlap winner. With 14k tokens across 2463 shows, even 2-3 weak token hits ("film", "she") clear the absolute-score threshold, especially when the filed show has zero overlap.

**Examples observed 2026-04-25:**
- `bloody-bloody-andrew-jackson-2010/hollywood-reporter--frank-scheck.json`: scrape captured HR homepage navigation ("Marion Ross cast in Hallmark Channel movie..."). Detected `a-history-of-the-american-film-1978` because "film" appeared 4×.
- `talk-radio-2007/variety--charles-isherwood.json`: URL was actually for `luisa-fernanda` (a zarzuela). Detected `the-trip-back-down-1977` on 4 weak tokens — neither the filed nor the detected show is correct.
- `the-bridges-of-madison-county-2014/wsj--terry-teachout.json`: detected `the-selling-of-the-president-1972` on "selling, president, james" — flag correct, detected show is a guess.

**How to apply:**
- Treat `crossAttributionAudit.detectedShowId` as a hint, not ground truth. Always read the file's content (fullText / wrongFullText / excerpt) before re-attributing.
- For the wrongShow decision itself, the audit is reliable at the high-confidence threshold — every spot-checked case across 70 flags was a real misattribution, even when the detected ID was approximate.
- Future improvement worth doing: add a "junk content detector" (navigation chrome, footer boilerplate, all-caps word soup) that bails out before claiming a detected show. Current bar of `top score >= 12` doesn't filter these because junk text often hits 12+ via common nouns.

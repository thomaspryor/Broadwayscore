---
name: Express pipeline coverage-gap diagnostics (5 root causes)
description: When Express captures fewer reviews than the live baseline, check these 5 specific gaps before assuming pipeline-wide issues. Each has a different fix surface.
type: feedback
originSessionId: b2030ae3-d1b1-48aa-bbf4-b0db0216c7c2
archived: true
---
When an Express simulation captures fewer reviews than the live baseline for the same show, do not assume a single pipeline-wide bug — there are at least five independent failure surfaces that must each be checked. The first four were active simultaneously during the 2026-04-19 proof-2026 simulation (16 captured vs 21 live); the fifth was caught in the v2 retest (18/20).

**Diagnostic order (cheapest signal first):**

1. **`/page/` URL guard rejecting valid reviews** — `urlLooksLikeReview()` in `scripts/lib/review-guards.js` rejects `/page/` as pagination. But Talkin' Broadway's review URLs are `/page/world/{titleslug}{year}.html`. Both `urlLooksLikeReview` (line ~115) AND `urlOrTitleLooksLikeReview` (line ~374) need carve-outs — they're independent code paths. Pattern: `if (lower.includes('/page/') && !lower.includes('talkinbroadway.com/page/'))`.

2. **Aggregator outlet/URL misattribution suppressing SERP** — `gather-reviews.js` builds `foundOutletIds` from raw outletId strings on found reviews. When an aggregator labels e.g. an NYSR URL as "WSJ", the SERP loop treats WSJ as already-found and skips re-search. Fix: validate URL hostname against the outlet's registered `domain` from critic-outlets.json before adding to `foundOutletIds`.

3. **Outlet missing from critic-outlets.json** — SERP only queries outlets in `scripts/config/critic-outlets.json`. NY Sun was absent for months despite Elysa Gardner being a regular Broadway critic. When seeing "live show has outlet X but Express misses X", first check critic-outlets.json — adding the outlet is a 1-line fix.

4. **Multi-critic SERP hits stranded in _pending** — When SERP discovers a URL at a multi-critic outlet (NYT, NYSR, Vulture, Theatrely), `criticName` defaults to "Unknown". `createReviewFile()` Pattern Card #4 routes Unknown-critic URLs to `data/review-texts/_pending/`. **`collect-review-texts.js` does not process `_pending/`** — so its AUTHOR ENRICHMENT path (line ~4519) never fires, the byline is never extracted, and the review never reaches scoring. Fix: in gather, single-critic outlets default `criticName` to that critic at SERP time; multi-critic outlets get `source: 'serp-discovery'` and bypass the _pending routing so collect can enrich.

5. **TB CamelCase year-suffix slug check rejection** — Even after fix #1, the cross-show URL slug guard in `urlLooksLikeReview` uses word-boundary matching: `(?:^|[\s\-/.\'"_])TITLE(?:$|[\s\-/.\'"_])`. TB URLs like `/page/world/Proof26.html` fail because `proof` is followed by digit `2` (no separator) and CamelCase URLs like `/MeteorShower2017.html` have no boundary between title words at all. Fix: TB-specific carve-out in `urlLooksLikeReview` that uses plain substring match for `talkinbroadway.com/(page/)?world/` paths, plus add `\\d` to the trailing-boundary character class for all other URLs (year/sequel suffixes are legitimate matches like `hairspray-2.html`).

**Why:** Each of these failure modes is silent — the Express pipeline reports "success" with a partial capture. Without the live baseline comparison (`reviews.json` reviews count for the source show), you cannot tell that 5 reviews are missing.

**How to apply:**
- After every Express simulation, count baseline reviews on the source show: `node -e "const r=require('./data/reviews.json'); console.log(r.reviews.filter(x=>x.showId==='SHOW_ID').length)"`. Compare to test capture.
- If gap > 2, work through the 5 above in order.
- The _pending check is the most-missed: `ls data/review-texts/_pending/` should be near-empty for an actively-gathered show. Files there mean unprocessed bylines.
- For #5, write a regression test against `urlLooksLikeReview` with TB year-suffix and CamelCase URL examples. The `node scripts/test-opening-night-fixes.js` suite has 294 cases — add the new ones there.

**Commits:** `f7005e28c3` ships fixes 1-4. `6b7349f8f4` (merged via `0fbf684fc3`) ships fix 5.

**Related:** [feedback_three_cross_show_dedup_guards.md](feedback_three_cross_show_dedup_guards.md), [feedback_express_pipeline_simulation.md](feedback_express_pipeline_simulation.md), [feedback_tb_camelcase_slugs.md](feedback_tb_camelcase_slugs.md).

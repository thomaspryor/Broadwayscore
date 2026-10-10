---
name: rebuild multi-critic URL allow-through defeats URL dedup
description: rebuild-all-reviews.js lets different named critics at same URL through — URL canonicalization alone is insufficient; also run critic-canonicalization at rebuild time.
type: feedback
originSessionId: 287936bf-b48f-4326-8ddd-6b0da45c4db5
archived: true
---
At `scripts/rebuild-all-reviews.js:2889`, the seenUrlsByOutlet dedup has a "multi-critic URL" carve-out: if two files have the SAME URL but DIFFERENT named critics (both non-Unknown), BOTH are kept. The intent was to support Daily Mail dual-reviews and NYT multi-critic pages.

The side effect: any mis-attribution bug that creates two files at the same URL with different critic names defeats URL dedup. Rocky Horror 2026-04-23: "David Finkle" (wrong) and "David Cote" (correct) at the same Cote Notices Substack URL were both kept because both are named critics.

**Why:** URL canonicalization (strip tracking params) makes the URLs MATCH, but the multi-critic allow-through explicitly wants to allow two different critics at the same URL. You cannot fix one without the other.

**How to apply:**
- Whenever you add a URL-canonicalization fix (e.g., new tracking param), also ask: "does a critic mis-attribution exist for this outlet pair that would defeat it via the multi-critic carve-out?"
- Run `canonicalizeCritic()` from `scripts/lib/critic-canonicalization.js` at rebuild time — not just at gather-time — so existing review files with wrong critic names get normalized BEFORE the dedup runs. See `scripts/rebuild-all-reviews.js:2761` for the integration point (right after defaultCritic resolution).
- Regression test pattern: `tests/unit/rebuild-critic-canon-dedup.test.mjs` asserts BOTH the bad case deduplicates AND the legitimate multi-critic case still passes through.
- Shipped by ship-check fix (commit 87187c14e4) after Session 3 merge — pre-shipcheck, the unit tests for canonicalizeUrlForDedup passed but the real repro would have still shipped twice.

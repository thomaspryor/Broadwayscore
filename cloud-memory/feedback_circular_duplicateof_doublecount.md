---
name: Circular duplicateOf double-counts reviews
description: When A.duplicateOf=B AND B.duplicateOf=A, rebuild's "refAlsoDupe recovery" path included BOTH files. Fixed with lexicographic tiebreaker 2026-04-19.
type: feedback
originSessionId: 3c6ff3c4-f1a0-4c7d-b918-ec1e69601bf4
archived: true
---
If two review JSONs form a circular `duplicateOf` cycle (A.duplicateOf=B AND B.duplicateOf=A), the rebuild's `refAlsoDupe` fallback will include BOTH files, double-counting a single review.

**Why:** rebuild-all-reviews.js lines 1515-1521 treated `refAlsoDupe=true` as "let this through, fingerprint dedup handles it." But fingerprint dedup doesn't fire if texts diverged (different fetch timestamps, different LLM scores, truncation differences). Observed 2026-04-19 on proof-2026: `nytimes--sarah-bahr ↔ nytimes--helen-shaw` (different text) AND `nysr--michael-sommers ↔ nysr--roma-torre` (same text but scored differently). Both pairs double-counted, pulling Proof composite from 73 to 72.

**How to apply:**
- The fix (commit c07c84dba5) adds an `isCircular` check (`refData.duplicateOf === file`) and excludes the lexicographically-greater filename when both are otherwise includable.
- When triaging a score anomaly where review count seems high, grep for circular duplicateOf: `grep -l "duplicateOf" data/review-texts/{show}/*.json` then `jq .duplicateOf` on each and check for back-references.
- Root cause of the circles: url-collision-detected-at-write fires on BOTH files (each was written separately, each saw the other as a collision). Any fix that creates duplicateOf should always pick a single canonical side, never set it bidirectionally.
- When a "ghost critic" is discovered (SERP misattribution where the actual article is by another critic), prefer setting `wrongAttribution: true` on the ghost — it's a hard block (rebuild line 2153) that doesn't depend on dupe-logic paths.

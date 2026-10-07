---
name: Fabricated review detection — three distinct patterns
description: Distinguishing genuine fabrications from stub-with-real-excerpt files; only the first pattern needs deletion
type: feedback
originSessionId: efa2a933-8f2d-45b1-97e1-a6a40e255001
archived: true
---
# Fabricated review detection — three distinct patterns

When auditing for fabricated reviews, three patterns coexist in `data/review-texts/`. Only **Pattern 1** is actually fabricated — Patterns 2 and 3 look suspicious but contain real signal.

## Pattern 1: TRUE FABRICATION — placeholder URL + hallucinated fullText
- Signal: URL has sequential-digit pattern (e.g., `SB123944876543210987`, `1234567`) AND `fullText` is non-empty AND fullText names a wrong director/playwright/cast member that contradicts shows.json.
- Example caught 2026-04-26: `joe-turners-come-and-gone-2009/wsj--terry-teachout.json` — fullText said "LaTanya Richardson Jackson's direction" but Bartlett Sher directed; Jackson was a cast member.
- **Action: DELETE.** Score was based on hallucinated body.

## Pattern 2: STUB WITH REAL AGGREGATOR EXCERPT — placeholder URL + empty fullText + real dtliExcerpt/showScoreExcerpt
- Signal: URL has placeholder/sequential-digit pattern AND `fullText` is empty AND `dtliExcerpt` or `showScoreExcerpt` is populated with real critic prose.
- Examples (8 found 2026-04-26): `gypsy-2024/ap--mark-kennedy.json`, `hamlet-2009/usatoday--elysa-gardner.json`, six WSJ Teachout files.
- These came from `source: web-search` ingest where the deep URL was unknown but DTLI/ShowScore had real excerpt+critic+date.
- **Action: KEEP** but consider replacing the placeholder URL with `null` or the aggregator URL. Score is from real excerpt, not hallucination.

## Pattern 3: ENSEMBLE-SCORED STUB — empty fullText + valid llmScore + real (often wrong-production) URL
- 3,700 files match this catalog-wide. Scanned 2026-04-26.
- Many are wrong-production attribution: e.g., `the-king-and-i-1985/hollywood-reporter--david-rooney.json` URL points to a 2015+ Rooney review of a different production. fullText was stripped during a content-quality migration but llmScore (from when text existed) remained.
- Some are legitimate (text was stripped because it was an excerpt-only after quality reclassification).
- **Action: investigate per-show, don't bulk-delete.** Many will resolve by re-scoring with current text or by setting `wrongProduction: true`.

## How to audit
- Per-file URL pattern check: `/SB?\d{0,4}(?:1234|2345|3456|4567|5678|6789|7890|0123)/i`, `/\/(?:SB)?\d{0,4}(?:1234567|12345678|123456789|1234567890)/i`. Catches Pattern 1 + 2.
- Per-file hallucination check: parse `fullText` for "directed by X" / "X's direction" patterns. Compare X against `creativeTeam` (filtered by role=director). False-positive risk: "music director X" — exclude.
- Stub-with-score: `fullText.length < 100 && (llmScore.score != null || originalScore != null)`. Catches all three patterns; needs URL+excerpt cross-check to disambiguate.

## Era coverage gaps (Broadway, run 2026-04-26)
- 2010+ shows: median 21–62 reviews, min ≥10. Healthy.
- 2002–2003: median 2–3 reviews. Worst era.
- Pre-2010 broadly: median 4–17, with 100+ shows below 8 reviews even when era median was higher.
- Likely cause: SERP indexing degrades sharply for pre-2010 content; SERP-only gather misses 80–90% of real reviews.
- Coverage-gap report: `/tmp/audit-historical.mjs` (Broadway only, era-median compare).

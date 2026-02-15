# Top 50 Show Quality Gate Audit
**Date:** 2026-02-15

## Quality Thresholds
- Full text coverage: >= 60% of reviews have complete/truncated text
- Scored coverage: >= 80% of reviews have assigned scores
- Tier 1 minimum: >= 4 Tier 1 outlet reviews

## Results: 46/50 PASS

**100% scored coverage across ALL 50 shows** — every review has a score.

### 4 Failures

| Show | Status | Reviews | Full Text | Scored | Tier 1 | Issue |
|------|--------|---------|-----------|--------|--------|-------|
| The Lion King | open | 21 | 48% | 100% | 6 | 1997 show, many old dead URLs |
| Shucked | closed | 54 | 57% | 100% | 9 | 2% below threshold |
| Two Strangers | open | 19 | 89% | 100% | 2 | Very new show (Nov 2025), reviews still coming in |
| All Out | open | 1 | 100% | 100% | 0 | Just opened Dec 2025, only 1 review |

### Recommendations
1. **The Lion King**: Run targeted collection (`show_filter=the-lion-king-1997`) to try Archive.org for old reviews
2. **Shucked**: Run targeted collection — only needs 2 more full texts to pass (31/54 → 33/54)
3. **Two Strangers / All Out**: These are new shows; reviews will come in via nightly collection
4. **Overall**: The 100% scored rate is excellent. Full text gaps are concentrated in 10 shows with 60-70% coverage — all are achievable via targeted collection runs

### Full Table (all 50 shows pass scored threshold)

| # | Show | Status | Reviews | Full Text % | Tier 1 |
|---|------|--------|---------|------------|--------|
| 1 | Harry Potter | open | 71 | 90% | 11 |
| 2 | Hadestown | open | 53 | 79% | 9 |
| 3 | Hell's Kitchen | open | 44 | 70% | 11 |
| 4 | Aladdin | open | 42 | 88% | 8 |
| 5 | Hamilton | open | 40 | 95% | 5 |
| 6 | Moulin Rouge | open | 37 | 92% | 9 |
| 7 | Book of Mormon | open | 37 | 68% | 13 |
| 8 | MJ The Musical | open | 36 | 86% | 10 |
| 9 | Bug | open | 34 | 100% | 8 |
| 10 | Oh, Mary! | open | 33 | 97% | 9 |

*(See full table in console output)*

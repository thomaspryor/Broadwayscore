# Data Integrity Report - 2026-03-08

## Summary

| Metric | Current | Previous | Change |
|--------|---------|----------|--------|
| Total Reviews | 31310 | 31310 | - |
| Unknown Outlets | 55 | 58 | -3 |
| Duplicates | 0 | 0 | - |
| Sync Delta | 13256 | 13256 | - |

## Issues Found

### 🔴 unknown_outlets

55 reviews have unknown outlets

**Examples:**
- `data/review-texts/11-to-midnight-off-broadway-2026/unknown--ryan-leeds.json` (outletId: unknown) (outlet: Unknown)
- `data/review-texts/a-dolls-house-part-2-2017/unknown--david-sheward.json` (outletId: unknown)
- `data/review-texts/airline-highway-2015/unknown--drew-shanahan.json` (outletId: unknown)
- `data/review-texts/allegiance-2015/tackles-an-underexplored-dark-chapter-in-our-history--george-takei.json` (outletId: tackles-an-underexplored-dark-chapter-in-our-history) (outlet: tackles-an-underexplored-dark-chapter-in-our-history)
- `data/review-texts/allegiance-2015/unknown--kevin-filipski.json` (outletId: unknown)

### 🔴 sync_delta

review-texts (31310) and reviews.json (18054) are out of sync by 13256 reviews

## Recommendations

- Run `node scripts/audit-outlet-registry.js` to identify and add missing outlets
- Run `node scripts/rebuild-all-reviews.js` to sync reviews.json with review-texts

---

*Report generated: 2026-03-08T06:31:11.345Z*

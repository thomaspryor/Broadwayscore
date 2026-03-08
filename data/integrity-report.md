# Data Integrity Report - 2026-03-08

## Summary

| Metric | Current | Previous | Change |
|--------|---------|----------|--------|
| Total Reviews | 31751 | 31751 | - |
| Unknown Outlets | 49 | 49 | - |
| Duplicates | 0 | 2 | -2 |
| Sync Delta | 13697 | 13697 | - |

## Issues Found

### 🔴 unknown_outlets

49 reviews have unknown outlets

**Examples:**
- `data/review-texts/11-to-midnight-off-broadway-2026/unknown--ryan-leeds.json` (outletId: unknown) (outlet: Unknown)
- `data/review-texts/a-dolls-house-part-2-2017/unknown--david-sheward.json` (outletId: unknown)
- `data/review-texts/airline-highway-2015/unknown--drew-shanahan.json` (outletId: unknown)
- `data/review-texts/allegiance-2015/unknown--kevin-filipski.json` (outletId: unknown)
- `data/review-texts/amazing-grace-2015/unknown--katy-walsh.json` (outletId: unknown)

### 🔴 sync_delta

review-texts (31751) and reviews.json (18054) are out of sync by 13697 reviews

## Recommendations

- Run `node scripts/audit-outlet-registry.js` to identify and add missing outlets
- Run `node scripts/rebuild-all-reviews.js` to sync reviews.json with review-texts

---

*Report generated: 2026-03-08T14:30:42.022Z*

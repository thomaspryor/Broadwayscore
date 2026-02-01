# Data Integrity Report - 2026-02-01

## Summary

| Metric | Current | Previous | Change |
|--------|---------|----------|--------|
| Total Reviews | 4598 | 1684 | +2914 |
| Unknown Outlets | 134 | 0 | +134 |
| Duplicates | 0 | 0 | - |
| Sync Delta | 2433 | 399 | +2034 |

## Issues Found

### 🔴 unknown_outlets

134 reviews have unknown outlets

**Examples:**
- `data/review-texts/aladdin/unknown--unknown.json` (outletId: unknown) (outlet: unknown)
- `data/review-texts/aladdin-2014/unknown--unknown.json` (outletId: unknown) (outlet: unknown)
- `data/review-texts/an-enemy-of-the-people/unknown--unknown.json` (outletId: unknown) (outlet: unknown)
- `data/review-texts/an-enemy-of-the-people-2024/unknown--unknown.json` (outletId: unknown) (outlet: unknown)
- `data/review-texts/and-juliet/unknown--unknown.json` (outletId: unknown) (outlet: unknown)

### 🔴 sync_delta

review-texts (4598) and reviews.json (2165) are out of sync by 2433 reviews

### 🟡 unknown_outlets_degradation

Unknown outlets increased from 0 to 134

## Recommendations

- Run `node scripts/audit-outlet-registry.js` to identify and add missing outlets
- Run `node scripts/rebuild-all-reviews.js` to sync reviews.json with review-texts

---

*Report generated: 2026-02-01T23:17:23.788Z*

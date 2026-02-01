# Data Integrity Report - 2026-02-01

## Summary

| Metric | Current | Previous | Change |
|--------|---------|----------|--------|
| Total Reviews | 1684 | 2111 | -427 |
| Unknown Outlets | 0 | 0 | - |
| Duplicates | 0 | 0 | - |
| Sync Delta | 399 | 14 | +385 |

## Issues Found

### 🔴 review_count_decrease

Review count decreased by 427 (20.2%) from 2111 to 1684

### 🔴 sync_delta

review-texts (1684) and reviews.json (2083) are out of sync by 399 reviews

## Recommendations

- Run `node scripts/rebuild-all-reviews.js` to sync reviews.json with review-texts
- Investigate missing reviews - check recent git history for deleted files

---

*Report generated: 2026-02-01T05:06:28.961Z*

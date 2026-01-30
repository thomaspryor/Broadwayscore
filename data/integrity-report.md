# Data Integrity Report - 2026-01-30

## Summary

| Metric | Current | Previous | Change |
|--------|---------|----------|--------|
| Total Reviews | 2111 | 2120 | -9 |
| Unknown Outlets | 0 | 9 | -9 |
| Duplicates | 0 | 0 | - |
| Sync Delta | 14 | 22 | -8 |

## Issues Found

### 🟡 review_count_decrease

Review count decreased by 9 (0.4%) from 2120 to 2111

### 🟡 sync_delta

review-texts (2111) and reviews.json (2097) are out of sync by 14 reviews

## Recommendations

- Run `node scripts/rebuild-all-reviews.js` to sync reviews.json with review-texts
- Investigate missing reviews - check recent git history for deleted files

---

*Report generated: 2026-01-30T21:10:39.832Z*

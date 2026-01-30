# Data Integrity Report - 2026-01-30

## Summary

| Metric | Current | Previous | Change |
|--------|---------|----------|--------|
| Total Reviews | 2111 | 2111 | - |
| Unknown Outlets | 0 | 0 | - |
| Duplicates | 0 | 0 | - |
| Sync Delta | 14 | 14 | - |

## Issues Found

### 🟡 sync_delta

review-texts (2111) and reviews.json (2097) are out of sync by 14 reviews

## Recommendations

- Run `node scripts/rebuild-all-reviews.js` to sync reviews.json with review-texts

---

*Report generated: 2026-01-30T21:27:17.707Z*

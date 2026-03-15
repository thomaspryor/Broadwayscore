# Data Integrity Report - 2026-03-15

## Summary

| Metric | Current | Previous | Change |
|--------|---------|----------|--------|
| Total Reviews | 31996 | 31751 | +245 |
| Unknown Outlets | 10 | 49 | -39 |
| Duplicates | 3 | 0 | +3 |
| Sync Delta | 14392 | 13697 | +695 |

## Issues Found

### 🟡 unknown_outlets

10 reviews have unknown outlets

**Examples:**
- `data/review-texts/driving-miss-daisy-2010/great-performances-online--unknown.json` (outletId: great-performances-online) (outlet: Great Performances Online)
- `data/review-texts/falsettos-2016/entries-are-now-being-accepted-online--unknown.json` (outletId: entries-are-now-being-accepted-online) (outlet: Entries are now being accepted online)
- `data/review-texts/going-bacharach-the-songs-of-an-icon-off-broadway-2026/goingbacharachcom--unknown.json` (outletId: goingbacharachcom) (outlet: GoingBacharach.com)
- `data/review-texts/hamlet-off-broadway-2026/here--unknown.json` (outletId: here) (outlet: here)
- `data/review-texts/im-almost-there-off-broadway-2026/here--unknown.json` (outletId: here) (outlet: here)

### 🟡 duplicates

3 duplicate reviews detected

**Examples:**
- `data/review-texts/all-my-sons-west-end-2025/timeout-london--andrzej-lukowski.json`
- `data/review-texts/cabaret-at-the-kit-kat-club-west-end-2021/timeout-london--unknown.json`
- `data/review-texts/punch-2025/deadline--unknown.json`

### 🔴 sync_delta

review-texts (31996) and reviews.json (17604) are out of sync by 14392 reviews

### 🟡 duplicates_degradation

Duplicates increased from 0 to 3

## Recommendations

- Run `node scripts/audit-outlet-registry.js` to identify and add missing outlets
- Run `node scripts/audit-review-duplicates.js` to identify duplicate reviews
- Run `node scripts/rebuild-all-reviews.js` to sync reviews.json with review-texts

---

*Report generated: 2026-03-15T05:12:28.783Z*

# Data Integrity Report - 2026-03-08

## Summary

| Metric | Current | Previous | Change |
|--------|---------|----------|--------|
| Total Reviews | 31111 | 30248 | +863 |
| Unknown Outlets | 67 | 47 | +20 |
| Duplicates | 35 | 49 | -14 |
| Sync Delta | 13064 | 12984 | +80 |

## Issues Found

### 🔴 unknown_outlets

67 reviews have unknown outlets

**Examples:**
- `data/review-texts/11-to-midnight-off-broadway-2026/unknown--ryan-leeds.json` (outletId: unknown) (outlet: Unknown)
- `data/review-texts/1984-2017/is-intense-in-a-way-ive-never-seen-on-broadway--duncan-macmillan.json` (outletId: is-intense-in-a-way-ive-never-seen-on-broadway) (outlet: is-intense-in-a-way-ive-never-seen-on-broadway)
- `data/review-texts/a-dolls-house-part-2-2017/unknown--david-sheward.json` (outletId: unknown)
- `data/review-texts/act-one-2014/its-a-brave-writer-who-would-contrive-this-show--moss-hart.json` (outletId: its-a-brave-writer-who-would-contrive-this-show) (outlet: its-a-brave-writer-who-would-contrive-this-show)
- `data/review-texts/airline-highway-2015/unknown--drew-shanahan.json` (outletId: unknown)

### 🔴 duplicates

35 duplicate reviews detected

**Examples:**
- `data/review-texts/be-more-chill-2019/theater-news-online--michael-appler.json`
- `data/review-texts/bigfoot-off-broadway-2026/nysr--unknown.json`
- `data/review-texts/broken-glass-west-end-2026/independent--unknown.json`
- `data/review-texts/falsettos-2016/newyorker--hilton-als.json`
- `data/review-texts/hadestown-2019/washpost--unknown.json`

### 🔴 sync_delta

review-texts (31111) and reviews.json (18047) are out of sync by 13064 reviews

### 🟡 unknown_outlets_degradation

Unknown outlets increased from 47 to 67

## Recommendations

- Run `node scripts/audit-outlet-registry.js` to identify and add missing outlets
- Run `node scripts/audit-review-duplicates.js` to identify duplicate reviews
- Run `node scripts/rebuild-all-reviews.js` to sync reviews.json with review-texts

---

*Report generated: 2026-03-08T04:48:57.815Z*

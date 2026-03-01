# Data Integrity Report - 2026-03-01

## Summary

| Metric | Current | Previous | Change |
|--------|---------|----------|--------|
| Total Reviews | 30248 | 24156 | +6092 |
| Unknown Outlets | 47 | 32 | +15 |
| Duplicates | 49 | 0 | +49 |
| Sync Delta | 12984 | 7677 | +5307 |

## Issues Found

### 🔴 unknown_outlets

47 reviews have unknown outlets

**Examples:**
- `data/review-texts/1984-2017/is-intense-in-a-way-ive-never-seen-on-broadway--duncan-macmillan.json` (outletId: is-intense-in-a-way-ive-never-seen-on-broadway) (outlet: is-intense-in-a-way-ive-never-seen-on-broadway)
- `data/review-texts/a-moon-for-the-misbegotten-2007/click-here--unknown.json` (outletId: click-here) (outlet: Click here)
- `data/review-texts/act-one-2014/its-a-brave-writer-who-would-contrive-this-show--moss-hart.json` (outletId: its-a-brave-writer-who-would-contrive-this-show) (outlet: its-a-brave-writer-who-would-contrive-this-show)
- `data/review-texts/allegiance-2015/tackles-an-underexplored-dark-chapter-in-our-history--george-takei.json` (outletId: tackles-an-underexplored-dark-chapter-in-our-history) (outlet: tackles-an-underexplored-dark-chapter-in-our-history)
- `data/review-texts/amazing-grace-2015/break-point--eric-metaxas.json` (outletId: break-point) (outlet: break-point)

### 🔴 duplicates

49 duplicate reviews detected

**Examples:**
- `data/review-texts/1984-2017/nbcny--robert-kahn.json`
- `data/review-texts/a-dolls-house-part-2-2017/nbcny--robert-kahn.json`
- `data/review-texts/anna-christie-1977/one-minute-critic--matthew-wexler.json`
- `data/review-texts/be-more-chill-2019/theater-news-online--michael-appler.json`
- `data/review-texts/blackout-songs-off-broadway-2026/one-minute-critic--emily-chackerian.json`

### 🔴 sync_delta

review-texts (30248) and reviews.json (17264) are out of sync by 12984 reviews

### 🟡 unknown_outlets_degradation

Unknown outlets increased from 32 to 47

### 🟡 duplicates_degradation

Duplicates increased from 0 to 49

## Recommendations

- Run `node scripts/audit-outlet-registry.js` to identify and add missing outlets
- Run `node scripts/audit-review-duplicates.js` to identify duplicate reviews
- Run `node scripts/rebuild-all-reviews.js` to sync reviews.json with review-texts

---

*Report generated: 2026-03-01T05:00:06.267Z*

# Data Integrity Report - 2026-02-19

## Summary

| Metric | Current | Previous | Change |
|--------|---------|----------|--------|
| Total Reviews | 24047 | 23923 | +124 |
| Unknown Outlets | 35 | 35 | - |
| Duplicates | 7 | 7 | - |
| Sync Delta | 7424 | 7367 | +57 |

## Issues Found

### 🔴 unknown_outlets

35 reviews have unknown outlets

**Examples:**
- `data/review-texts/1984-2017/is-intense-in-a-way-ive-never-seen-on-broadway--duncan-macmillan.json` (outletId: is-intense-in-a-way-ive-never-seen-on-broadway) (outlet: is-intense-in-a-way-ive-never-seen-on-broadway)
- `data/review-texts/a-chorus-line-2006/unknown--unknown.json` (outletId: unknown) (outlet: unknown)
- `data/review-texts/a-moon-for-the-misbegotten-2007/unknown--unknown.json` (outletId: unknown) (outlet: unknown)
- `data/review-texts/a-night-with-janis-joplin-2013/unknown--unknown.json` (outletId: unknown) (outlet: unknown)
- `data/review-texts/act-one-2014/its-a-brave-writer-who-would-contrive-this-show--moss-hart.json` (outletId: its-a-brave-writer-who-would-contrive-this-show) (outlet: its-a-brave-writer-who-would-contrive-this-show)

### 🟡 duplicates

7 duplicate reviews detected

**Examples:**
- `data/review-texts/1984-2017/newsday--elizabeth-vincentelli.json`
- `data/review-texts/august-osage-county-2007/nydailynews--unknown.json`
- `data/review-texts/book-of-mormon-2011/vulture--scott-brown.json`
- `data/review-texts/buena-vista-social-club-2025/nytimes--elizabeth-vincentelli.json`
- `data/review-texts/fences-2010/hollywood-reporter--unknown.json`

### 🔴 sync_delta

review-texts (24047) and reviews.json (16623) are out of sync by 7424 reviews

## Recommendations

- Run `node scripts/audit-outlet-registry.js` to identify and add missing outlets
- Run `node scripts/audit-review-duplicates.js` to identify duplicate reviews
- Run `node scripts/rebuild-all-reviews.js` to sync reviews.json with review-texts

---

*Report generated: 2026-02-19T01:25:27.483Z*

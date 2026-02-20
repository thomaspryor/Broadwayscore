# Data Integrity Report - 2026-02-20

## Summary

| Metric | Current | Previous | Change |
|--------|---------|----------|--------|
| Total Reviews | 24156 | 23923 | +233 |
| Unknown Outlets | 32 | 35 | -3 |
| Duplicates | 0 | 7 | -7 |
| Sync Delta | 7677 | 7367 | +310 |

## Issues Found

### 🔴 unknown_outlets

32 reviews have unknown outlets

**Examples:**
- `data/review-texts/1984-2017/is-intense-in-a-way-ive-never-seen-on-broadway--duncan-macmillan.json` (outletId: is-intense-in-a-way-ive-never-seen-on-broadway) (outlet: is-intense-in-a-way-ive-never-seen-on-broadway)
- `data/review-texts/a-chorus-line-2006/unknown--unknown.json` (outletId: unknown) (outlet: unknown)
- `data/review-texts/a-moon-for-the-misbegotten-2007/unknown--unknown.json` (outletId: unknown) (outlet: unknown)
- `data/review-texts/a-night-with-janis-joplin-2013/unknown--unknown.json` (outletId: unknown) (outlet: unknown)
- `data/review-texts/act-one-2014/its-a-brave-writer-who-would-contrive-this-show--moss-hart.json` (outletId: its-a-brave-writer-who-would-contrive-this-show) (outlet: its-a-brave-writer-who-would-contrive-this-show)

### 🔴 sync_delta

review-texts (24156) and reviews.json (16479) are out of sync by 7677 reviews

## Recommendations

- Run `node scripts/audit-outlet-registry.js` to identify and add missing outlets
- Run `node scripts/rebuild-all-reviews.js` to sync reviews.json with review-texts

---

*Report generated: 2026-02-20T00:11:13.016Z*

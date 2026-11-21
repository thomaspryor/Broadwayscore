---
name: feedback_reviews_json_outlet_ids
description: "outletId values don't match intuitive names; verify against real data first."
type: feedback
originSessionId: 906a9f8e-4588-449b-93e4-b2fa17bf0be0
archived: true
---
Always verify outletId values against reviews.json before writing any check or script that filters by outlet. Intuitive names are wrong:

| Wrong (invented) | Correct (actual) |
|---|---|
| the-guardian | guardian |
| ny-post | ny-post |
| the-telegraph | telegraph |
| time-out | timeout |
| time-out-london | timeout-london |
| the-times | times-uk |
| evening-standard | standard |

**Why:** Sprint A ship-check caught all 7 outlet IDs wrong in `unparsed-explicit-ratings.check.js` — check matched 0 of 470+ real cases in production.

**How to apply:** Before using any outletId in a hardcoded list, run:
```js
const reviews = require('./data/reviews.json');
const flat = reviews.reviews;
const matches = [...new Set(flat.map(r => r.outletId))].filter(id => id.includes('KEYWORD'));
console.log(matches);
```
Also note: `wrongProduction` does NOT appear in reviews.json (lives in review-texts source files). `originalRating` (raw string) is the field, not `originalScore`.

---
name: CI Unit Tests job needs npm ci for tests that import gather-reviews
description: "Tests importing gather-reviews need full install; playwright crashes without."
type: feedback
originSessionId: 8a4c950a-3ec6-4d56-9a7a-77582b696569
archived: true
---
The Unit Tests job in `.github/workflows/test.yml` was originally a no-data-dependency lightweight job: just checkout + setup-node + run a handful of `tests/unit/*.mjs` files. No `npm ci` step.

When wiring `scripts/test-opening-night-fixes.js` into this job, the tests failed in CI with:
```
Error: Cannot find module 'playwright'
Require stack:
  - scripts/lib/scraper.js
  - scripts/lib/url-discovery.js
  - scripts/gather-reviews.js
  - scripts/test-opening-night-fixes.js
```

**Why:** The opening-night tests import `extractBWWRoundupReviews` from `scripts/gather-reviews.js`, which transitively pulls in `playwright` via `scraper.js`. The lightweight Unit Tests job had no node_modules at all.

**How to apply:**
- Any CI job that runs scripts importing from `scripts/lib/scraper.js`, `scripts/gather-reviews.js`, `scripts/collect-review-texts.js`, or anything else in `scripts/` that touches scraping infrastructure MUST include `npm ci --prefer-offline --no-audit` before the test step.
- Pure-logic tests that only import from `scripts/lib/review-guards.js` (no transitive scraper deps) can skip the install and stay lightweight.
- When adding a new test to `test-opening-night-fixes.js`, check whether it adds a transitive scraper dependency. If so, the install is already there.

**See:** Broadwayscore@a5458cae51 (CI: install deps in Unit Tests job for review-guards regression tests).

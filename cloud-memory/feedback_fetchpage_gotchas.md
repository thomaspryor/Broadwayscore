---
name: fetchPage gotchas for aggregator migrations
description: "BD empty 200s, Playwright renders 404s as success, fetchPage is HTML-only."
type: feedback
---

When migrating raw `https.get` calls to `fetchPage()` from scraper.js:

1. **Bright Data returns 200 with 0 bytes** for some domains (theatre.reviews). fetchPage treated this as success. Fix: guard `result.content.length > 0` before accepting BD results. Already added to scraper.js.

2. **Playwright fetches 404 error pages "successfully"** — a 404 page can be 400KB+ of HTML that passes length checks. Fix: validate content markers (show title + review-specific characters like ⭑), not just length.

3. **fetchPage only returns HTML, not JSON.** WP API calls need `fetchJSON()` (added in this session). fetchJSON routes through ScrapingBee with `render_js=false` (1 credit) then falls back to direct fetch.

**Why:** These three issues caused theatre.reviews to silently fail in CI even after TLS migration. Each was only discoverable by running in CI against real data — local testing didn't expose them.

**How to apply:** When migrating any new fetch call to fetchPage, check: (a) does BD return content for this domain? (b) does the target URL ever 404? (c) does it return JSON not HTML?

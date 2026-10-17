---
name: fetchpage-gotchas-for-aggregator-migrations
description: "BD empty 200s, Playwright renders 404s as success, fetchPage is HTML-only."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 368ab661-d7b7-4a03-a68e-4e0e72265153
  modified: 2026-07-24T01:03:59.611Z
---

When migrating raw `https.get` calls to `fetchPage()` from scraper.js:

1. **Bright Data returns 200 with 0 bytes** for some domains (theatre.reviews). fetchPage treated this as success. Fix: guard `result.content.length > 0` before accepting BD results. Already added to scraper.js.

2. **Playwright fetches 404 error pages "successfully"** — a 404 page can be 400KB+ of HTML that passes length checks. Fix: validate content markers (show title + review-specific characters like ⭑), not just length.

3. **fetchPage only returns HTML, not JSON.** WP API calls need `fetchJSON()`. As of task #203 (2026-07-24) the chain is direct fetch → Scrapingdog (escalates plain→stealth_mode=true on a 400) → ScrapingBee → Bright Data (final tier) — not just SB+direct as originally shipped; a WAF-blocked host (westendtheatre.com wp-json from CI IPs) needed the full ladder before it stopped returning zero results.

4. **New `https.get`/`https.request` call sites in scraper.js need an explicit `timeout` option.** Two providers (`fetchWithBrightData`, `fetchWithScrapingBee`) shipped with no timeout at all — a hung connection would stall `fetchPage()`/`fetchJSON()` indefinitely with no way out. Found via `/what-else` pattern-recognition sweep after fixing the first instance, not by design. `grep -n "https\.get\|https\.request" scripts/lib/scraper.js` before adding a new provider call — every existing site now sets `{ timeout: 45000 }` + a `req.on('timeout', ...)` handler; match that pattern.

**Why:** These issues caused theatre.reviews and westendtheatre.com to silently fail in CI even after migration. Each was only discoverable by running in CI against real data — local testing didn't expose them.

**How to apply:** When migrating any new fetch call to fetchPage/fetchJSON, or adding a new provider tier, check: (a) does BD return content for this domain? (b) does the target URL ever 404? (c) does it return JSON not HTML? (d) does the new HTTP call have an explicit timeout matching the existing 45s pattern?

---
name: scraper_architecture_rule
description: "New scraping scripts MUST use fetchPage(); CI enforces BD+SB both present."
type: feedback
---

All new web scraping scripts MUST use `fetchPage()` from `scripts/lib/scraper.js` for page fetching, and `serpQuery()` from `scripts/lib/url-discovery.js` for Google SERP queries — never call BD or SB APIs directly inline.

**Why:** Scripts that call SB directly have no fallback when SB credits run out. BD goes dead silently. This caused weekly grosses/scraping to run Playwright-only without anyone noticing.

**How to apply:**
- New script doing Google SERP queries → `const { serpQuery } = require('./lib/url-discovery')` — returns `[{url, title, snippet}]`, BD first → SB fallback
- New script doing web fetching → `const { fetchPage } = require('./lib/scraper')`
- New workflow using a scraping script → must pass both `BRIGHTDATA_TOKEN` and `SCRAPINGBEE_API_KEY` env vars
- CI enforces this in `test.yml` `lint-workflows` job (Check scraping workflows have multi-service fallback)
- Exempt list in test.yml covers: health checks, JS-rendered pages (weekly-grosses, scrape-alltime — SB→Playwright is correct for those), and legacy scripts not yet migrated

**Exception:** BWW grosses pages require JS rendering. BD (raw HTML) can't replace SB here. Correct fallback for those is SB → Playwright (already implemented in the scripts). Don't add BD to `weekly-grosses.yml` or `scrape-alltime-grosses.yml` — it won't help.

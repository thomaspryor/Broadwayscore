# Scraper Fallback Chain

## The Tier Chain (in order)

```
Tier 0:  Direct fetch (no proxy) — for non-blocked sites
Tier 1:  Bright Data web_unlocker — handles most bot-detection
Tier 2:  ScrapingBee — fallback when BD fails
Tier 3:  Playwright (headless Chrome) — for JS-heavy sites
Tier 1.5: Browserbase — Cloudflare-protected sites ONLY
```

## When Each Tier Is Used

| Site type | Tier chain |
|-----------|-----------|
| Standard sites | Tier 0 → 1 → 2 → 3 |
| JS-required (render needed) | Tier 2 (SB, render_js=true) → 3 |
| Cloudflare protected | Tier 1.5 (Browserbase) only |
| Paywalled (cookies needed) | Tier 2 with premium_proxy + cookie forwarding |

## Special Domains

**JS_REQUIRED_DOMAINS** (render_js=true in SB): defined in `scripts/lib/scraper.js`
- These use SB at 5 credits/call instead of 1

**PLAYWRIGHT_FIRST_DOMAINS**: defined in `scripts/lib/scraper.js`
- Skip BD entirely, go straight to Playwright

**CONFIG.knownBlockedSites** in `scripts/collect-review-texts.js`:
- Routes to Browserbase (Tier 1.5) for Cloudflare-managed-challenge sites
- Adding here is required for Browserbase routing — it doesn't happen automatically

**Weekly grosses / all-time grosses:**
- These scripts use SB → Playwright (not BD first)
- BD (raw HTML) can't replace SB for JS-rendered pages
- Do NOT add BD to `weekly-grosses.yml` or `scrape-alltime-grosses.yml`

## The Architecture Rule

```js
// CORRECT — use the lib
const { fetchPage } = require('./lib/scraper');
const { serpQuery } = require('./lib/url-discovery');

// WRONG — never call directly
const response = await fetch(`https://app.scrapingbee.com/api/v1?...`);
const response = await fetch(`https://api.brightdata.com/...`);
```

## Workflow Requirements

Any workflow step using a script that calls fetchPage must include:
```yaml
env:
  BRIGHTDATA_TOKEN: ${{ secrets.BRIGHTDATA_TOKEN }}
  SCRAPINGBEE_API_KEY: ${{ secrets.SCRAPINGBEE_API_KEY }}
```

CI lint enforces this (`lint-workflows` job in `test.yml`). Exempt list is in `test.yml` with comments — only add to exempt list if the workflow genuinely doesn't scrape (health checks, credential validators, etc.).

## Diagnosing Which Tier Is Failing

Add `--verbose` or check `result.source` in fetchPage return:
```js
const result = await fetchPage(url);
console.log('Fetched via:', result.source); // 'brightdata', 'scrapingbee', 'playwright', 'browserbase', 'direct'
```

If all tiers fail:
1. Check if site added Cloudflare managed challenge recently → needs Browserbase
2. Check BD zone status: `curl https://api.brightdata.com/zone?zone=$BRIGHTDATA_ZONE -H "Authorization: Bearer $BRIGHTDATA_TOKEN"`
3. Check SB credits remaining: `curl https://app.scrapingbee.com/api/v1/usage?api_key=$SCRAPINGBEE_API_KEY`

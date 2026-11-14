---
name: Cloudflare bypass hierarchy — Browserbase is the only real solution
description: "Managed challenge defeats Playwright/BD/SB/fetch; only Browserbase works."
type: feedback
originSessionId: db355bb5-0a8d-4751-8eb3-299fb94a291b
---
When a site starts returning 403s or "Just a moment..." Cloudflare challenge pages, **do not waste time on these approaches** (all verified failing on TB 2026-04-15):

1. Headless Playwright with stealth plugin — managed challenge too strict
2. Headless Playwright with cf_clearance cookies — cookie is TLS-fingerprint-bound to the issuing browser, Node.js/Playwright has a different JA3 so cookie is invalid
3. BrightData web_unlocker — returns empty content (CF blocks at edge)
4. ScrapingBee with render_js=true + premium_proxy — 500 errors from SB
5. curl with Safari UA + cookies — 403 (SecureTransport TLS differs from Safari's)
6. Node.js fetch() with Chrome UA + cookies — 403 (same reason)

**Only Browserbase works** — cloud browser service with dedicated Cloudflare solving.

**Why:** Pass `solveCaptchas: true` in session config. Wait for the actual content element (e.g., `section.page`) not `page.title()` (title often stays "Just a moment..." even after CF solves server-side and content renders).

**How to apply:** When adding a new site that's Cloudflare-protected:
1. Add hostname to `CONFIG.knownBlockedSites` in `scripts/collect-review-texts.js` — this is what routes it to Browserbase tier (1.5). Without this, the tier chain never reaches Browserbase regardless of other tier failures.
2. Do NOT add to `PLAYWRIGHT_FIRST_DOMAINS` in `scripts/lib/scraper.js` — Playwright first wastes time/money.
3. If the site has an unusual content container (e.g., TB's `<section class="page">`), add it to both `extractArticleText` (in-browser, line ~3405) and `extractTextFromHtml` (server-side, line ~3600). Otherwise Browserbase gets the real HTML but extractor picks up nav junk.
4. Verify live against a known-good URL before claiming the fix works. 5 approaches failed on TB before Browserbase succeeded — don't assume, test.

**Cost:** Browserbase sessions count against daily/run/domain caps (200/40/15). Low-volume outlets are fine; high-volume would exhaust.

**2026-08-31 addendum — for a SINGLE stranded review, don't reach for `ingest-review-from-url.js`:** it calls `scripts/lib/scraper.js`'s `fetchPage()`, which has **zero Browserbase support** — Browserbase only exists inside `collect-review-texts.js`'s own tier chain. For a site already in `CONFIG.knownBlockedSites` (talkinbroadway.com confirmed), use `collect-review-texts.js` targeted at the one show instead: `SHOW_FILTER=<show-id> CONTENT_TIER_FILTER=truncated BROWSERBASE_ENABLED=true RETRY_FAILED=true node scripts/collect-review-texts.js`. **Caveat found the same session: `SHOW_FILTER` is parsed into config but was NOT enforced in the run that surfaced this — it scanned 152 unrelated shows instead of the 1-2 requested (BRO-2691, unfixed).** Expect broad API spend across many shows until BRO-2691 lands; check the written `data/audit/validation/collection-report-*.json`'s `processed`/`failed` show-id spread before assuming the run stayed scoped.

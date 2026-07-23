---
name: feedback_bww_ci_ip_block
description: "BroadwayWorld throttles/blocks GitHub Actions IPs specifically — a CI-only scraper failure against broadwayworld.com is IP-based, not a selector/DOM bug; verify via local curl first, fix with BD/SD proxy tiers ahead of bare Playwright."
metadata: 
  node_type: memory
  type: feedback
  originSessionId: 39ba1968-9622-41c4-9432-ee49a043c950
  modified: 2026-07-23T02:05:30.950Z
---

BroadwayWorld (grosses.php, and likely other BWW pages used by review scrapers) silently serves a different — non-`.all-gross-data`-bearing — response to GitHub Actions runner IPs while serving the normal static HTML to residential/office IPs. This is NOT a Cloudflare managed-challenge (no `cf_chl_opt`/"Just a moment" markers) — different mechanism than [[feedback_cloudflare_bypass_hierarchy.md]]'s WSJ/NewYorker case, so the "Browserbase only" conclusion there does NOT apply here: plain Bright Data / Scrapingdog (proxied, non-CI IP) succeeds immediately.

**Why:** 2026-07-21/22 weekly-grosses.yml incident (task #328) — ScrapingBee was quota-exhausted (expected, separate cause) and the bare-Playwright fallback (launches from the CI runner's own IP, no proxy) consistently timed out on `page.waitForSelector('.all-gross-data .row')` while `curl` of the identical URL from a non-CI machine returned the full page in <1s with the selector present. Two days of "all scraping tiers failed" were actually one exhausted-quota tier plus one CI-IP-blocked tier — neither diagnosis was "the scraper code is broken."

**How to apply:** When a BWW-dependent script fails ONLY in CI (works via manual local run / curl), don't debug selectors or page structure first — confirm via `curl -A "<desktop UA>" <url>` from a non-CI machine that the content is present, then add Bright Data / Scrapingdog tiers ahead of the bare-Playwright tier (both proxy through non-GH-Actions IPs) rather than tuning Playwright's wait/selector logic. [[feedback_scraper_architecture.md]] covers BWW's separate soft-404 quirk (200 status, homepage content, check `<title>`) — that's a different failure mode from this one. Task #66 tracks migrating BWW-touching direct-SB scripts to the shared `fetchPage()` (which already special-cases `broadwayworld.com` to try Playwright first, then Scrapingdog/BD/SB) — until that lands, any BWW script with only SB+bare-Playwright is a live risk for this exact failure class.

---
name: TimeOut and FT anti-bot protection
description: "TimeOut blocks browsers; FT renders stars client-side; LLM fallback."
type: feedback
archived: true
---

TimeOut (timeout.com) returns HTTP 400 to headless Playwright and Browserbase, HTTP 500 to ScrapingBee render_js=true, and raw HTML without SVG stars from Bright Data. All automated star extraction paths are blocked. Extract scores from existing fullText unicode stars instead; remaining reviews fall to LLM ensemble scoring.

FT (ft.com) serves paywall HTML even with valid subscriber cookies forwarded via ScrapingBee. Unicode star ratings are rendered client-side and don't appear in server HTML. Cookie forwarding works (ft.com added to ESSENTIAL_COOKIE_PATTERNS) but the HTML lacks rating content.

**Why:** Both sites use aggressive TLS fingerprinting and/or JS-only rendering that defeats all current scraping tiers.

**How to apply:** Don't waste credits trying to scrape stars from these outlets. Check `assignedScore` (LLM) as the fallback — both outlets are >99% LLM-scored. For TimeOut, always check fullText for unicode stars first (free). For FT, LBO roundup archives sometimes have star ratings.

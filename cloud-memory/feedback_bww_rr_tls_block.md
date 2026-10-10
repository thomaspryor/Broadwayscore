---
name: BWW RR plain https.get returns 403
description: scripts/scrape-bww-roundups.js used plain https.get which is TLS-fingerprinted by BWW; must use fetchPage() for known-good URLs
type: feedback
originSessionId: 059fcd51-c17e-4a91-8e17-cc34bafd046b
archived: true
---
BWW RR pages return 403 to Node's plain `https.get()` due to TLS fingerprinting, even for valid URLs (manual override, SERP result). Schmigadoon 2026-04-20 opening-night: scraper hit 403 on the correct URL override, then SERP fallback also 403'd → captured 0 of 19 thumbs.

**Why:** Node's TLS stack has a fingerprint BWW's WAF flags. Known pattern — already documented in `feedback_tls_fingerprinting.md` for other CDN-protected sites. `scripts/scrape-bww-roundups.js` predates the `fetchPage()` rule and still used raw `https.get()`.

**How to apply:** For known-good URLs (manual-URL override, SERP-returned URL), always call `httpGetUnblocked()` which wraps `fetchPage()` (BD → SB → Playwright). Fixed in commit 8b068eb8f4.

Fast-path URL pattern scanning (36+ try URLs) still uses plain `httpGet` for speed — 403s there are OK because any successful match tells us we have the right URL. If ALL patterns 403, the SERP fallback catches it with fetchPage.

**Signal for future regressions:** If bwwThumb coverage on a show is <50% of critics in the roundup, check the scraper logs for "status: 403" on the override URL.

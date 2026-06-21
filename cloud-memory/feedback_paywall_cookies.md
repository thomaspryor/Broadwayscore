---
name: Paywall Cookie Access
description: "Subscriber cookies for paywalled outlets live in GH secrets — check before assuming inaccessible. CI or Safari."
type: feedback
originSessionId: 3548d82c-4d8f-4ce3-8b16-044161f84602
archived: true
---
When scraping paywalled UK/US outlets, check for subscriber cookies before assuming content is inaccessible.

**Why:** Multiple sessions have wasted time trying to scrape paywalled sites without realizing we have subscriber access via cookies stored in GitHub secrets.

**How to apply:**

## Cookie Secrets (GitHub Actions)
The domain → `*_COOKIES` secret-name routing table is the single source of truth in
`scripts/lib/cookie-loader.js` (`COOKIE_DOMAIN_MAP`). Don't duplicate the outlet list here —
read it from that file. Each entry resolves a domain to its env var / file key.

## CI Workflows That Use Cookies
- `collect-review-texts.yml` — main collection
- `recollect-for-scores.yml` — score extraction
- `collect-hard-paywall.yml` / `collect-soft-paywall.yml` — specialized collection

## Local Cookie Extraction
- `scripts/extract-safari-cookies.py` — extracts from Safari's binary cookie store (needs Full Disk Access)
- `scripts/export-cookies.js` — exports cookies to Playwright format
- `scripts/check-cookie-health.js` — verifies cookie validity (Layer 1: structure, Layer 2: auth expiry, Layer 3: live access)
- `scripts/paywall-browser-login.js` — creates persistent Playwright profile with login session
- `scripts/paywall-browser-extract.js` — extracts articles using persistent profile

## When to Use
- Scraping a paywalled outlet? → Trigger a CI collection workflow with cookies (the workflow passes `COOKIES_BUNDLE_*`)
- Need to verify star ratings on paywalled pages? → `recollect-for-scores.yml` carries the relevant cookies
- Local scraping? → Extract Safari cookies first, or use `paywall-browser-login.js` to create a profile

## 2026-04-22 WSJ audit findings
The Schmigadoon postmortem claimed WSJ reviews routinely come back paywalled. Audit showed otherwise:
- Bundle-based wiring is healthy. `scripts/lib/cookie-loader.js` resolves `wsj.com` via `COOKIES_BUNDLE_*` env vars (Tier 1 → Tier 2 individual env → Tier 3 local file). 17 workflows pass `COOKIES_BUNDLE_1..11` through `env:`, so CI has access: `gather-reviews.yml`, `opening-night-poller.yml`, `opening-night-express.yml`, `collect-review-texts.yml`, `bulk-collect-review-texts.yml`, `recover-wsj-subscriber.yml`, etc.
- Weekly health check exists. `check-cookie-health.yml` (Tue + Fri) runs Layers 1+2 for WSJ (auth cookies `sso`, `djcs_route`, `session`). Layer 3 (live access) is skipped for WSJ — `proxyBlocked: true` — because DataDome blocks ScrapingBee even with valid cookies.
- Real leak rate across 36,355 review-texts: **0 files** matched the positional paywall detector. Out of 788 WSJ files, 311 are `textQuality=truncated` but that's real short-form content (~200–300 words), not paywall overlays. Only 5 files contained "subscribe to continue"-type phrases, all mid-paragraph (reviewers quoting WSJ's paywall) — false positives for a leak-detection signal.

## New tooling (2026-04-22)
- `scripts/lib/paywall-detector.js` — `detectHardPaywall(text, urlOrDomain)` with positional + outlet-specific markers. Unit-tested in `tests/unit/paywall-detector.test.mjs`.
- `scripts/audit-paywall-leaks.js` — on-demand scan of review-texts/. Writes `data/audit/paywall-leaks.json`. `--strict` for CI use; current baseline is 0 leaks.

## Refresh steps (if WSJ auth cookies ever go stale)
1. Confirm staleness: `gh workflow run "Check Cookie Health" -f live_check=false`. If Layer 2 reports WSJ `sso`/`djcs_route`/`session` expiring in <1 day, cookies are dying.
2. Mac Studio path (see `feedback_mac_studio_cookies.md`): log into WSJ in Safari, run `scripts/extract-safari-cookies.py --domain=wsj.com`, then `scripts/export-cookies.js --domain=wsj.com` to produce a Playwright cookie JSON.
3. Base64-encode the JSON and update the relevant `COOKIES_BUNDLE_*` secret in GitHub. The bundle's `wsj` fileKey is resolved by `cookie-loader.js`; the JSON must be a `{ fileKey: [cookies] }` object.
4. Re-run `check-cookie-health.yml` to confirm Layer 2 now reports healthy expiry windows.
5. Optional: `node scripts/audit-paywall-leaks.js --outlet=wsj` to confirm no leak has already been written. If leaks exist, delete the affected review-text files and re-run `gather-reviews` for those shows.

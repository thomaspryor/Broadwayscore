# Scraper Gotchas — Documented Failure Modes

Each entry below is a real incident. Read these before writing or modifying any scraping code.

---

## G1: fetchPage returns an object, not a string

**Symptom:** Script runs, exits 0, produces 0 results.
**Root cause:** `fetchPage()` returns `{content, format, source}`. Passing the object directly to HTML parsers silently produces empty results.
**Fix:** Always unwrap: `const html = result.content;` — then check `html.length > 0`.
**Detection:** Run with `--limit 1` and inspect output count. Never claim a scraper "works" based on `node --check` alone.

---

## G2: Bright Data returns 200 with 0 bytes

**Symptom:** BD tier appears to succeed (no error), but content is empty.
**Domains affected:** theatre.reviews (confirmed). Possibly others.
**Fix:** Guard `result.content.length > 0` before accepting BD results. This is already in scraper.js. If you add a new parser, add the guard too.
**Why:** BD silently returns empty 200s for some domains it can't access cleanly.

---

## G3: Playwright renders 404 pages as 200 success

**Symptom:** Playwright fetches return large HTML content (400KB+) that passes length checks, but it's the 404 error page.
**Fix:** Validate content markers specific to the show/review (show title, star characters ⭑, review-specific selectors) — not just length.
**Why:** A 404 error page is still valid HTML with substantial content.

---

## G4: fetchPage is HTML-only — use fetchJSON for APIs

**Symptom:** WP API or other JSON endpoints return garbled/HTML content.
**Fix:** Use `fetchJSON()` from scraper.js for JSON endpoints. It routes through ScrapingBee with `render_js=false` (1 credit) then falls back to direct fetch.
**Why:** fetchPage assumes HTML and may mangle JSON responses.

---

## G5: Workflow missing BRIGHTDATA_TOKEN + SCRAPINGBEE_API_KEY

**Symptom:** 100% failure rate in CI. Playwright handles all requests (slow, many timeouts).
**Fix:** Add to every workflow step that calls a script using fetchPage():
```yaml
env:
  BRIGHTDATA_TOKEN: ${{ secrets.BRIGHTDATA_TOKEN }}
  SCRAPINGBEE_API_KEY: ${{ secrets.SCRAPINGBEE_API_KEY }}
```
**Why:** Without them, fetchPage skips BD and SB tiers and falls through to Playwright (which isn't installed in most workflows).

---

## G6: TLS fingerprinting — use fetch() not https.get()

**Symptom:** 403 or HTML error response in CI for Reddit, Broadway.com, or CDN-protected sites. Works locally.
**Fix:** Use `fetch()` (Node 18+ / undici) instead of `https.get()` or `https.request()`.
**Why:** GitHub Actions IPs get bot-detected via TLS fingerprint. `https.get()` uses OpenSSL's cipher suite; `fetch()` uses undici's (different fingerprint that CDNs allow).
**Pattern:**
```js
const controller = new AbortController();
setTimeout(() => controller.abort(), 15000);
const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
```

---

## G7: Cloudflare managed challenge — Browserbase is the only solution

**What fails:** Headless Playwright, cf_clearance cookies, Bright Data web_unlocker, ScrapingBee premium proxy, curl with Safari UA, Node fetch with Chrome UA.
**What works:** Browserbase (cloud browser with dedicated CF solving). Pass `solveCaptchas: true`.
**Why cookies don't work:** cf_clearance is bound to the issuing browser, so a different client can't reuse it (TLS-fingerprint detail in `references/cookies.md`, local-only).
**To route a site to Browserbase:** Add hostname to `CONFIG.knownBlockedSites` in `scripts/collect-review-texts.js`. Do NOT add to `PLAYWRIGHT_FIRST_DOMAINS` in scraper.js.
**Gotcha:** Wait for actual content element (e.g. `section.page`), not `page.title()` — title stays "Just a moment..." even after CF resolves server-side.
**Cost:** Browserbase sessions count against daily/run/domain caps (200/40/15).

---

## G8: Aggregator soft 404 — BWW returns homepage with 200 OK

**Symptom:** BWW returns homepage HTML with 200 when the Review Roundup page doesn't exist yet.
**Fix:** Check `<title>` tag in validators. If title is "BroadwayWorld.com" (homepage) not the show title, treat as soft 404.
**Why:** BWW doesn't return proper 404 for missing roundup pages.

---

## G9: Cookie-only paywall outlets — never email/password

**Auth method:** Cookie-only via `cookie-loader.js` (`loadCookiesForDomain(host)`).
**Why:** Email/password login creates a new session on each CI run; many concurrent runners trip the outlet's session limit. The relevant `*_EMAIL` / `*_PASSWORD` secrets have been DELETED — do not re-add them.
**If cookies expire:** Refresh via Safari export. Never re-add email/password login.
**Site host + exact cookie set:** local-only — see `references/cookies.md` (gitignored). A cloud session without that file should ask the user for the host and cookie names rather than guessing.

---

## G10: ScrapingBee credit budget exhaustion

**Default caps:** `SB_CREDIT_BUDGET=250` (all fetchPage scripts), `SB_PAGE_CREDIT_BUDGET=200` (collect-review-texts.js)
**Override for bulk runs:** `env: { SB_CREDIT_BUDGET: '1000' }` in workflow step
**Credit costs:** render_js=false = 1 credit; render_js=true = 5 credits (JS_REQUIRED_DOMAINS only); premium_proxy = 10 credits
**When budget hit:** SB is skipped, Playwright handles remaining (graceful degradation, not failure)

---

## G11: Bright Data trial limit — auto-recovery creates new zone

**Symptom:** BD silently fails for all requests. `plan.disable: "trial limit reached"` in zone API response.
**Fix:** `check-secrets-health.js` auto-recovers by creating a new zone via API and updating `BRIGHTDATA_ZONE` GitHub secret.
**Current zone:** `web_unlocker2` (created 2026-03-31 after `mcp_unlocker` expired)
**Zone name:** Read from `BRIGHTDATA_ZONE` env var (fallback: `mcp_unlocker` in scraper.js)
**Manual create:** `curl -X POST https://api.brightdata.com/zone -H "Authorization: Bearer $BRIGHTDATA_TOKEN" -H "Content-Type: application/json" -d '{"zone":{"name":"web_unlocker3"},"plan":{"type":"unblocker","product":"unblocker"}}'`
**Note:** Disable field is at `data.plan.disable` NOT `data.disable` (common detection bug).

---

## G12: New scraper migration checklist

Before claiming a scraper migration works:
1. ✅ Unwrap `result.content` from fetchPage return
2. ✅ Guard `content.length > 0`
3. ✅ Run with `--limit 1`, confirm output count > 0, inspect a sample record
4. ✅ Workflow has `BRIGHTDATA_TOKEN` + `SCRAPINGBEE_API_KEY` in env
5. ✅ CI lint-workflows job passes (checks for multi-service fallback)
6. ✅ For Cloudflare sites: added to `CONFIG.knownBlockedSites`

`node --check` is syntax validation only. Never claim a script "works" based on it.

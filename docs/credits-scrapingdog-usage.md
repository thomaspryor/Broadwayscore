# ScrapingDog credit management (BRO-364)

Card filed by the daily health-check ledger (`health-check:Credits: ScrapingDog`):
`2399k credits left (60%) · 133k/day burn · renews in 18d · exhausts in ~18d
(BEFORE renewal)`. This doc is the reference for triaging that alert again —
what checks it, what already enforces spend, what actually changed this
session, and what's left as a live, owner-owned tradeoff.

## How to check current usage

```
curl -s "https://api.scrapingdog.com/account?api_key=$SCRAPINGDOG_API_KEY"
```
or the dashboard: app.scrapingdog.com. `node scripts/probe-scrapingdog-billing.js`
wraps the same call with the repo's usual error handling.

For a same-day breakdown of which script/workflow is spending the credits:
```
node scripts/check-provider-spend.js
```
This reads `data/audit/scraper-spend-ledger.jsonl` (per-call rows written by
`scripts/lib/provider-telemetry.js`'s `recordSdCall`) and prints top callers by
credits spent. **Caveat (see "Known attribution gap" below): this total can
undercount real SD spend** if a caller doesn't route through an instrumented
chokepoint.

## Architecture already in place

Three independent layers, each with a different job — don't conflate them:

1. **`scripts/lib/scrapingdog-caps.js` — the daily circuit breaker.** A
   cross-run credit ceiling, enforced BEFORE a call is made (not just reported
   after). Since BRO-2943 (2026-09-07) the ceiling is plan-derived
   (`planFairShareCeiling`: `(credits left) / (days to renewal) * 1.5` burst
   factor) rather than a flat number, so it scales as the prepaid pack drains.
   `scripts/check-sd-breaker.js` (hourly) computes today's credits from the
   billing API and writes `data/audit/sd-circuit-breaker.json`; `consultScrapingdog()`
   reads that state and blocks non-exempt callers once tripped (opening-window
   shows get a carved-out reserve so a bulk sweep can't starve them).
   Blocking is **soft** — it returns `{allowed:false}` and the caller falls
   through to Bright Data/ScrapingBee, exactly like a normal SD miss.

2. **`scripts/lib/scrapingdog-ack.js` — the health-check projection + its
   expiring acknowledgment.** `evaluateScrapingdogCredits()` computes
   `dailyBurn = requestUsed / daysIntoCycle` and projects exhaustion against
   `daysToRenewal`. If the projection lands before renewal it's `error`
   (surfaces as this Linear card); an expiring `SCRAPINGDOG_ACKNOWLEDGED_BURN`
   block can downgrade a *known, non-imminent* projection to `warn` — but it
   always re-escalates to `error` if the balance is `<=5%` or exhausts within
   3 days, so a real runaway can't hide behind a stale ack. **This is a
   pace/average calculation, not the same math as the breaker's ceiling** —
   the breaker can already be capping today's spend below the fair-share line
   while the health check's cycle-to-date average is still catching up, so a
   day or two of lag between "breaker fixed" and "alert clears" is expected
   and not itself a bug.

3. **`scripts/config/provider-spend-thresholds.json`'s `scrapingdogDailyCredits`
   — the digest alarm line.** Owner-owned, alarm-only (does not enforce
   anything). Raised 45,000 → 100,000 in BRO-2943 to match the new
   plan-derived ceiling (~130-160K/day is now a *normal* day, not overspend).

## Known attribution gap — fixed this session

`scripts/lib/scrapingdog-caps.js`'s own docstring flagged this as a known,
out-of-scope gap: **`scripts/lib/reddit-api.js`'s `fetchViaScrapingDog()` was
a third, independent SD caller that never consulted the breaker and never
wrote a ledger row.** Every other SD chokepoint (`scraper.js`'s
`fetchWithScrapingdog`, `url-discovery.js`'s `_serpViaScrapingdog`) does both.
Reddit's SD traffic escalates its tier ladder (plain 1cr → premium/stealth
10cr, **latched for the rest of the run** once escalated — real runs regularly
see 41/41 plain requests refused, i.e. every call after the first pays 10cr,
not 1cr) across several crons (`update-reddit-sentiment.yml`,
`bulk-reddit-sentiment.yml`, `brand-mention-monitor.yml` via
`fetch-social-pulse.js`) — a real, plausible contributor to the gap between
the account API's 133k/day burn and what `check-provider-spend.js`'s ledger
totals showed for the same days (~6-15k/day attributed).

Fixed in this session (see `scripts/lib/reddit-api.js`, tests in
`tests/unit/reddit-api-scrapingdog.test.mjs`): `fetchViaScrapingDog` now calls
`consultScrapingdog()` before each request (soft-fails to the SB fallback if
the breaker is tripped, same shape as `scraper.js`) and `scrapingDogRequest`
now calls `recordSdCall()` on every outcome (success, 4xx/401/403, and
connection-level errors bill 0). This closes the reddit-api.js blind spot
`check-provider-spend.js`'s attribution coverage metric was designed to catch
(`attributionCoverageMin` in `provider-spend-thresholds.json`) and makes
Reddit's SD traffic respect the daily ceiling like every other caller.

## If the alert recurs after this fix

1. Re-run `node scripts/check-provider-spend.js` and compare the ledger total
   against the account API's `requestUsed` for the same day — a large,
   still-unattributed gap means another uninstrumented caller exists (check
   for anything calling `https://api.scrapingdog.com/scrape` directly without
   going through `scraper.js`, `url-discovery.js`, or `reddit-api.js`).
2. If attribution now matches (gap closed) and burn is still high, the options
   are the ones the card already names — **upgrade the SD plan, or reduce
   scraping frequency** on the top callers `check-provider-spend.js` reports.
   Cutting frequency is a product/cost tradeoff (which crons to slow down) —
   that's an owner call, not something to guess at from this doc.
3. A `daysUntilExhaustion` that sits within a day or two of `daysToRenewal`
   (this card's exact shape: 18d burn projection vs 18d to renewal) is
   inherently marginal — small day-to-day variance will flip it between
   `warn` and `error` even with no underlying change. Don't chase noise here;
   only re-open if the gap widens materially or the balance drops under 15%.

# Opera Outlet Listing Verification — 2026-05-17

Sprint 1 of the Opera Auto-Discovery V2 plan. Confirms each outlet's listing page actually renders opera reviews server-side before any per-outlet endpoint code is written.

Method:
1. Plain `curl` with desktop Chrome UA — tests anonymous access (proxies what a CI runner without cookies sees).
2. If `curl` fails, retry via `scripts/lib/scraper.js#fetchPage` (cookies-plain → Bright Data → ScrapingBee fallback chain).
3. Outcome bucketed: **OK** = listing renders with article URLs; **paywall-blocked** = 403 with security challenge; **wrong URL** = 404 on assumed path (corrected); **blocked at all tiers** = no path works → needs alternate discovery strategy.

## Results

| Outlet | Listing URL | Tier needed | Status | Article URLs in HTML |
|---|---|---|---|---|
| Vulture / Davidson archive | `https://www.vulture.com/author/justin-davidson/` | plain | **OK** | 33 |
| New Yorker / Alex Ross contributor | `https://www.newyorker.com/contributors/alex-ross` | plain | **OK** | 0 directly (lazy-loaded; titles in HTML) |
| The Washington Post / Kennicott | `https://www.washingtonpost.com/people/philip-kennicott/` | cookies-plain | **OK** | 55 |
| Financial Times / classical-music | `https://www.ft.com/classical-music` | — | **blocked at all tiers** | 0 |
| The Times (London) / classical-opera | `https://www.thetimes.com/topic/opera` | plain | **OK** | many (615KB page) |
| The Arts Desk / opera | `https://theartsdesk.com/opera` | plain | **OK** | many |
| New York Stage Review / search | `https://nystagereview.com/?s=opera` | plain | **OK** | many |
| BroadwayWorld bwwopera | `https://www.broadwayworld.com/bwwopera/reviews` | plain | **OK** | many |
| TheaterMania | `https://www.theatermania.com/` | plain | **OK** (no dedicated opera section; SERP-only) | n/a |
| Observer / arts | `https://observer.com/category/arts/` | plain | **OK** (broad arts page; SERP-only filter) | n/a |

## URL corrections vs the plan

- `times-uk` plan URL was `thetimes.com/topic/classical-opera`. Actual working URL: `https://www.thetimes.com/topic/opera` (the `/classical-opera` path 404s on its own but redirects from `/culture/classical-opera`).
- `nystagereview` has no `/category/opera/` or `/category/classical-music/` — use the search endpoint `/?s=opera` instead.

## Blocked outlet: Financial Times

`ft.com/classical-music` returns:
- Plain curl: 403 Security Verification (DataDome challenge)
- cookies-plain via undici: 403 (subscriber cookies aren't enough for the DataDome layer on listing pages — they were sufficient for individual article pages earlier in the session)
- Bright Data: returns 1.3KB "Application Error" page (BD's request reached FT but the server returned an error response)

**Implication for Sprint 2 FT endpoint (S2-T4):** listing-page walking is not viable. FT URLs must be discovered via:
1. **Playbill roundup** — Sprint 3 step `playbill-roundup-discover.js` already extracts FT URLs from Playbill's per-show roundups (the Tristan roundup yielded `ft.com/content/4501580f-…` this session).
2. **SERP** — Google site-search for `{show title} site:ft.com`. Costs SB credits per query but cheap at one query per opera show.
3. **Aggregator pages** — slippedisc.com and andymanshel.nyc reblog FT/WSJ reviews; both are scrape-friendly.

Recommend S2-T4 be replaced with: "FT discovery via SERP + Playbill roundup only — no FT listing endpoint." This is consistent with what already works for FT review URLs we have on file (Frida and Tristan FT URLs in `data/review-texts/` were discovered via SERP/Playbill, not FT listing pages).

## Implication for Sprint 2 outlet list

- **Add endpoints (listing-page walkers):** vulture, newyorker, washpost, times-uk, artsdesk, nystagereview (search), bwwopera
- **SERP-only (no listing endpoint):** financialtimes, theatermania, observer
- **NYT:** already in the existing SERP path via multi-critic-serp; no new endpoint needed
- **WSJ:** deferred per plan (subscriber cookies needed)

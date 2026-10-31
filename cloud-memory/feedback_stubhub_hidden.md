---
name: StubHub hidden from rendering
description: StubHub buttons disabled 2026-04-11 due to stale performer IDs + 0% CR; will re-enable when Partnerize API access lands
type: feedback
originSessionId: ba2676a0-1232-4de7-b090-d7af31195aa2
archived: true
---
**StubHub is hidden from all ticket-link rendering as of 2026-04-11.** The `HIDDEN_PLATFORMS` Set in `src/lib/ticket-utils.ts` contains `'StubHub'` and `sortTicketLinks()` filters it out. `src/lib/seo.ts` also uses `isPlatformHidden()` to exclude it from JSON-LD `Offer` blocks.

**Why:**
- 56 StubHub clicks over 180 days (via Partnerize), **0 conversions ever**
- Root cause: StubHub reuses performer IDs when shows close → 11/67 of our stored URLs pointed to wrong shows or 404s. Hamilton, Lion King, Book of Mormon were all hard 404s. Joe Turner's Come and Gone redirected to "Mackerelle", Rocky Horror to "Colorful Future", etc.
- Short-term fix (commit ab8db5d in private data repo): replaced broken URLs with `https://www.stubhub.com/search?q=<title>` fallbacks. Doesn't 404, but adds an extra-click search results page → very unlikely to convert.
- Math on hiding: 36 clicks/week × TodayTix 3.7% CR × $16.73 avg commission ≈ **$22/week (~$87/month)** of recoverable revenue if even half the clicks redirect to TodayTix.
- Scraping StubHub to get fresh deep-link IDs is brittle (they block curl, block bots, URL format already changed once from /performer/ to /grouping/). Not worth the maintenance burden.

**How to apply:**
- **Re-enable when** Partnerize/StubHub approves API access for direct deep-link lookups. One-line change: remove `'StubHub'` from the `HIDDEN_PLATFORMS` Set in `src/lib/ticket-utils.ts`.
- Until then, treat StubHub as off. Don't spend time scraping/validating StubHub URLs unless StubHub traffic is strategically important again.
- The `scripts/validate-stubhub-urls.js` validator and the `weekly-stubhub-validate.yml` workflow still run and still email a weekly report — this protects the re-enable path so that when API access lands we know which URLs are fresh.
- `AFFILIATE_CONFIG.StubHub.enabled` stays `true` on purpose — any direct caller that bypasses `sortTicketLinks()` still gets Partnerize wrapping if they construct a StubHub link manually. The filter is the primary off switch, the config flag is the secondary one.

**Don't:**
- Don't remove the StubHub entries from `shows.json` ticketLinks — the URLs stay in data so re-enabling is trivial.
- Don't treat weekly "All 67 URLs OK" emails from the StubHub validator as a signal that StubHub is worth showing again. That only means the search URLs still 200. Conversion data on the affiliate dashboard is the real signal.
- Don't re-add `'StubHub'` to the A/B test `ticket-primary-platform` feature flag — the current `stubhub` variant silently no-ops because the filter strips it before the override runs.

---
name: NYT Critics Pick authoritative source
description: "Spotlight page only, not regex (~10% FP). Use data/nyt-critics-picks.json."
type: feedback
originSessionId: 96154346-df8a-4247-9303-ff1a49c01f18
archived: true
---
Never trust the `designation: 'Critics_Pick'` field on individual reviews in reviews.json for public-facing features. The field was set by `check-nyt-critics-pick.js` which regexes the full HTML page and catches sidebar/widget/related-article text — ~10% false positive rate (King Kong score 20 was flagged as a pick).

**Why:** The regex approach (`/criticsPick/i`, `/critics-pick/i` on full page HTML) matches the Critic's Pick label anywhere on the page, including navigation, "More Critics' Picks" widgets, and related article cards. This is unfixable without DOM-aware parsing.

**How to apply:** Use `data/nyt-critics-picks.json` as the source of truth. This file contains URLs scraped from the authoritative NYT spotlight page (`nytimes.com/spotlight/theater-critics-picks`). `getNYTCriticsPickShowIds()` in `data-core.ts` cross-references these URLs against our review URLs by exact match. Refresh with `node scripts/refresh-nyt-critics-picks.js`. The spotlight page covers ~100 most recent picks (back to ~April 2024). Older picks are not on the page and should not be assumed to be accurate.

Discovered 2026-04-15 when the homepage shelf shipped with false positives and had to be reverted, rebuilt with the spotlight source, and redeployed.

**2026-04-16 update:** The same regex trap also lived inside `rebuild-all-reviews.js` itself — it auto-detected Critic's Pick by matching `/criticsPick/i` and `/critic[''\u2019]?s[''\u2019]?\s*pick/i` against archived HTML, then **persisted** the designation back to the source review file. NYT's page HTML contains `criticsPick` as a CSS class on every review (site chrome), so the rebuild created new FPs every run — confirmed via user-reported Fear of 13 / Helen Shaw case. Fixed by having rebuild read `data/nyt-critics-picks.json` and assign designation solely from that URL set; also clears stale FP designations on subsequent rebuilds. `scripts/check-nyt-critics-pick.js` was converted to a deprecation stub that exits 1. Commits: 4e9e733d3a + a6dcc3dcd + 4f63fc2.

**Final state (2026-04-16):** Rebuild unions two authoritative sources: (1) `data/nyt-critics-picks.json` spotlight scrape, and (2) `data/designations.json → nyt_critics_pick` entries where `designation === 'Critics_Pick'` (narrow filter; some entries have `designation: null` with notes like "Critic's Notebook piece" or "predates modern Critics' Pick system" and MUST be excluded). Designations.json union matches by specific `critic` field with last-name fallback, and skips files flagged `wrongProduction` — otherwise directory-glob picks up misfiled old reviews (e.g. mamma-mia-2025's directory contained the 2001 Brantley URL, causing mamma-mia-2001's file to be wrongly designated).

**URL matching must be canonical.** Both rebuild and `getNYTCriticsPickShowIds()` in `data-core.ts` now strip query strings (`?searchResultPosition=1`, `?ref=theater`) and fragments before comparing. Without this, mother-play-2024 and eureka-day-2024 were missing badges despite having exact-path matches in the spotlight list.

**Shelf === Badge invariant.** `getNYTCriticsPickShowIds()` unions spotlight-URL-match AND `designation === 'Critics_Pick'` so the homepage shelf and the per-review badge always agree. Final shipped commit: cf2ee340bf.

**Partial-text and content-quality guards can block legit picks.** english-2025 (NYT paywall tail appended to scrape → `rejectionReason: garbage_text`), yellow-face-2024, gypsy-2024 were all excluded from reviews.json despite having valid Critics' Pick URLs. Fix path: re-fetch with `SHOW_FILTER=X REVIEW_FILTER=Y node scripts/collect-review-texts.js` to get fresh text with cookies, then clear stale flags (`rejectionReason: null`, `crossOutletDuplicate: false`, `humanReviewedWrongProduction: true`). If scrape returns paywall boilerplate appended to real text, strip the boilerplate from fullText directly.

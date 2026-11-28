---
name: Curated historical 4-review threshold for Broadway
description: How to display a composite score on a Broadway historical show with 4 reviews instead of the standard 5
type: feedback
originSessionId: efa2a933-8f2d-45b1-97e1-a6a40e255001
---
# Curated historical 4-review threshold

Standard Broadway threshold for displaying a composite score is **5 reviews** (`MIN_REVIEWS_FOR_SCORE` in `src/config/score-buckets.ts`).

For older shows where the recoverable critic-coverage universe is genuinely constrained (outlets purged, paywalls hardened, only ~4 outlets findable), there's a curated exception:

- Add the show ID to `data/curated-historical-shows.json`
- The on-page score badge gates on `hasEnoughReviews(reviewCount, category, tier1And2Count, isCuratedHistorical=true)` which uses `MIN_REVIEWS_FOR_SCORE_CURATED_HISTORICAL = 4`
- **The exception requires ≥1 T1/T2 review** — pure-blog T3-only shows still need 5 (preserves quality bar)
- Only applies to Broadway (`category === 'broadway'` or null); West End / Off-Broadway / Off-West-End keep their own thresholds

## When to apply

Use this for shows where:
- Coverage is realistically capped at 4 reviews (older shows, archives purged, paywalls broken)
- ≥1 of the 4 reviews is from a T1 or T2 outlet (NYT, Variety, Newsday, Talkin' Broadway, etc.)
- An audit confirms it's not "we missed reviews" but "the universe is what it is"

**Don't use** for currently-running shows under-reviewed; those should wait for more reviews to land naturally.

## Two separate gates

- **`shouldHideReviews(show)`** in `src/config/scoring.ts` — gates whether reviews are SHOWN AT ALL (pre-cutoff historicals are hidden by default; curated list overrides). For 2005+ shows this is no-op since cutoff is older.
- **`hasEnoughReviews(...)`** in `src/config/score-buckets.ts` — gates whether the score BADGE displays (TBD vs actual). Curated-historical override goes here.

The seo.ts microdata (`AggregateRating` schema.org) uses its own `getMarketMinReviews()` (Broadway=5) which is still strict — so curated 4-review shows display the badge but may not get the SEO rating microdata. Acceptable trade-off.

## Originated 2026-04-28

Used to unlock 17 Broadway shows from 2005-2010 that all had 4 reviews + ≥1 T1/T2:
joe-turners-come-and-gone-2009, the-odd-couple-2005, the-light-in-the-piazza-2005, spring-awakening-2006, the-little-dog-laughed-2006, butley-2006, faith-healer-2006, grease-2007, deuce-2007, journeys-end-2007, a-catered-affair-2008, come-back-little-sheba-2008, bye-bye-birdie-2009, hamlet-2009, superior-donuts-2009, 9-to-5-2009, mrs-warrens-profession-2010.

Commits: 047fc46b0b (code), 588ffbd6c0 (data).

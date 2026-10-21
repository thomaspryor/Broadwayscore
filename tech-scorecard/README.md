# Tech Scorecard (proof of concept)

Every gadget. Every review. One score. A light-theme port of the Broadway Scorecard
layout and scoring method to tech reviews, starting with three phones:
iPhone Duo, iPhone 18 Pro and Samsung Galaxy Z Fold 8.

## How it maps to Broadway Scorecard

| Broadway Scorecard | Tech Scorecard |
|---|---|
| `data/shows.json` | `data/products.json` |
| `data/reviews.json` | `data/reviews.json` (outlet, critic, url, date, published rating, 0-100 score, excerpt) |
| outlet tiers T1-T4 (1.0 / 0.75 / 0.4 / 0.2) | same weights, tech outlets (`data/outlets.json`) |
| Critical Gold 83+, Recommended 75+, Worth Seeing 65+, Mixed 55+ | same thresholds (`src/config/score-buckets.ts`) |
| `src/components/show-cards/` (ScoreBadge, ShowListCard, MiniShowCard, ScoreBreakdownBar, OutletTierChip) | `src/components/product-cards/` |
| `/show/[slug]` | `/product/[slug]` |

Scores: a published rating converts straight to 100 points (4.5/5 = 90). Unrated
reviews are scored from the verdict text and labeled "Unrated, scored from text".
Every review links to the original article.

## Commands

```
npm install
npm run validate        # data checks (rating conversion, https urls, excerpt length, duplicates)
npm run build           # static export to out/
npm run preview:build   # one self-contained preview/index.html with hash navigation
```

Review data was gathered on 2026-10-21 from the outlets' own review pages.

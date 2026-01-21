# Broadway Metascore Project Context

## Project Overview
A website that aggregates Broadway show reviews and calculates composite "metascores" similar to Metacritic, but for Broadway shows.

**Live Site:** https://thomaspryor.github.io/Broadwayscore/
**Tech Stack:** Next.js 14, TypeScript, Tailwind CSS, static export to GitHub Pages

## Scoring Methodology (v2.0.0)

### Component Weights
- Critic Score: 50%
- Audience Score: 35%
- Buzz Score: 15%

### Critic Score Calculation
- **Tier 1 outlets** (NYT, Vulture, Variety, etc.): weight 1.0
- **Tier 2 outlets** (TheaterMania, NY Post, etc.): weight 0.85
- **Tier 3 outlets** (blogs, smaller sites): weight 0.70

Each review has an `assignedScore` (0-100). Designation bumps are added:
- Critics_Pick: +3
- Critics_Choice: +2
- Recommended: +2

Two scores are calculated:
- **Simple Average** (MetaScore_v1): mean of all reviewMetaScores
- **Weighted Average**: tier-weighted mean

### Data Structure
```
data/
  shows.json      # Show metadata (id, title, venue, dates, etc.)
  reviews.json    # Critic reviews with assignedScore, bucket, thumb, designation
  audience.json   # Audience scores from platforms (ShowScore, Google, etc.)
  buzz.json       # Reddit/social buzz threads
```

### Key Files
- `src/config/scoring.ts` - All scoring rules, tier weights, outlet mappings
- `src/lib/engine.ts` - Scoring calculation engine
- `src/lib/data.ts` - Data loading layer
- `src/app/show/[slug]/page.tsx` - Individual show pages
- `src/app/page.tsx` - Homepage with show listings

## Current State
- Two Strangers has complete data (16 reviews) as proof of concept
- Other shows have partial/placeholder data
- Scoring engine is fully implemented and config-driven
- **Critic Reviews Agent implemented** (see below)

## Critic Reviews Agent

A data agent for fetching, normalizing, and managing critic reviews.

### Quick Commands
```bash
npm run reviews:report              # Data coverage report
npm run reviews:fetch -- --show <id> # Fetch for one show
npm run reviews:all                 # Fetch for all shows
npm run reviews:fetch -- --manual <file> # Import manual entries
```

### Key Features
- Multi-source fetching (BroadwayWorld, DidTheyLikeIt, Show-Score)
- Rating normalization (stars, letters, buckets → 0-100)
- Deduplication and merging
- Idempotent (running twice gives same results)
- Manual entry support for reviews that can't be fetched

### Agent Files
```
scripts/critic-reviews-agent/
├── index.ts        # CLI entry point
├── config.ts       # Outlets, tiers, normalization rules
├── normalizer.ts   # Rating conversion logic
├── deduper.ts      # Deduplication & merging
├── fetchers.ts     # Web scraping utilities
└── README.md       # Full documentation
```

### Manual Data Entry
See `data/manual-reviews-template.json` for the entry format.

## Next Steps / Parallel Workstreams

### 1. Data Population (high priority)
Use the critic reviews agent to populate data:
- Run agent for all shows to attempt auto-fetch
- Manually add reviews that can't be scraped
- Verify data quality with `npm run reviews:report`

### 2. UI Polish
- Mobile responsiveness improvements
- Score breakdown visualizations
- Review list improvements

### 3. Additional Features
- Search/filter shows
- Comparison views
- Historical tracking

## Commands
```bash
# Development
npm run dev      # Development server
npm run build    # Production build
npm run lint     # Lint check

# Data Agent
npm run reviews:report   # Data coverage report
npm run reviews:all      # Fetch reviews for all shows
npm run reviews:fetch -- --show <id>     # Fetch for specific show
npm run reviews:fetch -- --manual <file> # Import manual entries
npm run reviews:fetch -- --dry-run       # Preview without writing
```

## Branch Strategy
- `main` - Production, deploys to GitHub Pages
- `claude/...` - Feature branches for parallel development

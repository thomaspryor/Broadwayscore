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

## Next Steps / Parallel Workstreams

### 1. Data Agent (high priority)
Build automation to fetch/gather review data for all shows:
- Scrape critic reviews from aggregators (BroadwayWorld, DidTheyLikeIt, Show-Score)
- Parse and normalize ratings to assignedScores
- Identify outlet tier from source

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
npm run dev      # Development server
npm run build    # Production build
npm run lint     # Lint check
```

## Branch Strategy
- `main` - Production, deploys to GitHub Pages
- `claude/...` - Feature branches for parallel development

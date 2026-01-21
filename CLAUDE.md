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
npm run reviews:status              # See which shows need reviews
npm run reviews:validate <show-id>  # Validate a show's reviews
npm run reviews:report              # Data coverage report
```

### Collecting Reviews for a Show

When asked to "collect reviews for [Show Name]", follow this workflow:

**Phase 1: Discovery** - Search all 3 aggregators:
1. DTLI (didtheylikeit.com) - Get review count & positive/mixed/negative breakdown
2. Show-Score - Get list of outlets (ignore the % score, that's audience)
3. BroadwayWorld Review Roundup - Get additional outlets

**Phase 2: Rating Collection** - For each outlet found:
- Search for the actual star/letter rating (don't guess from snippets!)
- Convert to 0-100: 5★=100, 4★=80, 3★=60, 2★=40, 1★=20
- Assign bucket: 85+=Rave, 70-84=Positive, 50-69=Mixed, <50=Pan

**Phase 3: Report** - Generate a report showing:
- All reviews found with scores
- Cross-check against DTLI count
- Calculated metrics (average, % positive)
- Present for human review BEFORE committing

**Phase 4: Write** - After human approval:
- Add to data/reviews.json (and shows.json if new show)
- Run validation: `npm run reviews:validate <show-id>`
- Commit with descriptive message

See `scripts/critic-reviews-agent/collect-reviews.md` for full workflow details.

### Outlet Tiers
- **Tier 1** (1.0): NYT, Vulture, Variety, Time Out, Hollywood Reporter, Washington Post, AP
- **Tier 2** (0.85): NY Post, TheaterMania, EW, Chicago Tribune, NYTG, NYSR, The Wrap, Observer, Daily Beast
- **Tier 3** (0.70): Theatrely, Culture Sauce, One Minute Critic, Cititour, blogs

### Agent Files
```
scripts/critic-reviews-agent/
├── collect-reviews.md  # Full collection workflow
├── status.ts          # Shows needing reviews
├── validate.ts        # Validation script
├── config.ts          # Outlets, tiers, normalization rules
└── README.md          # Documentation
```

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

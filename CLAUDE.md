# Broadway Metascore Project Context

## Project Overview
A website that aggregates Broadway show reviews and calculates composite "metascores" similar to Metacritic, but for Broadway shows.

**Live Sites:**
- **Production (Vercel):** https://broadwayscore-ayv17ggvd-thomaspryors-projects.vercel.app
- **GitHub Pages:** https://thomaspryor.github.io/Broadwayscore/

**Tech Stack:** Next.js 14, TypeScript, Tailwind CSS, static export

## Current State (January 2026)

### What's Working
- **22 Broadway shows** with full metadata (synopsis, cast, creative team, venues, etc.)
- **Critics-only scoring** (V1 simplified approach - no audience/buzz yet)
- **Two Strangers** has complete review data (16 critic reviews) as proof of concept
- **TodayTix-inspired UI** with card layout, hero images, show details pages
- **External CDN images** from Contentful (TodayTix's CDN)

### Shows Database
- 17 currently open shows (including new additions: Bug, Oh Mary!, Operation Mincemeat, etc.)
- 5 closed shows tracked (Stereophonic, Cabaret, Water for Elephants, etc.)
- Full metadata: synopsis, cast, creative team, tags, age recommendations, theater addresses

## Scoring Methodology (V1 - Critics Only)

### Current Implementation
- **Metascore = Critic Score** (simplified for V1)
- Tier-weighted average of critic reviews

### Critic Score Calculation
- **Tier 1 outlets** (NYT, Vulture, Variety, etc.): weight 1.0
- **Tier 2 outlets** (TheaterMania, NY Post, etc.): weight 0.85
- **Tier 3 outlets** (blogs, smaller sites): weight 0.70

Each review has:
- `assignedScore` (0-100) - normalized score
- `originalRating` - original format (e.g., "B+", "4 stars", "Rave")
- `designation` bumps: Critics_Pick +3, Critics_Choice +2, Recommended +2

### Future (V2)
- Audience Score: 35% weight
- Buzz Score: 15% weight
- Confidence badges based on review count

## Data Structure

```
data/
  shows.json      # Show metadata with full details
  reviews.json    # Critic reviews with scores and original ratings
  audience.json   # (Future) Audience scores
  buzz.json       # (Future) Social buzz data

scripts/
  fetch-images.js       # Fetches show images from TodayTix CDN
  update-show-status.js # Auto-updates show statuses (closing dates)
```

### Show Schema (shows.json)
```typescript
{
  id, title, slug, venue, openingDate, closingDate, status, type, runtime, intermissions,
  images: { hero, thumbnail, poster },
  synopsis, ageRecommendation, tags,
  ticketLinks: [{ platform, url, priceFrom }],
  cast: [{ name, role }],
  creativeTeam: [{ name, role }],
  officialUrl, trailerUrl, theaterAddress
}
```

## Key Files
- `src/lib/engine.ts` - Scoring engine + TypeScript interfaces
- `src/lib/data.ts` - Data loading layer
- `src/app/page.tsx` - Homepage with show grid
- `src/app/show/[slug]/page.tsx` - Individual show pages
- `src/config/scoring.ts` - Scoring rules, tier weights, outlet mappings
- `scripts/fetch-images.js` - Image URL fetcher (run locally)

## Parallel Workstreams

### 1. Data Agent (in progress)
Building automation to fetch/gather review data for all shows:
- Scrape critic reviews from aggregators
- Parse and normalize ratings to assignedScores
- Identify outlet tier from source

### 2. UI Polish (in progress)
- Mobile responsiveness
- Score breakdown visualizations
- Review list improvements
- Show filtering/search

### 3. Image Fetching
Run locally to get CDN URLs for all shows:
```bash
node scripts/fetch-images.js
```
Outputs JSON with hero/thumbnail/poster URLs for shows.json

### 4. Data Freshness
Run locally to auto-update show statuses:
```bash
node scripts/update-show-status.js
```
- Checks TodayTix for closing date changes
- Auto-marks shows as closed when past closing date
- Updates shows.json with changes found

### 5. SEO (Implemented)
- JSON-LD structured data with ticket offers, cast, ratings
- Dynamic meta tags per show (title with score, Twitter cards)
- Sitemap.xml auto-generated with show prioritization
- Robots.txt configured
- Configurable BASE_URL via `NEXT_PUBLIC_SITE_URL` env var

### 6. Future Features
- Audience scores integration
- Comparison views
- Historical tracking
- Custom domain setup

## Commands
```bash
npm run dev      # Development server (localhost:3000)
npm run build    # Production build
npm run lint     # Lint check
```

## Deployment
- **Vercel**: Auto-deploys from feature branches
- **GitHub Pages**: Deploys from gh-pages branch

## Branch Strategy
- Feature branches: `claude/...`
- Vercel auto-deploys preview URLs for each branch
- Merge to trigger production deployment

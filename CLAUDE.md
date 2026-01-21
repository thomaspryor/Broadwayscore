# Broadway Metascore Project Context

## User Preferences (IMPORTANT)
- **NEVER suggest manual steps** if automation is possible. Always write scripts, create GitHub Actions, or implement code solutions instead.
- If a task requires network access Claude can't perform, write a script the user can run locally with a single command.
- When scripts fail for some items, fix the script or add retry logic - don't ask the user to manually fetch data.
- Automate everything: data fetching, image URLs, status updates, deployments.
- The user is not technical. They are often on their phone, away from a computer. Do NOT ask them to run things in terminal.

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
  shows.json            # Show metadata with full details
  reviews.json          # Critic reviews with scores and original ratings
  new-shows-pending.json # Auto-generated: new shows awaiting review data
  audience.json         # (Future) Audience scores
  buzz.json             # (Future) Social buzz data

scripts/
  fetch-images.js       # Fetches show images from TodayTix CDN
  update-show-status.js # Auto-updates show statuses (closing dates)
  discover-new-shows.js # Discovers new Broadway shows from TodayTix
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

## Completed Features

### UI & Design
- TodayTix-inspired card layout with hero images
- Mobile-responsive with bottom navigation
- Show filtering by status (Open/Closed)
- Search functionality
- Score badges with color coding
- Methodology page explaining scoring

### Data & Automation
- 22+ Broadway shows with full metadata
- Review data collection scripts (in `scripts/critic-reviews-agent/`)
- Image fetching from TodayTix CDN
- Weekly automated status updates via GitHub Actions
- New show discovery automation

### 4. Data Freshness & Discovery (Automated)
**GitHub Action:** `.github/workflows/update-show-status.yml`
- Runs automatically every Monday at 6 AM UTC
- Can be triggered manually via GitHub Actions UI

**What it does:**
1. **Status Updates** - Checks TodayTix for closing dates, auto-marks shows as closed
2. **New Show Discovery** - Scans TodayTix for new Broadway shows not in our database
3. **Auto-add Shows** - Adds new shows to shows.json with basic metadata
4. **Create Issues** - Opens GitHub issue for new shows needing review data
5. **Trigger Data Agent** - Attempts to trigger `gather-reviews.yml` workflow

**GitHub Action:** `.github/workflows/gather-reviews.yml`
- Triggered automatically when new shows are discovered
- Can be triggered manually with comma-separated show slugs
- Placeholder for review data gathering logic (integrate with data agent)

Manual runs:
```bash
node scripts/update-show-status.js    # Check status changes
node scripts/discover-new-shows.js    # Find new shows
```

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

## Deployment (Vercel)

**How it works:** Claude pushes code → Vercel auto-deploys. No manual steps needed.

**Production URL:** https://broadwaymetascore.com (once custom domain configured)

### One-time Vercel Setup
1. Vercel Dashboard → Settings → Git → Production Branch: `claude/broadway-metascore-site-8jjx7`
2. Vercel Dashboard → Settings → Environment Variables:
   - `NEXT_PUBLIC_SITE_URL` = `https://broadwaymetascore.com`
3. Vercel Dashboard → Settings → Domains → Add `broadwaymetascore.com`

### That's it!
Every push from Claude auto-deploys to production. No GitHub PRs or local terminal needed.

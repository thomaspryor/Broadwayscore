# Broadway Scorecard Project Context

## ⚠️ CRITICAL RULES - READ FIRST ⚠️

### 1. NEVER Ask User to Run Local Commands
The user is **non-technical and often on their phone**. They cannot run terminal commands.

❌ **NEVER say any of these:**
- "Run this locally: `npm install`"
- "Execute this in your terminal"
- "Run `node scripts/...`"
- "You can test with `npm run dev`"

✅ **Instead:**
- Make code changes and push to Git
- Create/update GitHub Actions for automation
- If something truly requires local execution, create a GitHub Action to do it

### 2. Vercel Deployment - CRITICAL
**Production site: Vercel** (auto-deploys when code is pushed)

| Platform | Status | URL |
|----------|--------|-----|
| **Vercel** | ✅ PRIMARY | https://broadwayscore.vercel.app |
| GitHub Pages | ⚠️ Secondary/Legacy | https://thomaspryor.github.io/Broadwayscore/ |

**⚠️ IMPORTANT: Vercel deploys from the PRODUCTION BRANCH, not just any branch!**

**Production branch:** `claude/broadway-metascore-site-8jjx7`

**Deployment workflow:**
```
1. Claude makes changes on assigned branch
2. Claude merges changes INTO the production branch (not the other way around)
3. Claude pushes the production branch
4. Vercel auto-deploys from production branch → Done
```

**NEVER:**
- ❌ Ask user to "create a PR" or "merge via GitHub"
- ❌ Talk about GitHub PRs, merges, or GitHub UI
- ❌ Push only to a feature branch and expect Vercel to deploy it

**ALWAYS:**
- ✅ Merge your changes into `claude/broadway-metascore-site-8jjx7`
- ✅ Push directly to production branch if you have permission
- ✅ If permission denied, resolve conflicts on your branch first, then ask user to merge ONE time

### 3. Automate Everything
- ❌ Don't ask user to manually fetch data
- ❌ Don't suggest "you could manually update..."
- ✅ Write scripts that run via GitHub Actions
- ✅ Create automation for any recurring task

### 4. NEVER Guess or Fake Data
- ❌ **NEVER** give approximate ranges like "~7-9 reviews" - there's always a specific number
- ❌ **NEVER** claim to have verified something you couldn't actually access
- ❌ **NEVER** make up numbers when a source is blocked/unavailable
- ✅ If you can't access a source, say "I cannot access [source] - getting 403 error"
- ✅ If you don't know, say "I don't know" - don't guess
- ✅ Always fetch and verify actual data before reporting numbers

---

## Project Overview

A website aggregating Broadway show reviews into composite "metascores" (like Metacritic for Broadway).

**Tech Stack:** Next.js 14, TypeScript, Tailwind CSS, static export

## Current State (January 2026)

### What's Working
- **22 Broadway shows** with full metadata (synopsis, cast, creative team, venues)
- **Critics-only scoring** (V1 approach)
- **Two Strangers** has complete review data (16 critic reviews) as proof of concept
- **TodayTix-inspired UI** with card layout, hero images, show detail pages
- **External CDN images** from Contentful (TodayTix's CDN)

### Shows Database
- 17 currently open shows
- 5 closed shows tracked
- Full metadata: synopsis, cast, creative team, tags, age recommendations, theater addresses

## Scoring Methodology (V1 - Critics Only)

### Current Implementation
- **Metascore = Critic Score** (simplified for V1)
- Tier-weighted average of critic reviews

### Critic Score Calculation
- **Tier 1 outlets** (NYT, Vulture, Variety): weight 1.0
- **Tier 2 outlets** (TheaterMania, NY Post): weight 0.85
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
  shows.json              # Show metadata with full details
  reviews.json            # Critic reviews with scores and original ratings
  new-shows-pending.json  # Auto-generated: new shows awaiting review data
  audience.json           # (Future) Audience scores
  buzz.json               # (Future) Social buzz data
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

## Automation (GitHub Actions)

All automation runs via GitHub Actions - no local commands needed.

### `.github/workflows/update-show-status.yml`
- **Runs:** Every Monday at 6 AM UTC (or manually via GitHub UI)
- **Does:** Updates show statuses, discovers new shows, auto-adds to database

### `.github/workflows/gather-reviews.yml`
- **Runs:** When new shows discovered (or manually triggered)
- **Does:** Gathers review data for shows

### `.github/workflows/fetch-images.yml`
- **Runs:** When triggered
- **Does:** Fetches show images from TodayTix CDN

## Deployment

### How It Works (Vercel)
1. Claude makes changes and pushes to `claude/broadway-metascore-site-8jjx7`
2. Vercel detects the push and auto-builds
3. Site is live within ~1 minute

**That's it.** No PRs, no approvals, no manual deployment steps.

### Vercel Configuration (already set up)
- Production Branch: `claude/broadway-metascore-site-8jjx7`
- Auto-deploy: Enabled
- Build Command: `npm run build`

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
- Automated image fetching via GitHub Action
- Weekly automated status updates
- New show discovery automation

### MCP Setup for Review Aggregators

The review aggregator sites (DTLI, Show-Score, BroadwayWorld) block standard web requests. To access them, we use the ScrapingBee MCP server.

**Setup (one-time):**
1. Get free API key (1,000 credits): https://www.scrapingbee.com/
2. Edit `.mcp.json` in the project root - replace `YOUR_API_KEY_HERE` with your actual key
3. **Start a NEW Claude Code session** (MCP servers only load at startup, not hot-reloaded)

**Usage:**
Once configured, use the `scrapingbee_get_page_html` tool to fetch aggregator pages:
```
- didtheylikeit.com/shows/[show-name]/ → Get review count breakdown (thumbs up/flat/down)
- show-score.com/broadway-shows/[show] → Get full critic review list with outlets
- broadwayworld.com review roundups → Get additional outlets
```

**Important:** Always cross-check our review count against these 3 aggregators before finalizing a show's reviews.

### SEO
- JSON-LD structured data with ticket offers, cast, ratings
- Dynamic meta tags per show
- Sitemap.xml auto-generated
- Robots.txt configured

## Future Features
- Audience scores integration
- Comparison views
- Historical tracking
- Custom domain setup (broadwayscorecard.com)

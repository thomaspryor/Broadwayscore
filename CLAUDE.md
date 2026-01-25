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

### 2. Git Branches - CRITICAL
**ALWAYS work on the `main` branch.** Do NOT create new branches.

```
✅ CORRECT: Make changes directly on main, push to main
❌ WRONG: Create a new branch like claude/feature-xyz
```

**Why:** The user works with multiple Claude sessions. Creating separate branches causes divergence and confusion. Everything should stay on `main`.

**At the START of every session:**
```
git checkout main
git pull origin main
```

**At the END of every session (if you made changes):**
```
git add -A
git commit -m "description"
git push origin main
```

### 3. Vercel Deployment
**Production site: Vercel** (auto-deploys when `main` is pushed)

| Platform | Status | URL |
|----------|--------|-----|
| **Vercel** | ✅ PRIMARY | https://broadwayscore.vercel.app |
| GitHub Pages | ⚠️ Secondary/Legacy | https://thomaspryor.github.io/Broadwayscore/ |

**Production branch:** `main`

**Deployment workflow:**
```
1. Claude makes changes on main
2. Claude pushes to main
3. Vercel auto-deploys → Done
```

**NEVER:**
- ❌ Create new branches (use main)
- ❌ Ask user to "create a PR" or "merge via GitHub"
- ❌ Push to a feature branch and expect Vercel to deploy it

**ALWAYS:**
- ✅ Work directly on `main`
- ✅ Push to `main` when done
- ✅ If you see you're on a different branch, switch to main first

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

A website aggregating Broadway show reviews into composite scores (independent Broadway-focused review aggregator).

**Tech Stack:** Next.js 14, TypeScript, Tailwind CSS, static export

## Current State (January 2026)

### What's Working
- **40 Broadway shows** with full metadata (synopsis, cast, creative team, venues)
- **1,150+ critic reviews** across all shows in `data/review-texts/`
- **Critics-only scoring** (V1 approach)
- **TodayTix-inspired UI** with card layout, hero images, show detail pages
- **External CDN images** from Contentful (TodayTix's CDN)
- **URL-based filtering** with shareable filter state (?status=now_playing&sort=score_desc)

### Shows Database
- 27 currently open shows
- 13 closed shows tracked
- **Upcoming shows** (status: "previews") with opening dates and preview start dates
- Full metadata: synopsis, cast, creative team, tags, age recommendations, theater addresses
- Ticket links for all open shows (TodayTix + Telecharge/Ticketmaster)

## Scoring Methodology (V1 - Critics Only)

### Current Implementation
- **Composite Score = Critic Score** (simplified for V1)
- Tier-weighted average of critic reviews

### Critic Score Calculation
- **Tier 1 outlets** (NYT, Vulture, Variety): weight 1.0
- **Tier 2 outlets** (TheaterMania, NY Post): weight 0.70
- **Tier 3 outlets** (blogs, smaller sites): weight 0.40

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
  shows.json                      # Show metadata with full details
  reviews.json                    # Critic reviews with scores and original ratings
  grosses.json                    # Box office data (weekly + all-time stats)
  new-shows-pending.json          # Auto-generated: new shows awaiting review data
  historical-shows-pending.json   # Auto-generated: historical shows awaiting metadata
  show-score.json                 # Show Score aggregator data (audience scores + critic reviews)
  show-score-urls.json            # URL mapping for Show Score pages
  audience.json                   # (Future) Audience scores
  buzz.json                       # (Future) Social buzz data
  review-texts/           # Individual review JSON files by show
    {show-id}/            # e.g., hamilton-2015/, wicked-2003/
      {outlet}--{critic}.json  # e.g., nytimes--ben-brantley.json
    failed-fetches.json   # Tracking file for reviews that couldn't be scraped
  archives/reviews/       # Archived HTML of scraped review pages
    {show-id}/            # HTML snapshots with timestamps
  aggregator-archive/     # Archived HTML pages from aggregator sites
    show-score/           # Show Score page archives (*.html)
    dtli/                 # Did They Like It archives
    bww-roundups/         # BroadwayWorld review roundups
```

### Show Schema (shows.json)
```typescript
{
  id, title, slug, venue, openingDate, closingDate, status, type, runtime, intermissions,
  images: { hero, thumbnail, poster },
  synopsis, ageRecommendation, tags,
  previewsStartDate,  // For upcoming shows (status: "previews")
  ticketLinks: [{ platform, url, priceFrom }],
  cast: [{ name, role }],
  creativeTeam: [{ name, role }],
  officialUrl, trailerUrl, theaterAddress
}
```

**Status values:**
- `"open"` - Currently running (opening date has passed)
- `"previews"` - Upcoming show (opening date is in future)
- `"closed"` - Show has closed (closing date has passed)

### Grosses Schema (grosses.json)
```typescript
{
  lastUpdated: string,           // ISO timestamp
  weekEnding: string,            // e.g., "1/18/2026"
  shows: {
    [slug: string]: {
      thisWeek?: {               // Only for currently running shows
        gross: number | null,
        grossPrevWeek: number | null,
        grossYoY: number | null,
        capacity: number | null,
        capacityPrevWeek: number | null,
        capacityYoY: number | null,      // Not available from BWW
        atp: number | null,              // Average Ticket Price
        atpPrevWeek: number | null,      // Not available from BWW
        atpYoY: number | null,           // Not available from BWW
        attendance: number | null,
        performances: number | null
      },
      allTime: {                 // Available for all shows including closed
        gross: number | null,
        performances: number | null,
        attendance: number | null
      },
      lastUpdated?: string
    }
  }
}
```

**Data availability from BroadwayWorld:**
- ✅ Gross: current, prev week, YoY
- ✅ Capacity: current, prev week
- ❌ Capacity YoY: not provided
- ✅ ATP: current only
- ❌ ATP prev week/YoY: not provided
- ✅ All-time stats: gross, performances, attendance (all shows)

## Key Files
- `src/lib/engine.ts` - Scoring engine + TypeScript interfaces
- `src/lib/data.ts` - Data loading layer (includes grosses data functions)
- `src/app/page.tsx` - Homepage with show grid
- `src/app/show/[slug]/page.tsx` - Individual show pages
- `src/config/scoring.ts` - Scoring rules, tier weights, outlet mappings
- `src/components/BoxOfficeStats.tsx` - Box office stats display component
- `scripts/discover-new-shows.js` - Discovers new/upcoming shows from Broadway.org (runs daily)
- `scripts/discover-historical-shows.js` - Discovers closed shows from past seasons (manual trigger)
- `scripts/scrape-grosses.ts` - BroadwayWorld weekly grosses scraper (Playwright)
- `scripts/scrape-alltime.ts` - BroadwayWorld all-time stats scraper (Playwright)
- `scripts/collect-review-texts-v2.js` - Enhanced review text scraper with stealth mode, ScrapingBee fallback, Archive.org fallback
- `scripts/audit-scores.js` - Validates all review scores, flags wrong conversions, sentiment placeholders, duplicates
- `scripts/fix-scores.js` - Automated fix for common scoring issues (wrong star/letter conversions)
- `scripts/rebuild-show-reviews.js` - Rebuilds reviews.json for specific shows from review-texts data

## Automation (GitHub Actions)

All automation runs via GitHub Actions - no local commands needed.

### `.github/workflows/update-show-status.yml`
- **Runs:** Every day at 8 AM UTC (3 AM EST) (or manually via GitHub UI)
- **Does:**
  - Updates show statuses (open → closed when closing date passes)
  - Transitions previews → open when opening date arrives
  - Discovers new shows on Broadway.org
  - Auto-adds new shows with status: "previews" if opening date is in future
  - Triggers review gathering only for shows that have opened (not previews)

### `.github/workflows/gather-reviews.yml`
- **Runs:** When new shows discovered (or manually triggered)
- **Does:** Gathers review data for shows

### `.github/workflows/fetch-images.yml`
- **Runs:** When triggered
- **Does:** Fetches show images from TodayTix CDN

### `.github/workflows/update-grosses.yml`
- **Runs:** Every Tuesday & Wednesday at 3pm UTC (10am ET)
- **Does:** Scrapes BroadwayWorld for weekly box office data and all-time stats
- **Data source:** BroadwayWorld (grosses.cfm for weekly, grossescumulative.cfm for all-time)
- **Note:** Data is typically released Monday/Tuesday after the week ends on Sunday
- **Skips:** If data for the current week already exists (unless force=true)

### `.github/workflows/discover-historical-shows.yml`
- **Runs:** Manual trigger only (workflow_dispatch)
- **Does:**
  - Discovers closed Broadway shows from past seasons
  - Works backwards through history (most recent first)
  - Adds shows with status: "closed" and tag: "historical"
  - Automatically triggers review gathering for all discovered shows
- **Usage:** Specify seasons like `2024-2025,2023-2024` (one or two seasons at a time recommended)
- **Strategy:** Start with most recent closed shows, gradually work back ~20 years
- **Note:** Review gathering happens automatically after discovery (same process as new shows)

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

### Box Office Stats
Show pages display box office data in two rows of stat cards:

**THIS WEEK row (for currently running shows):**
- Gross (with WoW and YoY % change arrows)
- Capacity % (with WoW % change arrow)
- Avg Ticket Price

**ALL TIME row (for all shows including closed):**
- Total Gross (e.g., "$2.1B" for Lion King)
- Total Performances
- Total Attendance

**Component:** `src/components/BoxOfficeStats.tsx`
**Data functions:** `getShowGrosses()`, `getGrossesWeekEnding()` in `src/lib/data.ts`

**Change indicators:**
- Green up arrow for positive changes
- Red down arrow for negative changes
- Only shows when comparison data is available

### Web Scraping Setup

**For GitHub Actions (automated scripts):**

Scripts use the shared `scripts/lib/scraper.js` module with automatic fallback:

1. **Bright Data** (primary) - Returns clean markdown
2. **ScrapingBee** (fallback) - Returns HTML
3. **Playwright** (last resort) - Browser automation

**Environment Variables:**
```bash
BRIGHTDATA_TOKEN=3686bf13-cbde-4a91-b54a-f721a73c0ed0
SCRAPINGBEE_API_KEY=TM5B2FK5G0BNFS2IL2T1OUGYJR7KP49UEYZ33KUUYWJ3NZC8ZJG6BMAXI83IQRD3017UTTNX5JISNDMW
```

**Scripts that use scraping:**
- `scripts/discover-new-shows.js` - Broadway.org show discovery
- `scripts/check-closing-dates.js` - Closing date monitoring
- `scripts/scrape-grosses.ts` - BroadwayWorld box office (uses Playwright directly)
- `scripts/scrape-alltime.ts` - BroadwayWorld all-time stats (uses Playwright directly)

**For Claude Code (MCP - local development):**

MCP servers configured in `.mcp.json`:
- **Bright Data MCP** - For all general scraping
- **ScrapingBee MCP** - For aggregator sites (Note: Has 431 header errors, prefer Bright Data)
- **Playwright MCP** - For complex JavaScript-heavy sites

**Usage in Claude:**
```
Use mcp__brightdata__scrape_as_markdown tool to fetch pages
Use Playwright MCP for BroadwayWorld and complex sites
```

**Important:** Always cross-check review counts against these 3 aggregators:
- didtheylikeit.com/shows/[show-name]/
- show-score.com/broadway-shows/[show]
- broadwayworld.com review roundups

### Show Score Integration

Show Score is a third aggregator source alongside DTLI and BWW Review Roundups. It provides:
- **Audience scores** (0-100%) from user ratings
- **Critic review lists** with outlet, author, date, excerpt, and review URL

**Files:**
- `data/show-score-urls.json` - Maps 37 show IDs to Show Score URLs
- `data/show-score.json` - Extracted data (audience scores + critic reviews)
- `data/aggregator-archive/show-score/*.html` - Archived HTML pages
- `scripts/extract-show-score-reviews.js` - Extraction script using JSDOM

**Current Status (January 2026):**
- 22 shows fully extracted with data
- 15 shows need archive pages fetched
- 3 shows need pages re-fetched (wrong content: moulin-rouge-2019, mj-2022, and-juliet-2022)

**To fetch missing pages:**
1. Use Playwright MCP to navigate to Show Score URL
2. Capture page HTML with `browser_evaluate` → `document.documentElement.outerHTML`
3. Save to `data/aggregator-archive/show-score/{show-id}.html` with metadata header
4. Run `node scripts/extract-show-score-reviews.js` to update show-score.json

**Data extracted per show:**
```json
{
  "showScoreUrl": "https://www.show-score.com/broadway-shows/...",
  "audienceScore": 90,
  "audienceReviewCount": 334,
  "criticReviewCount": 17,
  "criticReviews": [
    {
      "outlet": "The New York Times",
      "author": "Laura Collins-Hughes",
      "date": "November 20th, 2025",
      "excerpt": "Critic's Pick: \"The effervescent new musical...\"",
      "url": "https://www.nytimes.com/..."
    }
  ]
}
```

**Note:** Show Score paginates critic reviews - only first 8 are in the initial HTML. The `criticReviewCount` reflects the total from the heading (e.g., "Critic Reviews (17)").

### SEO
- JSON-LD structured data with ticket offers, cast, ratings
- Dynamic meta tags per show
- Sitemap.xml auto-generated
- Robots.txt configured

## Review Data Schema (January 2026)

Each review file in `data/review-texts/{showId}/{outletId}--{criticName}.json` has:

```json
{
  "showId": "two-strangers-bway-2025",
  "outletId": "nytimes",
  "outlet": "The New York Times",
  "criticName": "Laura Collins-Hughes",
  "url": "https://...",
  "publishDate": "November 20, 2025",
  "fullText": "..." or null,
  "isFullReview": true/false,
  "dtliExcerpt": "...",
  "bwwExcerpt": "...",
  "showScoreExcerpt": "...",
  "originalScore": null,
  "assignedScore": 78,
  "source": "playwright-scraped",
  "dtliThumb": "Up/Down/Meh",
  "bwwThumb": "Up/Down/Meh"
}
```

**Field meanings:**
- `fullText` - Complete review text (null if only excerpts available)
- `isFullReview` - true if fullText is a complete review (500+ chars from scraped source)
- `dtliExcerpt` - Excerpt from Did They Like It aggregator
- `bwwExcerpt` - Excerpt from BroadwayWorld Review Roundup
- `showScoreExcerpt` - Excerpt from Show Score aggregator
- `source` - Where the data came from: `dtli`, `bww-roundup`, `playwright-scraped`, `webfetch-scraped`, `manual`

## Subscription Access for Paywalled Sites

For scraping paywalled review sites, the user has subscriptions:

| Site | Email/Username | Password Location |
|------|---------------|-------------------|
| **New York Times** | ewcampbell1@gmail.com | GitHub Secrets |
| **Vulture/NY Mag** | thomas.pryor@gmail.com | GitHub Secrets |

**Usage:** When scraping NYT or Vulture reviews via Playwright, log in first using these credentials.

## Scraping Priority & Approach

### Free Outlets (scrape directly with Playwright/WebFetch)
- **Stage and Cinema** (stageandcinema.com) - Works well with Playwright
- **Theatrely** (theatrely.com) - Works with WebFetch
- **Cititour** (cititour.com) - Works with WebFetch
- **New York Theater** (newyorktheater.me) - Try Playwright
- **Culture Sauce** - Free access

### Paywalled Outlets (use subscription login)
- **New York Times** - Use NYT subscription
- **Vulture/NY Magazine** - Use Vulture subscription

### Blocked/Unavailable
- **Broadway News** - Many URLs return 404 (pages removed)
- **Entertainment Weekly** - Paywalled, no subscription
- **The Wrap** - Often blocked

## Future Features
- Audience scores integration
- Comparison views
- Historical tracking
- Custom domain setup (broadwayscorecard.com)

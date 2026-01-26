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

### 2. ALWAYS ASK: Quick Fix or Preview? (MANDATORY)

**Before making ANY code/design changes, Claude MUST ask:**

> "Is this a **quick fix** (ship directly to production) or do you want to **preview it first** (staging branch)?"

**User responses:**
- "Quick fix" / "Ship it" / "Just do it" → Work on `main`, push directly to production
- "Preview" / "Staging" / "Let me see it first" → Work on `staging` branch, provide preview URL

**The ONLY exceptions where you don't need to ask:**
- Pure data updates (adding shows, updating metadata)
- Documentation changes (CLAUDE.md, README)
- Bug fixes that are clearly broken and need immediate fixing

---

### 3. Git Workflow - Two Paths

#### Path A: Quick Fix (Direct to Production)
For small, low-risk changes. Work on `main` branch.

```
git checkout main
git pull origin main
# Make changes
git add -A && git commit -m "description" && git push origin main
# Vercel auto-deploys → Live in ~1 minute
```

#### Path B: Preview First (Staging Branch)
For UI changes, new features, or anything risky. Work on `staging` branch.

```
git checkout main
git pull origin main
git checkout -b staging  # Create fresh staging branch
# Make changes
git add -A && git commit -m "description" && git push origin staging
# Vercel creates preview URL automatically
```

**After user approves the preview:**
```
git checkout main
git merge staging
git push origin main
git branch -d staging  # Delete local staging
git push origin --delete staging  # Delete remote staging
```

**If user wants changes:** Continue working on `staging`, push again, new preview URL generated.

**Preview URLs:** Vercel automatically creates unique URLs like:
`https://broadwayscore-git-staging-[username].vercel.app`

Share this URL with the user so they can review on their phone before approving.

### 4. Vercel Deployment
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
- ❌ Ask user to "create a PR" or "merge via GitHub" - Claude handles all git operations
- ❌ Create random feature branches - only use `main` or `staging`

**ALWAYS:**
- ✅ Ask "Quick fix or Preview?" before making changes (see Rule #2)
- ✅ Use `main` for quick fixes, `staging` for preview-first changes
- ✅ Delete `staging` branch after merging to main

### 5. Automate Everything
- ❌ Don't ask user to manually fetch data
- ❌ Don't suggest "you could manually update..."
- ✅ Write scripts that run via GitHub Actions
- ✅ Create automation for any recurring task

### 6. NEVER Guess or Fake Data
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
  audience-buzz.json              # Audience Buzz data (Show Score, Mezzanine, Reddit)
  audience.json                   # (Legacy/Future) Audience scores
  buzz.json                       # (Legacy/Future) Social buzz data
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

### Audience Buzz Schema (audience-buzz.json)
```typescript
{
  _meta: { lastUpdated, sources, notes },
  shows: {
    [showId: string]: {
      title: string,
      designation: "Loving" | "Liking" | "Shrugging" | "Loathing",
      // Thresholds: ❤️ Loving 88+, 👍 Liking 78-87, 🤷 Shrugging 68-77, 💩 Loathing 0-67
      combinedScore: number,  // Weighted: SS/Mezz split by sample size (80%), Reddit fixed (20%)
      sources: {
        showScore?: { score: number, reviewCount: number },
        mezzanine?: { score: number, reviewCount: number, starRating: number },
        reddit?: {
          score: number,
          reviewCount: number,
          lastUpdated: string,
          sentiment: { enthusiastic, positive, mixed, negative },  // percentages
          recommendations: number,
          positiveRate: number  // enthusiastic + positive combined
        }
      }
    }
  }
}
```

**Audience Buzz Weighting (Dynamic):**
- **Reddit**: Fixed 20% when available (captures buzz/enthusiasm)
- **Show Score & Mezzanine**: Split remaining 80% (or 100% if no Reddit) proportionally by sample size

Example: Show Score has 3,000 reviews, Mezzanine has 1,000, Reddit available:
- Show Score: (3000/4000) × 80% = 60%
- Mezzanine: (1000/4000) × 80% = 20%
- Reddit: 20%

This gives more weight to sources with larger sample sizes.

**Audience Buzz Sources:**
- **Show Score**: Aggregates audience reviews with 0-100 scores (weekly automated)
- **Mezzanine**: Aggregates audience reviews with star ratings (manual - iOS app only)
- **Reddit**: Sentiment analysis from r/Broadway discussions (monthly automated)

## Key Files
- `src/lib/engine.ts` - Scoring engine + TypeScript interfaces
- `src/lib/data.ts` - Data loading layer (includes grosses data functions)
- `src/app/page.tsx` - Homepage with show grid
- `src/app/show/[slug]/page.tsx` - Individual show pages
- `src/config/scoring.ts` - Scoring rules, tier weights, outlet mappings
- `src/components/BoxOfficeStats.tsx` - Box office stats display component
- `scripts/discover-new-shows.js` - Discovers new/upcoming shows from Broadway.org (runs daily)
- `scripts/discover-historical-shows.js` - Discovers closed shows from past seasons (manual trigger)
- `scripts/lib/deduplication.js` - **Centralized show deduplication** (prevents duplicate show entries)
- `scripts/scrape-grosses.ts` - BroadwayWorld weekly grosses scraper (Playwright)
- `scripts/scrape-alltime.ts` - BroadwayWorld all-time stats scraper (Playwright)
- `scripts/scrape-reddit-sentiment.js` - Reddit r/Broadway sentiment scraper (ScrapingBee + Claude Opus)
- `scripts/collect-review-texts-v2.js` - Enhanced review text scraper with stealth mode, ScrapingBee fallback, Archive.org fallback
- `scripts/audit-scores.js` - Validates all review scores, flags wrong conversions, sentiment placeholders, duplicates
- `scripts/fix-scores.js` - Automated fix for common scoring issues (wrong star/letter conversions)
- `scripts/rebuild-show-reviews.js` - Rebuilds reviews.json for specific shows from review-texts data

### Show Deduplication System

The `scripts/lib/deduplication.js` module prevents duplicate shows from being added by automated processes. It uses 9 different checks:

1. **Exact title match** (case-insensitive)
2. **Exact slug match**
3. **ID base match** (slug without year suffix)
4. **Known duplicate patterns** - 50+ Broadway shows with common variations
5. **Normalized title match** - Strips ": The Musical", "on Broadway", etc.
6. **Slug prefix match** - Catches "hamilton" vs "hamilton-an-american-musical"
7. **Same venue + similar title**
8. **Title containment** - One title contains the other
9. **Fuzzy matching** - Levenshtein distance for typos

**Known Duplicates Map:** Handles short titles that can't rely on normalization alone:
- "MJ" / "MJ: The Musical" / "MJ The Musical"
- "SIX" / "SIX: The Musical" / "SIX on Broadway"
- "Cats" / "Cats The Musical"
- "Rent" / "RENT on Broadway"
- And 50+ more Broadway shows

**To add new known duplicates:** Edit `KNOWN_DUPLICATES` in `scripts/lib/deduplication.js`:
```javascript
'show name': ['show name', 'show name the musical', 'other variation'],
```

## Automation (GitHub Actions)

All automation runs via GitHub Actions - no local commands needed.

### `.github/workflows/update-show-status.yml`
- **Runs:** Every day at 8 AM UTC (3 AM EST) (or manually via GitHub UI)
- **Does:**
  - Updates show statuses (open → closed when closing date passes)
  - Transitions previews → open when opening date arrives
  - Discovers new shows on Broadway.org
  - Auto-adds new shows with status: "previews" if opening date is in future
  - **Triggers for newly opened shows (previews → open):**
    - `gather-reviews.yml` - Collects critic reviews
    - `update-reddit-sentiment.yml` - Gets Reddit buzz data
    - `update-show-score.yml` - Gets Show Score audience data

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

### `.github/workflows/process-review-submission.yml`
- **Runs:** When a GitHub issue is created/edited with the `review-submission` label
- **Does:**
  - Validates review submission using AI (Claude API)
  - Checks: Valid URL, Broadway show, legitimate outlet, not duplicate
  - If approved: Automatically scrapes review and adds to database
  - Posts validation result as issue comment
  - Closes issue when successfully processed

### `.github/workflows/update-show-score.yml`
- **Runs:**
  - Weekly (Sundays at 12pm UTC) for all shows
  - Automatically when shows transition previews → open (triggered by update-show-status.yml)
  - Manually via GitHub UI
- **Does:**
  - Scrapes show-score.com for audience scores and review counts
  - Updates `data/audience-buzz.json` with Show Score data
  - Saves incrementally after each show (prevents data loss on timeout)
- **Manual trigger options:**
  - `show`: Process specific show ID
  - `shows`: Comma-separated show IDs for batch processing
  - `limit`: Limit number of shows to process (default: 50)
- **Technical notes:**
  - Uses ScrapingBee with JS rendering to fetch pages
  - Extracts audience score from JSON-LD structured data
  - Show Score weighted at 40% in combined Audience Buzz score
  - 1-hour timeout with `if: always()` commit step
- **Script:** `scripts/scrape-show-score-audience.js`

### `.github/workflows/update-reddit-sentiment.yml`
- **Runs:**
  - Monthly (1st of each month at 10am UTC) for all shows
  - Automatically when shows transition previews → open (triggered by update-show-status.yml)
  - Manually via GitHub UI
- **Does:**
  - Scrapes r/Broadway for show discussions and reviews
  - Uses Claude Opus for sentiment analysis (enthusiastic/positive/mixed/negative)
  - Updates `data/audience-buzz.json` with Reddit scores
  - Saves incrementally after each show (prevents data loss on timeout)
- **Manual trigger options:**
  - `show`: Process specific show ID (e.g., `maybe-happy-ending-2024`)
  - `shows`: Comma-separated show IDs for batch processing (e.g., `hamilton-2015,wicked-2003`)
  - `limit`: Limit number of shows to process (default: 50)
- **Technical notes:**
  - Uses ScrapingBee with premium proxy to access Reddit
  - Generic titles (The Outsiders, Chicago, etc.) use Broadway-qualified searches to avoid movie/book noise
  - Prioritizes Review-tagged posts for better signal
  - Reddit score weighted at 20% in combined Audience Buzz score
  - 2-hour timeout with `if: always()` commit step to save partial progress
- **Script:** `scripts/scrape-reddit-sentiment.js`

### `.github/workflows/process-review-submission.yml`
- **User-facing page:** `/submit-review` (accessible from navigation)
- **Issue template:** `.github/ISSUE_TEMPLATE/missing-review.yml`
- **Validation script:** `scripts/validate-review-submission.js`

### `.github/workflows/update-critic-consensus.yml`
- **Runs:** Every Sunday at 2 AM UTC (9 PM ET Saturday) (or manually via GitHub UI)
- **Does:**
  - Generates concise "Critics' Take" editorial summaries for shows (1-2 short sentences, max 280 chars)
  - Uses Claude API to analyze review texts and create summaries
  - Only regenerates shows with 3+ new reviews since last update
  - Updates `data/critic-consensus.json`
- **Manual trigger:** Supports `force` flag to regenerate all shows
- **Script:** `scripts/generate-critic-consensus.js`
- **API:** Uses ANTHROPIC_API_KEY secret

### `.github/workflows/process-feedback.yml`
- **Runs:** Every Monday at 9 AM UTC (4 AM EST) (or manually via GitHub UI)
- **Does:**
  - Fetches feedback submissions from Formspree (last 7 days)
  - AI categorizes feedback: Bug, Feature Request, Content Error, Praise, Other
  - Assigns priority (High/Medium/Low) and recommended actions
  - Creates GitHub issue with weekly digest
- **User-facing page:** `/feedback` (accessible from navigation)
- **Script:** `scripts/process-feedback.js`
- **Setup guide:** `FORMSPREE-SETUP.md`
- **Requires:** FORMSPREE_TOKEN secret (see setup guide)

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
- User-submitted review system with AI validation (automated approval & scraping)
- **Site feedback system** with AI categorization
  - Formspree-powered form at `/feedback`
  - Weekly digest with automated categorization (Bug, Feature, Content Error, Praise, Other)
  - Priority assignment and recommended actions via Claude API
- **Critics' Take** - LLM-generated concise editorial summaries (1-2 short sentences, max 280 chars)
  - Updates weekly if 3+ new reviews added
  - Displayed on show pages between synopsis and reviews
  - Script: `scripts/generate-critic-consensus.js`
  - Data: `data/critic-consensus.json`

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

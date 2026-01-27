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
| **Vercel** | ✅ PRIMARY | https://broadwayscorecard.com |
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
- `scripts/validate-data.js` - **Run before pushing** - validates shows.json for duplicates, missing fields, etc.
- `tests/e2e/` - Playwright E2E tests for homepage and show pages
- `playwright.config.ts` - Playwright test configuration

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

## Automated Testing

The site has comprehensive automated testing that runs via GitHub Actions.

### IMPORTANT: Run Tests Before Pushing
**Always run `node scripts/validate-data.js` before pushing changes to shows.json.** This catches:
- Duplicate shows (like SIX vs "SIX: The Musical")
- Missing required fields
- Invalid data formats

If validation fails, **do not push** - fix the issues first.

### Test Commands
```bash
npm run test:data    # Data validation only (fast, run frequently)
npm run test:e2e     # E2E browser tests (slower, tests live site)
npm run test         # Run all tests
```

### `.github/workflows/test.yml`
- **Runs:**
  - On every push to `main`
  - Daily at 6 AM UTC (1 AM EST)
  - Manually via GitHub UI
- **Tests:**
  - **Data Validation**: Duplicates, required fields, date formats, status consistency
  - **E2E Tests**: Homepage loads, show pages work, navigation, filters, mobile responsiveness
- **On Failure**: Automatically creates GitHub issue with details

### What Gets Tested

**Data Validation** (`scripts/validate-data.js`):
- No duplicate shows (IDs, slugs, or titles via deduplication module)
- All required fields present (id, title, slug, status, venue for open shows)
- Valid status values (open, closed, previews)
- Date format validation (YYYY-MM-DD)
- Logical consistency (closed shows shouldn't have future closing dates)
- URL-safe slugs
- Valid image URLs
- Minimum show counts (safety check)

**E2E Tests** (`tests/e2e/`):
- Homepage loads without errors
- Show cards display correctly
- All show detail pages load (no 404s)
- Navigation works (home → show → back)
- Filters are functional
- Mobile responsive layout
- No console errors

## Automation (GitHub Actions)

All automation runs via GitHub Actions - no local commands needed.

### ⚠️ CRITICAL: GitHub Secrets in Workflows

**Secrets are NOT automatically available to scripts.** You MUST explicitly pass them via `env:` blocks.

```yaml
# ❌ WRONG - Secret exists but script can't see it
- name: Run script
  run: node scripts/my-script.js

# ✅ CORRECT - Secret is passed as environment variable
- name: Run script
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
  run: node scripts/my-script.js
```

**Available secrets in this repository:**
| Secret | Purpose | Used By |
|--------|---------|---------|
| `ANTHROPIC_API_KEY` | Claude API for AI features | gather-reviews, score-reviews, validate-submission, reddit-sentiment |
| `BRIGHTDATA_TOKEN` | Web scraping (primary) | gather-reviews, discover-shows |
| `SCRAPINGBEE_API_KEY` | Web scraping (fallback) | gather-reviews, discover-shows |
| `FORMSPREE_TOKEN` | Feedback form integration | process-feedback |

**When creating/editing workflows:** Always check if the script needs API keys and add the appropriate `env:` block.

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
- **Does:** Gathers review data for shows by searching aggregators and outlets
- **Secrets required:** `ANTHROPIC_API_KEY` (for web search), `BRIGHTDATA_TOKEN`, `SCRAPINGBEE_API_KEY`
- **Script:** `scripts/gather-reviews.js`
- **Manual trigger:** `gh workflow run gather-reviews.yml -f shows=show-id-here`
- **Parallel runs supported:** Yes - multiple workflows can run simultaneously
- **Technical notes:**
  - Installs Playwright Chromium for Show Score carousel scraping
  - Show Score extraction uses Playwright to scroll through ALL critic reviews (not just first 8)
  - Detects and rejects Show Score redirects to off-broadway/off-off-broadway shows
  - Tries `-broadway` URL suffix patterns first to find correct Broadway shows
  - **Parallel-safe:** Only commits `review-texts/` and `archives/` (NOT `reviews.json`)
  - Uses retry loop (5 attempts) with random backoff for git push conflicts
  - After batch runs complete, rebuild `reviews.json` with: `node scripts/rebuild-all-reviews.js`

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

### `.github/workflows/collect-review-texts.yml`
- **Runs:** Manual trigger only (workflow_dispatch)
- **Does:**
  - Fetches full review text from URLs using multi-tier fallback
  - Tier 1: Playwright with stealth plugin
  - Tier 2: ScrapingBee API
  - Tier 3: Bright Data API
  - Tier 4: Archive.org Wayback Machine (most successful!)
  - Supports subscription logins for paywalled sites (NYT, WSJ, Vulture, WaPo)
- **Manual trigger:** `gh workflow run "Collect Review Texts" --field show_filter=show-id`
- **Parallel runs:** YES - launch multiple with different show_filter values
- **Key options:**
  - `batch_size`: Reviews per batch (default 10)
  - `max_reviews`: Max to process (default 50)
  - `show_filter`: Process only specific show (REQUIRED for parallel runs)
  - `stealth_proxy`: Use ScrapingBee stealth mode (75 credits/request)
- **Script:** `scripts/collect-review-texts.js`

### `.github/workflows/llm-ensemble-score.yml`
- **Runs:** Manual trigger only (workflow_dispatch)
- **Does:**
  - Scores reviews using Claude Sonnet + GPT-4o-mini ensemble
  - Averages both model scores for final score
  - Flags reviews where models disagree by >15 points for manual review
  - Includes calibration and validation steps
- **Manual trigger:** `gh workflow run "LLM Ensemble Score Reviews"`
- **Key options:**
  - `show`: Process specific show only
  - `limit`: Max reviews to process
  - `run_calibration`: Run calibration after scoring (default true)
  - `dry_run`: Don't save changes
- **Script:** `scripts/llm-scoring/index.ts`
- **Requires:** ANTHROPIC_API_KEY, OPENAI_API_KEY secrets

## Parallel Workflow Execution Strategy

For large batch operations (review text collection, scoring), run MANY workflows in parallel:

### Why Parallel?
- Single workflow processes ~50-100 reviews in 30-60 minutes
- With 700+ reviews needing text, sequential = 7+ hours
- Parallel with show_filter = 30-40 workflows, done in ~1 hour

### How to Run Parallel Text Collection
```bash
# Launch workflows for multiple shows simultaneously
gh workflow run "Collect Review Texts" --field show_filter=hamilton-2015 &
gh workflow run "Collect Review Texts" --field show_filter=wicked-2003 &
gh workflow run "Collect Review Texts" --field show_filter=hadestown-2019 &
# ... repeat for all shows with scrapable reviews
```

### Avoiding Git Conflicts
- Each workflow has robust retry logic (5 attempts)
- Uses rebase-first, falls back to merge with `-X ours`
- Show-specific workflows touch different files, minimizing conflicts

### Checking Which Shows Need Processing
```javascript
// Find shows with scrapable reviews (have URL but no fullText)
node -e "
const fs = require('fs');
const path = require('path');
const dir = 'data/review-texts';
fs.readdirSync(dir)
  .filter(f => fs.statSync(path.join(dir, f)).isDirectory())
  .forEach(show => {
    const files = fs.readdirSync(path.join(dir, show))
      .filter(f => f.endsWith('.json') && f != 'failed-fetches.json');
    let scrapable = 0;
    files.forEach(f => {
      const d = JSON.parse(fs.readFileSync(path.join(dir, show, f)));
      if (!d.fullText && d.url) scrapable++;
    });
    if (scrapable > 5) console.log(show + ': ' + scrapable);
  });
"
```

### Monitoring Progress
```bash
# Check running workflows
gh run list --limit 20

# Check coverage after workflows complete
git pull origin main
node /tmp/analyze-fulltext-potential.js  # If script exists
```

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

Show Score is an aggregator that provides:
- **Audience scores** (0-100%) from user ratings
- **Critic review lists** with outlet, author, date, excerpt, and review URL

**Two separate integrations:**

1. **Critic Reviews** (via `gather-reviews.js`):
   - Automatically extracts ALL critic reviews using Playwright with carousel scrolling
   - Handles Show Score's paginated carousel (reviews load as you scroll)
   - Creates individual review files in `data/review-texts/{show-id}/`
   - URL pattern matching tries `-broadway` suffix first to avoid redirects to wrong shows
   - Detects and rejects redirects to off-broadway/off-off-broadway shows

2. **Audience Scores** (via `scrape-show-score-audience.js`):
   - Weekly automated via `update-show-score.yml` workflow
   - Updates `data/audience-buzz.json` with audience scores
   - Uses ScrapingBee with JS rendering

**Show Score URL Patterns:**
Show Score uses various URL patterns for Broadway shows:
- `{slug}-broadway` (most common, tried first)
- `{slug}-the-musical-broadway` (for musicals)
- `{slug}` (can redirect to wrong shows - off-broadway variants)

**Important:** Always use `-broadway` suffix patterns first. URLs like `/broadway-shows/redwood` can redirect to `/off-off-broadway-shows/redwood` (a completely different show).

**Legacy files (for reference):**
- `data/show-score-urls.json` - Manual URL mappings (less needed now with auto-discovery)
- `data/show-score.json` - Legacy extracted data
- `scripts/extract-show-score-reviews.js` - Legacy JSDOM extraction (superseded by Playwright)

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

| Site | Email/Username | GitHub Secret Names |
|------|---------------|---------------------|
| **New York Times** | ewcampbell1@gmail.com | NYT_EMAIL, NYTIMES_PASSWORD |
| **Vulture/NY Mag** | thomas.pryor@gmail.com | VULTURE_EMAIL, VULTURE_PASSWORD |
| **The New Yorker** | (same as Vulture - Condé Nast) | VULTURE_EMAIL, VULTURE_PASSWORD |
| **Wall Street Journal** | (user has subscription) | WSJ_EMAIL, WSJ_PASSWORD |
| **Washington Post** | (user has subscription) | WAPO_EMAIL, WASHPOST_PASSWORD |

**Usage:** The `collect-review-texts.js` script automatically logs in to these sites when scraping. Credentials are passed via GitHub Secrets environment variables.

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
- **The New Yorker** - Shares Condé Nast login with Vulture
- **Wall Street Journal** - Use WSJ subscription
- **Washington Post** - Use WaPo subscription

### Blocked/Unavailable
- **Broadway News** - Many URLs return 404 (pages removed)
- **Entertainment Weekly** - Paywalled, no subscription
- **NY Post** - Hard paywall, no subscription

## Future Features
- Audience scores integration
- Comparison views
- Historical tracking
- Custom domain setup (broadwayscorecard.com)

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
- **Locally archived images** (poster, thumbnail, hero) in `public/images/shows/`, with CDN URL backups in `data/image-sources.json`
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
  grosses-history.json            # 55+ weeks of historical grosses for WoW/YoY comparisons
  new-shows-pending.json          # Auto-generated: new shows awaiting review data
  historical-shows-pending.json   # Auto-generated: historical shows awaiting metadata
  show-score.json                 # Show Score aggregator data (audience scores + critic reviews)
  show-score-urls.json            # URL mapping for Show Score pages
  image-sources.json              # Backup of original CDN URLs before local archival
  todaytix-ids.json               # Cached TodayTix show IDs for image discovery
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
        capacityYoY: number | null,      // Enriched from grosses-history.json (~52 weeks ago)
        atp: number | null,              // Average Ticket Price
        atpPrevWeek: number | null,      // Enriched from grosses-history.json (prev week)
        atpYoY: number | null,           // Enriched from grosses-history.json (~52 weeks ago)
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
- ✅ ATP: current only
- ✅ All-time stats: gross, performances, attendance (all shows)

**Self-computed from grosses-history.json (not available from BWW):**
- ✅ Capacity YoY: current capacity vs ~52 weeks ago
- ✅ ATP prev week (WoW): current ATP vs previous week
- ✅ ATP YoY: current ATP vs ~52 weeks ago

### Grosses History System

`grosses-history.json` stores weekly snapshots of box office data to enable WoW and YoY comparisons for fields BWW doesn't provide (capacity YoY, ATP WoW, ATP YoY).

**How it works:**
1. `scrape-grosses.ts` runs weekly (Tuesday) and scrapes BWW for current data
2. After scraping, it looks up `grosses-history.json` for previous week and ~52-week-ago data
3. Enriches `grosses.json` with `atpPrevWeek`, `capacityYoY`, `atpYoY` from history
4. Saves the current week's snapshot into `grosses-history.json` for future lookups

**History data schema:**
```typescript
{
  _meta: { description: string, lastUpdated: string },
  weeks: {
    "YYYY-MM-DD": {  // Week ending date (Sunday)
      [showSlug: string]: {
        gross: number | null,
        capacity: number | null,
        atp: number | null,
        attendance: number | null,
        performances: number | null
      }
    }
  }
}
```

**Backfill:** Historical data was backfilled from Playbill (`playbill.com/grosses?week=YYYY-MM-DD`) using `scripts/backfill-grosses-history.ts`. The backfill workflow uses `domcontentloaded` (not `networkidle` - Playbill's tracking scripts cause timeouts) with 3 retries per week.

**Key files:**
- `data/grosses-history.json` - 55+ weeks of snapshots (Jan 2025 - present)
- `scripts/scrape-grosses.ts` - Weekly scraper + history enrichment logic
- `scripts/backfill-grosses-history.ts` - One-time Playbill backfill script
- `.github/workflows/backfill-grosses.yml` - Manual trigger for backfill
- `src/components/BoxOfficeStats.tsx` - Displays WoW/YoY arrows (auto-shows when data is non-null)

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

### Commercial Data Schema (commercial.json)

The `data/commercial.json` file tracks financial and business metrics for Broadway shows:

```typescript
{
  _meta: { lastUpdated, sources, notes },
  shows: {
    [showId: string]: {
      title: string,
      weeklyRunningCost: number | null,      // Weekly operating expenses
      weeklyRunningCostRange?: { min, max }, // Range if exact unknown
      capitalization: number | null,         // Total investment to open
      recouped: boolean | null,              // Has show recouped?
      recoupedDate: string | null,           // When it recouped (YYYY-MM-DD)
      estimatedRecoupmentPct: number | null, // % toward recoupment (0-100+)
      profitMargin: number | null,           // Weekly profit margin %
      costMethodology: string,               // How costs were calculated (see below)
      sources: [{                            // Data provenance
        type: "reddit" | "trade" | "sec" | "manual",
        url: string,
        date: string,
        excerpt?: string
      }],
      deepResearch?: {                       // Protection for manually-verified data
        verifiedFields: string[],
        verifiedDate: string,
        verifiedBy: string,
        notes?: string
      },
      lastUpdated: string
    }
  }
}
```

### Cost Methodology Tracking

The `costMethodology` field tracks how weekly running costs and other financial estimates are calculated:

| Methodology | Description | Reliability |
|-------------|-------------|-------------|
| `reddit-standard` | Reddit Grosses Analysis methodology (may exclude theater's ~9% cut, producer fee, royalty pools, marketing) | Medium |
| `trade-reported` | Figures from trade press (Deadline, Variety, Broadway News) | High |
| `sec-filing` | Official SEC Form D filings | Very High |
| `producer-confirmed` | Direct producer confirmation | Very High |
| `deep-research` | Extensively verified through multiple authoritative sources | Very High |
| `industry-estimate` | General estimate based on comparable shows | Low |

**Why methodology matters:** Reddit analyst estimates may calculate costs differently than official sources. For example, the Reddit methodology often excludes the theater's ~9% cut from weekly operating costs. When comparing data from different sources, incompatible methodologies are not flagged as contradictions.

### Deep Research Protection

Shows with manually-verified commercial data are protected from automated overwrites via the `deepResearch` object:

```json
"deepResearch": {
  "verifiedFields": ["estimatedRecoupmentPct", "weeklyRunningCost"],
  "verifiedDate": "2026-01-28",
  "verifiedBy": "manual",
  "notes": "Verified through multi-source research"
}
```

**How it works:**
1. When automated updates propose changes to a verified field, the change is **blocked** (not applied)
2. A GitHub issue is automatically created for manual review
3. Critical/High severity conflicts are always blocked

**To mark a field as Deep Research verified:**
1. Add/update the `deepResearch` object in `data/commercial.json`
2. List field names in `verifiedFields` array
3. Set `verifiedDate` to today's date (YYYY-MM-DD format)
4. Optionally add notes explaining the verification

**Conflict resolution:**
- If the automated data is correct: Update the verified value and adjust `verifiedDate`
- If the verified data is correct: No action needed (change was correctly blocked)
- If verification is no longer needed: Remove the field from `verifiedFields`

**Shows with Deep Research protection:**
- death-becomes-her (estimatedRecoupmentPct, weeklyRunningCost)
- the-great-gatsby (weeklyRunningCost, estimatedRecoupmentPct)
- stranger-things (capitalization, recouped, recoupedDate)
- operation-mincemeat (weeklyRunningCost, estimatedRecoupmentPct)
- just-in-time (weeklyRunningCost, estimatedRecoupmentPct)
- all-out (weeklyRunningCost, estimatedRecoupmentPct)

### Commercial Data Automation Files

| File | Purpose |
|------|---------|
| `scripts/update-commercial-data.js` | Main automation script - gathers Reddit/trade press, proposes changes via Claude |
| `scripts/lib/deep-research-guardian.js` | Blocks changes to Deep Research verified fields |
| `scripts/lib/source-validator.js` | Cross-references sources, flags contradictions |
| `data/commercial.json` | Commercial data with deepResearch and costMethodology fields |
| `data/commercial-changelog.json` | Audit log of all automated changes |
| `data/methodology-definitions.json` | Defines cost calculation methodologies |
| `.github/workflows/update-commercial.yml` | Weekly automated commercial data update |

**CLI testing:**
```bash
node scripts/lib/deep-research-guardian.js --test  # Test guardian module
node scripts/lib/source-validator.js --test        # Test source validation
```

## Key Files
- `src/lib/engine.ts` - Scoring engine + TypeScript interfaces
- `src/lib/data.ts` - Data loading layer (includes grosses data functions)
- `src/app/page.tsx` - Homepage with show grid
- `src/app/show/[slug]/page.tsx` - Individual show pages
- `src/config/scoring.ts` - Scoring rules, tier weights, outlet mappings
- `src/config/commercial.ts` - **Single source of truth** for commercial designations (colors, sort orders, descriptions, icons, badge styles). All biz components import from here - never hardcode designation config elsewhere.
- `src/components/BoxOfficeStats.tsx` - Box office stats display component
- `scripts/discover-new-shows.js` - Discovers new/upcoming shows from Broadway.org (runs daily)
- `scripts/discover-historical-shows.js` - Discovers closed shows from past seasons (manual trigger)
- `scripts/lib/deduplication.js` - **Centralized show deduplication** (prevents duplicate show entries)
- `scripts/scrape-grosses.ts` - BroadwayWorld weekly grosses scraper (Playwright) + history enrichment for WoW/YoY
- `scripts/scrape-alltime.ts` - BroadwayWorld all-time stats scraper (Playwright)
- `scripts/backfill-grosses-history.ts` - Playbill historical grosses backfill (Playwright)
- `scripts/scrape-reddit-sentiment.js` - Reddit r/Broadway sentiment scraper (ScrapingBee + Claude Opus)
- `scripts/collect-review-texts-v2.js` - Enhanced review text scraper with stealth mode, ScrapingBee fallback, Archive.org fallback
- `scripts/audit-scores.js` - Validates all review scores, flags wrong conversions, sentiment placeholders, duplicates
- `scripts/fix-scores.js` - Automated fix for common scoring issues (wrong star/letter conversions)
- `scripts/fix-critic-misattribution.js` - **Data cleanup** - Removes reviews with misattributed critics (e.g., Jesse Green at Variety)
- `scripts/dedupe-reviews-json.js` - **Data cleanup** - Deduplicates reviews.json by outlet+critic combo
- `scripts/rebuild-show-reviews.js` - Rebuilds reviews.json for specific shows from review-texts data
- `scripts/fetch-show-images-auto.js` - Discovers and fetches show images from TodayTix CDN
- `scripts/archive-show-images.js` - Archives CDN images locally to `public/images/shows/` as WebP
- `src/components/ShowImage.tsx` - Image component with cascading source fallback and onError handling
- `scripts/validate-data.js` - **Run before pushing** - validates shows.json for duplicates, missing fields, etc.
- `scripts/update-commercial-data.js` - Weekly commercial data automation (Reddit + trade press + SEC + Claude analysis)
- `scripts/lib/parse-grosses.js` - Reddit Grosses Analysis post parser (exported for unit testing)
- `scripts/lib/trade-press-scraper.js` - **Trade press article scraper** with site-specific CSS selectors, Archive.org fallback, paywall login support
- `scripts/lib/sec-edgar-scraper.js` - **SEC EDGAR Form D scraper** with rate limiting, XML parsing, known Broadway LLC CIK mappings
- `scripts/lib/source-validator.js` - **Multi-source validation framework** with source weights, corroboration detection, confidence adjustment
- `scripts/test-commercial-integration.js` - Integration test for commercial data modules
- `scripts/process-commercial-tip.js` - Processes user-submitted commercial data tips from GitHub issues
- `data/commercial-changelog.json` - Changelog of automated commercial data updates
- `tests/unit/` - Unit tests (parse-grosses, commercial filtering, shadow classifier, source-validator, trade-press-scraper, sec-edgar-scraper)
- `tests/e2e/` - Playwright E2E tests for homepage, show pages, and biz-buzz
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

### Review Normalization System (CRITICAL)

The `scripts/lib/review-normalization.js` module prevents duplicate review files from being created. This is essential because different sources use different naming:

**Problem it solves:**
- "The New York Times" vs "NYT" vs "nytimes" → all become `nytimes`
- "Jesse Green" vs "Jesse" vs "jesse-green" → all become `jesse-green`
- "Johnny Oleksinski" vs "Johnny Oleksinki" (typo!) → both become `johnny-oleksinski`

**Key functions:**
- `normalizeOutlet(name)` - Returns canonical outlet ID (e.g., `nytimes`, `vulture`)
- `normalizeCritic(name)` - Returns canonical critic slug (e.g., `jesse-green`)
- `generateReviewFilename(outlet, critic)` - Returns consistent filename
- `generateReviewKey(outlet, critic)` - Returns key for deduplication
- `areCriticsSimilar(name1, name2)` - Handles partial names and typos

**Outlet aliases (40+ variations):** Maps all variations to canonical IDs:
```javascript
'nytimes': ['nytimes', 'new york times', 'the new york times', 'ny times', 'nyt', ...]
'vulture': ['vulture', 'new york magazine / vulture', 'ny mag', 'nymag', 'vult', ...]
```

**Critic aliases (30+ variations):** Maps name variations and typos:
```javascript
'jesse-green': ['jesse green', 'jesse', 'j green'],
'johnny-oleksinski': ['johnny oleksinski', 'johnny oleksinki', 'johnny'], // Note typo
```

**To add new aliases:** Edit `OUTLET_ALIASES` or `CRITIC_ALIASES` in `scripts/lib/review-normalization.js`

**Cleanup script:** `scripts/cleanup-duplicate-reviews.js`
- Run with `--dry-run` first to see what would change
- Merges duplicate files, keeping best data from each
- Renames files to canonical format

### Review Data Quality - Lessons Learned (Jan 2026)

**CRITICAL:** Web search collection can introduce data quality issues. In January 2026, we discovered 147 misattributed reviews (7% of all reviews) where critics were incorrectly attributed to outlets they don't write for.

**What happened:**
- Jesse Green (NYT critic) appearing under Variety, TheaterMania, Vulture
- Peter Marks (WashPost critic) appearing under Variety
- Adam Feldman (Time Out critic) appearing under TheaterMania
- Chris Jones (Chicago Tribune) appearing under NY Daily News

**Root causes:**
1. Web search returned results mentioning a critic's name in context of another outlet
2. No validation that a critic actually writes for the attributed outlet
3. No automated tests catching misattribution

**Fixes implemented:**
1. `scripts/fix-critic-misattribution.js` - Maps known critics to their outlets, removes misattributions
2. `scripts/dedupe-reviews-json.js` - Deduplicates by outlet+critic combo per show
3. `scripts/validate-data.js` - Now checks for:
   - Duplicate outlet+critic combos in reviews.json
   - Known critic misattributions

**Audit logs saved to:** `data/audit/misattribution-log.json`, `data/audit/dedup-log.json`

**Prevention:**
- `validate-data.js` now catches these issues before they reach production
- Known critics list in validation prevents future misattributions
- Always run `node scripts/validate-data.js` after bulk data changes

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
- **reviews.json checks** (added Jan 2026):
  - No duplicate outlet+critic combos per show
  - No known critic misattributions (e.g., Jesse Green at Variety)

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

### `.github/workflows/review-refresh.yml`
- **Runs:** Weekly on Mondays at 9 AM UTC (4 AM EST), year-round
- **Does:**
  - Checks all open shows for new reviews not yet in the database
  - Compares Show Score / DTLI / BWW review counts against local review-texts
  - If new reviews found, triggers `collect-review-texts.yml` for each show individually
- **Manual trigger:** `gh workflow run "Refresh Review Data"` with optional `show_filter` or `force_collection`
- **Script:** `scripts/check-show-freshness.js`
- **Note:** This workflow discovers new reviews but does NOT rebuild `reviews.json` — that requires a separate `rebuild-all-reviews.js` run (Gap #1, pending)

### `.github/workflows/fetch-aggregator-pages.yml`
- **Runs:** Manual trigger only
- **Does:** Fetches and archives HTML pages from ALL THREE aggregator sources
- **CRITICAL:** Use all three sources for complete review coverage:
  1. **Show Score** - Best for recent shows, has audience scores + critic reviews
  2. **DTLI (Did They Like It)** - Excellent historical coverage back to ~2000s
  3. **BWW Review Roundups** - BroadwayWorld's review collections, good historical data
- **Manual trigger:**
  ```bash
  # Fetch from all aggregators for missing shows
  gh workflow run "Fetch Aggregator Pages" --field aggregator=all --field shows=missing

  # Fetch specific aggregator for specific shows
  gh workflow run "Fetch Aggregator Pages" --field aggregator=dtli --field shows=hamilton-2015,wicked-2003
  ```
- **Options:**
  - `aggregator`: show-score, dtli, bww-rr, or **all** (recommended)
  - `shows`: comma-separated IDs, "all", or "missing" (only fetch shows without archives)
  - `force`: Re-fetch even if archive exists
- **Archives saved to:** `data/aggregator-archive/{show-score,dtli,bww-roundups}/`
- **Why archive?** Avoid painful re-scraping - pages are saved locally with timestamps

### `.github/workflows/fetch-all-image-formats.yml`
- **Runs:** Twice weekly (Mon & Thu at 6 AM UTC), or when triggered by show discovery workflows
- **Does:**
  1. Fetches poster, thumbnail, and hero images from TodayTix CDN (via Contentful)
  2. Archives images locally to `public/images/shows/{show-id}/` as WebP
  3. Backs up original CDN URLs to `data/image-sources.json`
  4. Updates `shows.json` to use local paths (e.g., `/images/shows/hamilton-2015/poster.webp`)
- **Scripts:** `scripts/fetch-show-images-auto.js` (fetch from CDN) → `scripts/archive-show-images.js` (download + localize)
- **Triggered by:** `update-show-status.yml` (new shows) and `discover-historical-shows.yml` (historical shows)
- **Manual trigger:** `gh workflow run "Fetch Show Images"` with optional `show_id` or `only_missing=true`
- **Image formats archived:**
  - Poster: 720×1080 WebP (face-focused crop)
  - Thumbnail: 540×540 WebP (face-focused crop)
  - Hero: 1920×800 WebP (center crop)
- **ShowImage component:** `src/components/ShowImage.tsx` renders images with cascading source fallback and onError handling — if local file fails, tries next source; if all fail, renders emoji fallback

### `.github/workflows/weekly-grosses.yml`
- **Runs:** Every Tuesday & Wednesday at 3pm UTC (10am ET)
- **Does:** Scrapes BroadwayWorld for weekly box office data and all-time stats
- **Also:** Enriches `grosses.json` with WoW/YoY data from `grosses-history.json`, saves current week to history
- **Data source:** BroadwayWorld (grosses.cfm for weekly, grossescumulative.cfm for all-time)
- **Note:** Data is typically released Monday/Tuesday after the week ends on Sunday
- **Skips:** If data for the current week already exists (unless force=true)

### `.github/workflows/backfill-grosses.yml`
- **Runs:** Manual trigger only (workflow_dispatch)
- **Does:** Scrapes Playbill for historical weekly grosses data to populate `grosses-history.json`
- **Source:** `playbill.com/grosses?week=YYYY-MM-DD` (requires JS rendering via Playwright)
- **Options:** `weeks` (default 55), `start_from` (YYYY-MM-DD)
- **Reliability:** Uses `domcontentloaded` (not `networkidle`), 3 retries per week, `if: always()` commit, push retry with rebase
- **Script:** `scripts/backfill-grosses-history.ts`
- **Note:** Only needed for initial setup or extending history range. Weekly updates happen automatically via `weekly-grosses.yml`

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

### `.github/workflows/update-commercial.yml`
- **Runs:** Every Wednesday at 4 PM UTC (11 AM EST) (or manually via GitHub UI)
- **Does:**
  - Scrapes Reddit for u/Boring_Waltz_9545's weekly Grosses Analysis posts
  - Searches trade press (Deadline, Variety, Broadway Journal, etc.) for financial news
  - Enhanced full-text extraction from trade press using `trade-press-scraper.js`
  - Optional SEC EDGAR Form D filing search for capitalization data
  - Uses Claude Sonnet to analyze gathered data and propose commercial.json updates
  - **Multi-source validation:** Cross-references proposed changes against all gathered sources
  - Applies high/medium confidence changes automatically, flags low/conflicting confidence for review
  - Runs shadow classifier to detect designation disagreements
  - Creates GitHub issue summarizing all changes with validation details
  - Writes to `data/commercial-changelog.json`
  - **On failure:** Automatically creates a GitHub issue alerting maintainers
- **Manual trigger options:**
  - `dry_run`: Don't save changes (default: false)
  - `gather_only`: Stop after gathering data, don't run AI analysis (default: false)
- **CLI flags (in script):**
  - `--gather-sec`: Enable SEC EDGAR Form D filing search
  - `--gather-trade-full`: Use enhanced trade press scraper with full-text extraction
  - `--skip-validation`: Bypass multi-source validation pipeline
  - `--gather-reddit`, `--gather-trade`, `--gather-all`: Control data sources
- **Script:** `scripts/update-commercial-data.js`
- **Supporting modules:**
  - `scripts/lib/parse-grosses.js` - Reddit Grosses Analysis post parser
  - `scripts/lib/trade-press-scraper.js` - Trade press article scraper with site-specific extraction
  - `scripts/lib/sec-edgar-scraper.js` - SEC EDGAR Form D filing search and parsing
  - `scripts/lib/source-validator.js` - Multi-source validation framework
- **Integration test:** `scripts/test-commercial-integration.js`
- **Requires:** ANTHROPIC_API_KEY, SCRAPINGBEE_API_KEY secrets
- **Optional:** NYT_EMAIL, NYTIMES_PASSWORD, VULTURE_EMAIL, VULTURE_PASSWORD (for paywalled trade press)

### `.github/workflows/process-commercial-tip.yml`
- **Runs:** When a GitHub issue is created/edited with the `commercial-tip` label
- **Does:**
  - Validates commercial data tips submitted by users via issue template
  - Uses Claude API to assess accuracy and relevance
  - If valid: applies changes to `data/commercial.json` and commits
  - Posts validation result as issue comment
- **Issue template:** `.github/ISSUE_TEMPLATE/commercial-tip.yml`
- **Script:** `scripts/process-commercial-tip.js`
- **Requires:** ANTHROPIC_API_KEY secret

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
- **Truncation Detection:** The script detects if scraped text is truncated:
  - Checks for paywall text ("subscribe", "sign in", "members only")
  - Checks for "read more" or "continue reading" prompts
  - Checks if text ends with proper punctuation
  - Checks if fullText is shorter than 1.5x the excerpt
  - Checks for footer junk ("privacy policy", "terms of use")
  - Marks reviews as `textQuality: "truncated"` if signals detected
- **Audit script:** `node scripts/audit-truncated-reviews.js`
  - Scans all existing reviews for truncation signals
  - Flags false positives (marked "full" but actually truncated)
  - Saves list to `data/audit/truncated-reviews-to-fix.json`

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

### Broadway Investment Tracker (`/biz`)
A dedicated section for recoupment tracking and investment analysis.

**Routes:**
- `/biz` - Dashboard with season stats, recent developments, approaching recoupment, at-risk shows, all open shows table
- `/biz/season/[season]` - Season detail pages (auto-generated from data via `getSeasonsWithCommercialData()`)

**Key patterns:**
- **Seasons are dynamic** - discovered from `commercial.json` data, not hardcoded. New seasons appear automatically when shows are added.
- **`calculateWeeksToRecoup(openingDate, recoupedDate)`** in `data.ts` is the source of truth for recoupment weeks. Never use manually stored `recoupedWeeks` values.
- **`recouped: true` requires `recoupedDate`** - validation enforces this in `validate-data.js`
- **"Current season" filter** computes dynamically (Sept = new season start)
- **Centralized config** - All designation colors, sort orders, icons, and badge styles live in `src/config/commercial.ts`. Components import from there.

**Components:** `src/components/biz/` (AllShowsTable, SeasonStatsCard, ApproachingRecoupmentCard, AtRiskCard, RecoupmentTable, RecentDevelopmentsList, DesignationLegend)

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

### Three Aggregator Sources (CRITICAL)

**IMPORTANT:** We use THREE aggregator sources for comprehensive review coverage. Do NOT rely on just one - each has different historical coverage and may have reviews the others miss.

#### 1. Show Score (show-score.com)
- **Best for:** Recent shows (2015+), audience scores
- **Provides:** Audience scores (0-100%) + critic review lists with excerpts
- **URL patterns:**
  - `{slug}-broadway` (most common, tried first)
  - `{slug}-the-musical-broadway` (for musicals)
  - `{slug}` (can redirect to wrong shows - avoid!)
- **Technical:** Uses Playwright carousel scrolling to get ALL reviews (not just first 8)
- **Workflow:** `Update Show Score Data` or `Gather Review Data`

#### 2. DTLI - Did They Like It (didtheylikeit.com)
- **Best for:** Historical shows back to ~2000s, thumbs up/down sentiment
- **Provides:** Critic reviews with excerpts and thumbs (Up/Down/Meh)
- **URL pattern:** `didtheylikeit.com/shows/{show-name}/`
- **Coverage:** Excellent for older shows that may not be on Show Score
- **Workflow:** `Fetch Aggregator Pages` with aggregator=dtli

#### 3. BWW Review Roundups (BroadwayWorld)
- **Best for:** Comprehensive critic coverage, historical archives
- **Provides:** Review roundups with excerpts, links, often sentiment classification
- **URL pattern:** `broadwayworld.com/article/...Reviews-{SHOW-NAME}...`
- **Coverage:** Often has reviews from smaller outlets not on other aggregators
- **Workflow:** `Fetch Aggregator Pages` with aggregator=bww-rr

### Aggregator Archives

**ALL aggregator pages are archived locally** to avoid re-scraping:
```
data/aggregator-archive/
  show-score/      # ~41 shows archived
  dtli/            # ~41 shows archived
  bww-roundups/    # ~42 shows archived
```

**To archive pages for new shows:**
```bash
# Archive all three sources for missing shows
gh workflow run "Fetch Aggregator Pages" --field aggregator=all --field shows=missing

# Archive specific shows
gh workflow run "Fetch Aggregator Pages" --field aggregator=all --field shows=hamilton-2015,wicked-2003
```

**Scripts for extraction:**
- `scripts/extract-show-score-reviews.js` - Extract from Show Score HTML
- `scripts/extract-bww-reviews.js` - Extract from BWW Roundup HTML
- `scripts/gather-reviews.js` - Main script that searches all sources

### Show Score Technical Details

**URL Pattern Warning:** Always use `-broadway` suffix patterns first. URLs like `/broadway-shows/redwood` can redirect to `/off-off-broadway-shows/redwood` (a completely different show).

**Legacy files (for reference):**
- `data/show-score-urls.json` - Manual URL mappings (less needed now with auto-discovery)
- `data/show-score.json` - Legacy extracted data

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

### Data Quality Flags

Reviews may have these flags to indicate data quality issues:

| Flag | Purpose | Effect |
|------|---------|--------|
| `wrongProduction: true` | Review is from wrong production (e.g., off-Broadway run filed under Broadway) | Excluded from reviews.json |
| `wrongShow: true` | Review content is for a completely different show | Excluded from reviews.json |
| `isRoundupArticle: true` | Article reviews multiple shows (same URL legitimately in multiple show directories) | Included but flagged |
| `mergedFrom: [...]` | File was merged from duplicates | Tracks merge history |

**Common wrongProduction cases:**
- Hadestown: 37 reviews from 2016 NYTW off-Broadway run (Broadway opened 2019)
- Suffs: Reviews from 2022 Public Theater run (Broadway opened 2024)
- An Enemy of the People: Reviews from 2012 MTC revival

**wrongShow example:**
- `wicked-2003/newyorker--unknown.json` contained a review of "Cat on a Hot Tin Roof"

### Data Quality Fix Scripts

| Script | Purpose | Usage |
|--------|---------|-------|
| `scripts/fix-wrong-production-reviews.js` | Flags reviews from wrong productions | `--dry-run` first |
| `scripts/fix-url-outlet-mismatches.js` | Fixes files where outlet doesn't match URL domain | `--dry-run` first |
| `scripts/fix-url-duplicates-same-show.js` | Merges files with same URL in same show | `--dry-run` first |
| `scripts/fix-critic-name-duplicates.js` | Merges "jesse-green" and "jesse" variants | `--dry-run` first |
| `scripts/audit-scores.js` | Validates score conversions | Report only |
| `scripts/cleanup-duplicate-reviews.js` | Merges duplicate files | `--dry-run` first |

**Always run with `--dry-run` first to preview changes!**

### Common Data Issues & Fixes

**1. URL-Outlet Mismatches** (outlet doesn't match URL domain)
```
nydailynews--chris-jones.json with chicagotribune.com URL
→ Rename to chicagotribune--chris-jones.json
```
Run: `node scripts/fix-url-outlet-mismatches.js --dry-run`

**2. Same-URL Duplicates** (multiple files for same review)
```
amny--matt-windman.json and amny--unknown.json with same URL
→ Merge into single file, keep best data
```
Run: `node scripts/fix-url-duplicates-same-show.js --dry-run`

**3. Critic Name Variations** (partial names create duplicates)
```
nytimes--jesse-green.json and nytimes--jesse.json
→ Merge into canonical full-name version
```
This is handled by `scripts/lib/review-normalization.js` during extraction.

**4. Wrong Production Detection**
Reviews are flagged if `publishDate` predates show's `openingDate` by >6 months.
Check `data/shows.json` opening dates are correct first!

**Known date corrections:**
- Harry Potter: Opens 2018-04-22 (not 2021 - that was post-COVID reopen)

### Validation Checks

Run `node scripts/validate-data.js` before pushing. It checks:
- No duplicate shows (ID, slug, title)
- Required fields present
- No duplicate outlet+critic combos in reviews.json
- Review directories match show IDs
- Critic-outlet associations (warnings for unexpected combos - critics freelance)

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

# Broadway Scorecard Project Context

## CRITICAL RULES - READ FIRST

### 1. NEVER Ask User to Run Local Commands
The user is **non-technical and often on their phone**. They cannot run terminal commands.

- Make code changes and push to Git
- Create/update GitHub Actions for automation
- If something truly requires local execution, create a GitHub Action to do it

### 2. ALWAYS ASK: Quick Fix or Preview? (MANDATORY)

**Before making ANY code/design changes, Claude MUST ask:**

> "Is this a **quick fix** (ship directly to production) or do you want to **preview it first** (staging branch)?"

**User responses:**
- "Quick fix" / "Ship it" / "Just do it" → Work on `main`, push directly to production
- "Preview" / "Staging" / "Let me see it first" → Work on `staging` branch, provide preview URL

**Exceptions (don't need to ask):** Pure data updates, documentation changes, clearly broken bug fixes.

---

### 3. Git Workflow - Two Paths

#### Path A: Quick Fix (Direct to Production)
```
git checkout main && git pull origin main
# Make changes
git add -A && git commit -m "description" && git push origin main
# Vercel auto-deploys → Live in ~1 minute
```

#### Path B: Preview First (Staging Branch)
```
git checkout main && git pull origin main
git checkout -b staging
# Make changes
git add -A && git commit -m "description" && git push origin staging
# Vercel creates preview URL automatically
```

**After user approves:** `git checkout main && git merge staging && git push origin main` then delete staging branch (local + remote).

**Preview URLs:** `https://broadwayscore-git-staging-[username].vercel.app`

### 4. Vercel Deployment
**Production site:** https://broadwayscorecard.com (auto-deploys when `main` is pushed)

| Platform | Status | URL |
|----------|--------|-----|
| **Vercel** | PRIMARY | https://broadwayscorecard.com |
| GitHub Pages | Secondary/Legacy | https://thomaspryor.github.io/Broadwayscore/ |

**Production branch:** `main`

**NEVER:** Ask user to "create a PR" or create random feature branches (only `main` or `staging`).

### 5. Automate Everything
- Write scripts that run via GitHub Actions
- Create automation for any recurring task
- Never ask user to manually fetch data

### 6. NEVER Guess or Fake Data
- Never give approximate ranges - there's always a specific number
- Never claim to have verified something you couldn't access
- If you can't access a source, say so. If you don't know, say "I don't know."
- Always fetch and verify actual data before reporting numbers

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
- **Locally archived images** in `public/images/shows/`, CDN URL backups in `data/image-sources.json`. Open shows use native square thumbnails (1080x1080) from TodayTix API; closed shows use cropped-from-portrait squares via Contentful transforms
- **URL-based filtering** with shareable filter state

### Shows Database
- 27 currently open, 13 closed shows tracked
- Upcoming shows (status: "previews") with opening dates and preview start dates
- Full metadata: synopsis, cast, creative team, tags, age recommendations, theater addresses
- Ticket links for all open shows

## Scoring Methodology (V1 - Critics Only)

- **Composite Score = Critic Score** (tier-weighted average)
- **Tier 1** (NYT, Vulture, Variety): weight 1.0
- **Tier 2** (TheaterMania, NY Post): weight 0.70
- **Tier 3** (blogs, smaller sites): weight 0.40
- Each review: `assignedScore` (0-100), `originalRating` (e.g., "B+", "4 stars")
- Designation bumps: Critics_Pick +3, Critics_Choice +2, Recommended +2

**V2 planned:** Audience Score 35%, Buzz Score 15%, confidence badges.

## Data Structure

```
data/
  shows.json                      # Show metadata
  reviews.json                    # Critic reviews with scores
  grosses.json                    # Box office data (weekly + all-time)
  grosses-history.json            # 55+ weeks historical grosses for WoW/YoY
  commercial.json                 # Financial/recoupment data
  audience-buzz.json              # Audience Buzz (Show Score, Mezzanine, Reddit)
  critic-consensus.json           # LLM-generated editorial summaries
  new-shows-pending.json          # New shows awaiting review data
  historical-shows-pending.json   # Historical shows awaiting metadata
  image-sources.json              # Backup of original CDN URLs
  review-texts/{show-id}/         # Individual review JSON files
    {outlet}--{critic}.json       # e.g., nytimes--ben-brantley.json
  aggregator-archive/             # Archived HTML from aggregator sites
    show-score/ | dtli/ | bww-roundups/
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

**Status values:** `"open"` (running), `"previews"` (opening date in future), `"closed"` (closed)

### Grosses Schema (grosses.json)
```typescript
{
  lastUpdated: string, weekEnding: string,
  shows: {
    [slug: string]: {
      thisWeek?: {  // Only for currently running shows
        gross, grossPrevWeek, grossYoY,
        capacity, capacityPrevWeek, capacityYoY,  // YoY enriched from history
        atp, atpPrevWeek, atpYoY,                 // WoW/YoY enriched from history
        attendance, performances
      },
      allTime: { gross, performances, attendance }  // All shows including closed
    }
  }
}
```

**From BroadwayWorld:** Gross (current/prev/YoY), Capacity (current/prev), ATP (current only), all-time stats.
**Self-computed from grosses-history.json:** Capacity YoY, ATP WoW, ATP YoY. The `scrape-grosses.ts` script runs weekly, enriches grosses.json from history, and saves current week's snapshot.

### Audience Buzz Schema (audience-buzz.json)
```typescript
{
  shows: {
    [showId]: {
      designation: "Loving" | "Liking" | "Shrugging" | "Loathing",
      // Thresholds: Loving 88+, Liking 78-87, Shrugging 68-77, Loathing 0-67
      combinedScore: number,
      sources: {
        showScore?: { score, reviewCount },
        mezzanine?: { score, reviewCount, starRating },
        reddit?: { score, reviewCount, sentiment: { enthusiastic, positive, mixed, negative }, positiveRate }
      }
    }
  }
}
```

**Weighting:** Reddit fixed 20% when available. Show Score & Mezzanine split remaining 80% (or 100%) proportionally by sample size.

**Sources:** Show Score (weekly automated, 0-100), Mezzanine (manual, star ratings), Reddit r/Broadway (monthly automated, sentiment analysis).

### Commercial Data Schema (commercial.json)
```typescript
{
  shows: {
    [showId]: {
      title, weeklyRunningCost, weeklyRunningCostRange?: { min, max },
      capitalization, recouped, recoupedDate,
      estimatedRecoupmentPct, profitMargin,
      costMethodology: string,  // See methodology table below
      sources: [{ type: "reddit"|"trade"|"sec"|"manual", url, date, excerpt? }],
      deepResearch?: { verifiedFields: string[], verifiedDate, verifiedBy, notes? },
      lastUpdated
    }
  }
}
```

**Cost Methodology values:**

| Methodology | Reliability | Notes |
|-------------|-------------|-------|
| `reddit-standard` | Medium | May exclude theater's ~9% cut, producer fee, royalty pools |
| `trade-reported` | High | From Deadline, Variety, Broadway News |
| `sec-filing` | Very High | Official SEC Form D filings |
| `producer-confirmed` | Very High | Direct confirmation |
| `deep-research` | Very High | Multi-source verified |
| `industry-estimate` | Low | Based on comparable shows |

**Deep Research Protection:** Shows with `deepResearch.verifiedFields` are protected from automated overwrites. Automated changes to verified fields are blocked and a GitHub issue is created for manual review. Protected shows: death-becomes-her, the-great-gatsby, stranger-things, operation-mincemeat, just-in-time, all-out.

**Key automation files:** `scripts/update-commercial-data.js` (main), `scripts/lib/deep-research-guardian.js`, `scripts/lib/source-validator.js`, `scripts/lib/parse-grosses.js`, `scripts/lib/trade-press-scraper.js`, `scripts/lib/sec-edgar-scraper.js`.

## Key Files

**App:**
- `src/lib/engine.ts` - Scoring engine + TypeScript interfaces
- `src/lib/data.ts` - Data loading layer (includes grosses data functions)
- `src/app/page.tsx` - Homepage with show grid
- `src/app/show/[slug]/page.tsx` - Individual show pages
- `src/config/scoring.ts` - Scoring rules, tier weights, outlet mappings
- `src/config/commercial.ts` - **Single source of truth** for commercial designations (colors, sort orders, icons, badge styles). All biz components import from here.
- `src/components/BoxOfficeStats.tsx` - Box office stats display
- `src/components/ShowImage.tsx` - Image component with cascading source fallback

**Scripts:**
- `scripts/discover-new-shows.js` - Broadway.org show discovery (daily)
- `scripts/lib/deduplication.js` - Centralized show deduplication (9 checks)
- `scripts/lib/review-normalization.js` - Outlet/critic name normalization
- `scripts/scrape-grosses.ts` - BroadwayWorld weekly grosses + history enrichment
- `scripts/validate-data.js` - **Run before pushing** - validates shows.json + reviews.json
- `scripts/gather-reviews.js` - Main review gathering from all aggregator sources
- `scripts/collect-review-texts.js` - Full review text scraper with multi-tier fallback
- `scripts/rebuild-show-reviews.js` - Rebuilds reviews.json from review-texts data
- `scripts/update-commercial-data.js` - Weekly commercial data automation
- `scripts/generate-critic-consensus.js` - LLM editorial summaries
- `scripts/fetch-show-images-auto.js` - Image fetcher: TodayTix API (open shows) → page scrape → Playbill fallback
- `scripts/archive-show-images.js` - Downloads CDN images to local WebP files

**Tests:**
- `tests/unit/` - Unit tests (parse-grosses, commercial filtering, source-validator, etc.)
- `tests/e2e/` - Playwright E2E tests (homepage, show pages, biz-buzz)

### Show Deduplication System

`scripts/lib/deduplication.js` prevents duplicate shows via 9 checks: exact title/slug match, ID base match, known duplicate patterns (50+ shows), normalized title, slug prefix, same venue + similar title, title containment, fuzzy matching (Levenshtein). Add new patterns to `KNOWN_DUPLICATES` map in the file.

### Review Normalization System

`scripts/lib/review-normalization.js` prevents duplicate review files by normalizing outlet/critic names. Key functions: `normalizeOutlet()`, `normalizeCritic()`, `generateReviewFilename()`, `areCriticsSimilar()`. Add new aliases to `OUTLET_ALIASES` (40+ variations) or `CRITIC_ALIASES` (30+ variations) in the file.

### Review Data Quality

In Jan 2026, we discovered 147 misattributed reviews (7%) where critics were incorrectly attributed to wrong outlets. `validate-data.js` now catches these. **Always run validation after bulk data changes.**

### Text Quality Classification

`collect-review-texts.js` classifies scraped text quality and strips trailing junk:

**Quality levels:**
- `full` - >1500 chars, mentions show title, >300 words, no truncation signals
- `partial` - 500-1500 chars or larger but missing criteria
- `truncated` - Has paywall/login text, "read more" prompts, or severe signals
- `excerpt` - <500 chars

**Automatic junk stripping:** Removes newsletter promos (TheaterMania), login prompts (BroadwayNews), "Read more" links (amNY), signup forms (Vulture/NY Mag) from end of scraped text.

**Legitimate endings recognized:** Theater addresses, URLs, production credits, ticket info - these don't trigger false truncation.

**Truncation signals detected:**
- `has_paywall_text` - "subscribe", "sign in", "members only"
- `has_read_more_prompt` - "continue reading", "read more"
- `has_footer_text` - "privacy policy", "terms of use"
- `shorter_than_excerpt` - fullText shorter than aggregator excerpt
- `no_ending_punctuation` - Doesn't end with .!?"')
- `possible_mid_word_cutoff` - Ends with lowercase letter

**Automated quality checks:**
- `scripts/audit-text-quality.js` - Runs in CI, enforces thresholds (35% full, <40% truncated, <5% unknown)
- Quality classification happens automatically during `collect-review-texts.js`
- `review-refresh.yml` now rebuilds `reviews.json` after collecting new reviews

## Automated Testing

**Always run `node scripts/validate-data.js` before pushing changes to shows.json.** If validation fails, do not push.

**Build-time gate:** `scripts/validate-shows-prebuild.js` runs before every Vercel build and blocks deployment if duplicate shows exist in `shows.json`. This is the last line of defense — no duplicate can go live regardless of how it was introduced.

```bash
npm run test:data    # Data validation only (fast)
npm run test:e2e     # E2E browser tests
npm run test         # All tests
```

Tests run automatically on push to `main` and daily. On failure, a GitHub issue is created.

## Automation (GitHub Actions)

All automation runs via GitHub Actions - no local commands needed. See `.github/workflows/CLAUDE.md` for individual workflow descriptions.

### Data Sync Architecture

**Source of truth:** `data/review-texts/{show-id}/*.json` (individual review files)
**Derived file:** `data/reviews.json` (aggregated for website consumption)

| Workflow | Modifies review-texts | Rebuilds reviews.json | Notes |
|----------|----------------------|----------------------|-------|
| `rebuild-reviews.yml` | ❌ | ✅ | **PRIMARY sync** - daily 4 AM UTC + manual trigger |
| `review-refresh.yml` | ✅ | ✅ | Weekly extraction + rebuild |
| `gather-reviews.yml` | ✅ | ❌ | Parallel-safe, relies on daily rebuild |
| `collect-review-texts.yml` | ✅ | ❌ | Parallel-safe, relies on daily rebuild |
| `fetch-guardian-reviews.yml` | ✅ | ✅ | Single-threaded, rebuilds inline |
| `process-review-submission.yml` | ✅ | ✅ | Single-threaded, rebuilds inline |

**For bulk imports (100s of shows):** Run parallel gather-reviews workflows, then trigger manual rebuild:
```bash
gh workflow run "Rebuild Reviews Data" -f reason="Post bulk import sync"
```

**Why this architecture?** Parallel workflows (gather-reviews, collect-review-texts) can't rebuild `reviews.json` without merge conflicts. They write only to their show-specific `review-texts/` directory. The daily rebuild consolidates all changes, and manual trigger allows immediate sync after bulk work.

### CRITICAL: GitHub Secrets in Workflows

**Secrets are NOT automatically available to scripts.** You MUST explicitly pass them via `env:` blocks.

```yaml
# WRONG - Secret exists but script can't see it
- name: Run script
  run: node scripts/my-script.js

# CORRECT - Secret is passed as environment variable
- name: Run script
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
  run: node scripts/my-script.js
```

**Available secrets:**

| Secret | Purpose |
|--------|---------|
| `ANTHROPIC_API_KEY` | Claude API for AI features |
| `OPENAI_API_KEY` | GPT-4o for ensemble scoring |
| `GEMINI_API_KEY` | Gemini 2.0 Flash for 3-model ensemble (optional) |
| `BRIGHTDATA_TOKEN` | Web scraping (primary) |
| `SCRAPINGBEE_API_KEY` | Web scraping (fallback) |
| `BROWSERBASE_API_KEY` | Managed browser cloud with CAPTCHA solving ($0.10/session) |
| `BROWSERBASE_PROJECT_ID` | Browserbase project identifier |
| `FORMSPREE_TOKEN` | Feedback form |

**When creating/editing workflows:** Always check if the script needs API keys and add the appropriate `env:` block.

## Broadway Investment Tracker (`/biz`)

Dedicated section for recoupment tracking and investment analysis.

**Routes:**
- `/biz` - Dashboard with season stats, recent developments, approaching recoupment, at-risk shows
- `/biz/season/[season]` - Season detail pages (auto-generated via `getSeasonsWithCommercialData()`)

**Key patterns:**
- **Seasons are dynamic** - discovered from `commercial.json` data, not hardcoded
- **`calculateWeeksToRecoup(openingDate, recoupedDate)`** in `data.ts` is the source of truth for recoupment weeks
- **`recouped: true` requires `recoupedDate`** - validation enforces this
- **"Current season" filter** computes dynamically (Sept = new season start)
- **Centralized config** - All designation colors/icons/badges in `src/config/commercial.ts`

**Components:** `src/components/biz/` (AllShowsTable, SeasonStatsCard, ApproachingRecoupmentCard, AtRiskCard, RecoupmentTable, RecentDevelopmentsList, DesignationLegend)

## Box Office Stats

Show pages display box office data: THIS WEEK row (Gross with WoW/YoY arrows, Capacity %, ATP) and ALL TIME row (Total Gross, Performances, Attendance). Component: `src/components/BoxOfficeStats.tsx`, data functions in `src/lib/data.ts`.

## Web Scraping

Scripts use `scripts/lib/scraper.js` with automatic fallback: Bright Data (primary) → ScrapingBee → Playwright. Credentials stored as GitHub Secrets (never in code). MCP servers (Bright Data, ScrapingBee, Playwright) configured in `.mcp.json` for local Claude Code use.

### Three Aggregator Sources

Use ALL THREE for comprehensive review coverage - each has different historical coverage:

1. **Show Score** (show-score.com) - Best for recent shows (2015+). URL: `{slug}-broadway` (always try `-broadway` suffix first to avoid off-broadway redirects)
2. **DTLI** (didtheylikeit.com) - Excellent historical coverage back to ~2000s. URL: `didtheylikeit.com/shows/{show-name}/`
3. **BWW Review Roundups** - Reviews from smaller outlets not on other aggregators. URL: search BroadwayWorld.

Archives stored in `data/aggregator-archive/`. Extraction scripts: `scripts/extract-show-score-reviews.js`, `scripts/extract-bww-reviews.js`.

## Review Data Schema

Each review file in `data/review-texts/{showId}/{outletId}--{criticName}.json`:

```json
{
  "showId", "outletId", "outlet", "criticName", "url", "publishDate",
  "fullText": "..." or null,
  "isFullReview": true/false,
  "dtliExcerpt", "bwwExcerpt", "showScoreExcerpt",
  "assignedScore": 78,
  "source": "dtli|bww-roundup|playwright-scraped|webfetch-scraped|manual",
  "dtliThumb": "Up/Down/Meh",
  "bwwThumb": "Up/Down/Meh"
}
```

**Data quality flags:** `wrongProduction: true` (e.g., off-Broadway run), `wrongShow: true` (different show entirely), `isRoundupArticle: true` (multi-show article). Wrong production/show reviews are excluded from reviews.json.

**Known date corrections:** Harry Potter opens 2018-04-22 (not 2021 post-COVID reopen).

## Subscription Access for Paywalled Sites

| Site | GitHub Secret Names |
|------|---------------------|
| New York Times | NYT_EMAIL, NYTIMES_PASSWORD |
| Vulture/NY Mag/New Yorker | VULTURE_EMAIL, VULTURE_PASSWORD |
| Wall Street Journal | WSJ_EMAIL, WSJ_PASSWORD |
| Washington Post | WAPO_EMAIL, WASHPOST_PASSWORD |

`collect-review-texts.js` automatically logs in using these credentials.

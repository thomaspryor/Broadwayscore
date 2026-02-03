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
- **Unified letter grade → score mapping** (used across all three code locations):
  A+=97, A=93, A-=90, B+=87, B=83, B-=78, C+=72, C=65, C-=58, D+=40, D=35, D-=30, F=20
  Source of truth: `src/config/scoring.ts` LETTER_GRADE_MAP (also duplicated in `scripts/rebuild-all-reviews.js`)

**V2 planned:** Audience Score 35%, Buzz Score 15%, confidence badges.

## Data Structure

> **For querying data**, use the SQLite query layer instead of writing one-off scripts. See [SQLite Query Layer](#sqlite-query-layer) below.

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
  critic-registry.json              # Auto-generated critic-outlet affinity data
  review-texts/{show-id}/         # Individual review JSON files (versioned IDs, e.g., bug-2026/)
    {outlet}--{critic}.json       # e.g., nytimes--ben-brantley.json
  audit/                           # Audit reports (auto-generated)
    critic-outlet-affinity.json    # Flagged reviews + freelancer list
    validation-baseline.json       # Previous validation counts (auto-written by validate-data.js)
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
      designation: "Loving" | "Liking" | "Shrugging" | "Loathing",  // Legacy field, still in data file
      // UI displays letter grades (A+ through F) computed from combinedScore via getAudienceGrade()
      // Labels: A+/A = "Loving It", A-/B+ = "Liking It", B/B- = "Shrugging", C+ and below = "Loathing It"
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
- `scripts/discover-new-shows.js` - Broadway.org show discovery (daily), enriches dates from IBDB
- `scripts/lib/deduplication.js` - Centralized show deduplication (9 checks)
- `scripts/lib/review-normalization.js` - Outlet/critic name normalization
- `scripts/lib/text-cleaning.js` - Centralized text cleaning (HTML entity decoding, cross-reference stripping, junk stripping)
- `scripts/lib/content-quality.js` - Text quality classification + garbage detection
- `scripts/lib/ibdb-dates.js` - IBDB date lookup module (preview, opening, closing dates)
- `scripts/enrich-ibdb-dates.js` - Standalone IBDB date enrichment (`--dry-run`, `--verify`, `--force`, `--show=SLUG`)
- `scripts/scrape-grosses.ts` - BroadwayWorld weekly grosses + history enrichment
- `scripts/validate-data.js` - **Run before pushing** - validates shows.json + reviews.json. Uses dynamic thresholds from `data/audit/validation-baseline.json` (auto-written on success)
- `scripts/audit-critic-outlets.js` - Generates critic-outlet affinity registry from corpus (`npm run audit:critics`)
- `scripts/gather-reviews.js` - Main review gathering from all aggregator sources
- `scripts/collect-review-texts.js` - Full review text scraper with declarative tier chain (see architecture below)
- `scripts/rebuild-all-reviews.js` - Rebuilds reviews.json from review-texts data (source of truth for scoring pipeline)
- `scripts/update-commercial-data.js` - Weekly commercial data automation
- `scripts/generate-critic-consensus.js` - LLM editorial summaries
- `scripts/fetch-show-images-auto.js` - Image fetcher: TodayTix API (open shows) → page scrape → Playbill fallback
- `scripts/archive-show-images.js` - Downloads CDN images to local WebP files
- `scripts/scrape-nysr-reviews.js` - NYSR full text + star ratings via WordPress API
- `scripts/scrape-playbill-verdict.js` - Playbill Verdict review URL discovery
- `scripts/scrape-nyc-theatre-roundups.js` - NYC Theatre excerpt extraction (2023+ shows)
- `scripts/lib/show-matching.js` - Shared title→show matching utility
- `scripts/audit-content-quality.js` - Deep content audit: fabricated URLs, wrong-production content, critic mismatches, domain mismatches, cross-show duplicate URLs, excerpt-as-fullText, generic URLs. Run manually after bulk data changes.
- `scripts/build-sqlite.js` - Builds SQLite query database from JSON files (`npm run db:build`)
- `scripts/query.js` - Ad-hoc SQL queries against SQLite database (`npm run db:query`)
- `scripts/schema.sql` - SQLite schema definition (tables, indexes, views)

**Tests:**
- `tests/unit/` - Unit tests (parse-grosses, commercial filtering, source-validator, etc.)
- `tests/e2e/` - Playwright E2E tests (homepage, show pages, biz-buzz)

### SQLite Query Layer

A read-only SQLite database (`data/broadway.db`) built from the JSON source files. Use it for data analysis, auditing, and ad-hoc queries instead of writing one-off scripts or scanning thousands of files.

**The database is ephemeral** — gitignored, never committed, rebuilt from JSON on demand. JSON files remain the source of truth. The website does not use SQLite.

```
JSON source files ──build-sqlite.js──► broadway.db (ephemeral, read-only)
                                            │
     ┌──────────────────────────────────────┤
     ▼                    ▼                 ▼
 audit scripts      validate-data.js   ad-hoc queries (Claude Code)
```

**Setup:** `npm run db:build` (rebuilds in ~0.1s, creates ~2.3MB file)

**Querying:**
```bash
node scripts/query.js "SELECT COUNT(*) FROM reviews"
node scripts/query.js "SELECT critic_name, COUNT(*) c FROM reviews GROUP BY critic_name ORDER BY c DESC LIMIT 10"
node scripts/query.js "SELECT * FROM content_quality_summary ORDER BY total DESC LIMIT 10"
node scripts/query.js "SELECT * FROM duplicate_urls"
node scripts/query.js "SELECT content_tier, COUNT(*) FROM review_texts GROUP BY content_tier"
```

**Tables:** `shows`, `reviews`, `review_texts`, `commercial`, `grosses`, `audience_buzz`, `critic_registry`

**Built-in views:** `duplicate_urls`, `content_quality_summary`, `critic_outlet_activity`, `scoring_stats`, `duplicate_outlet_critic`

**When to rebuild:** Run `npm run db:build` after any JSON data changes (new reviews, show updates, bulk imports) and before running any queries. Claude Code sessions should do this automatically — rebuild the DB after data modifications and before any analytical queries. Use `npm run db:build:full` to include fullText fields (~23MB).

**Key files:**
- `scripts/schema.sql` - Schema definition (tracked in git)
- `scripts/build-sqlite.js` - Build script (atomic writes, integrity check)
- `scripts/query.js` - CLI query wrapper (read-only, integrity check on open)

### IBDB Date Enrichment

`scripts/lib/ibdb-dates.js` looks up preview, opening, and closing dates from IBDB. Also extracts creative team (15 role patterns). Used by `discover-new-shows.js`, `discover-historical-shows.js`, and standalone `enrich-ibdb-dates.js` (`--dry-run`, `--show=SLUG`, `--missing-only`, `--verify`, `--force`, `--status=`). If IBDB succeeds, its opening date overwrites Broadway.org's ambiguous "Begins:" date. If it fails, "Begins:" becomes `previewsStartDate`.

> **Details:** `docs/CLAUDE-REFERENCE.md` § "IBDB Date Enrichment" — SERP fallback chain, creative team parsing, integration behavior.

### Review-Text Directory Convention

Review-text directories use **versioned show IDs** matching `shows.json` (e.g., `data/review-texts/bug-2026/`, not `data/review-texts/bug/`). All scripts that write review files (`gather-reviews.js`, `collect-review-texts.js`) use the show's `id` field from `shows.json` as the directory name.

### Show Deduplication System

`scripts/lib/deduplication.js` prevents duplicate shows via 9 checks: exact title/slug match, ID base match, known duplicate patterns (50+ shows), normalized title, slug prefix, same venue + similar title, title containment, fuzzy matching (Levenshtein). Add new patterns to `KNOWN_DUPLICATES` map in the file.

### Review Normalization System

`scripts/lib/review-normalization.js` prevents duplicate review files by normalizing outlet/critic names. Key functions: `normalizeOutlet()`, `normalizeCritic()`, `generateReviewFilename()`, `areCriticsSimilar()`, `validateCriticOutlet()`. Add new aliases to `OUTLET_ALIASES` (40+ variations) or `CRITIC_ALIASES` (30+ variations) in the file.

Includes automatic outlet-critic concatenation stripping, first-name prefix dedup (in both `gather-reviews.js` and `rebuild-all-reviews.js`), and critic-outlet validation against the auto-generated registry.

> **Details:** `docs/CLAUDE-REFERENCE.md` § "Review Normalization Internals".

### Review Data Quality

In Jan 2026, we discovered 147 misattributed reviews (7%) where critics were incorrectly attributed to wrong outlets. `validate-data.js` now catches these. **Always run validation after bulk data changes.**

### Critic-Outlet Misattribution Detection

Auto-generated system using `data/critic-registry.json` (106 critics, 31 freelancers). `validate-data.js` catches misattributions; `gather-reviews.js` warns on suspicious pairings. Registry auto-regenerates during daily rebuild. Freelancers (3+ outlets or no single outlet >70%) are never flagged.

> **Details:** `docs/CLAUDE-REFERENCE.md` § "Critic-Outlet Misattribution System" — full detection pipeline, confidence levels, files.

### Text Quality Classification

**Canonical system:** `contentTier` (5-tier) in `scripts/lib/content-quality.js`. Called by `collect-review-texts.js`, `gather-reviews.js`, `rebuild-all-reviews.js`.

**Tiers:** `complete` (full review), `truncated` (paywall/cutoff), `excerpt` (aggregator excerpt only), `stub` (<150 words), `invalid` (garbage). Three paths to "complete": standard (300+ words), long text (500+), or short-but-complete (150+ with opinion language).

**Legacy:** `textQuality` (4-tier: full/partial/truncated/excerpt) also written to files but `contentTier` is canonical.

**Junk handling:** Automatic stripping of newsletter promos, login prompts, signup forms. Garbage detection guards prevent false positives on legitimate reviews.

> **Details:** `docs/CLAUDE-REFERENCE.md` § "Text Quality Classification" — complete path logic, truncation signals, garbage guards, legacy system.

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
| `gather-reviews.yml` | ✅ | ✅ | Rebuilds inline after commit |
| `collect-review-texts.yml` | ✅ | ✅ | Nightly 2 AM UTC + manual. Single-job rebuilds inline; parallel triggers `rebuild-reviews.yml` after all jobs complete |
| `fetch-guardian-reviews.yml` | ✅ | ✅ | Single-threaded, rebuilds inline |
| `process-review-submission.yml` | ✅ | ✅ | Single-threaded, rebuilds inline |
| `adjudicate-review-queue.yml` | ✅ | ❌ | Daily 5 AM UTC, triggers rebuild after commit |

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

### Local API Keys

**All API keys are also available locally** in the `.env` file at the project root. When running scripts locally or calling external APIs (OpenAI, Gemini, ScrapingBee, etc.), source this file first:

```bash
source /Users/tompryor/Broadwayscore/.env
```

This file contains the same keys listed in the GitHub Secrets table above. **Do not claim keys are unavailable locally** — they are in `.env`.

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

### Five Aggregator Sources

Use ALL FIVE for comprehensive review coverage - each has different historical coverage:

1. **Show Score** (show-score.com) - Best for recent shows (2015+). URL: `{slug}-broadway` (always try `-broadway` suffix first to avoid off-broadway redirects)
2. **DTLI** (didtheylikeit.com) - Excellent historical coverage back to ~2000s. URL: `didtheylikeit.com/shows/{show-name}/`
3. **BWW Review Roundups** - Reviews from smaller outlets not on other aggregators. URL: search BroadwayWorld.
4. **Playbill Verdict** (playbill.com/category/the-verdict) - Discovers review URLs from many outlets. Script: `scripts/scrape-playbill-verdict.js`. Google fallback for shows not on category page.
5. **NYC Theatre Roundups** (newyorkcitytheatre.com) - Excerpts for paywalled reviews from 2023+ shows. Script: `scripts/scrape-nyc-theatre-roundups.js`. Google discovery for roundup page URLs.

Archives stored in `data/aggregator-archive/`. Extraction scripts: `scripts/extract-show-score-reviews.js`, `scripts/extract-bww-reviews.js`.

### Outlet-Specific Scrapers

Unlike aggregators (which collect reviews from many outlets), outlet-specific scrapers target a single publication to fill coverage gaps:

- **NYSR** (nystagereview.com) - WordPress REST API (`/wp-json/wp/v2/posts?categories=1`). Script: `scripts/scrape-nysr-reviews.js`. Fetches full text + star ratings for all Broadway reviews. Star ratings are in `excerpt.rendered`, not content body. Cross-reference lines (`[Read X's ★★★★☆ review here.]`) are stripped at three levels: (1) `scrape-nysr-reviews.js` at scrape time, (2) `text-cleaning.js:stripCrossReferences()` in `cleanText()`, (3) `rebuild-all-reviews.js:extractExplicitRating()` before star extraction.

### Shared Title Matching

`scripts/lib/show-matching.js` provides `matchTitleToShow(externalTitle, showsData)` for matching external show titles (from aggregators, APIs) to shows.json entries. Used by NYSR, Playbill Verdict, and NYC Theatre scrapers. Handles aliases, slug matching, normalized titles, title variants (stripping subtitles after colons/dashes), and partial containment. Returns match with confidence level (high/medium/low).

## Review Data Schema

Each review file in `data/review-texts/{showId}/{outletId}--{criticName}.json`:

```json
{
  "showId", "outletId", "outlet", "criticName", "url", "publishDate",
  "fullText": "..." or null,
  "isFullReview": true/false,
  "dtliExcerpt", "bwwExcerpt", "showScoreExcerpt", "nycTheatreExcerpt",
  "assignedScore": 78,
  "humanReviewScore": 48,
  "humanReviewNote": "Explanation of why manual override was needed",
  "source": "dtli|bww-roundup|playbill-verdict|nyc-theatre|nysr|playwright-scraped|webfetch-scraped|manual",
  "dtliThumb": "Up/Down/Meh",
  "bwwThumb": "Up/Down/Meh"
}
```

**Data quality flags:** `wrongProduction: true` (e.g., off-Broadway run), `wrongShow: true` (different show entirely), `isRoundupArticle: true` (multi-show article). Wrong production/show reviews are excluded from reviews.json.

**Known date corrections:** Harry Potter opens 2018-04-22 (not 2021 post-COVID reopen).

**Wrong-production prevention:** Three layers (`gather-reviews.js` production-verifier, `scrape-playbill-verdict.js` title+URL-year filters, `collect-review-texts.js` post-scrape date check) prevent wrong-production/wrong-show content. Year gap thresholds: >3 years before or >2 years after opening.

**Off-Broadway transfers:** 18 reviews flagged `wrongProduction: true` are reusable when adding off-Broadway entries (Hamilton, Stereophonic, Great Gatsby, Illinoise, Oh Mary!).

> **Details:** `docs/CLAUDE-REFERENCE.md` § "Wrong-Production Prevention Guards" and "Off-Broadway Transfer Reviews".

## Subscription Access for Paywalled Sites

| Site | GitHub Secret Names |
|------|---------------------|
| New York Times | NYT_EMAIL, NYTIMES_PASSWORD |
| Vulture/NY Mag/New Yorker | VULTURE_EMAIL, VULTURE_PASSWORD |
| Wall Street Journal | WSJ_EMAIL, WSJ_PASSWORD |
| Washington Post | WAPO_EMAIL, WASHPOST_PASSWORD |

`collect-review-texts.js` automatically logs in using these credentials.

**Credential note:** WSJ and NYT are untestable in CI (anti-bot blocking). Use Browserbase tier for actual collection.

### Full Text Collection

`collect-review-texts.js` uses a declarative tier chain: Archive.org → Playwright → Browserbase ($0.10/session) → ScrapingBee → Bright Data → Archive.org CDX → final fallback. Low success rates are normal (many dead URLs). Nightly cron processes ~100 reviews with Browserbase enabled.

**Commands:** `gh workflow run "Collect Review Texts" -f show_filter=SHOW_ID -f max_reviews=0` (per-show) or `-f content_tier=truncated` (by tier: `excerpt`, `truncated`, `needs-rescrape`).

> **Details:** `docs/CLAUDE-REFERENCE.md` § "Full Text Collection Architecture" — tier chain internals, CDX multi-snapshot, credential status, Browserbase routing, collection status counts.

## Scoring & Data Quality Summary

All major data quality issues from the Jan-Feb 2026 audit are **FIXED**. Current audit baseline: 17 legitimate flags (long-running show re-reviews, freelancer syndication, roundup articles).

**Scoring hierarchy:** Priority 0 (explicit ratings) → 0.5 (humanReviewScore) → 0b (originalScore) → 1 (LLM ensemble) → 2 (thumb override) → 3 (LLM fallback). Excerpt-only reviews auto-downgraded to low confidence.

**LLM ensemble scoring:** ~0.66 min/review, max safe batch ~400, ~$0.045/review. Git checkpointing every 100 reviews. Trigger: `llm-ensemble-score.yml`.

**Human review queue:** `data/audit/needs-human-review.json` — 2 reviews remaining. Automated adjudication runs daily at 5 AM UTC (`adjudicate-review-queue.yml`).

**Re-scraping queue:** ~704 reviews need fullText (568 free-site, 136 paywalled). Nightly cron handles collection.

**Content quality audit:** Run `node scripts/audit-content-quality.js` after bulk data changes.

> **Details:** `docs/CLAUDE-REFERENCE.md` — see sections: "Scoring Pipeline Internals", "LLM Ensemble Scoring Constraints", "Known Audit Flags", "Remaining Data Quality Work", "Fixed Data Quality Issues".

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
- `scripts/validate-data.js` - **Run before pushing** - validates shows.json + reviews.json
- `scripts/audit-critic-outlets.js` - Generates critic-outlet affinity registry from corpus (`npm run audit:critics`)
- `scripts/gather-reviews.js` - Main review gathering from all aggregator sources
- `scripts/collect-review-texts.js` - Full review text scraper with multi-tier fallback
- `scripts/rebuild-show-reviews.js` - Rebuilds reviews.json from review-texts data
- `scripts/update-commercial-data.js` - Weekly commercial data automation
- `scripts/generate-critic-consensus.js` - LLM editorial summaries
- `scripts/fetch-show-images-auto.js` - Image fetcher: TodayTix API (open shows) → page scrape → Playbill fallback
- `scripts/archive-show-images.js` - Downloads CDN images to local WebP files
- `scripts/scrape-nysr-reviews.js` - NYSR full text + star ratings via WordPress API
- `scripts/scrape-playbill-verdict.js` - Playbill Verdict review URL discovery
- `scripts/scrape-nyc-theatre-roundups.js` - NYC Theatre excerpt extraction (2023+ shows)
- `scripts/lib/show-matching.js` - Shared title→show matching utility

**Tests:**
- `tests/unit/` - Unit tests (parse-grosses, commercial filtering, source-validator, etc.)
- `tests/e2e/` - Playwright E2E tests (homepage, show pages, biz-buzz)

### IBDB Date Enrichment

`scripts/lib/ibdb-dates.js` looks up preview, opening, and closing dates from IBDB (Internet Broadway Database). IBDB has separate "1st Preview" and "Opening Date" fields, unlike Broadway.org which only has an ambiguous "Begins:" date.

**How it works:** Google SERP search (`site:ibdb.com/broadway-production`) → ScrapingBee premium proxy to fetch production page HTML → JSDOM text extraction → regex date parsing.

**Fallback chain for search:** ScrapingBee Google SERP → Bright Data SERP → direct URL construction from title slug.

**Integration with discovery:** Both `discover-new-shows.js` and `discover-historical-shows.js` enrich dates from IBDB after discovering shows. If IBDB lookup succeeds, its opening date overwrites Broadway.org's "Begins:" date. If IBDB fails, Broadway.org's "Begins:" is treated as `previewsStartDate` (not `openingDate`).

**Standalone enrichment:** `node scripts/enrich-ibdb-dates.js` with flags: `--dry-run`, `--show=SLUG`, `--missing-only` (default), `--verify` (compare only), `--force` (overwrite), `--status=open|previews|closed`.

### Review-Text Directory Convention

Review-text directories use **versioned show IDs** matching `shows.json` (e.g., `data/review-texts/bug-2026/`, not `data/review-texts/bug/`). All scripts that write review files (`gather-reviews.js`, `collect-review-texts.js`) use the show's `id` field from `shows.json` as the directory name.

### Show Deduplication System

`scripts/lib/deduplication.js` prevents duplicate shows via 9 checks: exact title/slug match, ID base match, known duplicate patterns (50+ shows), normalized title, slug prefix, same venue + similar title, title containment, fuzzy matching (Levenshtein). Add new patterns to `KNOWN_DUPLICATES` map in the file.

### Review Normalization System

`scripts/lib/review-normalization.js` prevents duplicate review files by normalizing outlet/critic names. Key functions: `normalizeOutlet()`, `normalizeCritic()`, `generateReviewFilename()`, `areCriticsSimilar()`, `validateCriticOutlet()`. Add new aliases to `OUTLET_ALIASES` (40+ variations) or `CRITIC_ALIASES` (30+ variations) in the file.

**Outlet-critic concatenation handling:** `normalizeOutlet()` automatically strips critic names from concatenated outlet IDs (e.g., `variety-frank-rizzo` → `variety`, `new-york-magazinevulture-sara-holdren` → `vulture`). This catches upstream data sources that merge outlet and critic names.

**First-name prefix dedup:** `gather-reviews.js` checks if an incoming critic's name is a first-name prefix of an existing critic at the same outlet (e.g., incoming "Jesse" at nytimes matches existing "Jesse Green"). Merges into the existing file instead of creating a duplicate. `rebuild-all-reviews.js` also has prefix dedup as a safety net when building reviews.json, skipping entries where one critic key is a prefix of another at the same outlet.

### Review Data Quality

In Jan 2026, we discovered 147 misattributed reviews (7%) where critics were incorrectly attributed to wrong outlets. `validate-data.js` now catches these. **Always run validation after bulk data changes.**

### Critic-Outlet Misattribution Detection

Auto-generated system to catch when reviews are attributed to the wrong outlet. No manual database maintenance — everything is derived from the corpus.

**How it works:**
1. `scripts/audit-critic-outlets.js` scans all `review-texts/` files, builds per-critic outlet frequency stats, writes `data/critic-registry.json` (106 critics with 3+ reviews, 31 freelancers identified)
2. `validateCriticOutlet(critic, outlet)` in `review-normalization.js` checks the registry and returns `{ isSuspicious, confidence, reason, knownOutlets }`
3. `validate-data.js` runs two checks: cross-outlet same-critic detection (same critic at 2+ outlets for same show) and registry-based misattribution flagging
4. `gather-reviews.js` warns (never blocks) when saving a review with a suspicious critic-outlet pairing

**Confidence levels:** High (10+ reviews, 0 at target outlet, not freelancer), Medium (5+ reviews, <10% share), Low (insufficient data)

**Freelancer detection:** `isFreelancer = true` when 3+ outlets or no single outlet >70% share. Freelancers are never flagged. Known freelancers list in audit script (Chris Jones, Charles Isherwood, etc.)

**Auto-updated:** Registry regenerates during daily `rebuild-reviews.yml` workflow and is committed if changed.

**Files:**
- `data/critic-registry.json` — Auto-generated, consumed by `validateCriticOutlet()`
- `data/audit/critic-outlet-affinity.json` — Detailed report with flagged reviews and freelancer list

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

**Garbage detection guards (Feb 2026):** To prevent false positives on legitimate reviews:
- Legal page patterns (e.g., "All Rights Reserved") are skipped for texts >500 chars — copyright footers are not garbage
- Error page patterns (e.g., "has been removed") only check first 300 chars for long texts — prevents theatrical context matches
- Ad blocker detection requires full message context, not just the word "adblock"

**Automated quality checks:**
- `scripts/audit-text-quality.js` - Runs in CI, enforces thresholds (35% full, <40% truncated, <5% unknown)
- Quality classification happens automatically during `collect-review-texts.js` and `gather-reviews.js`
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

**Off-Broadway transfer reviews (reusable):** 18 reviews are flagged `wrongProduction: true` with `wrongProductionNote` indicating the off-Broadway venue. When adding off-Broadway show entries, these reviews can be moved/copied to the new show:
- **Hamilton** (4 reviews) → Public Theater, Feb 2015
- **Stereophonic** (6 reviews) → Playwrights Horizons, Oct 2023
- **The Great Gatsby** (3 reviews) → Park Central Hotel immersive, Jun 2023
- **Illinoise** (3 reviews) → Park Avenue Armory, Mar 2024
- **Oh, Mary!** (2 reviews) → Lucille Lortel Theatre, Feb-May 2024

**Known date corrections:** Harry Potter opens 2018-04-22 (not 2021 post-COVID reopen).

## Subscription Access for Paywalled Sites

| Site | GitHub Secret Names |
|------|---------------------|
| New York Times | NYT_EMAIL, NYTIMES_PASSWORD |
| Vulture/NY Mag/New Yorker | VULTURE_EMAIL, VULTURE_PASSWORD |
| Wall Street Journal | WSJ_EMAIL, WSJ_PASSWORD |
| Washington Post | WAPO_EMAIL, WASHPOST_PASSWORD |

`collect-review-texts.js` automatically logs in using these credentials.

## Known Extraction & Data Quality Issues (Feb 2026)

Documented from the Jan-Feb 2026 review corpus audit (1,825→2,022 reviews). These inform planned improvements below.

### Text Quality Issues

**HTML entity pollution (FIXED Feb 2026):** Entities decoded at three points: `cleanText()` in text-quality.js (LLM scorer path), `mergeReviews()` in review-normalization.js (incoming text), and `rebuild-show-reviews.js` (rebuild path). All use shared `decodeHtmlEntities()` from text-cleaning.js.

**Outlet-specific junk in fullText (FIXED Feb 2026):** `scripts/lib/text-cleaning.js` now has outlet-specific trailing junk patterns for EW (`<img>` tags, srcset, "Related Articles"), BWW ("Get Access To Every Broadway Story"), Variety ("Related Stories", "Popular on Variety"), BroadwayNews (site navigation), and The Times UK (paywall prefix). Applied at write time in all three consumer scripts via `cleanText()`.

**Quality classification in `gather-reviews.js` (FIXED Feb 2026):** `gather-reviews.js` now runs `classifyContentTier()` on every review before writing (line 1194). All 2,141 review files have contentTier assigned. Distribution: complete 1,108, excerpt 463, truncated 257, stub 293, other 20.

### Scoring Issues

**Explicit ratings auto-converted (FIXED Feb 2026):** `rebuild-all-reviews.js` extracts explicit ratings (stars, letter grades, X/5, "X out of Y") from review text and `originalScore` field, overriding LLM scores. Priority 0 in the scoring hierarchy. As of Feb 2026: 217 text-extracted + 110 originalScore-parsed = 327 reviews (16.3%) using explicit ratings. The `scoreSource` field in reviews.json tracks which method produced each score.

**Scoring hierarchy in `rebuild-all-reviews.js`:** Priority 0 (explicit ratings from text/originalScore) → Priority 0.5 (`humanReviewScore` manual override) → Priority 0b (originalScore parsed) → Priority 1 (LLM high/medium confidence) → Priority 2 (aggregator thumb override for low-confidence LLM) → Priority 3 (LLM fallback). The `humanReviewScore` field (1-100) is set during manual audit of flagged reviews where LLM and aggregator thumbs disagree. It persists across rebuilds and takes precedence over all automated scoring except explicit ratings. Always paired with `humanReviewNote` explaining the rationale.

**Excerpt-only confidence downgrade (FIXED Feb 2026):** Audit showed ~50% error rate when LLM scored excerpt-only reviews with high/medium confidence. `rebuild-all-reviews.js` now computes `effectiveConfidence` that downgrades to "low" when `fullText` is missing or <100 chars. This routes excerpt-only reviews through Priority 2 (thumb override) instead of trusting the LLM score directly.

**garbageFullText recovery (FIXED Feb 2026):** Some reviews have valid text in `garbageFullText` (flagged as garbage only due to trailing junk like newsletters/copyright). `rebuild-all-reviews.js` now recovers this text by running `cleanText()` on `garbageFullText` when `fullText` is null, promoting it to `fullText` if the cleaned result is >200 chars.

**LLM low-confidence as garbage detector (FIXED Feb 2026):** `detectGarbageFromReasoning()` in `content-quality.js` checks 17 patterns in LLM reasoning text (e.g., "plot summary without evaluation", "headline only", "not a review"). When confidence is "low" and a pattern matches, the review is auto-flagged `contentTier: "needs-rescrape"` with `garbageReasoningDetected` label. Integrated into the scoring pipeline (`llm-scoring/index.ts` post-scoring check) and backfilled on existing reviews (34 flagged).

### Deduplication Issues

**URL uniqueness (FIXED Feb 2026):** `gather-reviews.js` checks URL uniqueness across all files in a show directory (not just same outlet+critic). First-name prefix matching and outlet-critic concatenation normalization prevent the most common duplicate patterns. In Feb 2026 cleanup: 158 duplicate files deleted, validation went from 18 to 0 duplicate outlet+critic combos.

### Workflow Issues

**Parallel push conflicts (FIXED Feb 2026):** All 8 parallel-safe workflows now use robust push retry: `git checkout -- . && git clean -fd` before rebase, `-X theirs` for auto-conflict resolution, `rebase --abort` on failure, random 10-30s backoff, 5 retries. Fixed in: `gather-reviews.yml`, `rebuild-reviews.yml`, `scrape-nysr.yml`, `scrape-new-aggregators.yml`, `fetch-guardian-reviews.yml`, `process-review-submission.yml`, `review-refresh.yml`, `update-commercial.yml`.

### Remaining Data Quality Work (Feb 2026)

**Truncated reviews re-scrape (IN PROGRESS Feb 2026):** 314 reviews across 67 shows with `contentTier: "truncated"` or `"needs-rescrape"` are being re-scraped via 3 parallel `collect-review-texts.js` batches. The `contentTier` gap in `collect-review-texts.js` was fixed — it now checks `contentTier` in addition to `textQuality`/`textStatus` when deciding what to re-scrape.

**27 cross-outlet duplicate-text reviews:** Files with `duplicateTextOf` field where the same fullText appears at a different outlet (e.g., Chris Jones at both Chicago Tribune and NY Daily News). These are legitimate — the same freelance critic published in multiple outlets. Same-outlet duplicates and wrong-critic attributions have been cleaned up.

**Test infrastructure (ALL GREEN Feb 2026):** CI fully passing. Both `ensemble.test.mjs` and `trade-press-scraper.test.mjs` use Node test runner with `createRequire` for CJS module loading. Text quality audit uses `contentTier` fallback. Review-text validator treats unknown outlets and garbage critic names as warnings (not errors). Symlink double-counting fixed in all validation scripts.

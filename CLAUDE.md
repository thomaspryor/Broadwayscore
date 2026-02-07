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

- "Quick fix" / "Ship it" → Work on `main`, push directly
- "Preview" / "Staging" → Work on `staging` branch, provide preview URL
- **Exceptions:** Pure data updates, documentation, clearly broken bug fixes

### 3. Git Workflow - Two Paths
**Path A: Quick Fix** → Work on `main`, push. Vercel auto-deploys in ~1 min.
**Path B: Preview** → Branch `staging` from `main`, push. Merge to `main` after approval, delete staging.
**Preview URLs:** `https://broadwayscore-git-staging-[username].vercel.app`
**Production:** https://broadwayscorecard.com | **Branch:** `main`
**NEVER:** Create PRs or random feature branches (only `main` or `staging`).

### 4. Automate Everything — SET AND FORGET
**This site is designed to run indefinitely with zero manual intervention.** All data pipelines, scrapers, and updates must be fully automated via GitHub Actions with dynamic date ranges (no hardcoded years). Never ask user to manually fetch data or update year constants. If a workflow requires annual tweaks, fix it to be dynamic.

### 5. NEVER Guess or Fake Data
Never give approximate ranges. If you can't access a source, say so.

### 6. NEVER Extract Metadata from URLs
**URL structure is wildly inconsistent.** NEVER extract years, production info, or identifiers from URL patterns. A 2021 URL can contain a 2024 review; `/6910/` is an article ID, not a year. **DO** use publish date, review text content, and exact URL matching instead. Multiple past sessions have introduced bugs by assuming URL years indicate production years.

### 7. Batch Scripts MUST Checkpoint
**Any script that processes >10 items in CI MUST save progress incrementally.** A 3-hour workflow that only writes results at the end will lose everything on timeout. Required pattern:
- **Script:** Save output files (e.g., `shows.json`) every 25 items
- **Workflow:** Use `if: always()` on archive/commit/push steps so partial progress is committed on timeout or failure
- **Push:** Use 5-retry loop with `--rebase -X theirs` (see `gather-reviews.yml` pattern)
- Before shipping any new batch script or workflow, verify: "If this times out at 50%, do we keep the first 50%?" If no, add checkpointing.

---

## Project Overview

Broadway review aggregator. **Tech:** Next.js 14, TypeScript, Tailwind CSS, static export.
**Production:** https://broadwayscorecard.com (Vercel, auto-deploys from `main`)

**Philosophy:** Set-and-forget automation. The site maintains itself indefinitely via GitHub Actions — new shows discovered daily, reviews gathered automatically, grosses updated weekly, Tony Awards scraped annually. No manual intervention required.

**Current state:** 724+ shows (IBDB 2005-present + pre-2005 classics), 8,900+ source files, 3,400+ scored reviews. ~29 open, ~16 previews, 690+ closed. Critics-only scoring (V1).

## Scoring Methodology

- **Composite = Critic Score** (tier-weighted average)
- **Tier 1** (NYT, Vulture, Variety): 1.0 | **Tier 2** (TheaterMania, NY Post): 0.70 | **Tier 3** (blogs): 0.40
- Designation bumps: Critics_Pick +3, Critics_Choice +2, Recommended +2
- **Letter grade map** (source of truth: `src/config/scoring.ts`):
  A+=97, A=93, A-=90, B+=87, B=83, B-=78, C+=72, C=65, C-=58, D+=40, D=35, D-=30, F=20

**Scoring hierarchy in `rebuild-all-reviews.js`:**
- **P0:** Explicit ratings from text (stars, letter grades, X/5) — ~199 reviews
- **P0.5:** `humanReviewScore` manual override (paired with `humanReviewNote`) — ~60 active
- **P0b:** `originalScore` parsed (letter grades, star ratings) — ~67 reviews
- **P1:** LLM ensemble (high/medium confidence) — ~1,142 reviews
- **P2:** Aggregator thumb direction override for low-confidence LLM (compares directions, not buckets) — 0 reviews
- **P3:** LLM fallback (low confidence, single/no thumbs) — ~272 reviews

**Key rules:** Excerpt-only reviews (<100 chars fullText) get confidence downgraded to "low". `garbageFullText` >200 chars recovered via `cleanText()` during rebuild (in-memory only). `scoreSource` tracks method in reviews.json.

**V2 planned:** Audience Score 35%, Buzz Score 15%, confidence badges.

## Data Structure

> **For querying data**, use SQLite: `npm run db:build` then `node scripts/query.js "SQL"`. Tables: shows, reviews, review_texts, commercial, grosses, audience_buzz, critic_registry. Views: duplicate_urls, content_quality_summary, scoring_stats. Rebuild DB after data changes and before queries. Use `db:build:full` for fullText (~23MB).

```
data/
  shows.json                      # Show metadata (source of truth)
  reviews.json                    # Derived from review-texts/ via rebuild
  grosses.json / grosses-history.json  # Box office (weekly + historical)
  commercial.json                 # Financial/recoupment data
  audience-buzz.json              # Audience scores (Show Score, Mezzanine, Reddit)
  critic-consensus.json           # LLM editorial summaries
  critic-registry.json            # Auto-generated critic-outlet affinity
  review-texts/{show-id}/         # Individual review files (versioned IDs, e.g., bug-2026/)
    {outlet}--{critic}.json
  audit/                          # Auto-generated reports
  aggregator-archive/             # Cached HTML from 5 aggregator sources
```

### Show Schema
```typescript
{
  id, title, slug, venue, openingDate, closingDate, status, type, runtime, intermissions,
  images: { hero, thumbnail, poster }, synopsis, ageRecommendation, tags,
  previewsStartDate, ticketLinks: [{ platform, url, priceFrom }],
  creativeTeam: [{ name, role }], officialUrl, trailerUrl, theaterAddress
}
```
**Status:** `"open"` | `"previews"` | `"closed"`

### Grosses Schema
```typescript
{
  lastUpdated, weekEnding,
  shows: { [slug]: {
    thisWeek?: { gross, grossPrevWeek, grossYoY, capacity, capacityPrevWeek, capacityYoY,
                 atp, atpPrevWeek, atpYoY, attendance, performances },
    allTime: { gross, performances, attendance }
  }}
}
```
WoW/YoY for capacity and ATP self-computed from `grosses-history.json`.

### Audience Buzz Schema
```typescript
{
  shows: { [showId]: {
    designation, combinedScore,
    sources: {
      showScore?: { score, reviewCount },
      mezzanine?: { score, reviewCount, starRating },
      reddit?: { score, reviewCount, sentiment: {...}, positiveRate }
    }
  }}
}
```
**Weighting:** Reddit fixed 20%. Show Score & Mezzanine split remaining proportionally by sample size.

### Commercial Data Schema
```typescript
{
  shows: { [showId]: {
    title, weeklyRunningCost, weeklyRunningCostRange?, capitalization,
    recouped, recoupedDate, estimatedRecoupmentPct, profitMargin,
    costMethodology, sources: [{ type, url, date, excerpt? }],
    deepResearch?: { verifiedFields, verifiedDate, verifiedBy }, lastUpdated
  }}
}
```

**Methodology reliability:** `sec-filing`/`producer-confirmed`/`deep-research` (Very High) > `trade-reported` (High) > `reddit-standard` (Medium) > `industry-estimate` (Low)

**Deep Research Protection:** Shows with `deepResearch.verifiedFields` are protected from automated overwrites. Protected shows: death-becomes-her, the-great-gatsby, stranger-things, operation-mincemeat, just-in-time, all-out.

**Recoupment rules:** Never mark `recouped: true` without trade press citation (Deadline, Variety, Playbill, Broadway Journal, Broadway News). Never infer from grosses math or show designation — The Roommate (2024) was incorrectly listed as recouped due to this. Use `recouped: false` with `estimatedRecoupmentPct`.

**Public exports:** After editing `commercial.json`, regenerate with `node /tmp/regen-public.js` or the inline script pattern from commercial expansion sessions. Prebuild handles this on Vercel deploys.

**Designation criteria (applied in practice):**

| Designation | Criteria | Examples |
|-------------|----------|---------|
| Miracle | Extraordinary ROI, long-running mega-hit | Hamilton (10 weeks), Phantom |
| Windfall | Solid hit, recouped in <2 years, profitable | Mean Girls (21 months), Leopoldstadt, Sweeney Todd 2023 |
| Easy Winner | Limited run, low cap, quick recoup, modest upside | Prima Facie ($4.1M/10 weeks), Into the Woods ($4M), Appropriate ($3.75M) |
| Trickle | Recouped slowly (>2 years or with difficulty) | Ain't Too Proud (recouped after COVID gap), Funny Girl (16 months, cast change needed) |
| Fizzle | Did not recoup, but recovered ~30%+ of investment | Shucked, Kimberly Akimbo (~50%), Frozen ($120M gross but $35M cap) |
| Flop | Did not recoup, recovered <30% | KPOP (17 perf), Paradise Square, King Kong |
| Nonprofit | LCT, Roundabout, MTC, Second Stage — no commercial investors | Doubt, Uncle Vanya, Mary Jane, Camelot 2023 |
| Tour Stop | National tour engagement on Broadway | Beetlejuice 2025, Mamma Mia 2025 |
| TBD | Still running, too early to call | Currently open commercial shows |

**ChatGPT Deep Research workflow:** User sends financial profiles to Claude Code in batches of 5-8 shows. Template prompt saved in `data/audit/deep-research-raw.md`. Raw research data archived there too. Process: verify slugs exist in shows.json → add to commercial.json → validate → regenerate exports → push.

**Slug matching pitfall:** The `batch-commercial-research.js` script sometimes creates entries with `-YYYY` suffixed slugs that don't match shows.json (e.g., `illinoise-2024` when shows.json uses `illinoise`). Always verify the commercial.json key matches the show's actual slug in shows.json. Run the sense-check after bulk additions.

**Commercial expansion status (Feb 2026):** 120 shows with commercial data. Coverage: 2024-2025 season ~70%, 2023-2024 ~65%, 2022-2023 ~45%. Remaining gaps are mostly plays (often nonprofit) and shows where financial data isn't publicly available. Tools: `scripts/batch-commercial-research.js` (automated), `scripts/apply-commercial-pending.js`, ChatGPT Deep Research (manual, higher quality).

**Validation gotchas discovered:**
- `deepResearch.verifiedFields` cannot be an empty array — omit the `deepResearch` block entirely for nonprofits
- `recoupedDate` must be YYYY or YYYY-MM format (not YYYY-MM-DD)
- `originalProductionId` must reference an existing key in commercial.json
- Always run `node scripts/validate-data.js` before pushing

## Key Files

**App:** `src/lib/engine.ts` (scoring), `src/lib/data.ts` (barrel re-export — backward compat), `src/app/page.tsx` (homepage), `src/app/show/[slug]/page.tsx` (show pages), `src/config/scoring.ts` (scoring rules/tiers/outlets), `src/config/commercial.ts` (commercial designations — single source of truth), `src/components/BoxOfficeStats.tsx`, `src/components/ShowImage.tsx` (fallback: thumbnail → poster → hero → placeholder)

**Data modules** (split from data.ts for bundle optimization — import from these directly, not the barrel):
- `src/lib/data-types.ts` — All shared TypeScript interfaces (zero runtime cost)
- `src/lib/data-core.ts` — `getAllShows()`, `getShowBySlug()`, directors, theaters, browse (imports reviews.json)
- `src/lib/data-grosses.ts` — Box office functions (grosses.json only)
- `src/lib/data-awards.ts` — Award functions (awards.json only)
- `src/lib/data-audience.ts` — Audience buzz functions (audience-buzz.json only)
- `src/lib/data-commercial.ts` — Biz/commercial functions (commercial.json + grosses-history.json, uses raw shows to avoid reviews.json)
- `src/lib/data-consensus.ts` — Critic consensus (critic-consensus.json only)
- `src/lib/data-lottery.ts` — Lottery/rush (lottery-rush.json only)

**Core Scripts:**
- `scripts/gather-reviews.js` — Main review gathering from all aggregators
- `scripts/collect-review-texts.js` — Full text scraper (declarative tier chain)
- `scripts/rebuild-all-reviews.js` — Rebuilds reviews.json from review-texts/
- `scripts/validate-data.js` — **Run before pushing** — validates shows.json + reviews.json
- `scripts/discover-new-shows.js` — Broadway.org discovery + IBDB enrichment (daily)
- `scripts/enrich-ibdb-dates.js` — Standalone IBDB enrichment (`--dry-run`, `--show=SLUG`, `--verify`, `--force`, `--status=`)
- `scripts/scrape-lottery-rush.js` — Lottery/rush scraper: BwayRush (ScrapingBee HTML→markdown) + Playbill (LLM extraction via Claude Sonnet). Incremental merge, pre-write backup, post-merge cleanup. CLI: `--source=bwayrush|playbill`, `--dry-run`, `--verbose`
- `scripts/sync-lottery-rush-tags.js` — Syncs lottery/rush/sro tags in shows.json from lottery-rush.json
- `scripts/scrape-grosses.ts` — BroadwayWorld weekly grosses + history enrichment
- `scripts/update-commercial-data.js` — Weekly commercial automation
- `scripts/generate-critic-consensus.js` — LLM editorial summaries
- `scripts/fetch-show-images-auto.js` — Image fetcher: TodayTix → page scrape → Playbill fallback. **Has `PINNED_IMAGES` set — NEVER overwrite these thumbnails** (manually curated promotional art). To update a pinned image: remove from the set first, then re-fetch.
- `scripts/lib/verify-image.js` — Gemini 2.0 Flash vision gate for image verification (used by fetch pipeline with `--verify`)

**Libraries:** `scripts/lib/` — `deduplication.js` (9-check show dedup), `review-normalization.js` (outlet/critic normalization), `text-cleaning.js` (HTML entities, junk stripping), `content-quality.js` (content tier classification + garbage detection), `ibdb-dates.js` (IBDB date/creative team lookup), `show-matching.js` (title→show matching), `scraper.js` (Bright Data → ScrapingBee → Playwright fallback), `deep-research-guardian.js`, `source-validator.js`, `parse-grosses.js`

**Audit/Scrapers:** `scripts/audit-content-quality.js` (run after bulk changes), `scripts/audit-aggregator-coverage.js` (`--output-gaps`, `--status=`, `--show=`), `scripts/audit-critic-outlets.js`, `scripts/scrape-playbill-verdict.js`, `scripts/scrape-nyc-theatre-roundups.js`, `scripts/scrape-nysr-reviews.js`, `scripts/adjudicate-review-queue.js` (daily auto-adjudication), `scripts/build-sqlite.js` / `scripts/query.js` / `scripts/schema.sql`

**Tests:** `tests/unit/` (unit), `tests/e2e/` (Playwright E2E)

## Content Quality System

### Content Tier (canonical, 5-tier) — `classifyContentTier()` in `content-quality.js`

- `complete` — Full review (300+ words + proper ending, OR 500+ words, OR 150+ with opinion language and >1.1x excerpt)
- `truncated` — Paywall/read-more/mid-sentence cutoff signals
- `excerpt` — Only aggregator excerpt, no fullText
- `stub` — <150 words, not structurally complete
- `invalid` — Garbage (navigation, ads, error pages)

Applied by: `collect-review-texts.js`, `gather-reviews.js`, `rebuild-all-reviews.js`.

**Junk handling:** Leading nav stripping (`stripLeadingNavigation()`), show-not-mentioned detection (nulls fullText, preserves in `wrongFullText`), outlet-specific trailing junk removal, garbage detection with guards (>500 char legal footers ok, >300 char error patterns scoped, contextual adblock detection).

## Deduplication & Normalization

**Show dedup** (`deduplication.js`): 9 checks. Add patterns to `KNOWN_DUPLICATES` map.

**Review normalization** (`review-normalization.js`): `normalizeOutlet()` strips critic names from concatenated IDs. `normalizeCritic()` with 30+ aliases. First-name prefix dedup in `gather-reviews.js` and `rebuild-all-reviews.js`. Add aliases to `OUTLET_ALIASES` or `CRITIC_ALIASES`.

**Critic-outlet misattribution** (`critic-registry.json`): Auto-generated from corpus. `validateCriticOutlet()` flags suspicious pairings. Freelancers (3+ outlets or <70% at any one) never flagged. Auto-regenerates daily.

## Automated Testing

**Always run `node scripts/validate-data.js` before pushing.** Build-time gate: `validate-shows-prebuild.js` blocks deployment on duplicates.

```bash
npm run test:data    # Data validation (fast)
npm run test:e2e     # E2E browser tests
npm run test         # All tests
```

## Automation (GitHub Actions)

See `.github/workflows/CLAUDE.md` for individual workflow descriptions.

**Source of truth:** `data/review-texts/` → **Derived:** `data/reviews.json`

| Workflow | Modifies texts | Rebuilds reviews | Schedule |
|----------|---------------|-----------------|----------|
| `rebuild-reviews.yml` | No | Yes | Daily 4 AM UTC |
| `collect-review-texts.yml` | Yes | Yes | Nightly 2 AM UTC |
| `gather-reviews.yml` | Yes | Yes | Manual/triggered |
| `review-refresh.yml` | Yes | Yes | Weekly |
| `adjudicate-review-queue.yml` | Yes | Triggers | Daily 5 AM UTC |
| `update-lottery-rush.yml` | No | No | Weekly Mon 10 AM UTC, updates `lottery-rush.json` + syncs tags in `shows.json` |
| `update-mezzanine.yml` | No | No | Weekly Sun 1 PM UTC |
| `scrape-new-aggregators.yml` | Yes | Yes | Weekly Sun 11 AM UTC |
| `fetch-guardian-reviews.yml` | Yes | Yes | Manual |
| `process-review-submission.yml` | Yes | Yes | Manual |

**For bulk imports:** Run parallel gather-reviews, then `gh workflow run "Rebuild Reviews Data"`.

### Workflow Robustness Checklist

1. **Parallel-safe** — Matrix strategy, never 700+ items in one job (use gather-reviews.yml pattern)
2. **Incremental progress** — Each batch commits independently, 5-retry push with `--rebase -X theirs`
3. **Idempotent** — Safe to re-run, skip-if-exists caching
4. **Test first** — Small batch before bulk
5. **Budget-aware** — Log API calls, `continue-on-error` for non-critical steps, `timeout-minutes` on every job (batch: 60, rebuild: 15, scraping: 30, single-show: 10)
6. **No conflicts** — Parallel jobs only commit own file paths, derived files rebuilt in final job
7. **Secrets in env blocks** — MUST explicitly pass via `env:` blocks (NOT auto-available)

### GitHub Secrets

| Secret | Purpose |
|--------|---------|
| `ANTHROPIC_API_KEY` | Claude API |
| `OPENAI_API_KEY` | GPT-4o ensemble |
| `GEMINI_API_KEY` | Gemini Flash (optional) |
| `BRIGHTDATA_TOKEN` | Scraping (primary) |
| `SCRAPINGBEE_API_KEY` | Scraping (fallback) |
| `BROWSERBASE_API_KEY` / `_PROJECT_ID` | Browser cloud + CAPTCHA ($0.10/session) |
| `MEZZANINE_APP_ID` / `_SESSION_TOKEN` | Mezzanine Parse API (token may expire) |
| `FORMSPREE_TOKEN` | Feedback form |

```yaml
# CORRECT - explicitly pass secrets:
- name: Run script
  env:
    ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
  run: node scripts/my-script.js
```

**Local API keys:** All in `.env` at project root. Source: `source /Users/tompryor/Broadwayscore/.env`. Do not claim keys are unavailable locally.

## Web Scraping & Review Sources

Scraper fallback: Bright Data → ScrapingBee → Playwright (`scripts/lib/scraper.js`).

### Six Aggregator Sources
1. **Show Score** — Recent (2015+). URL: `{slug}-broadway` (always try `-broadway` suffix first)
2. **DTLI** — Historical (2000s+). URL: `didtheylikeit.com/shows/{show-name}/`
3. **BWW Roundups** — 10-20+ reviews per show. Two sub-formats: new (~2023+) has thumb images + `Average Rating: XX%`, old (pre-2023) has plain text. Both have review URLs. Search BroadwayWorld.
4. **BWW Reviews Pages** — `/reviews/{Title}` pages with 1-10 scores per review, review URLs, excerpts. ~74% hit rate across all shows. Direct URL construction with slug variations (no Google). URL slug validation prevents cross-show contamination.
5. **Playbill Verdict** — Review URL discovery. `--shows=X,Y,Z`, `--no-date-filter`
6. **NYC Theatre Roundups** — Paywalled excerpts (2023+). `--shows=X,Y,Z`

Sources 1-3 inline in `gather-reviews.js`. Sources 3-4 also via `scrape-bww-reviews.js` (weekly `scrape-bww-reviews.yml`). Sources 5-6 weekly via `scrape-new-aggregators.yml`. Archives in `data/aggregator-archive/`.

**BWW-specific fields:** `bwwScore` (1-10, from /reviews/ pages only — stored separately from `originalRating` to avoid corrupting scoring pipeline), `bwwThumb` (Up/Meh/Down, from new-format roundups), `bwwRoundupUrl`, `bwwExcerpt`.

### NYSR Scraper
WordPress API. Star ratings in `excerpt.rendered`. Cross-reference lines stripped at 3 levels.

### Aggregator Coverage Audit
`scripts/audit-aggregator-coverage.js` compares archive vs local counts. `trulyMissing = max(0, maxAggregatorCount - totalLocal)`. ~97% of per-aggregator gaps are attribution differences. Coverage gap closure: `.github/workflows/close-coverage-gaps.yml` (with per-show checkpointing every 5 shows to prevent data loss on timeout).

**Feb 2026 gap closure results:** 4-era batch run gathered 2,016+ new review files. Remaining: 496 truly missing across 275 shows (mostly BWW/PV attribution differences on long-running open shows like Hamilton, Moulin Rouge, Oh Mary!).

## Review Data Schema

Each file in `data/review-texts/{showId}/{outletId}--{criticName}.json`:
```json
{
  "showId", "outletId", "outlet", "criticName", "url", "publishDate",
  "fullText": "..." or null,
  "dtliExcerpt", "bwwExcerpt", "showScoreExcerpt", "nycTheatreExcerpt",
  "assignedScore": 78, "humanReviewScore": 48, "humanReviewNote": "...",
  "source": "dtli|bww-roundup|bww-reviews|playbill-verdict|nyc-theatre|nysr|playwright-scraped|webfetch-scraped|manual",
  "bwwScore": 8, "bwwRoundupUrl": "https://...",
  "dtliThumb": "Up/Down/Meh", "bwwThumb": "Up/Down/Meh"
}
```

**Quality flags:** `wrongProduction`, `wrongShow`, `isRoundupArticle` — excluded from reviews.json.

**Wrong-production prevention (4 layers):**
1. **Scraper-level:** Year param + preview skip in gather-reviews.js, scrape-playbill-verdict.js, scrape-bww-reviews.js
2. **Write-time:** 30-day date guard in gather-reviews.js; `isNotBroadway()` streaming/TV filter; cross-production URL dedup
3. **Rebuild-time** (`rebuild-all-reviews.js`): 30-day date guard + `multiProdDirectorGuard` — pre-computed map for multi-production show groups. Reviews in older dirs mentioning newer production's director = auto-skipped. `allowEarlyDate: true` on source file bypasses date guard.
4. **Automated audit:** `audit-wrong-production.js` runs report-only in `rebuild-reviews.yml` after every rebuild

**Pre-Broadway/transfer reviews excluded by design** — out-of-town tryouts, off-Broadway transfers, and venue transfers are filtered by the 30-day date guard. These are not Broadway reviews.

**Review-text dirs use versioned show IDs** from shows.json (e.g., `bug-2026/`, not `bug/`).

**Off-Broadway transfers (18 reviews, `wrongProduction: true`):** Hamilton (4→Public Theater), Stereophonic (6→Playwrights Horizons), The Great Gatsby (3→Park Central Hotel), Illinoise (3→Park Ave Armory), Oh Mary! (2→Lucille Lortel). Reusable when adding off-Broadway entries.

**Known date correction:** Harry Potter opens 2018-04-22 (not 2021 post-COVID reopen).

### Subscription Access

| Site | Secrets |
|------|---------|
| NYT | `NYT_EMAIL`, `NYTIMES_PASSWORD` |
| Vulture/NY Mag | `VULTURE_EMAIL`, `VULTURE_PASSWORD` |
| WSJ | `WSJ_EMAIL`, `WSJ_PASSWORD` |
| WaPo | `WAPO_EMAIL`, `WASHPOST_PASSWORD` |

WSJ/NYT untestable in CI (anti-bot blocks headless Chrome). Use Browserbase tier for actual collection.

### Full Text Collection

~2,700+ reviews need fullText. Nightly cron processes ~500/run (raised from 100 in Feb 2026). For bulk catch-up, use `bulk-collect-review-texts.yml` with parallel jobs and self-chaining. Multi-tier fallback: Archive.org → Playwright → Browserbase ($0.10) → ScrapingBee → Bright Data → Archive.org (final). Low success rates normal (many dead URLs/defunct sites).

**Per-show:** `gh workflow run "Collect Review Texts" -f show_filter=SHOW_ID -f max_reviews=0`

### LLM Ensemble Scoring Constraints

- ~0.66 min/review (4-model), checkpoints every 100 reviews in CI (git commit+push), safe to run batches of 300-500
- Full rescore: `--rescore --limit=400` then repeated `--outdated --limit=400` batches
- Cost: ~$0.045/review (~$80 full corpus)
- **Human review queue:** `data/audit/needs-human-review.json`. Set `humanReviewScore` + `humanReviewNote` on source file. Auto-adjudication daily at 5 AM UTC via Claude Sonnet (3 uncertain attempts → auto-accepts).

## Broadway Investment Tracker (`/biz`)

Routes: `/biz` (dashboard), `/biz/season/[season]` (auto-generated). Seasons discovered from `commercial.json`. `calculateWeeksToRecoup()` in `data.ts`. `recouped: true` requires `recoupedDate`. Config: `src/config/commercial.ts`. Components: `src/components/biz/`.

## Images

**Current:** ~460 local thumbnails, ~21 CDN URLs, ~250 null (placeholder). All open/previews shows have correct images.

**Reliability:** TodayTix `.webp` (reliable) > Contentful `.webp` (reliable) > Google `.jpg` (unreliable — caused contamination, pipeline reverted).

**Recovery:** Deleted originals in `data/audit/deleted-images/`. Restore: copy back + update shows.json thumbnail path.

**Key files:** `scripts/audit-images-llm.js` (Gemini audit), `scripts/apply-image-cleanup.js` (curated cleanup with false positive overrides), `data/audit/image-verification.json`, `src/components/ShowImage.tsx`

**Phase 2 (NOT DONE):** LLM-verified image pipeline. Plan at `/Users/tompryor/.claude/plans/temporal-hugging-bachman.md`. Re-fetch ~250 null thumbnails with LLM gate.

## Data Quality Notes

**All major issues fixed as of Feb 2026.** Prevention mechanisms now in code: content quality classifiers, outlet-specific junk stripping, byline extraction excludes creative team, critic-outlet registry, URL dedup across directories, streaming/TV filter, confidence downgrade for excerpt-only scoring. See `memory/historical-fixes-reference.md` for detailed fix history.

**Audit baseline (17 known flags, all verified legitimate):** 9 long-running show re-reviews, 4 Chris Jones syndication URLs, 1 Deadline roundup, 2 partial scrapes, 1 legacy null URL.

**Run after bulk changes:** `node scripts/audit-content-quality.js`

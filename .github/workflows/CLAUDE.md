# GitHub Actions Workflow Reference

Detailed descriptions of all automated workflows. See root `CLAUDE.md` for secrets table and critical rules.

## Data Sync Architecture

**Source of truth:** `data/review-texts/{show-id}/*.json` (individual review files)
**Derived file:** `data/reviews.json` (aggregated for website consumption)

| Workflow | Modifies review-texts | Rebuilds reviews.json | Notes |
|----------|----------------------|----------------------|-------|
| `rebuild-reviews.yml` | ❌ | ✅ | **PRIMARY sync** - daily + manual trigger |
| `review-refresh.yml` | ✅ | ✅ | Weekly extraction + rebuild |
| `gather-reviews.yml` | ✅ | ✅ | Parallel-safe, rebuilds inline after commit |
| `collect-review-texts.yml` | ✅ | ✅ | Parallel-safe, rebuilds inline after commit |
| `fetch-guardian-reviews.yml` | ✅ | ✅ | Single-threaded, rebuilds inline |
| `process-review-submission.yml` | ✅ | ✅ | Single-threaded, rebuilds inline |
| `adjudicate-review-queue.yml` | ✅ | ❌ | Daily 5 AM UTC, triggers rebuild after commit |
| `scrape-nysr.yml` | ✅ | ❌ | Weekly NYSR via WordPress API, relies on daily rebuild |
| `scrape-new-aggregators.yml` | ✅ | ✅ | Weekly Playbill Verdict + NYC Theatre, rebuilds inline after scrape |
| `scrape-bww-reviews.yml` | ✅ | ✅ | Weekly BWW /reviews/ pages + roundups, rebuilds after scrape |
| `audit-aggregator-coverage.yml` | ❌ | ❌ | Weekly audit, writes `data/audit/aggregator-coverage.json` only |
| `close-coverage-gaps.yml` | ✅ | ✅ | Manual per-era gap closure orchestration (audit → parallel gather → scrape PV/NYC → rebuild) |

**For bulk imports (100s of shows):** Run parallel gather-reviews, then trigger manual rebuild via:
```bash
gh workflow run "Rebuild Reviews Data" -f reason="Post bulk import sync"
```

---

## `rebuild-reviews.yml`
- **Runs:** Daily at 4 AM UTC (11 PM EST), or manually triggered
- **Does:** Rebuilds `reviews.json` from `review-texts/` source files
- **Manual trigger:** `gh workflow run "Rebuild Reviews Data" -f reason="Post bulk import sync"`
- **Purpose:** PRIMARY sync mechanism for derived data
- **When to use manually:**
  - After bulk imports (100s of shows via parallel gather-reviews)
  - After manual edits to review-texts files
  - When reviews.json appears stale
- **Script:** `scripts/rebuild-all-reviews.js`

## `update-show-status.yml`
- **Runs:** Daily at 8 AM UTC (3 AM EST)
- **Does:** Updates show statuses (open → closed, previews → open), discovers new shows on Broadway.org, auto-adds new shows with status "previews"
- **IBDB enrichment:** New shows are enriched with preview/opening/closing dates from IBDB. If IBDB fails, Broadway.org's "Begins:" date is treated as `previewsStartDate` (not `openingDate`)
- **Timeout:** 10 minutes (to accommodate IBDB lookups with rate limiting)
- **Triggers for newly opened shows (previews → open):** `gather-reviews.yml`, `update-reddit-sentiment.yml`, `update-show-score.yml`, `update-mezzanine.yml`, `fetch-all-image-formats.yml`
- **Outputs:** `opened_count`, `opened_slugs` (shows transitioning previews→open), plus discovery outputs

## `opening-night-reviews.yml`
- **Runs:** Daily at 5 AM UTC (midnight EST), or manually
- **Does:** Finds shows that opened in the last 2 days (by `openingDate`), triggers `gather-reviews.yml` to catch opening night reviews the same evening they're published
- **Why:** The morning `update-show-status.yml` (8 AM UTC) fires before reviews exist (~10-11 PM EST). This evening workflow catches reviews after publication.
- **Options:** `lookback_days` (default 2)
- **Guards:** Checks if gather-reviews is already running before triggering
- **No secrets needed** beyond `GITHUB_TOKEN`
- **Manual trigger:** `gh workflow run "Opening Night Reviews" -f lookback_days=7`

## `gather-reviews.yml`
- **Runs:** When new shows discovered (or manually triggered)
- **Does:** Gathers review data by searching aggregators and outlets, then scrapes supplementary aggregators (Playbill Verdict + NYC Theatre), then rebuilds `reviews.json`
- **Secrets required:** `ANTHROPIC_API_KEY`, `BRIGHTDATA_TOKEN`, `SCRAPINGBEE_API_KEY`
- **Script:** `scripts/gather-reviews.js`
- **Manual trigger:** `gh workflow run gather-reviews.yml -f shows=show-id-here`
- **Job pipeline:** `prepare → gather-reviews → scrape-aggregators (non-blocking) → rebuild`
  - `scrape-aggregators`: Runs Playbill Verdict + NYC Theatre for the target shows (`--shows=`). Uses `continue-on-error: true` so rebuild always runs even if scrapers fail. 30-minute timeout.
- **Technical notes:**
  - Installs Playwright Chromium for Show Score carousel scraping
  - Show Score extraction uses Playwright to scroll through ALL critic reviews (not just first 8)
  - Detects and rejects Show Score redirects to off-broadway shows
  - Tries `-broadway` URL suffix patterns first
  - **Parallel-safe:** Only commits `review-texts/` and `archives/` (NOT `reviews.json`)
  - Uses retry loop (5 attempts) with random backoff for git push conflicts

## `review-refresh.yml`
- **Runs:** Weekly on Mondays at 9 AM UTC
- **Does:** Checks all open shows for new reviews, extracts from aggregator archives, **rebuilds reviews.json**, triggers collection if needed
- **Script:** `scripts/check-show-freshness.js`
- **Key steps:** Extract reviews → Rebuild reviews.json → Commit → Trigger collection for shows with gaps
- **Note:** Now automatically rebuilds `reviews.json` after extraction (fixed Jan 2026)

## `fetch-aggregator-pages.yml`
- **Runs:** Manual trigger only
- **Does:** Fetches and archives HTML pages from all three aggregator sources (Show Score, DTLI, BWW Review Roundups)
- **Manual trigger:**
  ```bash
  gh workflow run "Fetch Aggregator Pages" --field aggregator=all --field shows=missing
  ```
- **Options:** `aggregator` (show-score/dtli/bww-rr/all), `shows` (comma-separated IDs/"all"/"missing"), `force`
- **Archives saved to:** `data/aggregator-archive/{show-score,dtli,bww-roundups}/`

## `fetch-all-image-formats.yml`
- **Runs:** Twice weekly (Mon & Thu at 6 AM UTC), or triggered by show discovery
- **Does:** Fetches poster/thumbnail/hero images, archives locally as WebP, updates `shows.json` to use local paths
- **Image sourcing (3-tier fallback):**
  1. **TodayTix API** (open shows) — batch-fetches all active NYC shows from `api.todaytix.com/api/v2/shows`, uses native `posterImageSquare` (1080x1080), `posterImage` (480x720), `appHeroImage`. No ScrapingBee needed.
  2. **TodayTix page scrape** (closed shows) — discovers TodayTix page via Google SERP, scrapes Contentful image URLs, crops portrait to square via Contentful transforms
  3. **Playbill fallback** — OG image only (landscape, used as hero)
- **Scripts:** `scripts/fetch-show-images-auto.js` → `scripts/archive-show-images.js`
- **Triggered by:** `update-show-status.yml` and `discover-historical-shows.yml`
- **Image formats:** Poster 720x1080 (portrait), Thumbnail 1080x1080 (square), Hero 1920x800 (landscape) — all WebP
- **Flags:** `--missing` (only shows without images), `--bad-images` (re-source shows with identical Playbill images), `--show=ID` (single show)

## `weekly-grosses.yml`
- **Runs:** Every Tuesday & Wednesday at 3pm UTC (10am ET)
- **Does:** Scrapes BroadwayWorld for weekly box office and all-time stats, enriches with WoW/YoY from `grosses-history.json`
- **Data source:** BroadwayWorld (grosses.cfm, grossescumulative.cfm)
- **Skips:** If current week data already exists (unless force=true)

## `backfill-grosses.yml`
- **Runs:** Manual trigger only
- **Does:** Scrapes Playbill for historical weekly grosses to populate `grosses-history.json`
- **Options:** `weeks` (default 55), `start_from` (YYYY-MM-DD)
- **Reliability:** Uses `domcontentloaded` (not `networkidle`), 3 retries per week
- **Script:** `scripts/backfill-grosses-history.ts`
- **Note:** Only for initial setup or extending history range

## `backfill-aggregators.yml`
- **Runs:** Manual trigger only
- **Does:** One-time parallel backfill of Playbill Verdict + NYC Theatre data for all shows (730+)
- **Options:** `parallel_jobs` (default 5, 1-10), `aggregator` (all/playbill-verdict/nyc-theatre), `date_filter` (default false = all eras)
- **Job pipeline:** `prepare → backfill (N parallel matrix jobs) → rebuild`
- **Parallel-safe:** 30s stagger between jobs, 5-retry push with random backoff
- **Caching:** Both scripts skip shows with existing archives in `data/aggregator-archive/`. Re-runs cost ~0 API calls.
- **Cost:** ~$8-11 ScrapingBee credits for full 730-show backfill (first run)
- **Manual trigger:** `gh workflow run "Backfill Aggregator Data" -f parallel_jobs=5 -f aggregator=all`

## `bulk-collect-review-texts.yml`
- **Runs:** Manual trigger only
- **Does:** One-time bulk collection of review full texts across all shows, partitioned across parallel runners
- **Options:** `parallel_jobs` (default 5, 1-10), `max_per_job` (0 = all), `batch_size` (default 10), `browserbase_enabled` (default true), `browserbase_per_job` (default 5), `retry_failed` (default true), `archive_first` (default true), `content_tier` (filter), `aggressive` (default true, skips Playwright for known-blocked sites), `test_mode` (limit to 5/job), `max_rounds` (default 3, auto-chaining), `current_round` (auto-set)
- **Job pipeline:** `prepare → collect (N parallel matrix jobs) → rebuild → chain next round`
- **Self-chaining:** After rebuild, counts remaining reviews. If >50 remain and rounds left, auto-dispatches next round. Set `max_rounds=0` to disable. Stops at diminishing returns (<50 remaining).
- **Parallel-safe:** 45s stagger between jobs, SHOW_FILTER ensures disjoint show sets, 5-retry push with shows.json integrity check
- **Load balancing:** Prepare job counts reviews per show, sorts by count descending, distributes round-robin
- **Script:** `scripts/collect-review-texts.js` (with SHOW_FILTER env var for partitioning)
- **Requires:** `SCRAPINGBEE_API_KEY`, `BRIGHTDATA_TOKEN`, `BROWSERBASE_API_KEY`, `BROWSERBASE_PROJECT_ID`, plus login credentials (NYT, Vulture, WSJ, WaPo)
- **Cost:** ~$22-38 ScrapingBee + Browserbase credits per round
- **Manual trigger:** `gh workflow run "Bulk Collect Review Texts" -f parallel_jobs=5`
- **Full autonomous run:** `gh workflow run "Bulk Collect Review Texts" -f parallel_jobs=5 -f max_rounds=5` (chains up to 5 rounds)
- **Test mode:** `gh workflow run "Bulk Collect Review Texts" -f parallel_jobs=2 -f test_mode=true`

## `discover-historical-shows.yml`
- **Runs:** Manual trigger only
- **Does:** Discovers closed Broadway shows from past seasons, adds with status "closed" and tag "historical", auto-triggers review gathering
- **IBDB enrichment:** Enriches preview/opening/closing dates from IBDB after discovery
- **Usage:** Specify seasons like `2024-2025,2023-2024` (one or two at a time)

## `enrich-ibdb-dates.yml`
- **Runs:** Manual trigger only
- **Does:** Enriches or verifies show dates (preview, opening, closing) from IBDB
- **Options:** `mode` (enrich/verify/force), `show` (optional slug), `status` (optional filter)
- **Script:** `scripts/enrich-ibdb-dates.js`
- **Requires:** `SCRAPINGBEE_API_KEY` (primary), `BRIGHTDATA_TOKEN` (fallback)
- **Modes:**
  - `enrich` (default): Fill missing/null dates only, never overwrite existing
  - `verify`: Compare IBDB vs shows.json, report discrepancies (read-only)
  - `force`: Overwrite all dates with IBDB values
- **Rate limiting:** 1.5s between IBDB requests, 30-minute timeout

## `process-review-formspree.yml`
- **Runs:** Daily at 6 AM UTC (1 AM EST), or manually
- **Does:** Polls Formspree review submission form, creates GitHub Issues for each new submission in the format `process-review-submission.yml` expects. Tracks processed IDs to prevent duplicates.
- **User-facing page:** `/submit-review` (Formspree form)
- **Script:** `scripts/process-review-formspree.js`
- **Tracking:** `data/audit/processed-review-submissions.json`
- **Requires:** `FORMSPREE_TOKEN`, `GITHUB_TOKEN`
- **Flow:** Formspree form → this workflow creates Issue → `process-review-submission.yml` auto-triggers

## `process-review-submission.yml`
- **Runs:** When GitHub issue created/edited with `review-submission` label
- **Does:** Validates review submission via Claude API, scrapes and adds if approved, closes issue
- **Triggered by:** `process-review-formspree.yml` (creates issues with `review-submission` label)
- **Issue template:** `.github/ISSUE_TEMPLATE/missing-review.yml`
- **Script:** `scripts/validate-review-submission.js`

## `update-show-score.yml`
- **Runs:** Weekly (Sundays 12pm UTC), on previews → open transition, or manually
- **Does:** Scrapes show-score.com for audience scores, updates `data/audience-buzz.json`
- **Options:** `show`, `shows` (comma-separated), `limit` (default 50)
- **Technical:** Uses ScrapingBee with JS rendering, extracts from JSON-LD, 1-hour timeout with `if: always()` commit
- **Script:** `scripts/scrape-show-score-audience.js`

## `update-reddit-sentiment.yml`
- **Runs:** Monthly (1st of month at 10am UTC), on previews → open transition, or manually
- **Does:** Scrapes r/Broadway for discussions, uses Claude Sonnet for sentiment analysis, updates `data/audience-buzz.json`. Default: open shows only (use --all for closed).
- **Options:** `show`, `shows` (comma-separated), `limit` (default 50)
- **Technical:** Uses ScrapingBee with premium proxy, generic titles use Broadway-qualified searches, 2-hour timeout with `if: always()` commit
- **Script:** `scripts/scrape-reddit-sentiment.js`

## `update-mezzanine.yml`
- **Runs:** Weekly (Sundays 1pm UTC, after Show Score), on previews → open transition, or manually
- **Does:** Calls Mezzanine (theaterdiary.com) Parse API to fetch all Broadway production ratings, matches to shows.json, updates `data/audience-buzz.json`
- **Options:** `show`, `shows` (comma-separated or "missing"), `limit`, `dry_run`
- **Technical:** Direct Parse Server REST API calls, no web scraping needed. Fetches all productions with ratings, filters to NYC/Broadway, matches via normalized title + year. 15-minute timeout.
- **Script:** `scripts/scrape-mezzanine-audience.js`
- **Requires:** `MEZZANINE_APP_ID`, `MEZZANINE_SESSION_TOKEN`
- **Note:** Session token may expire. To refresh, intercept Mezzanine iOS app traffic via mitmproxy and update the `MEZZANINE_SESSION_TOKEN` GitHub Secret.

## `update-lottery-rush.yml`
- **Runs:** Weekly (Mondays 10 AM UTC / 5 AM EST), or manually
- **Does:** Scrapes BwayRush.com (ScrapingBee with JS rendering → HTML→markdown → regex parsing) and Playbill lottery/rush article (ScrapingBee → Claude Sonnet LLM extraction). Incrementally merges into `data/lottery-rush.json`, syncs tags in `data/shows.json`.
- **Script:** `scripts/scrape-lottery-rush.js`
- **Requires:** `SCRAPINGBEE_API_KEY`, `ANTHROPIC_API_KEY`
- **Optional:** `BRIGHTDATA_TOKEN` (fallback, currently zone not configured)
- **Safety features:**
  - Pre-write backup (keeps last 5)
  - Incremental merge (scrapers add/update, never delete)
  - Stability guard (aborts if >5 new or >3 removed show IDs)
  - Closed show + orphan cleanup (separate lifecycle step)
  - Per-source post-processing (catches LLM lottery vs rush misclassifications)
  - Post-merge cleanup (deduplicates cross-source entries, removes non-integer SRO prices)
- **CLI:** `--source=bwayrush|playbill`, `--dry-run`, `--verbose`
- **Manual trigger:** `gh workflow run "Update Lottery/Rush Data"`

## `adjudicate-review-queue.yml`
- **Runs:** Daily at 5 AM UTC (1 hour after rebuild generates queue), or manually
- **Does:** Auto-resolves flagged reviews where LLM scores disagree with aggregator thumbs using Claude Sonnet
- **Script:** `scripts/adjudicate-review-queue.js`
- **Requires:** ANTHROPIC_API_KEY
- **Manual trigger:** `gh workflow run "Adjudicate Review Queue"` (supports `dry_run` option)
- **Logic:**
  - Reads `data/audit/needs-human-review.json` (produced by `rebuild-all-reviews.js`)
  - Early exit if queue is empty (no Node setup, no API calls)
  - For each flagged review: loads source file, calls Claude Sonnet with full text + context
  - High/medium confidence → writes `humanReviewScore` to source file
  - Low confidence → increments `adjudicationAttempts`, skips
  - After 3 uncertain attempts → auto-accepts LLM original score (permanent queue removal)
  - API errors don't consume adjudication attempts (transient failures)
  - Commits changed files, triggers `Rebuild Reviews Data` workflow
- **Parallel-safe:** Only commits `review-texts/`, uses push retry loop

## `update-critic-consensus.yml`
- **Runs:** Every Sunday at 2 AM UTC
- **Does:** Generates "Critics' Take" editorial summaries (1-2 sentences, max 280 chars) via Claude API, only regenerates shows with 3+ new reviews
- **Script:** `scripts/generate-critic-consensus.js`
- **Data:** `data/critic-consensus.json`

## `process-feedback.yml`
- **Runs:** Every Monday at 9 AM UTC
- **Does:** Fetches Formspree submissions, AI-categorizes feedback, auto-diagnoses bugs/content errors, creates GitHub issue digest + separate bug-diagnosis issues
- **User-facing page:** `/feedback`
- **Scripts:** `scripts/process-feedback.js`, `scripts/diagnose-feedback-bug.js`
- **Requires:** FORMSPREE_TOKEN, ANTHROPIC_API_KEY
- **Bug diagnosis:** For each Bug/Content Error submission (max 5), keyword-matches to relevant file categories, loads code/data within ~30K token budget, calls Claude Sonnet for structured diagnosis. Creates separate GitHub Issue per bug with labels `bug-diagnosis` + `{priority}-priority`.
- **Cost:** ~$0.15/bug diagnosis, typical week $0-0.45, max $0.75
- **CLI test:** `node scripts/diagnose-feedback-bug.js --message "score seems wrong" --show "Hamilton"`

## `update-commercial.yml`
- **Runs:** Every Wednesday at 4 PM UTC
- **Does:** Scrapes Reddit grosses analysis posts, searches trade press, optional SEC EDGAR filings, uses Claude Sonnet to propose commercial.json updates, multi-source validation, shadow classifier
- **Options:** `dry_run`, `gather_only`
- **CLI flags:** `--gather-sec`, `--gather-trade-full`, `--skip-validation`, `--gather-reddit`, `--gather-trade`, `--gather-all`
- **Script:** `scripts/update-commercial-data.js`
- **Supporting modules:** `scripts/lib/parse-grosses.js`, `scripts/lib/trade-press-scraper.js`, `scripts/lib/sec-edgar-scraper.js`, `scripts/lib/source-validator.js`
- **Requires:** ANTHROPIC_API_KEY, SCRAPINGBEE_API_KEY
- **Optional:** NYT_EMAIL, NYTIMES_PASSWORD, VULTURE_EMAIL, VULTURE_PASSWORD
- **On failure:** Auto-creates GitHub issue

## `process-commercial-tip.yml`
- **Runs:** When GitHub issue created/edited with `commercial-tip` label
- **Does:** Validates user-submitted commercial data tips via Claude API, applies if valid
- **Issue template:** `.github/ISSUE_TEMPLATE/commercial-tip.yml`
- **Script:** `scripts/process-commercial-tip.js`

## `collect-review-texts.yml`
- **Runs:** Nightly at 2 AM UTC (9 PM EST) + manual trigger
- **Does:** Fetches full review text using multi-tier fallback: Archive.org → Playwright → Browserbase → ScrapingBee → Bright Data. Supports subscription logins for paywalled sites.
- **Manual trigger:** `gh workflow run "Collect Review Texts" --field show_filter=show-id`
- **Parallel runs:** YES - launch multiple with different show_filter values
- **Options:** `batch_size` (default 10), `max_reviews` (default 100), `show_filter` (REQUIRED for parallel runs), `stealth_proxy`, `browserbase_enabled` (default true), `browserbase_max_sessions` (default 10)
- **Browserbase tier (1.5):** Managed browser cloud with CAPTCHA solving. Costs ~$0.10/session. Enabled by default. Has spending limits: `browserbase_max_sessions` (default 10 per run), daily limit of 30 sessions (~$3/day max).
- **Script:** `scripts/collect-review-texts.js`
- **Truncation detection:** Checks for paywall text, "read more" prompts, proper punctuation, text length ratios, footer junk. Marks as `textQuality: "truncated"`.

## `llm-ensemble-score.yml`
- **Runs:** Manual trigger only
- **Does:** Scores reviews using 3-model ensemble (Claude Sonnet + GPT-4o + Gemini 2.0 Flash) with bucket-first approach
  - **Bucket-first scoring:** Models classify into bucket (Rave/Positive/Mixed/Negative/Pan) first, then score within range
  - **Voting logic:** Unanimous (all 3 agree) → Majority (2/3) → No consensus (uses median)
  - **Graceful degradation:** 3→2→1 model fallback if any model fails
  - **2-model mode:** If GEMINI_API_KEY not set, uses Claude + GPT-4o only
- **Options:** `show`, `limit`, `run_calibration` (default true), `run_validation`, `dry_run`, `needs_rescore`
- **Script:** `scripts/llm-scoring/index.ts`
- **Requires:** ANTHROPIC_API_KEY, OPENAI_API_KEY
- **Optional:** GEMINI_API_KEY (enables 3-model mode)
- **Pre-flight test:** `npx ts-node scripts/llm-scoring/test-ensemble.ts` (tests ensemble logic with all 3 models)
- **Ensemble calibration:** `npx ts-node scripts/llm-scoring/index.ts --ensemble-calibrate` (analyzes per-model performance)

## `scrape-nysr.yml`
- **Runs:** Weekly on Sundays at 10 AM UTC, or manually
- **Does:** Scrapes New York Stage Review via WordPress REST API, fetches full text + star ratings for all Broadway reviews
- **Script:** `scripts/scrape-nysr-reviews.js`
- **No secrets needed** (public WordPress API)
- **Technical:** Paginates `/wp-json/wp/v2/posts?categories=1`, extracts star ratings from `excerpt.rendered`, strips cross-reference lines to prevent rating contamination, HTML→plain text via cheerio
- **Parallel-safe:** Only commits `review-texts/` and `aggregator-archive/nysr/`

## `scrape-new-aggregators.yml`
- **Runs:** Weekly on Sundays at 11 AM UTC (after NYSR), or manually. Also triggered per-show via `gather-reviews.yml` scrape-aggregators job.
- **Does:** Scrapes Playbill Verdict (review URL discovery) and NYC Theatre roundups (excerpt extraction), then rebuilds `reviews.json`
- **Options:** `aggregator` (all/playbill-verdict/nyc-theatre), `shows` (comma-separated show IDs for targeted runs)
- **Requires:** SCRAPINGBEE_API_KEY (for Google search + page fetching)
- **Optional:** BRIGHTDATA_TOKEN (fallback for Playbill Verdict)
- **Scripts:** `scripts/scrape-playbill-verdict.js` (`--shows=X,Y,Z`, `--no-date-filter`), `scripts/scrape-nyc-theatre-roundups.js` (`--shows=X,Y,Z`)
- **NYC Theatre:** Only processes shows from 2023+, skip-if-exists caching via `data/aggregator-archive/nyc-theatre/`
- **Parallel-safe:** Only commits `review-texts/` and `aggregator-archive/`, rebuild commits `reviews.json`

## `scrape-bww-reviews.yml`
- **Runs:** Weekly on Sundays at 1 PM UTC (after existing scrapers), or manually
- **Does:** Scrapes BWW `/reviews/` pages (1-10 scores, review URLs, excerpts) and BWW Review Roundup articles (thumb up/meh/down, review URLs, excerpts), then rebuilds `reviews.json`
- **Options:** `type` (all/reviews/roundup), `shows` (comma-separated show IDs), `limit` (default 200), `force` (override cache)
- **Requires:** SCRAPINGBEE_API_KEY
- **Script:** `scripts/scrape-bww-reviews.js`
- **Three BWW formats handled:** (1) `/reviews/` pages with 1-10 scores, (2) new-format roundups (~2023+) with thumb images, (3) old-format roundups (pre-2023) with plain text
- **Checkpointing:** Every 25 shows in CI with git push retry
- **Archives:** `data/aggregator-archive/bww-reviews/` (review pages), `data/aggregator-archive/bww-roundups/` (roundup articles)
- **Parallel-safe:** Only commits `review-texts/` and `aggregator-archive/`, rebuild commits `reviews.json`

## `audit-aggregator-coverage.yml`
- **Runs:** Weekly on Mondays at 6 AM UTC, or manually
- **Does:** Audits review coverage across all 6 aggregator sources (DTLI, Show Score, BWW Roundups, BWW Reviews, Playbill Verdict, NYC Theatre) for all shows. Compares archive-extracted counts against local review files to identify genuine coverage gaps.
- **Options:** `status` (open/closed/all, default all), `show` (single show ID for targeted audit)
- **Script:** `scripts/audit-aggregator-coverage.js`
- **Output:** `data/audit/aggregator-coverage.json` — per-show gap analysis with `trulyMissing` metric
- **Key metrics:**
  - Per-aggregator gaps: how many reviews each aggregator lists that we don't have attributed to that source
  - `trulyMissing = max(0, maxAggregatorCount - totalLocal)`: genuine missing reviews (not just source attribution differences)
  - ~97% of per-aggregator gaps are source-attribution differences, not truly missing reviews
- **No secrets needed** (reads local files only)
- **Parallel-safe:** Only commits `data/audit/aggregator-coverage.json`
- **CLI:** `node scripts/audit-aggregator-coverage.js --output-gaps` (prints show IDs with genuine gaps for piping to gather-reviews)

## `close-coverage-gaps.yml`
- **Runs:** Manual trigger only (workflow_dispatch)
- **Does:** Orchestrates full coverage gap closure for a given era: audits gaps, gathers reviews in parallel (aggregators-only mode), scrapes PV/NYC Theatre, validates, rebuilds reviews.json
- **Options:**
  - `era`: `2021-2026` | `2016-2020` | `2011-2015` | `pre-2011` | `all`
  - `parallel_jobs`: Number of parallel gather jobs (1-10, default 5)
  - `dry_run`: Audit only, no gathering
- **Manual trigger:**
  ```bash
  gh workflow run "Close Coverage Gaps" --field era="2021-2026" --field parallel_jobs=5 --field dry_run=false
  ```
- **Job pipeline (4 jobs):**
  1. `prepare` — Filters shows by era, runs coverage audit, identifies gap shows, partitions into matrix batches, uploads gap-data artifact
  2. `gather-gaps` (matrix, N parallel jobs) — Runs `gather-reviews.js --aggregators-only` per show, checkpoint commits every 10 shows, pre-commit JSON validation, failure tracking via artifacts. No ANTHROPIC_API_KEY needed.
  3. `scrape-pv-nyc` — Runs Playbill Verdict + NYC Theatre for gap shows (60 min, continue-on-error)
  4. `rebuild` — Validates data, rebuilds reviews.json, writes step summary
- **Requires:** SCRAPINGBEE_API_KEY, BRIGHTDATA_TOKEN (no ANTHROPIC_API_KEY needed — aggregators-only mode)
- **Performance:** ~20 sec/show (vs ~5 min/show previously). 100 gap shows in ~7 min with 5 parallel jobs.
- **Parallel-safe:** Matrix strategy with round-robin distribution, 30s stagger, 5-retry push with rebase, fail-fast: false, pre-commit JSON validation, atomic file writes

## `test.yml`
- **Runs:** On push to `main`, daily at 6 AM UTC, manually
- **Tests:** Data validation (duplicates, required fields, dates, status), **text quality audit** (35% full, <40% truncated, <5% unknown), E2E tests (homepage, show pages, navigation, filters, mobile)
- **Quality thresholds:** Fails if review text quality drops below standards
- **On Failure:** Auto-creates GitHub issue

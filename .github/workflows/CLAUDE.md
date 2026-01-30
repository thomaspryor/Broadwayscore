# GitHub Actions Workflow Reference

Detailed descriptions of all automated workflows. See root `CLAUDE.md` for secrets table and critical rules.

## `update-show-status.yml`
- **Runs:** Daily at 8 AM UTC (3 AM EST)
- **Does:** Updates show statuses (open → closed, previews → open), discovers new shows on Broadway.org, auto-adds new shows with status "previews"
- **Triggers for newly opened shows (previews → open):** `gather-reviews.yml`, `update-reddit-sentiment.yml`, `update-show-score.yml`

## `gather-reviews.yml`
- **Runs:** When new shows discovered (or manually triggered)
- **Does:** Gathers review data by searching aggregators and outlets
- **Secrets required:** `ANTHROPIC_API_KEY`, `BRIGHTDATA_TOKEN`, `SCRAPINGBEE_API_KEY`
- **Script:** `scripts/gather-reviews.js`
- **Manual trigger:** `gh workflow run gather-reviews.yml -f shows=show-id-here`
- **Technical notes:**
  - Installs Playwright Chromium for Show Score carousel scraping
  - Show Score extraction uses Playwright to scroll through ALL critic reviews (not just first 8)
  - Detects and rejects Show Score redirects to off-broadway shows
  - Tries `-broadway` URL suffix patterns first
  - **Parallel-safe:** Only commits `review-texts/` and `archives/` (NOT `reviews.json`)
  - Uses retry loop (5 attempts) with random backoff for git push conflicts
  - After batch runs complete, rebuild `reviews.json` with: `node scripts/rebuild-all-reviews.js`

## `review-refresh.yml`
- **Runs:** Weekly on Mondays at 9 AM UTC
- **Does:** Checks all open shows for new reviews not yet in the database, compares aggregator review counts against local review-texts, triggers `collect-review-texts.yml` per show if new reviews found
- **Script:** `scripts/check-show-freshness.js`
- **Note:** Discovers new reviews but does NOT rebuild `reviews.json`

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
- **Does:** Fetches poster/thumbnail/hero from TodayTix CDN, archives locally as WebP, backs up CDN URLs to `data/image-sources.json`, updates `shows.json` to use local paths
- **Scripts:** `scripts/fetch-show-images-auto.js` → `scripts/archive-show-images.js`
- **Triggered by:** `update-show-status.yml` and `discover-historical-shows.yml`
- **Image formats:** Poster 720x1080, Thumbnail 540x540, Hero 1920x800 (all WebP)

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

## `discover-historical-shows.yml`
- **Runs:** Manual trigger only
- **Does:** Discovers closed Broadway shows from past seasons, adds with status "closed" and tag "historical", auto-triggers review gathering
- **Usage:** Specify seasons like `2024-2025,2023-2024` (one or two at a time)

## `process-review-submission.yml`
- **Runs:** When GitHub issue created/edited with `review-submission` label
- **Does:** Validates review submission via Claude API, scrapes and adds if approved, closes issue
- **User-facing page:** `/submit-review`
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
- **Does:** Scrapes r/Broadway for discussions, uses Claude Opus for sentiment analysis, updates `data/audience-buzz.json`
- **Options:** `show`, `shows` (comma-separated), `limit` (default 50)
- **Technical:** Uses ScrapingBee with premium proxy, generic titles use Broadway-qualified searches, 2-hour timeout with `if: always()` commit
- **Script:** `scripts/scrape-reddit-sentiment.js`

## `update-critic-consensus.yml`
- **Runs:** Every Sunday at 2 AM UTC
- **Does:** Generates "Critics' Take" editorial summaries (1-2 sentences, max 280 chars) via Claude API, only regenerates shows with 3+ new reviews
- **Script:** `scripts/generate-critic-consensus.js`
- **Data:** `data/critic-consensus.json`

## `process-feedback.yml`
- **Runs:** Every Monday at 9 AM UTC
- **Does:** Fetches Formspree submissions, AI-categorizes feedback, creates GitHub issue digest
- **User-facing page:** `/feedback`
- **Script:** `scripts/process-feedback.js`
- **Requires:** FORMSPREE_TOKEN

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
- **Runs:** Manual trigger only
- **Does:** Fetches full review text using multi-tier fallback: Playwright → Browserbase → ScrapingBee → Bright Data → Archive.org. Supports subscription logins for paywalled sites.
- **Manual trigger:** `gh workflow run "Collect Review Texts" --field show_filter=show-id`
- **Parallel runs:** YES - launch multiple with different show_filter values
- **Options:** `batch_size` (default 10), `max_reviews` (default 50), `show_filter` (REQUIRED for parallel runs), `stealth_proxy`, `browserbase_enabled`, `browserbase_max_sessions`
- **Browserbase tier (1.5):** Managed browser cloud with CAPTCHA solving. Costs ~$0.10/session. Enable with `browserbase_enabled=true`. Has spending limits: `browserbase_max_sessions` (default 10 per run), daily limit of 30 sessions (~$3/day max).
- **Script:** `scripts/collect-review-texts.js`
- **Truncation detection:** Checks for paywall text, "read more" prompts, proper punctuation, text length ratios, footer junk. Marks as `textQuality: "truncated"`.

## `llm-ensemble-score.yml`
- **Runs:** Manual trigger only
- **Does:** Scores reviews using Claude Sonnet + GPT-4o-mini ensemble, flags disagreements >15 points
- **Options:** `show`, `limit`, `run_calibration` (default true), `dry_run`
- **Script:** `scripts/llm-scoring/index.ts`
- **Requires:** ANTHROPIC_API_KEY, OPENAI_API_KEY

## `test.yml`
- **Runs:** On push to `main`, daily at 6 AM UTC, manually
- **Tests:** Data validation (duplicates, required fields, dates, status) + E2E (homepage, show pages, navigation, filters, mobile)
- **On Failure:** Auto-creates GitHub issue

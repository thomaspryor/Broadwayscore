# Broadway Scorecard — Detailed Reference

> **Companion documentation to `CLAUDE.md`.** Read specific sections when working on the corresponding subsystem. Do NOT read the entire file for general tasks — `CLAUDE.md` has summaries with pointers to relevant sections here.

---

## IBDB Date Enrichment

`scripts/lib/ibdb-dates.js` looks up preview, opening, and closing dates from IBDB (Internet Broadway Database). IBDB has separate "1st Preview" and "Opening Date" fields, unlike Broadway.org which only has an ambiguous "Begins:" date.

**How it works:** Google SERP search (`site:ibdb.com/broadway-production`) → ScrapingBee premium proxy to fetch production page HTML → JSDOM text extraction → regex date parsing.

**Fallback chain for search:** ScrapingBee Google SERP → Bright Data SERP → direct URL construction from title slug.

**Creative team extraction:** `extractCreativeTeamFromText()` parses 15 role patterns from IBDB page text (e.g., "Directed by X", "Choreographed by Y", "Scenic Design by Z"). Handles multi-word names, "and" separators, excess whitespace from HTML tables, and deduplicates "Music & Lyrics" vs standalone "Music"/"Lyrics" entries. Returns `[{ name, role }]` array matching the `creativeTeam` schema.

**Integration with discovery:** Both `discover-new-shows.js` and `discover-historical-shows.js` enrich dates and creative team from IBDB after discovering shows. If IBDB lookup succeeds, its opening date overwrites Broadway.org's "Begins:" date and creative team is populated (if non-empty). If IBDB fails, Broadway.org's "Begins:" is treated as `previewsStartDate` (not `openingDate`).

**Standalone enrichment:** `node scripts/enrich-ibdb-dates.js` with flags: `--dry-run`, `--show=SLUG`, `--missing-only` (default), `--verify` (compare only), `--force` (overwrite), `--status=open|previews|closed`. Also backfills shows with empty `creativeTeam` arrays.

---

## Review Normalization Internals

**Outlet-critic concatenation handling:** `normalizeOutlet()` automatically strips critic names from concatenated outlet IDs (e.g., `variety-frank-rizzo` → `variety`, `new-york-magazinevulture-sara-holdren` → `vulture`). This catches upstream data sources that merge outlet and critic names.

**First-name prefix dedup:** `gather-reviews.js` checks if an incoming critic's name is a first-name prefix of an existing critic at the same outlet (e.g., incoming "Jesse" at nytimes matches existing "Jesse Green"). Merges into the existing file instead of creating a duplicate. `rebuild-all-reviews.js` also has prefix dedup as a safety net when building reviews.json, skipping entries where one critic key is a prefix of another at the same outlet.

---

## Critic-Outlet Misattribution System

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

---

## Text Quality Classification — Full Details

### Content Tier Paths to "Complete"

1. **Path 1** (standard): 300+ words, proper ending punctuation, no truncation signals
2. **Path 2** (long text): 500+ words regardless of ending (long enough to be usable)
3. **Path 3** (short but complete): 150+ words, zero truncation signals, proper ending, opinion language detected, text longer than 1.1x longest excerpt

Path 3 uses `hasOpinionLanguage()` which requires 2+ matches from evaluative/critical patterns (brilliant, disappointing, succeeds, struggles, recommended, etc.) to distinguish real capsule reviews from plot summaries.

### Legacy Text Quality (4-tier)

Set by `classifyTextQuality()` inline in `collect-review-texts.js`. Stored as `textQuality` field:
- `full` — >1500 chars, mentions show title, >300 words, no truncation signals
- `partial` — 500-1500 chars or larger but missing criteria
- `truncated` — Has paywall/login text, "read more" prompts, or severe signals
- `excerpt` — <500 chars

### Junk Handling Details

**Automatic junk stripping:** Removes newsletter promos (TheaterMania), login prompts (BroadwayNews), "Read more" links (amNY), signup forms (Vulture/NY Mag) from end of scraped text.

**Legitimate endings recognized:** Theater addresses, URLs, production credits, ticket info — these don't trigger false truncation.

**Truncation signals detected:**
- `has_paywall_text` — "subscribe", "sign in", "members only"
- `has_read_more_prompt` — "continue reading", "read more"
- `has_footer_text` — "privacy policy", "terms of use"
- `shorter_than_excerpt` — fullText shorter than aggregator excerpt
- `no_ending_punctuation` — Doesn't end with .!?"')
- `possible_mid_word_cutoff` — Ends with lowercase letter

**Garbage detection guards (Feb 2026):** To prevent false positives on legitimate reviews:
- Legal page patterns (e.g., "All Rights Reserved") are skipped for texts >500 chars — copyright footers are not garbage
- Error page patterns (e.g., "has been removed") only check first 300 chars for long texts — prevents theatrical context matches
- Ad blocker detection requires full message context, not just the word "adblock"

**Automated quality checks:**
- `scripts/audit-text-quality.js` — Runs in CI, enforces thresholds (35% full, <40% truncated, <5% unknown)
- Quality classification happens automatically during `collect-review-texts.js` and `gather-reviews.js`
- `review-refresh.yml` now rebuilds `reviews.json` after collecting new reviews

---

## Off-Broadway Transfer Reviews

18 reviews are flagged `wrongProduction: true` with `wrongProductionNote` indicating the off-Broadway venue. When adding off-Broadway show entries, these reviews can be moved/copied to the new show:
- **Hamilton** (4 reviews) → Public Theater, Feb 2015
- **Stereophonic** (6 reviews) → Playwrights Horizons, Oct 2023
- **The Great Gatsby** (3 reviews) → Park Central Hotel immersive, Jun 2023
- **Illinoise** (3 reviews) → Park Avenue Armory, Mar 2024
- **Oh, Mary!** (2 reviews) → Lucille Lortel Theatre, Feb-May 2024

---

## Wrong-Production Prevention Guards

Three layers prevent wrong-production/wrong-show content from entering the corpus:

1. **`gather-reviews.js`** — `production-verifier.js` checks review text against show metadata at intake time. Only runs for reviews entering via aggregator sources (DTLI, BWW, Show Score, etc.).

2. **`scrape-playbill-verdict.js`** — Two guards:
   - Title filter (`isNotBroadway()`) rejects streaming/TV keywords: "apple tv", "netflix", "hulu", "disney+", "streaming", "amazon prime", "tv series", "tv show"
   - URL year check: extracts year from review URL, compares to show opening year. Skips if gap > 3 years before or 2 years after opening. Catches TV series reviews (e.g., 2021 Schmigadoon! Apple TV+ vs 2026 Broadway) and old off-Broadway productions.

3. **`collect-review-texts.js`** — Post-scrape date check in `updateReviewJson()`: after successfully scraping fullText, extracts year from URL, compares to show opening year. Auto-flags `wrongProduction: true` with explanatory note if gap exceeds ±3/+2 years. Uses `_showsJsonCache` for efficient shows.json lookups.

**Year gap thresholds:** `urlYear < showYear - 3` or `urlYear > showYear + 2`. The asymmetric window accounts for pre-opening press (reviews up to 3 years before) and post-opening coverage (up to 2 years after). URL year extraction uses `/\/((?:19|20)\d{2})\//` pattern restricted to plausible years (avoids matching article IDs like `/6910/`).

---

## Full Text Collection Architecture

### Tier Chain

`collect-review-texts.js` uses a declarative tier chain:

| Tier | Method | Success Rate | Notes |
|------|--------|-------------|-------|
| 0 | Archive.org (first for paywalled) | 11.1% | Best performer |
| 0.5 | Archive.org CDX multi-snapshot | New (Feb 2026) | Queries CDX API for up to 10 snapshots, tries oldest-first |
| 1 | Playwright + stealth | 6.7% | Local browser |
| 1.5 | Browserbase | Enabled by default | $0.10/session, CAPTCHA solving |
| 2 | ScrapingBee | 3.6% | API-based |
| 3 | Bright Data Web Unlocker | 3.7% | API-based |
| 3.5 | Archive.org CDX (fallback) | New (Feb 2026) | Same as 0.5 but final fallback |
| 4 | Archive.org (final fallback) | — | Last resort |

### Declarative Architecture

- `buildTierContext()` — computes URL properties (isKnownBlocked, isArchiveFirst, hasPaywallCreds) and mutable state signals (including `_archiveCdxRan`)
- `buildTierChain()` — returns 9 tier descriptors (0, 0.5, 1, 4-early, 1.5, 2, 3, 3.5, 4), each with `shouldRun()` predicates and `onFailure()` hooks
- `checkContentQuality()` — quality gate using `isGarbageContent()` that rejects paywall pages, newsletter overlays, ad-blocker walls. When a tier returns HTTP 200 with garbage content, the loop falls through to the next tier instead of accepting it.
- `withTimeout()` — wraps tier execution with configurable timeout (Browserbase gets 120s)
- Best-of-garbage fallback — tracks the longest garbage response in case all tiers fail, uses it as last resort

### Archive.org CDX Multi-Snapshot

`fetchFromArchiveCDX()` queries the CDX API (`/cdx/search/cdx?url=X&output=json&limit=10`) to find multiple archived snapshots when the single-snapshot availability API fails. Tries oldest-first (pre-paywall content for WSJ, pre-login for BroadwayNews). Rate limited: 2s between snapshot fetches (CDX has ~15 req/min undocumented limit). Integrated as Tier 0.5 (archive-first sites) and Tier 3.5 (final fallback).

`archiveFirstSites` includes: nytimes, vulture, nymag, washingtonpost, wsj, newyorker, ew, latimes, rollingstone, chicagotribune, nypost, nydailynews, theatrely, amny, forward, timeout, broadwaynews.

### Browserbase Routing Fix (Feb 2026)

Paywalled sites returning 404 used to trigger a fast-path that skipped Browserbase entirely. Fixed to allow paywalled 404s to fall through to Browserbase when login credentials exist, since 404 may be due to anti-bot blocking rather than a dead URL. `archiveFirstSites` routes paywalled domains to Archive.org first (Tier 0), meaning Browserbase only fires for non-archived paywalled content.

### Content Tier Filtering

`CONTENT_TIER_FILTER` env var (and `content_tier` workflow input) allows targeted collection runs by tier: `excerpt`, `truncated`, or `needs-rescrape`. Enables parallel dispatches for different review categories.

### Collection Status (Feb 2026)

**704 reviews need re-scraping** (truncated/stub/needs-rescrape):

| Category | Count | Top Outlets |
|----------|-------|-------------|
| Free (no login) | 568 | timeout (52), deadline (40), new-york-sun (34), observer (26), nydailynews (24), thestage (18) |
| Paywalled | 136 | wsj, nytimes, vulture, newyorker, washpost, latimes, telegraph, financialtimes |

**Content tier distribution (3,644 source files):** 2,138 complete (58.6%), 774 excerpt (21.2%), 484 truncated (13.3%), 154 stub (4.2%), 66 needs-rescrape (1.8%), 16 invalid, 8 none, 4 full.

---

## Credential Status & Anti-Bot Notes

| Site | Status | Notes |
|------|--------|-------|
| WSJ | **Untestable in CI** | Dow Jones SSO blocks headless Chrome on GitHub Actions IPs — form fields don't render. Use Browserbase tier for actual collection. |
| NYT | **Untestable in CI** | Same anti-bot blocking — `myaccount.nytimes.com` won't render login form in headless CI Chrome. Browserbase tier needed. |
| Vulture/NY Mag | Untested | Needs verification |
| Washington Post | Untested | Needs verification |

`test-paywalled-access.yml` uses plain Playwright headless Chrome which WSJ and NYT block. The actual `collect-review-texts.js` uses Browserbase (Tier 1.5) with CAPTCHA solving. To test credentials, run collection with `browserbase_enabled=true` targeting a specific paywalled review.

---

## Scoring Pipeline Internals

### Full Scoring Hierarchy (with review counts)

- **Priority 0:** Explicit ratings extracted from review text (stars, letter grades, X/5, "X out of Y") — 199 reviews
- **Priority 0.5:** `humanReviewScore` (1-100) — manual override from audit queue, always paired with `humanReviewNote` — 60 reviews (120 source files, but 60 overridden by higher-priority explicit ratings)
- **Priority 0b:** `originalScore` parsed from field (letter grades, star ratings) — 67 reviews
- **Priority 1:** LLM ensemble score (high/medium confidence, not needs-review) — 1,142 reviews
- **Priority 2:** Aggregator thumb override of low-confidence/needs-review LLM — 0 reviews
- **Priority 3:** LLM fallback (low confidence, single/no thumbs) — 272 reviews

### P2 Direction Comparison Fix (Feb 2026)

The P2 thumb override previously compared exact buckets (Rave/Positive/Mixed/Negative/Pan), but aggregator thumbs only have 3 levels (Up/Meh/Down). This caused false overrides: an LLM score of 87 (Rave bucket) with both thumbs "Up" (Positive bucket) was treated as a disagreement. Fixed by comparing *directions* (positive/negative/neutral) instead of exact buckets.

### Excerpt-Only Confidence Downgrade

When `fullText` is missing or <100 chars, LLM confidence is downgraded to "low" regardless of model report. Audit showed ~50% error rate on excerpt-only high/medium confidence scores. Routes through Priority 2/3 instead.

### garbageFullText Recovery

During rebuild, reviews with `fullText: null` but `garbageFullText` >200 chars are cleaned via `cleanText()`. If >200 chars after cleaning, promoted to `fullText` for scoring. 114 reviews recovered. Source files NOT modified — recovery is in-memory only.

### contentTier Flow-Through

`rebuild-all-reviews.js` carries `contentTier` from source files into `reviews.json`.

### Human Review Queue

`data/audit/needs-human-review.json` lists reviews where LLM score and aggregator thumbs disagree. Categories: `both-thumbs-override-llm` (auto-handled), `single-thumb-override-low-conf`, `both-thumbs-disagree-with-llm` (needs manual review). As of Feb 2026: 2 reviews in queue.

### Automated Adjudication

`scripts/adjudicate-review-queue.js` runs daily at 5 AM UTC (via `adjudicate-review-queue.yml`), 1 hour after rebuild. For each flagged review, calls Claude Sonnet to re-evaluate. High/medium confidence → writes `humanReviewScore`. Low confidence → increments `adjudicationAttempts`. After 3 uncertain attempts → auto-accepts LLM original score. API errors don't consume attempts.

Fields written: `humanReviewScore`, `humanReviewNote`, `humanReviewPreviousScore`, `humanReviewAt`, `adjudicationAttempts`, `adjudicationHistory`.

---

## LLM Ensemble Scoring Constraints

**BEFORE triggering `llm-ensemble-score.yml`, ALWAYS calculate estimated runtime:**
- 4-model ensemble (Claude + GPT-4o + Gemini + Kimi): ~0.66 min/review (~90 reviews/hour)
- 3-model ensemble: ~0.5 min/review (~120 reviews/hour)
- GitHub Actions job timeout: **6 hours (360 minutes)**
- **Max safe batch: ~400 reviews** (400 × 0.66 = 264 min, well under 360)

**Git checkpointing:** Every 100 reviews (default in CI, configurable via `--checkpoint=N`), the pipeline commits and pushes. If the job times out at review 350, reviews 0-299 are safe (3 checkpoints committed).

**Full rescore procedure (~1,700+ reviews):**
1. Batch 1: `--rescore --limit=500` (scores first 500 with new prompt version)
2. Batch 2+: `--outdated` with no limit (catches reviews still on old prompt version)
3. Final verification: `--outdated` with no limit (should find 0 to process)

**Why `--outdated` works after batch 1:** The first `--rescore` batch updates `promptVersion` on scored files. Subsequent `--outdated` runs find files with older versions — exactly the remaining unscored ones.

**Cost:** ~$0.045/review ($18/batch of 400, ~$80 for full corpus)

---

## Known Audit Flags

**17 verified legitimate flags** — these are flagged by audits but are correct:
- **9 long-running show re-reviews:** URL year mismatches for Book of Mormon (2011), Chicago (1996), Lion King (1997), Wicked (2003) — critics reviewing years after opening.
- **4 Chris Jones cross-outlet URLs:** 3 nydailynews reviews have chicagotribune.com URLs, 1 washpost has journaltimes.com. Freelancer syndication.
- **1 Deadline roundup:** 8 shows share one roundup URL. Flagged `isRoundupArticle: true`.
- **2 fullText matches excerpt:** purlie-victorious-2023 and the-roommate-2024 — partial scrapes marked truncated.
- **1 web-search null URL:** lion-king washpost legacy entry.

---

## Remaining Data Quality Work

**Re-scraping queue:** ~188 free-site reviews and ~136 paywalled reviews still need fullText. Nightly cron handles collection.

**TheaterMania misattribution cleanup (Feb 2026):** 11 reviews attributed to Jesse Green/Adam Feldman at TheaterMania were web-search bulk import artifacts. All flagged `wrongAttribution: true`, `contentTier: "invalid"`.

**L&SA and TalkingBroadway URLs are NOT generic:** Use query parameters for routing (`?ID=`, `?page=&id=`). Audit `normalizeUrl()` preserves query params (only strips tracking params like `utm_*`).

**27 cross-outlet duplicate-text reviews:** Files with `duplicateTextOf` field where the same fullText appears at different outlets. Legitimate freelancer syndication.

**Content quality audit:** Run `node scripts/audit-content-quality.js` after bulk data changes. Baseline: 17 issues, zero critic name mismatches.

---

## Fixed Data Quality Issues (Feb 2026)

> All issues below have been resolved. This section is preserved as historical reference for understanding past patterns and the systems that now prevent recurrence.

### Text Quality Issues (All Fixed)

**HTML entity pollution:** Entities decoded at three points: `cleanText()`, `mergeReviews()`, and `rebuild-all-reviews.js`. All use shared `decodeHtmlEntities()` from text-cleaning.js.

**Outlet-specific junk in fullText:** `text-cleaning.js` has outlet-specific trailing junk patterns for EW, BWW, Variety, BroadwayNews, and The Times UK.

**Byline extraction false positives:** `extractByline()` accepts `options.excludeNames` to skip creative team names. Pattern 3 ("Written by X") removed. Non-name word blocklist added.

**Quality classification in `gather-reviews.js`:** Now runs `classifyContentTier()` on every review before writing.

**Web-search bulk import garbage:** 79 files fixed (63 excerpt copies, 9 error pages, 5 paywall stubs, 2 misc). Detection: `audit-content-quality.js` "fullText Matches Excerpt" check.

**BroadwayNews cross-contamination:** 3 reviews at EW/Deadline had BroadwayNews content scraped. Fixed by nulling fullText.

**Critic name misattributions:** 8 reviews fixed. Patterns: same person different name, wrong critic's text, wrong outlet content, aggregator misattributed critic.

### Scoring Issues (All Fixed)

**Explicit ratings auto-converted:** 327 reviews (16.3%) using explicit ratings. `scoreSource` field tracks method.

**Excerpt-only confidence downgrade:** ~50% error rate on excerpt-only high/medium confidence. Now auto-downgrades.

**garbageFullText recovery:** 114 reviews recovered from garbage field via `cleanText()`.

**LLM low-confidence garbage detector:** `detectGarbageFromReasoning()` checks 17 patterns. 34 reviews flagged `needs-rescrape`.

### Deduplication Issues (All Fixed)

**URL uniqueness:** 158 duplicate files deleted, 0 duplicate outlet+critic combos remaining.

### Workflow Issues (All Fixed)

**Parallel push conflicts:** All 8 parallel-safe workflows use robust push retry with random backoff and 5 retries.

### Schmigadoon TV Series Pattern (Fixed)

14 reviews for the 2021 Apple TV+ series incorrectly entered `schmigadoon-2026/`. All flagged `wrongShow: true`. Prevention: playbill-verdict now has title keyword filter + URL year check.

**Test infrastructure:** CI fully passing. All test compatibility issues resolved.

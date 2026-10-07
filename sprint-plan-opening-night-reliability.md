# Sprint Plan: Opening Night Reliability

## Overview
Make opening night review gathering reliable by: (1) expanding RSS coverage, (2) deferring SERP discovery for the first ~4 hours when Google hasn't indexed reviews yet, (3) building a URL paste fallback for manual/agent-assisted ingestion, and (4) shifting the broadcast target to morning. The goal is to eliminate the 6-7 hour post-opening cleanup sessions caused by SERP discovering wrong URLs.

## Sprint Summary
| Sprint | Goal | Tasks | Complexity | Model |
|--------|------|-------|------------|-------|
| 1 | RSS + SERP deferral ship — automation is safer tonight | 5 | 4S, 1M | Sonnet |
| 2 | URL paste mode works end-to-end | 4 | 1S, 2M, 1S | Opus |
| 3 | Quarantine gate prevents bad data from entering pipeline | 3 | 1S, 2M | Opus |

---

## Sprint 1: RSS Expansion + SERP Deferral
**Demo:** Opening night poller skips SERP for first N iterations; 3 new RSS feeds active
**Risks:** RSS feeds could 404 by implementation time (tested today, all working). Orchestrator loop iteration math might be off.
**MODEL: Sonnet** — straightforward config/flag changes with clear specs

### Task S1-T1: Add 3 RSS feeds to rss-discovery.js
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** `scripts/lib/rss-discovery.js` (modify)
- **Description:** Add NY Post Entertainment, IndieWire, and Rolling Stone TV/Movies feeds to the ENTERTAINMENT_FEEDS array. All three use `needsFilter: true` for title matching.
- **Acceptance criteria:**
  - VERIFY: `node -e "const {ALL_FEEDS} = require('./scripts/lib/rss-discovery'); console.log(ALL_FEEDS.length)"` shows 22 (up from 19)
  - VERIFY: `node -e "const {ALL_FEEDS} = require('./scripts/lib/rss-discovery'); console.log(ALL_FEEDS.filter(f => ['nypost','indiewire','rollingstone'].includes(f.outletId)).map(f => f.name))"` shows all 3 new feeds
  - VERIFY: `node -e "const {checkRSSFeeds} = require('./scripts/lib/rss-discovery'); checkRSSFeeds('Dog Day Afternoon', {verbose:true, maxHoursAgo:168}).then(r => console.log(r.length, 'results'))"` returns results (may be 0 if no matching reviews, but no errors)

### Task S1-T2: Verify outlet IDs exist in outlet-registry.json
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** `data/outlet-registry.json` (verify, possibly modify)
- **Description:** Confirm that 'nypost', 'indiewire', and 'rollingstone' exist as outlet IDs in outlet-registry.json. If any are missing or use different IDs, either add them or adjust the RSS feed config to use the correct ID.
- **Acceptance criteria:**
  - VERIFY: `node -e "const r=require('./data/outlet-registry.json'); ['nypost','indiewire','rollingstone'].forEach(id => console.log(id, r[id] ? 'EXISTS' : 'MISSING'))"` shows all 3 as EXISTS

### Task S1-T3: Make orchestrator skip SERP for first N iterations
- **Complexity:** M
- **Depends on:** None
- **Parallel:** Yes
- **Files:** `.github/workflows/opening-night-orchestrator.yml` (modify)
- **Description:** In the orchestrator's polling loop (line 274), add logic to pass `skip_serp=true` for the first 4 iterations (roughly the first 4 hours at 45-min intervals). After iteration 4, stop passing the flag so SERP kicks in. This uses the existing `skip_serp` input on the poller workflow — no new flags needed. The SERP budget check (line 243) should still override with skip_serp=true if budget is low.
- **Acceptance criteria:**
  - VERIFY: Read the workflow and confirm: iterations 1-4 pass `-f skip_serp=true`, iterations 5+ do not (unless budget override)
  - VERIFY: `act` dry-run or manual read confirms the YAML is valid
  - VERIFY: The existing `SKIP_SERP` budget override on line 243 still takes precedence (if budget is low, ALL iterations skip SERP)

### Task S1-T4: Gate gather-reviews SERP during opening night window
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** `.github/workflows/opening-night-orchestrator.yml` (modify) OR `.github/workflows/gather-reviews.yml` (modify)
- **Description:** The orchestrator dispatches gather-reviews.yml which has its own SERP path (gather-reviews.js:3370). During opening night, gather-reviews should also skip SERP. Two options: (a) orchestrator passes `aggregators_only=true` to gather-reviews.yml, or (b) gather-reviews.yml checks if it was dispatched by the orchestrator and auto-skips SERP. Option (a) is simpler — gather-reviews.js already has `--aggregators-only` (line 3318).
- **Acceptance criteria:**
  - VERIFY: When orchestrator dispatches gather-reviews during opening night, the `--aggregators-only` flag is passed
  - VERIFY: gather-reviews.yml has an `aggregators_only` workflow_dispatch input (add if missing)
  - VERIFY: The flag flows through to the script CLI args

### Task S1-T5: Test RSS + SERP deferral against a real show
- **Complexity:** S
- **Depends on:** S1-T1, S1-T2, S1-T3
- **Parallel:** No
- **Files:** None (testing only)
- **Description:** Run the poller in dry-run mode against a recently-opened show (e.g., dog-day-afternoon-2026) with `--skip-serp` to simulate Phase 1 behavior. Verify that Layers 1-3 (aggregators + RSS + site-search) find a reasonable number of reviews without SERP. Compare count against what SERP adds.
- **Acceptance criteria:**
  - VERIFY: `node scripts/opening-night-poller.js --show=dog-day-afternoon-2026 --skip-serp --dry-run --verbose 2>&1 | tail -20` shows review count from Layers 1-3
  - VERIFY: Layer 1-3 coverage is at least 60% of total known reviews for that show
  - VERIFY: No errors or crashes in dry-run mode

---

## Sprint 2: URL Paste Mode (Break Glass)
**Demo:** Paste a file of URLs → reviews are ingested, scored, and appear on the site
**Risks:** resolveOutletFromUrl() returns null for unknown domains. fetchPage() may fail on some outlets in local env (no BD/SB keys).
**MODEL: Opus** — new script with integration across multiple existing modules

### Task S2-T1: Create ingest-urls.js script (core logic)
- **Complexity:** M
- **Depends on:** None
- **Parallel:** Yes
- **Files:** `scripts/ingest-urls.js` (new)
- **Description:** Create a script that reads `--show=ID` and `--urls=file.txt` (one URL per line, blank lines and # comments ignored). For each URL: resolve outlet via `resolveOutletFromUrl()`, fetch text via `fetchPage()`, create review file via `createOrMergeReviewFile()`. Handle null outlet resolution with a warning + `--default-outlet=ID` override flag. Skip URLs that already have review files (dedup). Print summary at end.
- **Acceptance criteria:**
  - VERIFY: `echo "https://www.nytimes.com/2026/03/30/theater/dog-day-afternoon-review.html" > /tmp/test-urls.txt && node scripts/ingest-urls.js --show=dog-day-afternoon-2026 --urls=/tmp/test-urls.txt --dry-run` shows outlet detection + dry-run output (no files created)
  - VERIFY: Script handles a URL with unknown domain gracefully (warning, not crash)
  - VERIFY: Script handles empty file, file with only comments, file not found — all gracefully

### Task S2-T2: Add scoring + rebuild trigger to ingest-urls.js
- **Complexity:** M
- **Depends on:** S2-T1
- **Parallel:** No
- **Files:** `scripts/ingest-urls.js` (modify)
- **Description:** After all URLs are ingested, trigger: (1) LLM ensemble scoring for new files via `gh workflow run llm-ensemble-score.yml`, (2) rebuild via `gh workflow run rebuild-reviews.yml`, (3) deploy via `gh workflow run vercel-deploy.yml`. Add `--no-rebuild` flag to skip these (for when user wants to ingest in batches). Print workflow run URLs so user can monitor.
- **Acceptance criteria:**
  - VERIFY: `node scripts/ingest-urls.js --show=test --urls=/tmp/test-urls.txt --dry-run` shows "Would trigger: scoring, rebuild, deploy" message
  - VERIFY: `--no-rebuild` flag suppresses workflow triggers
  - VERIFY: Script uses `gh workflow run` (not direct API calls)

### Task S2-T3: Add ingest-urls GitHub workflow
- **Complexity:** S
- **Depends on:** S2-T1
- **Parallel:** Yes
- **Files:** `.github/workflows/ingest-urls.yml` (new)
- **Description:** Workflow_dispatch workflow that accepts `show_id` and `urls` (newline-separated text input) parameters. Runs ingest-urls.js in CI with proper secrets (BRIGHTDATA_TOKEN, SCRAPINGBEE_API_KEY, OPENAI_API_KEY). This allows running from phone via `gh workflow run`.
- **Acceptance criteria:**
  - VERIFY: YAML is valid (`python3 -c "import yaml; yaml.safe_load(open('.github/workflows/ingest-urls.yml'))"`)
  - VERIFY: Workflow has `workflow_dispatch` trigger with `show_id` and `urls` inputs
  - VERIFY: Both BRIGHTDATA_TOKEN and SCRAPINGBEE_API_KEY are in env block

### Task S2-T4: Test ingest-urls end-to-end with 3 real URLs
- **Complexity:** S
- **Depends on:** S2-T1, S2-T2
- **Parallel:** No
- **Files:** None (testing only)
- **Description:** Test with 3 diverse URLs: one T1 outlet (e.g., NYT), one T2 (e.g., NY Post), one with unknown domain. Verify outlet detection, text fetching, and file creation all work. Run with `--no-rebuild` to avoid triggering workflows during testing.
- **Acceptance criteria:**
  - VERIFY: 3 URLs ingested, 2 files created (T1 + T2), 1 warning for unknown domain
  - VERIFY: Created files have correct outlet ID, URL, and non-empty fullText
  - VERIFY: Files are in the correct show directory under data/review-texts/

---

## Sprint 3: Review Quarantine Gate
**Demo:** Poller rejects bad URLs before they enter the scoring pipeline
**Risks:** Too-strict validation could reject legitimate reviews. Need to tune thresholds on real data.
**MODEL: Opus** — modifying core pipeline logic, needs careful analysis

### Task S3-T1: Add pre-write validation function to review-guards.js
- **Complexity:** M
- **Depends on:** None
- **Parallel:** Yes
- **Files:** `scripts/lib/review-guards.js` (modify)
- **Description:** Add `validateBeforeWrite(showData, reviewData)` function that checks: (1) outlet resolves to a known ID (domain → outlet-registry), (2) no existing file from same outlet+critic (dedup), (3) publish date within ±14 days of opening date if available. Returns `{ valid: true }` or `{ valid: false, reason: string }`. Reuse existing `titleMatchesShow()` from rss-discovery.js for title validation. Keep the ±14 day window loose — this is a safety net, not a filter.
- **Acceptance criteria:**
  - VERIFY: `node -e "const {validateBeforeWrite} = require('./scripts/lib/review-guards'); console.log(typeof validateBeforeWrite)"` shows 'function'
  - VERIFY: Test with a valid review object → returns `{ valid: true }`
  - VERIFY: Test with unknown outlet domain → returns `{ valid: false, reason: 'unknown outlet' }`
  - VERIFY: Test with publish date 90 days before opening → returns `{ valid: false, reason: 'date out of range' }`

### Task S3-T2: Wire quarantine into opening-night-poller.js
- **Complexity:** M
- **Depends on:** S3-T1
- **Parallel:** No
- **Files:** `scripts/opening-night-poller.js` (modify)
- **Description:** Before writing each new review file (in the file creation section after each discovery layer), call `validateBeforeWrite()`. If invalid, log the rejection with reason and skip writing the file. This prevents bad SERP results from entering the pipeline even when SERP is enabled (Phase 2, after hour 4). Count and report rejections at end of cycle.
- **Acceptance criteria:**
  - VERIFY: `node scripts/opening-night-poller.js --show=dog-day-afternoon-2026 --dry-run --verbose 2>&1 | grep -i "quarantine\|rejected\|skipped"` shows validation is running
  - VERIFY: A URL with clearly wrong domain (e.g., recipe site) would be rejected
  - VERIFY: Legitimate reviews from known outlets still pass through

### Task S3-T3: Wire quarantine into gather-reviews.js
- **Complexity:** S
- **Depends on:** S3-T1
- **Parallel:** Yes (with S3-T2)
- **Files:** `scripts/gather-reviews.js` (modify)
- **Description:** Same as S3-T2 but for gather-reviews.js's save path. Apply `validateBeforeWrite()` in the `saveReview` function (~line 2382) before writing files.
- **Acceptance criteria:**
  - VERIFY: `node scripts/gather-reviews.js --show=dog-day-afternoon-2026 --dry-run --limit=5 2>&1 | grep -i "quarantine\|rejected\|validate"` shows validation is running
  - VERIFY: No regression — existing reviews are not rejected

---

## Dependencies Graph
```
S1-T1 ──┐
S1-T2 ──┼── S1-T5 (test)
S1-T3 ──┘
S1-T4 ──── (independent)

S2-T1 ──┬── S2-T2 ── S2-T4 (test)
        └── S2-T3

S3-T1 ──┬── S3-T2
        └── S3-T3
```

## Parallel Execution Map
```
Track 1:  S1-T1 → S1-T2 → S1-T5 → S2-T1 → S2-T2 → S2-T4
Track 2:  S1-T3 → S1-T4 ─────────→ S2-T3
Track 3:                           S3-T1 → S3-T2 → S3-T3
Sync:     ─── after S1-T5 ─── after S2-T4 ─── after S3-T3 ───
```

**Parallel sprints:** Sprint 3 can start as soon as Sprint 1 is done (no dependency on Sprint 2).
**Critical path:** S1-T1 → S1-T5 → S2-T1 → S2-T2 → S2-T4 (5 tasks, ~2 sessions)
**Max parallelism:** 2 agents (Track 1+2 in Sprint 1, Track 1+3 in Sprint 2/3)

## Known Edge Cases
- RSS feeds returning 0 items for a show with a very short title (e.g., "Tru") — titleMatchesShow may false-positive on "Trump" etc. Existing word-boundary matching should handle this but test with short titles.
- resolveOutletFromUrl() returns null for sites behind URL shorteners or CDN domains (t.co, bit.ly). The ingest script should warn, not crash.
- gather-reviews.js's `--aggregators-only` flag may need a workflow_dispatch input added to gather-reviews.yml if it doesn't already exist.
- Orchestrator iteration count: at 45-min intervals, 4 iterations = 3 hours (not 4). Adjust to iteration 5 if the interval is 45 min, or iteration 4 if 60 min. Check actual POLL_INTERVAL value.

## Key Risks
1. **RSS feeds go stale** — feeds work today but could 404 next month (Playbill, Vulture both died). Mitigation: RSS errors are already non-fatal (line 277 rss-discovery.js).
2. **SERP deferral misses critical T1 reviews** — AP, Bloomberg have no non-SERP path. Mitigation: these outlets rarely review Broadway shows on opening night; when they do, they publish by morning when SERP is enabled.
3. **Quarantine too strict** — could reject legitimate reviews from new outlets not in registry. Mitigation: unknown-outlet check warns but doesn't block in the poller (only blocks in strict mode for ingest-urls).

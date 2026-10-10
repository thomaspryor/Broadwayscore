# Sprint Plan: Fix WE Opening Night Pipeline

## Overview
The WE opening night review pipeline captures 0-15% of published reviews (0/19 for John Proctor, 3/10+ for Teeth 'n' Smiles). This plan fixes 16 identified issues across 3 PRs, with every fix verified in CI against real WE shows — not locally.

## Ground Truth (verification baseline)
- **John Proctor is the Villain** (Royal Court, opened 2026-03-26): 19+ published WE reviews, 0 captured
- **Teeth 'n' Smiles** (Duke of York's, opened 2026-03-26): 10+ published WE reviews, 3 captured (1 bogus)

## Sprint Summary
| Sprint | Goal | Tasks | Model |
|--------|------|-------|-------|
| 1 | PR1: TLS migration — WE aggregators actually fetch in CI | 8 | Opus |
| 2 | PR2: Polling window + orchestrator fixes | 5 | Sonnet |
| 3 | PR3: Extraction, filing, coverage fixes | 10 | Opus (extraction) / Sonnet (config) |

---

## Sprint 1: TLS Migration (PR1)
**Goal:** All WE aggregator fetches in opening-night-poller.js work in CI, not just locally
**Demo:** Trigger poller for john-proctor-is-the-villain-west-end-2026 in CI → theatre.reviews, WET, LBO all return non-zero results
**Risks:**
- `fetchPage()` returns `{content, format, source}` not raw HTML string — every call site needs adaptation
- `fetchPage()` does NOT support JSON — WP API calls (theatre.reviews, WET) need a different fix (use `fetchPage()` on the page URL after discovering it, or use ScrapingBee JSON endpoint directly)
- RSS feeds (rss-discovery.js) may not be TLS-blocked — RSS is usually plain XML from CDN, not Cloudflare-protected. Test before migrating.
- ScrapingBee/Bright Data quota — 11+ new proxy calls per poll cycle. Check credit levels.

MODEL: Opus — multi-file migration with subtle API differences

### Task S1-T1: Audit which https.get calls are actually TLS-blocked in CI
- **Complexity:** M
- **Depends on:** None
- **Parallel:** Yes
- **Files:** None (read-only investigation)
- **Description:** Before migrating anything, confirm which calls actually fail in CI. Trigger the poller manually for john-proctor-is-the-villain-west-end-2026 and add temporary verbose logging (`console.log('HTTP status:', res.statusCode)`) to each https.get call. Check the CI logs to see which get 403/timeout vs 200. This prevents wasting proxy credits on calls that already work.
- **Acceptance criteria:**
  - VERIFY: `gh workflow run opening-night-poller.yml -f show_id=john-proctor-is-the-villain-west-end-2026 -f market=west-end` completes
  - VERIFY: CI logs show HTTP status for each aggregator call (theatre.reviews WP API, LBO sitemap, LBO page, WET WP API, WET page, RSS feeds)
  - VERIFY: Document which calls return non-200 in CI vs locally

### Task S1-T2: Create fetchPageOrJSON() helper for proxy-routed fetches
- **Complexity:** M
- **Depends on:** S1-T1
- **Parallel:** No
- **Files:** scripts/lib/scraper.js (modify)
- **Description:** `fetchPage()` only returns HTML. WP API calls need JSON. Add a `fetchJSON()` or modify fetchPage to support a `{json: true}` option that returns parsed JSON instead of HTML. Route through ScrapingBee with `render_js=false` for efficiency. This is the foundation for all subsequent migrations.
- **Acceptance criteria:**
  - VERIFY: `node -e "const {fetchJSON} = require('./scripts/lib/scraper'); fetchJSON('https://theatre.reviews/wp-json/wp/v2/posts?per_page=1&search=Teeth').then(d => console.log(d.length, 'posts'))"` returns "1 posts" or similar
  - VERIFY: `npx tsc --noEmit` passes (if TS) or `node --check scripts/lib/scraper.js` passes

### Task S1-T3: Migrate theatre.reviews fetches to use proxy
- **Complexity:** M
- **Depends on:** S1-T2
- **Parallel:** Yes (with S1-T4, S1-T5)
- **Files:** scripts/opening-night-poller.js (modify lines 469-530)
- **Description:** Replace 4 `https.get` calls in the theatre.reviews section (direct URL fetch at line 473, redirect follow at 477, WP API at 504, roundup page fetch at 517) with `fetchPage()`/`fetchJSON()`. The WP API call needs JSON parsing; the roundup page fetch needs HTML.
- **Acceptance criteria:**
  - VERIFY: Run locally: `node scripts/opening-night-poller.js --show=teeth-n-smiles-west-end-2026 --dry-run 2>&1 | grep "theatre.reviews"` shows reviews found (not "no roundup found")
  - VERIFY: Push to branch, trigger CI: `gh workflow run opening-night-poller.yml -f show_id=teeth-n-smiles-west-end-2026 -f market=west-end`
  - VERIFY: CI log shows `theatre.reviews: N reviews found` where N > 0
  - VERIFY: CI log shows the WP API found URL: `WP API found: https://theatre.reviews/reviews-roundup/teeth-n-smiles-self-esteem-reviews/`

### Task S1-T4: Migrate WestEndTheatre.com fetches to use proxy
- **Complexity:** M
- **Depends on:** S1-T2
- **Parallel:** Yes (with S1-T3, S1-T5)
- **Files:** scripts/opening-night-poller.js (modify lines 591-660)
- **Description:** Replace 3 `https.get` calls in the WET section (WP API at 601, page fetch at 639, redirect at 644) with proxy-routed equivalents. WP API needs JSON; rendered page needs HTML via fetchPage().
- **Acceptance criteria:**
  - VERIFY: Run locally: `node scripts/opening-night-poller.js --show=john-proctor-is-the-villain-west-end-2026 --dry-run 2>&1 | grep "WestEndTheatre"` shows >1 rating found
  - VERIFY: Push to branch, trigger CI poller for john-proctor
  - VERIFY: CI log shows `WestEndTheatre: N ratings found` where N > 1 (was 1 before fix)

### Task S1-T5: Migrate LBO and Talkin' Broadway fetches to use proxy
- **Complexity:** M
- **Depends on:** S1-T2
- **Parallel:** Yes (with S1-T3, S1-T4)
- **Files:** scripts/opening-night-poller.js (modify lines 291, 358, 377, 402)
- **Description:** Replace 4 `https.get` calls: Talkin' Broadway direct fetch (291), LBO direct fetch (358), LBO sitemap (377), LBO roundup page (402). All need HTML.
- **Acceptance criteria:**
  - VERIFY: Run locally for teeth-n-smiles, check LBO finds the review page
  - VERIFY: Push to branch, trigger CI for teeth-n-smiles
  - VERIFY: CI log shows `LBO: N reviews found` where N > 0 (was 0 before)

### Task S1-T6: Test RSS and site-search for TLS blocking (before migrating)
- **Complexity:** S
- **Depends on:** S1-T1
- **Parallel:** Yes
- **Files:** None (read-only)
- **Description:** RSS feeds (rss-discovery.js) and site-search (site-search-discovery.js) also use https.get, but RSS feeds from nytimes.com, variety.com may NOT be Cloudflare-blocked. Check S1-T1 logs. Only migrate if actually blocked. Site-search uses both `fetchSSR()` (https.get) and `fetchWithScrapingBee()` (already proxied) — check which WE endpoints use which.
- **Acceptance criteria:**
  - VERIFY: Document from S1-T1 CI logs: RSS feeds — blocked or working? Site search per-endpoint — blocked or working?
  - VERIFY: Decision logged: "Migrate rss-discovery: YES/NO" and "Migrate site-search endpoints: [list]"

### Task S1-T7: Migrate blocked RSS/site-search calls (if needed per S1-T6)
- **Complexity:** M
- **Depends on:** S1-T6
- **Parallel:** No
- **Files:** scripts/lib/rss-discovery.js (if blocked), scripts/lib/site-search-discovery.js (if blocked)
- **Description:** If S1-T6 confirms TLS blocking, migrate the affected calls. For RSS, this means fetchUrl() at line 62. For site-search, this means fetchSSR() at line 321. Note: site-search already has a ScrapingBee path (fetchWithScrapingBee at line 380) — may just need to route more endpoints through it.
- **Acceptance criteria:**
  - VERIFY: If RSS migrated: CI log shows RSS feed items found for WE shows
  - VERIFY: If site-search migrated: CI log shows site search results for WE outlets (not "HTTP 429" or 0 results)
  - SKIP: If S1-T6 found no blocking, mark this task as "Not needed" and commit a comment explaining why

### Task S1-T8: Full integration test — trigger CI poller for both WE shows
- **Complexity:** S
- **Depends on:** S1-T3, S1-T4, S1-T5, S1-T7
- **Parallel:** No
- **Files:** None (verification only)
- **Description:** Final PR1 verification. Trigger the poller for BOTH test shows in CI and compare results against pre-fix baseline. This is the "did we actually fix it?" check.
- **Acceptance criteria:**
  - VERIFY: `gh workflow run opening-night-poller.yml -f show_id=john-proctor-is-the-villain-west-end-2026 -f market=west-end`
  - VERIFY: `gh workflow run opening-night-poller.yml -f show_id=teeth-n-smiles-west-end-2026 -f market=west-end`
  - VERIFY: John Proctor CI log: Layer 1 aggregators find >0 reviews (was 0)
  - VERIFY: Teeth 'n' Smiles CI log: theatre.reviews finds roundup (was "no roundup found")
  - VERIFY: New review files created in data/review-texts/ for both shows (count before vs after)
  - VERIFY: New files are REAL WE reviews (not Broadway contamination) — check for "Royal Court" or "Duke of York" in content

---

## Sprint 2: Polling Window + Orchestrator (PR2)
**Goal:** WE shows stay in the polling window long enough for reviews to publish, and no show gets skipped due to run ordering
**Demo:** John Proctor (opened March 26) appears in the orchestrator's "recently opened" list on March 30 (4 days later)

MODEL: Sonnet — config/workflow changes with clear specs

### Task S2-T1: Extend orchestrator lookback to 4 days for WE
- **Complexity:** S
- **Depends on:** None (independent of Sprint 1)
- **Parallel:** Yes
- **Files:** .github/workflows/opening-night-orchestrator.yml (modify line ~119)
- **Description:** Change `cutoff.setDate(cutoff.getDate() - 1)` to market-aware: -4 for west-end, -2 for broadway. The orchestrator's inline JS filter determines which shows get polled.
- **Acceptance criteria:**
  - VERIFY: `node -e "const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 4); console.log(cutoff.toISOString())"` confirms 4-day window
  - VERIFY: Push to branch, trigger orchestrator manually: `gh workflow run opening-night-orchestrator.yml -f market=west-end`
  - VERIFY: CI log shows john-proctor-is-the-villain-west-end-2026 in "Shows to poll" list (opened 2 days ago, within 4-day window)

### Task S2-T2: Extend poller lookback_days default for WE
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes (with S2-T1)
- **Files:** .github/workflows/opening-night-poller.yml (modify line ~82)
- **Description:** Change `inputs.lookback_days || 2` to be market-aware. When the orchestrator dispatches the poller with `market=west-end`, use 4-day lookback. Keep 2 for broadway.
- **Acceptance criteria:**
  - VERIFY: Push to branch, trigger poller with `market=west-end` and no explicit lookback_days
  - VERIFY: CI log shows "Recently opened shows" includes shows from 3-4 days ago

### Task S2-T3: Diagnose March 26 run cancellation
- **Complexity:** M
- **Depends on:** None
- **Parallel:** Yes
- **Files:** None (investigation)
- **Description:** The poller has `cancel-in-progress: false` and 5-min per-show timeout, so the "cancellation kills shows" theory needs re-examination. Check: (a) was the March 26 20:41 run cancelled by a newer orchestrator dispatch? (b) did GitHub's concurrency limit queue and then timeout? (c) did the 40-min job timeout hit? Check `gh run view 23616998154 --json conclusion,event,headBranch` and the timestamp gap.
- **Acceptance criteria:**
  - VERIFY: Root cause of March 26 cancellation identified with evidence (run ID, timestamps, conclusion reason)
  - VERIFY: Fix implemented OR documented as "not fixable" with mitigation

### Task S2-T4: Implement cancellation fix (based on S2-T3 findings)
- **Complexity:** S-M (depends on diagnosis)
- **Depends on:** S2-T3
- **Parallel:** No
- **Files:** .github/workflows/opening-night-poller.yml (likely)
- **Description:** Apply the fix identified in S2-T3. Likely one of: increase job timeout, add per-show error isolation, or randomize show order.
- **Acceptance criteria:**
  - VERIFY: Trigger poller with 3+ WE shows, all get polled (none skipped)
  - VERIFY: CI log shows "Polling: [show]" for every show in the list

### Task S2-T5: Full integration test — orchestrator dispatches poller for WE shows
- **Complexity:** S
- **Depends on:** S2-T1, S2-T2, S2-T4
- **Parallel:** No
- **Files:** None (verification only)
- **Description:** Trigger the full orchestrator → poller chain for WE market. Verify the extended window picks up shows and the poller completes for all of them.
- **Acceptance criteria:**
  - VERIFY: `gh workflow run opening-night-orchestrator.yml -f market=west-end`
  - VERIFY: Orchestrator log: john-proctor in "Shows to poll" (if still within 4-day window)
  - VERIFY: Poller dispatched and completed for all shows
  - VERIFY: No shows skipped or cancelled

---

## Sprint 3: Extraction, Filing, and Coverage (PR3)
**Goal:** Fix all remaining extraction bugs, filing issues, and add coverage gaps
**Demo:** Poller captures 10+ of the 19 published John Proctor WE reviews

MODEL: Opus for extraction logic (#5, #8, #13), Sonnet for config (#6, #11, #14, #16)

### Task S3-T1: Investigate Site Search outlet filtering (why only Daily Mail?)
- **Complexity:** M
- **Depends on:** Sprint 1 (TLS fixes may change what's available)
- **Parallel:** Yes
- **Files:** scripts/opening-night-poller.js (read getMissingT1T2Outlets + Layer 3 code)
- **Description:** Site search has 7 WE endpoints configured but the poller only searched "1 outlets: daily-mail" for John Proctor. The `getMissingT1T2Outlets` function filters by what's already found — if Broadway contamination created files for many outlets, they'd be marked as "found" even though they're wrongProduction. Check if this is the cause.
- **Acceptance criteria:**
  - VERIFY: Root cause identified — why does getMissingT1T2Outlets return only Daily Mail?
  - VERIFY: Fix implemented so Layer 3 searches 5+ WE outlets for a show with no real reviews

### Task S3-T2: Fix Show Score carousel timeout
- **Complexity:** M
- **Depends on:** None
- **Parallel:** Yes
- **Files:** scripts/gather-reviews.js (scrapeShowScoreWithPlaywright, ~line 730)
- **Description:** Increase carousel scroll timeout from 30s to 60s. Add fallback: if carousel yields 0, try extracting from initial page HTML (the main page often has 3-5 reviews visible before scrolling).
- **Acceptance criteria:**
  - VERIFY: Run locally: `node scripts/gather-reviews.js --show=teeth-n-smiles-west-end-2026 --dry-run 2>&1 | grep "Show Score"` shows >0 reviews
  - VERIFY: Push to branch, trigger gather-reviews workflow for teeth-n-smiles
  - VERIFY: CI log shows Show Score reviews extracted (not "carousel scroll timeout — stopping with 0")

### Task S3-T3: Curate Show Score URLs for current WE shows
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** data/show-score-urls.json (modify)
- **Description:** Manually find the correct Show Score URLs for john-proctor-is-the-villain-west-end-2026 and teeth-n-smiles-west-end-2026 and add them to the curated URL map. This bypasses slug guessing entirely.
- **Acceptance criteria:**
  - VERIFY: `node -e "const m=require('./data/show-score-urls.json'); console.log(m['john-proctor-is-the-villain-west-end-2026'])"` returns a valid Show Score URL
  - VERIFY: URL loads in browser and shows critic reviews

### Task S3-T4: Fix LBO review extraction (verify after Sprint 1 TLS fix)
- **Complexity:** S-M
- **Depends on:** Sprint 1
- **Parallel:** No
- **Files:** scripts/scrape-london-box-office-roundups.js (if extraction logic is broken)
- **Description:** After Sprint 1 TLS fix, LBO page fetches should work. Re-run poller and check if extractReviewsFromLBO now returns reviews. If still 0, debug the HTML parser against the actual LBO page structure.
- **Acceptance criteria:**
  - VERIFY: Trigger CI poller for teeth-n-smiles (LBO has a review for this show)
  - VERIFY: CI log shows `LBO: N reviews found` where N > 0
  - SKIP: If Sprint 1 fix already resolved this, mark as "Fixed by S1"

### Task S3-T5: Fix WET malformed filenames (header row parsing)
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** scripts/opening-night-poller.js (WET extraction section)
- **Description:** WET creates files like `publicationratingcriticwhat-s-on-stage--unknown.json` because the HTML table parser includes the header row. Add a guard to skip rows where the "outlet" field matches known header text (e.g., "Publication", "Rating", "Critic").
- **Acceptance criteria:**
  - VERIFY: Run poller locally for john-proctor, no files created with "publicationrating" in the name
  - VERIFY: `ls data/review-texts/john-proctor-is-the-villain-west-end-2026/ | grep publication` returns nothing

### Task S3-T6: Investigate and fix NYT RSS domain mismatch
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** scripts/lib/rss-discovery.js (investigate), scripts/opening-night-poller.js (fix if needed)
- **Description:** The NYT Theater feed config already has `outletId: 'nytimes'` (confirmed at rss-discovery.js:24). But the poller log shows "URL domain nytimes.com doesn't match outlet nyt-theater". This means the mismatch happens AFTER RSS discovery — in the filing/dedup step. Check how RSS results are mapped to outlet IDs in the poller's processing pipeline.
- **Acceptance criteria:**
  - VERIFY: Root cause identified — where does `nyt-theater` get assigned?
  - VERIFY: After fix, NYTimes RSS reviews file under `nytimes--` prefix, not `nyt-theater--`

### Task S3-T7: Filter bogus Variety gallery/news URLs from RSS
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** scripts/lib/rss-discovery.js or scripts/opening-night-poller.js
- **Description:** Variety RSS returns non-review URLs (celebrity photo galleries, news articles) that get filed as reviews. Add a URL filter: reject Variety URLs containing `/gallery/`, `/news/` (non-review paths). Only accept `/legit/reviews/` or similar review paths.
- **Acceptance criteria:**
  - VERIFY: `node -e "..."` test with a gallery URL is filtered out
  - VERIFY: Run poller for teeth-n-smiles, no file created with gallery URL

### Task S3-T8: Add WE RSS feeds (Time Out London, London Theatre, BWW WE)
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** scripts/lib/rss-discovery.js
- **Description:** Add RSS feeds for major WE review outlets that currently have no feed configured. Research and add: Time Out London theatre, London Theatre (londontheatre.co.uk), BroadwayWorld West End, Musical Theatre Review, Theatre Weekly (if RSS exists).
- **Acceptance criteria:**
  - VERIFY: `node -e "const {checkRSSFeeds} = require('./scripts/lib/rss-discovery'); checkRSSFeeds({title:'Test',id:'test'}).then(r => console.log(r.length, 'items'))"` returns items from new feeds
  - VERIFY: At least 2 new WE feeds added and returning valid items

### Task S3-T9: Skip Broadway aggregators for WE show IDs in gather-reviews
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** scripts/gather-reviews.js
- **Description:** gather-reviews.js pulls from BWW Roundup and Playbill Verdict for all shows, creating 26 wrongProduction files for WE shows. Add a market check: skip these Broadway-only aggregators when `isLondonMarket(show.category)`.
- **Acceptance criteria:**
  - VERIFY: Run gather-reviews for john-proctor WE show, no new Broadway review files created
  - VERIFY: Existing wrongProduction files are not affected (idempotent)

### Task S3-T10: Add zero-review alert to orchestrator
- **Complexity:** S
- **Depends on:** None
- **Parallel:** Yes
- **Files:** .github/workflows/opening-night-orchestrator.yml or check-cron-health.yml
- **Description:** After the poller completes, check if any show that's been open >24h has <3 non-wrongProduction review files. If so, emit a GitHub Actions warning annotation. This catches the "0 reviews for 48 hours" scenario.
- **Acceptance criteria:**
  - VERIFY: Trigger orchestrator, check for warning annotation in CI logs for shows with low review counts
  - VERIFY: Shows with sufficient reviews do NOT trigger the warning

---

## Dependencies Graph
```
Sprint 1:
  S1-T1 (audit) → S1-T2 (fetchJSON helper) → S1-T3 (theatre.reviews) ─┐
                                              → S1-T4 (WET)            ├→ S1-T8 (integration test)
                                              → S1-T5 (LBO/TB)        ┘
  S1-T1 → S1-T6 (RSS/site-search audit) → S1-T7 (migrate if needed) → S1-T8

Sprint 2: (can start in parallel with Sprint 1 for S2-T1, S2-T2, S2-T3)
  S2-T1 (orchestrator window) ─┐
  S2-T2 (poller window)        ├→ S2-T5 (integration test)
  S2-T3 (diagnose) → S2-T4    ┘

Sprint 3: (depends on Sprint 1 for S3-T1, S3-T4)
  S3-T1 through S3-T10 are mostly independent — can parallelize heavily
  S3-T4 depends on Sprint 1 completion
  S3-T1 depends on Sprint 1 (to see post-fix behavior)
```

## Parallel Execution Map
```
Track 1 (TLS):     S1-T1 → S1-T2 → S1-T3 → S1-T4 → S1-T5 → S1-T8
Track 2 (Window):   S2-T1 → S2-T2 → S2-T5
Track 3 (Cancel):   S2-T3 → S2-T4 → S2-T5
Track 4 (Fixes):    S3-T2, S3-T3, S3-T5, S3-T6, S3-T7, S3-T8, S3-T9, S3-T10 (all parallel)
Sync points:       ──── after S1-T8 (TLS verified) ──── after S2-T5 (window verified) ────
Post-sync:          S3-T1, S3-T4 (need Sprint 1 results)
```

**Critical path:** S1-T1 → S1-T2 → S1-T3/T4/T5 → S1-T8 → S3-T1 → S3-T4 (minimum 2 sessions)
**Max parallelism:** 4 tracks (TLS, window, cancel diagnosis, extraction fixes)
**Parallel sprints:** Sprint 2 tasks S2-T1/T2/T3 can run alongside Sprint 1

## Known Edge Cases
- Shows with no `category` field default to 'broadway' — WE shows MUST have `category: 'west-end'`
- theatre.reviews URL slugs include star names unpredictably — WP API search is the only reliable path
- Show Score may categorize Royal Court as "off-west-end" not "west-end" — slug variations must cover both
- fetchPage() uses Bright Data first, ScrapingBee as fallback — if BD zone is disabled (known issue), all calls route through SB
- The Stage is paywalled — BrowserBase credentials may have expired (check separately)
- Some WE outlets (Telegraph, Times, FT) are paywalled — can discover URL via search but can't extract full text

## Key Risks
1. **Proxy credit consumption:** 11+ new proxy calls per poll cycle × 4+ shows × 4 crons/day = ~200+ proxy calls/day. Monitor BD/SB credit levels.
2. **fetchPage() rate limiting:** Multiple concurrent proxy calls may trigger rate limits on the proxy providers. Add delays between calls.
3. **False confidence:** The biggest risk is declaring "fixed" after local testing. EVERY verification must be in CI. The ground truth is: does the poller create new, real WE review files in GitHub Actions?

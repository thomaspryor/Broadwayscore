# Roadmap — Last updated 2026-04-10 (Wrong-production prevention + data integrity)

> **Active work is now tracked on the [GitHub Projects board](https://github.com/users/thomaspryor/projects/1).**
> Open issues with `session` label = active Claude Code sessions.
> This file is kept as a historical archive of completed work and backlog reference.

## HIGH PRIORITY

**Product:**
1. ~~**Lists feature**~~ → DONE. Third tab on /my-shows, show page dropdown, deferred auth, drag-to-reorder.
2. **Diary/Watchlist polish** — WIP (another session). Tidying existing UGC pages.
3. **TestFlight validation + App Store submission** — Build #29. Target: **2026-03-22**. Needs live testing then submit.
4. ~~**GitHub history cleanup**~~ → DONE (2026-03-08). Force-push purged copyrighted content from all 101,630 commits.

**West End Launch (target: 2026-03-17):**
5. ~~**WE opening-night pipeline**~~ → DONE (2026-03-14). Wired Show Score WE (59 curated URLs) + LBO roundups into gather-reviews.yml. E2E tested on Hadestown. Backfill of 62 shows in progress.
6. ~~**Off-West End expansion**~~ → DONE (2026-03-16). 56 OWE shows, 56 scripts updated with `isLondonMarket()`, venue classification JSON, frontend badges, discovery pipeline.
7. ~~**SeatPlan audience scores**~~ → DONE (2026-03-17). Fixed slug generation for OWE shows (venue suffixes, colon subtitles). Extracted shared `buildLondonSlugVariants` to `show-matching.js`. SeatPlan OWE: 5→10 shows. LBO OWE: 13→17 shows. 24/56 OWE shows now have audience data.

**WE Review Coverage:**
8. ~~**Cross-show URL dedup bug**~~ → DONE (2026-03-16). Paddington/Man and Boy misplaced files removed, wrongProduction flags cleared. LBO scraper guard added.
9. ~~**Outlet registry missing UK outlets**~~ → DONE (2026-03-16). 9 UK outlets added with `region: 'london'`. URL domain fallback in cross-market guard.
10. ~~**Classifier market-awareness (ROOT CAUSE FIX)**~~ → DONE (2026-03-17). `isUkOutletUrl()` shared helper added to venue-classification.js. Guards added to all 4 wrongShow sources: classify-wrong-show.js, audit-cross-show-url-collisions.js (12 tiers), llm-scoring/index.ts, rebuild-all-reviews.js. Rebuild safety net simplified.
11. ~~**OWE venue discovery gap**~~ → DONE (2026-03-17). 6 major OWE venues now scraped directly (Almeida, Soho Theatre, Stratford East, New Diorama, King's Head, Finborough). 30 shows discovered. Plus LondonTheatre.co.uk added by parallel session (40 OWE shows). Total: 5 London discovery sources.

**P0 Score Recovery (2026-03-16, 220 reviews upgraded):**
12. ~~**OUTLET_VERIFIED_SOURCES fix**~~ → DONE. 85 WE reviews promoted LLM→P0.
13. ~~**EW letter grade regex recovery**~~ → DONE. 92 reviews, pure regex, no LLM.
14. ~~**Playwright recollection (Stage, WOS, Time Out, etc.)**~~ → DONE. 26 reviews.
15. ~~**Guardian API recovery**~~ → DONE. 17 reviews via Guardian Content API.
16. ~~**LLM extractor hallucination fix**~~ → DONE. verifyInText tightened (40%→<2% false positive).
17. ~~**Playwright star capture in gather-reviews.js**~~ → DONE. Code change deployed, takes effect on next gather run (~510 future P0.5 scores).
18. **USA Today star re-collection** — BLOCKED. Older articles no longer render star widgets after site redesigns. ~291 reviews permanently unavailable.
19. **Remaining UK outlet gaps** — Telegraph SVG extractor (73), Culture Sauce React (58). Need outlet-specific extractor improvements. Post-launch.

**Data Integrity (P0 — from Mar 20 sweep incident):**
- ~~**28 WE reviews need rescoring**~~ → DONE (2026-03-20). All 21 WE shows rescored via targeted `--show=ID` dispatches. Zero unscored reviews remain.
- ~~**`--all` scoring skips scoreable files**~~ → RESOLVED (2026-03-20). Verified: scheduled runs correctly find 29-51 valid files. Issue was transient.
- ~~**217 SERP-discovery phantom reviews**~~ → DONE (2026-03-20). Root cause: gather-reviews SERP discovery misattributed outlets (BWW URLs → Broadway News, etc.). Fix: domain validation extended to all SERP-discovered reviews (was only unknown critics). 217 phantom files deleted, deployed.
- ~~**Aggregator archive files critically low**~~ → RESOLVED (2026-03-17).

**Site Reliability:**
7. ~~**Pipeline health dashboard**~~ → Phase 1 DONE (health monitoring, 9 categories).
8. ~~**Notification Phase 2: Daily Digest + Auto-Fix**~~ → DONE. Daily email via Resend with auto-dispatch of fix workflows, urgency badges, plain-English instructions. LOW items suppressed.
9. **Phase 3: Smart Escalation** — Per-system cooldowns, cookie/secret expiry warnings at 7/3/1 days, digest subject urgency increases with persistence. Build after Phase 2 soak (~2 weeks).
10. ~~**URL brittleness remediation**~~ → DONE (2026-03-16). Weekly health monitoring, SERP Telecharge discovery, centralized url-utils.js, TodayTix API verification, TM allowlist, OUTLET_DOMAINS derived from registry (1,242 entries vs 119 hardcoded).

**Performance:**
11. **Deploy deduplication** — 48 deploys/day invalidates all ISR cache before it can serve a second request. Add skip-if-deployed-within-30-min logic to `vercel-deploy.yml`. Biggest efficiency win for ISR.
12. ~~**Restore critic/outlet static pre-rendering**~~ → DONE (2026-03-25). ~1,580 pages back to build-time generation. `x-vercel-cache: PRERENDER` confirmed.
13. ~~**Fix SEO health check false alarm**~~ → DONE (2026-03-25). `health-check.js` read `data.timestamp` but `seo-health.json` uses `lastChecked`.
14. **Pre-render creative pages after measuring impact** — If critic/outlet pre-rendering shows improved crawl stats in Search Console after 2 weeks (check Apr 8), restore creative pages too (+2,200 pages, +2-3 min build).
15. **SEO triage→email gap** — Triage system shows `escalationState: "monitoring"` but `lastAlertTimestamp: null` for SEO warnings. The monitoring state may not be surfacing in digest emails properly.

## MEDIUM PRIORITY

**Product:**
9. **Off-West End scoring expansion** — Classification done. 56 OWE shows in DB, 11 open with scores. Needs more review collection via aggregators.
9b. ~~**Theatre.reviews scraper**~~ → DONE (2026-03-22). Part of WE aggregator sweep. 24 shows, 224 reviews. Homepage scraping + comprehensive venue slug matching + inline star extraction. Archive-first.
10. **App icon refinement** — Hard to read at small sizes.
11. **BTC/TodayTix partnership (paused)** — Waiting on TodayTix for launch timing, co-branding, legal.

**Opening Night Speed:**
- ~~**Add site search for UK T1/T2 outlets**~~ → DONE (2026-03-18). Telegraph, The Stage, Times UK added by parallel session. 5/7 UK outlets now have configs.
- ~~**Audience data ready by 11:30 PM ET on opening night**~~ → DONE (2026-03-24). Orchestrator now dispatches all 4 audience scrapers at session start (9 PM ET). Broadway.com added to `update-show-status.yml` previews→open chain (was missing). `update-broadway-com.yml` now accepts `shows` plural input.

**Audience Data Gaps:**
- ~~**SERP-based slug discovery for audience scrapers**~~ → DONE (2026-03-18). Auto-discovers slugs via BrightData SERP API after scraper coverage report. Title validation + blog URL filtering. Tested on LBO: 4/7 valid slugs found, added to LBO_OVERRIDES.
- ~~**Verify LTD audience data renders on WE show pages**~~ → DONE (2026-03-18). Verified live: Hamilton WE shows 5 audience sources including LTD (3.5K reviews, 4.7/5).
- ~~**Bright Data `mcp_unlocker` trial exhausted**~~ → DONE (2026-03-25). Zone recovered + re-enabled via UI. New admin token (`d52fd1e8`) deployed to all 4 repos. Billing active at $1.5/CPM.
- ~~**ScrapingBee credits depleted**~~ → DONE (2026-03-25). Replenished to ~1M credits. Renews 2026-04-25.
- **`mcp_browser` zone wrong type** — `client_10090`: Browser API requires WebSocket/CDP, not HTTP proxy. Code now detects and skips it permanently. Either reconfigure zone as Unblocker type, or leave unused (only `mcp_unlocker` is needed).
- **Broadway.com coverage ceiling** — ~30-40% of closed shows have customer reviews (only ticket buyers can review). Shows like Phantom, Dear Evan Hansen, Kimberly Akimbo have no audience reviews on Broadway.com. The remaining ~70% genuinely lack data — not a scraping issue. Could batch more closed shows with `--field shows=ID1,ID2,...` but diminishing returns.

**Data Quality:**
- **Boy at the Back of the Class WE — collect actual April 2026 reviews** (P1) — Show ID `the-boy-at-the-back-of-the-class-west-end-2026`. QEH Southbank Apr 7-12, 2026 (6-day run, 2026 Olivier nominee Best Family Show). Currently 0 displayed reviews after I flagged 5 Show Score reviews as wrongProduction (commit `7315065b3c` in broadway-review-texts) — they were actually from the same touring production's Feb 2024 Rose Theatre Kingston run. Action: targeted gather-reviews / opening-night-poller dispatch for this show ID to find actual QEH-run reviews. As of Apr 10, 3 days into run, 2 days remaining.
- **`cleanup-fake-publish-dates.js` destroys recoverable real dates** (P2 fix) — When run with `--all`, the script unconditionally nulls `publishDate` when it equals `openingDate`, even though real dates are often recoverable from URL/text. Concrete impact: all 5 Show Score reviews on the-boy-at-the-back-of-the-class-west-end-2026 had this happen (real Feb 2024 dates restored manually via web fetch in commit `7315065b3c`). Fix: before nulling, attempt URL-based date extraction (rebuild-all-reviews.js logic). Better: do URL date extraction during gather-reviews.js for show-score sources so the opening-date fallback never fires. Note: 8 sibling reviews via bww-roundup pipeline correctly extracted dates from URL (YYYYMMDD pattern) — gap is specifically pure show-score collection.
- **Audit other touring-then-WE shows for the same wrong-production review pattern** (P2 data quality) — Show Score has one page per production. When a touring production hits the WE and we list it as a WE show, Show Score's reviews on that page are still from original tour stops, contaminating the WE show's score. Audit: `cd data/review-texts && git grep -l 'publishDateNulledReason.*show-score' | sed 's|/[^/]*$||' | sort | uniq -c | sort -rn` — group by show ID, triage shows where >50% of reviews share the issue. Likely candidates: shows that toured (Rose Theatre, Devonshire Park Theatre, etc.) before transferring to a WE venue. Companion to the cleanup-fake-publish-dates fix above.
12. ~~WE/OB review cleanup — duplicates~~ → DONE. 35→0 duplicates via comprehensive dedup.
13. ~~WE/OB review cleanup — URL collisions~~ → DONE. All 87 collisions resolved (94 files flagged across 53 shows).
14. ~~Cross-outlet duplicate reviews~~ → DONE. 90 found, 31 flagged (28 very-high + 3 AP syndication). Remaining 59 are false positives (different critics, similar text).
15. ~~WE/OB early reviews + URL mismatches~~ → DONE. 31 wrongProduction, 32 wrongUrl, 6 domain aliases added. Validation: 0/0/0.
16. ~~Unknown outlets~~ → Reduced 55→49. 7 junk flagged, 1 fixed, 1 added to registry. Remaining 49 are `outletId: "unknown"` (need outlet identification — separate effort).
17. ~820 shows missing synopses (mostly obscure historical).
18. ~~**Broadway News wrongUrl cleanup + domain validation**~~ → DONE (2026-03-20). Subsumed by P0 phantom review fix — all 29 Broadway News phantoms + 188 others deleted. Root cause fixed in gather-reviews.js.

**Pipeline:**
17. ~~Collection coverage dashboard~~ → DONE. Weekly report: fullText/excerpt/stub by outlet, tier, access model, market. Identifies top collection opportunities. History tracking for trends.

## LOW PRIORITY / BACKLOG

**iOS App:** Widget, Spotlight search, iPad layout, Android, Share sheet, App Clips, Siri
**Image gaps:** Dear England WE (score 83, 7 reviews) has no image — auto-fetch missed it, may need manual sourcing. Birthright/Giulia/Whoopi Monologues (previews) have CDN placeholders — will auto-archive when TodayTix releases real art.
**Infrastructure:** Show images to CDN (173MB/deploy), prune low-value static pages, domain retry intelligence, ~~ScrapingBee SERP credit optimization~~ → DONE (3.3M→968K credits/month + BrightData fallback), ~~Scraper cost optimization~~ → DONE (Playwright-first for public sites, BD-first SERP, SB credit pre-check, per-run cost logging). gather-reviews outlet-SERP cut 200→30 searches for routine runs (2026-03-25), 200 preserved for opening nights (max_tier=3)
**Scraper resilience:** Consolidate inline SERP in collect-review-texts.js to use shared url-discovery.js module (eliminates diverged 200-line fork). Migrate `recollect-for-scores.js`, `scrape-theater-tips.js` to use `scraper.js` fetchPage() instead of calling SB API directly (currently in CI exempt list — no BD fallback)
- **matchTitleToShow confidence audit** — 25+ scripts call `matchTitleToShow()` without checking `.confidence`. Same bug class as WET wrong-show contamination. Highest-risk: aggregator scrapers (theatre.reviews, LBO roundups, The Stage, Stagedoor, Playbill Verdict, NYSR, WP theater blogs, SERP discovery). Add confidence gates to all aggregator callers.
- **Zero-data aggregator scraper guard** — WET scraper silently returned 0 posts for ~2 weeks (Sucuri WAF). Add health check: if an aggregator scraper fetches 0 items, warn or fail instead of silent success.
- **WET title extraction regression tests** — 30+ real WET post titles tested manually. Extract into unit test file to protect against future regressions in `extractShowTitle` and `matchTitleToShow`.
**Domain matching:** `domainMatchesExpected()` in `scraper.js` doesn't match subdomains of registry aliases (e.g., `articles.philly.com` doesn't match alias `philly.com`). Workaround: added explicit subdomain aliases. Real fix: extend the matching function. LOW priority.
**Code Quality:**
18. ~~**TypeScript strictness cleanup**~~ → DONE. Zero TS errors, zero `as any` casts. Added Window.gtag/Sentry declarations, SentryEvent interface, GoldListType narrowing.
19. ~~**Unit test coverage**~~ → engine.ts DONE (37 tests) + data-core.ts DONE (81 tests). Both in CI. Remaining: rebuild pipeline.
20. **Script hardening** — Assessed: 130 CI scripts mostly well-structured. No critical gaps (JSON writes use stringify, Node 20+ handles rejections). Remaining: TS migration for top scripts, structured logging. LOW priority.
21. ~~**Custom ESLint rules**~~ → Phase 1 DONE. Regression guards instead: contentVerification deletion guard, isScoreable import guards for 3 scripts.
22. ~~**Dead code removal**~~ → DONE. Removed ~736 lines from 12 src/ files (32 dead exports/functions).
23. ~~**CI workflow cleanup**~~ → Phase 2 DONE. Push-with-retry migration (15 workflows, -281 lines) + setup-node composite action (10 workflows migrated, 65+ remaining). Total: -369 lines boilerplate.
**Data/Scoring:** LLM prompt contamination audit, cross-aggregator excerpt enrichment, Playwright critic resolution, 14 author-byline mismatches need manual review (audit report in data/audit/syndicated-duplicates.json)
24. **Integrate date-window validator into rebuild** — Currently standalone script. Should run automatically in `rebuild-all-reviews.js` after the existing pre-opening guard. The existing guard uses 90-day threshold and only covers preview/upcoming shows; the new validator is stricter (21d/7d) and covers all statuses.
25. **Outlet-specific date extractors** — ~490 reviews have fullText but no date. Top offenders: Cititour (55), The Stage (49), Lighting & Sound America (41). Would need custom extraction for these outlets' HTML patterns.
**Lists Enhancements:** ~~Public/shareable lists~~ → DONE (2026-03-21), **notes editing UI** (note field exists in DB + renders on shared page, but no UI to add/edit — highest value next step), "Add to List" from Diary/Watchlist rows, smart list suggestions (auto-suggest based on diary), drag handle discoverability (animation/tooltip), list import from Diary (bulk add seen shows), list count in header stats bar
**Viral/Social:** Share-a-score image cards (zero-auth "Share this score" button → branded image with poster + score + URL, works on iMessage/social — higher viral potential than lists, OG infra already exists)
**SEO:** FAQ schema on show detail pages
**Code Quality:** ~~Regression protection for critical patterns~~ → DONE (grep-based guards in CI). ~~Linter/IDE revert root cause~~ → DONE (concurrent sessions, not auto-formatter).
- **Fix ProGateContext recapture unit test** — `email-capture-integrity.test.mjs:102` failing since 2026-03-24. Test expects ProGateContext to include recapture logic for users who submitted via broken modal pre-fix. The fix commit (`2adfba69a1`) apparently missed this. LOW priority (no user-facing impact).
- **9 duplicate review-text files** — `validate-review-texts.js` reports: timeout-london/timeout outlet aliasing (5 WE shows), unknown→named critic aliasing (cabaret-kit-kat, great-gatsby, giant). Failing CI. Fix: delete the `timeout-london` and `unknown` duplicates in the private review-texts repo. MEDIUM priority.

## Recently Completed

### Cats Opening Night Save + Date Fallback Removal (2026-04-07 to 2026-04-10)
- **OB reviews leaked onto Cats Broadway 2026 page** on opening day. Two unflagged Vulture/WhatsOnStage files from the OB 2024 BWW roundup were displayed with fake April 7 dates. Saw it live, had to fix mid-day.
- **Root cause #1: opening-night-poller.js missing year validation.** Called `extractBWWRoundupReviews()` but NOT `validateBWWRoundupYear()`, so SERP-discovered OB roundups passed through. Fixed: exported `validateBWWRoundupYear` from `gather-reviews.js`, applied in poller after extraction. Tested: blocks roundups 18+ months before opening date.
- **Root cause #2: createReviewFile() opening-date fallback.** When a review had no `publishDate`, it stamped the show's openingDate. This made OB reviews look like they were from the Broadway opening, defeating ALL date-based wrong-production guards. Fixed: removed fallback, use `null` instead.
- **Root cause #3: getKnownUrls() included wrongProduction URLs.** Could block fresh discovery of legitimate same-URL Broadway reviews. Fixed: skip wrongProduction/wrongShow files when building knownUrls set.
- **Root cause #4: normalizeUrlForDedup() didn't strip tracking params.** `?searchResultPosition=1`, `#/`, UTM params made identical URLs look different. Cross-show URL dedup missed duplicate OB/Broadway copies. Fixed: strip known tracking params + fragments while preserving meaningful query params for old-format URLs.
- **Historical date cleanup (2,315 files):** Created `scripts/cleanup-fake-publish-dates.js` to null fake `publishDate == openingDate` values from all aggregator sources (show-score-playwright 716, playbill-verdict 600, bww-reviews 298, bww-roundup 292, etc.). Pushed to private repo.
- **Date recovery (109 files):** Created `scripts/recover-null-dates.js` to extract real dates from URL patterns (`/YYYY/MM/DD/`, `-YYYYMMDD`, etc.) using existing `extractDateFromUrl()`. fullText regex scanning was tried and removed (~60% false positive rate — matched show booking dates and historical references). Cleanup script also enhanced inline (parallel session) to recover URL dates BEFORE nulling.
- **Final date recovery tally:** 308 (daily backfill) + 109 (URL extraction) + 793 (parallel session — Archive.org/cookies) = ~1,210 of 2,388 originally fake dates now have real values (~51%). Remaining ~1,178 are aggregator stubs without scrapeable dates — null is honest, and the cross-show URL dedup falls back to URL year extraction for them.
- **Cats result:** Live page now shows 24 real critic reviews (NYT, Vulture, NY Post, Variety, Time Out, Guardian, etc.) with accurate April 7-8 dates and a composite score of 86.16. No OB contamination.

### WET Scraper Wrong-Show Fix + WAF Bypass (2026-04-08)
- **27 wrong-show archives** — WET scraper accepted medium-confidence fuzzy matches from `matchTitleToShow()`. Generic WP titles matched random shows via word overlap (e.g., "Best West End Shows This Week" → "THIS IS NOT ABOUT ME."). Fixed: confidence gate (only HIGH), content validation (show title words in post body), short-title fallback.
- **Sucuri WAF bypass** — WET WordPress API blocked since ~Mar 22 (returning HTML challenge instead of JSON). Replaced custom curl/https with shared `scraper.js` `fetchJSON()` (ScrapingBee proxy, 1 credit/page). 884 posts fetched successfully.
- **Title extraction for real WP patterns** — Handles 10+ real WET title formats: `{Show} Reviews Round-up – {Venue} [Updated]`, `{Show} reviews: {subtitle}`, 30+ named WE venues. 171 shows matched at HIGH confidence (up from 143 before extraction fix).
- **Romeo & Juliet alias** — Added `"romeo & juliet"` / `"romeo and juliet"` to show-matching aliases.

### Full Review Button Fix + URL Backfill (2026-04-07)
- **"Full Review" button broken for 433 reviews** — `ReviewsList.tsx` rendered `<a href="undefined">` for reviews with null URLs. Fixed with conditional guard + updated TypeScript type to `string | null`.
- **URL backfill via SERP** — 55 missing review URLs discovered via BrightData SERP search. Top outlets recovered: NYT, Vulture, Guardian, Daily Mail, The Stage, Talkin' Broadway. 328 remain unfindable (defunct outlets: Lighting & Sound America print-only, Bloomberg theater desk, AP wire).
- **Re-enabled `rediscover-urls.yml`** — Weekly cron was manually disabled. Re-enabled for ongoing dead URL detection.

### Broadway.com Backfill + Reddit Preview Fix (2026-03-28)
- **Broadway.com bot-challenge bypass** — Playwright fallback for Cloudflare-blocked pages. 17→55+ shows with data. HTML fallback parser for pages without JSON-LD (`extractHtmlRating()`). Sitemap discovery + URL construction for closed shows.
- **Broadway.com backfill** — 10 major closed shows extracted (Sunset Blvd 88, Gypsy 94, Hell's Kitchen 96, Merrily 100, Notebook 96, etc.). ~30% of closed shows have Broadway.com customer reviews (only shows sold via their ticketing platform).
- **Reddit scraper includes preview shows** — Was filtering to `status === 'open'` only, missing all preview-period discussion. Now includes `previews`. CATS: The Jellicle Ball got Reddit data (score 79, 22 posts, 97 relevant items).
- **Reddit triggered on show discovery** — `update-show-status.yml` now dispatches Reddit sentiment for newly discovered preview shows (not just previews→open transitions).
- **BD zone fix** — `reddit-api.js` hardcoded wrong zone names (`mcp_browser`). Now uses `BRIGHTDATA_ZONE` env var consistently with all other scrapers.
- **Process.exit fix** — Broadway.com scraper didn't exit after completion (Playwright held process open). Each show hit 120s bash timeout even when scraping took 2s. Fixed: `process.exit(0)` on completion. Batches now complete in ~2 min instead of 20.

### Image Pipeline Hardening (2026-03-26)
- **Hash-based placeholder detection** — 6 known "Coming Soon" hash variants added. Downloads rejected, `--missing` filter re-queues affected shows. CI now errors on open/previews shows with placeholder disk files via `validatePlaceholderImageHashes()` in validate-data.js.
- **276 orphan dirs + 48 placeholder files deleted** — 40.6 MB freed. Stale dirs from old ID formats (before `-off-broadway-`/`-west-end-` suffixes standardized).
- **Burnout Paradise restored** — Root cause: Mar 3 auto-fetch archived Contentful CDN URL already serving placeholder hash `52968e9f`. Fixed: removed bad CDN entry, converted poster.jpg → hero.webp via Sharp, pinned.
- **Jerome dates corrected** — Wrong year (2025→2026), wrong status (open→upcoming), contaminated cast/creativeTeam removed.
- **Bughouse confirmed** — Dark Maria Baranova production photo IS real art. TodayTix CDN serves "Coming Soon"; our site correct. Pinned to prevent future overwrite.
- **West End/OWE audit** — All 58 open shows confirmed clean.

### Discount Tickets / Box Office / Showtimes Launch Audit (2026-03-25)
- **Status filter bug fixed** — All 5 discount pages used `'preview'` instead of `'previews'` (plural). Shows in previews were silently excluded. Fixed + best-value was missing previews entirely.
- **Grosses data freshened** — Updated from week ending 3/15 → 3/22 (force-triggered weekly scraper). 25 shows now have thisWeek data (was 24). Every Brilliant Thing now included.
- **West End grosses contamination fixed (systematic)** — 32 West End entries had Broadway+WE combined allTime data. Removed entries + added slug guards in both `scrape-grosses.ts` and `scrape-alltime.ts` to prevent recurrence.
- **Lottery data quality (systematic)** — HP duplicate lottery/digitalRush: added dedup rule in sanitizer. BOM null platform: added null/empty cleanup. URL casing: `normalizeUrl()` now lowercases domains. Generic URL overwrite: merge logic preserves specific URLs. Schedule junk: writer now filters closed/announced shows.
- **8 generic lottery URLs upgraded** — Hamilton, Harry Potter, Book of Mormon, Hadestown, etc. now link to show-specific lottery pages from BWayRush.
- **All fixes tested** — dry-run scraper, unit tests for each rule (dedup, URL merge, schedule filter, slug filter, null cleanup, URL normalization). Every fix is pipeline-level, not data-level.
- **Ship-check passed** — tsc, lint, validate-data, all 6 pages verified at 390px + 1440px. Production verified: all pages 200, box office shows 3/22 data.

### Infrastructure Recovery + SERP Cost Optimization (2026-03-25)
- **Bright Data admin token rotation** — Old token had User role (read-only for zone management). New token `d52fd1e8` has Admin role. Updated in all 4 GitHub repos + local `.env`.
- **mcp_unlocker zone restored** — Zone was in "Trial limit reached" then "deleted" soft-delete state. Recovered via UI Recover button + enabled via Configuration toggle. Billing active.
- **ScrapingBee replenished** — Credits were fully exhausted (1,350,023/1,350,000). Replenished. Renews 2026-04-25.
- **SERP cost fix (gather-reviews)** — `gather-reviews.yml` outlet-SERP job was running `--max-searches 200` on every run (10+ times on opening night = ~$2/day). Cut to 30 for routine runs (max_tier=2), preserved 200 for opening nights (max_tier=3). Estimated savings: ~85% of daily SERP spend.
- **SERP cost fix (update-show-status WE)** — `update-show-status.yml` was dispatching `collect-outlet-reviews.yml` with 200 searches for WE previews→open transitions at max_tier=2 (not opening night). Cut to 30. Same pattern as gather-reviews fix.
- **BD zone health monitoring** — `check-secrets-health.js` now checks `mcp_unlocker` zone status (verifies `disable` field absent). `BRIGHTDATA_TOKEN` added to workflow env. Would have caught Giant's opening night failure automatically. Verified live in CI: `✅ Bright Data: mcp_unlocker zone active`.
- **Text collection safety fix** — `collect-review-texts.js` was overwriting fullText on already-scored reviews, causing contentTier=invalid and exclusion from reviews.json. Fixed: skip re-fetching reviews that already have assignedScore.
- **CLAUDE.md §14 updated** — BD zone readiness step now points to `check-secrets-health.yml` (which covers it) + curl command for manual verification.


### Rebuild Guard → Claude-Powered Drop Analysis (2026-03-24)
- **Root cause: Guards were blocking legitimate cleanup** — Every historical guard fire (−756, −731, −335, −117, −109 reviews) was intentional pipeline work (dedup, quality flagging, domain validation), never corruption. Guards caused a 10-day stall by blocking the rebuild in a retry loop.
- **Fix: Removed `process.exit(1)` from both guards** in `rebuild-all-reviews.js`. Guards now write audit files and log warnings, but never block the rebuild.
- **New: `analyze-rebuild-drops.js`** — Runs after each rebuild. If total drops >30 or any single show >10, calls Claude Sonnet for qualitative analysis: classifies drops as flag-explained (routine) vs unexplained, checks era distribution and recent pipeline activity, produces ROUTINE/NEEDS_REVIEW/SUSPICIOUS verdict with plain-English explanation. Sends email with verdict in subject line.
- **Removed dead code** — `sendGuardStallAlert` (125 lines), invalid `allow_regression=true` references in workflows, `ALLOW_DRIFT: 'true'` from 3 workflows (`scrape-dtli-show-score`, `scoring-audit`, `scrape-bww-reviews`).
- **Pre-existing Test Suite failure noted** — `ProGateContext has recapture logic` unit test failing since 2026-03-24 (pre-dates this session, introduced by ProGateContext modal fix). Needs fix in a separate session.


### Opening Night Audience Data Fixes (2026-03-24)
- **Root cause: TLS fingerprinting** — `https.get()` (OpenSSL TLS) gets blocked by Reddit and Broadway.com CDN in CI; `fetch()` (undici TLS) passes. Fixed both scrapers. Broadway.com verified live: Giant 4.8/5 → 96 score fetched correctly.
- **Root cause: combinedScore drift on concurrent pushes** — `push-core-data` reconciliation merged sources from remote but didn't recalculate `combinedScore`. Reddit's +8 calibration was silently dropped. Fix: inline `calculateCombinedScore()` in the action after source merging. Verified against 1,686 shows: zero drift.
- **Root cause: Broadway.com missing from opening night chain** — Reddit/ShowScore/Mezzanine all auto-dispatched on previews→open; Broadway.com was not. Added to `update-show-status.yml`. Added `shows` plural input to `update-broadway-com.yml` to match the other audience workflow interfaces.
- **Opening night SLA** — Orchestrator (starts 9 PM ET) now dispatches all 4 audience scrapers at session start, so data is ready before the 11:30 PM ET broadcast window.
- **Giant fixed manually** — combinedScore=80 (B+, "Liking"), all 4 sources: Mezzanine 78 (93 reviews), Reddit 68 raw/76 calibrated (88 posts), Theatr 89 (39 votes), Broadway.com 96 (15 reviews).

### Hero Image Orphan Fix + Rebuild Guard Auto-Allow (2026-03-22)
- **Root cause: 352 orphan images across all markets** — `applyImages()` in `fetch-show-images-auto.js` replaced the entire `show.images` object on re-runs, wiping previously-downloaded hero/poster paths when a source returned null. Broadway worst hit (337), not just WE (5).
- **3 fixes**: (1) `applyImages()` now preserves all existing local image paths when new fetch returns null. (2) `generate-mobile-show-details.js` checks for hero files on disk (.webp/.jpg/.png) as fallback. (3) `pre-deploy-check.js` extended to handle all image formats.
- **315 shows fixed** in shows.json + 81 jpg→webp upgrades. Public JSONs regenerated. All verified live.
- **Rebuild regression/drift guards unblocked** — Guards couldn't distinguish intentional data cleanup (899 wrongProduction-flagged reviews across 311 shows) from corruption. Fix: regression guard now counts flagged vs unflagged scored files on disk. If the drop is explained by audit flags + inline guard tolerance (≤2), it auto-allows. Drift guard skips shows where drops were explained. Tested: rent-1996 (flagged→EXPLAINED), hamilton-2015 (no flags→REGRESSION). CI rebuild 23415960940 passed without overrides.
- **Duplicate show fix** — Removed malformed Krapp's Last Tape WE entry that was blocking all deploys.
- **Watermark chain restored** — rebuild→deploy→watermark now flows automatically since guards no longer block.

### Shareable Lists (2026-03-21)
- **Public/shareable lists**: One-tap Share button → auto-public + copy URL. Read-only page at `/list/[slug]` with posters, critic scores, venues, user notes, ticket links.
- **OG social previews**: generateMetadata + custom OG image (type=list in /api/og). Links look good in iMessage/social.
- **Privacy controls**: Make Private option in overflow menu + public/private toggle in edit modal + "Public" badge.
- **DB changes needed**: `is_public` + `share_slug` columns + 3 anonymous RLS policies. Migration SQL in `memory/shareable-lists-migration.md`.
- **Scope**: 9 files changed, +752 lines. Behind `userAccounts` feature flag (demo only). Won't work until Supabase migration runs.

### publishDate Backfill + Wrong-Production Cleanup (2026-03-21)
- **3,802 reviews dated**: URL patterns (3,087) + text-regex bylines (685) + LLM multi-date disambiguation (30). Collection pipeline now has 3 fallback layers: HTML metadata → URL path → text-regex.
- **LLM scoring now extracts publishDate**: Added to V5 prompt + all 5 scorers (Claude, OpenAI, Gemini, Kimi). Zero extra cost — every future scored review gets a date if the LLM can find one.
- **1,112 wrong-production reviews flagged**: Date-window validator [preview-21d, close+7d] catches reviews from earlier/later productions. Script: `flag-wrong-production-by-date.js`.
- **Review card alignment fixed (15th time, for real)**: Root cause was `<a>` tags stretching in flex rows. Fix: `<span>` wrapper with inline styles.
- **Corrupt shows.json in private data repo fixed**: Invalid JSON at position 1417569 was blocking all deploys.

Scripts: `backfill-url-dates.js`, `backfill-text-dates.js`, `backfill-llm-dates.js`, `flag-wrong-production-by-date.js`
All re-runnable. Run `flag-wrong-production-by-date.js` after adding more dates.

### wrongUrl Prevention + Recovery (2026-03-20)
- **Root cause**: Pre-March-1 `OUTLET_DOMAINS` had mismatched keys (`'broadway-news'` vs `'broadwaynews'`), so SERP queries had no `site:` filter and no domain check on results. 175 reviews got bad URLs (BWW, Facebook, IMDB, etc.).
- **3 prevention fixes**: (1) Wired `domainAliases` from outlet-registry into SERP matching (20 outlets like `1minutecritic.com` ↔ `oneminutecritic.com`). (2) Domain validation in `createReviewFile()` — rejects URL-domain mismatches at creation time from all sources. (3) Automated `wrongUrl` flagging in `rebuild-all-reviews.js` — catches unflagged mismatches on every rebuild.
- **Recovery**: Targeted `retry-wrong-urls.js` script + workflow. Fixed 6 T1 reviews (Times UK ×3, Telegraph, Evening Standard, Deadline). 71 unfixed are mostly Broadway News OB shows with no real review page.
- **Workflow fix**: `gather-reviews` job now runs even if `outlet-serp` times out (`needs.prepare.result == 'success'` instead of `needs.outlet-serp.result != 'cancelled'`).

### WE Data Expansion (2026-03-18)
- **London Theatre Direct (LTD) audience scraper** — 8th audience source. 35 WE shows with scores (Hamilton 93, Lion King 95, Wicked 90). JSON-LD extraction from londontheatredirect.com. Weekly CI + auto-trigger on show open.
- **WestEndTheatre.com critic roundup scraper** — WordPress REST API, extracts star rating tables. 12 shows, 6-10 UK outlets each. Weekly CI workflow. Uses curl for Sucuri WAF bypass.
- **Stagedoor full scrape** — 59 shows processed, 26 with critic reviews, 236 total reviews. 41 new + 195 merged with existing review files.
- **Cross-market false positives fixed** — 77 legit WE reviews from UK outlets (Guardian, Telegraph, Times, Stage, etc.) were wrongly flagged `wrongProduction`. Fixed both `flag-we-cross-production.js` (London URL check on all outlets) and `rebuild-all-reviews.js` (extended auto-clear for stale no-note flags).
- **3 duplicate WE shows removed** — Phantom OWE copy, Krapps slug variant, Unfortunate London variant. Validation: all checks pass.
- **LTD wired into auto-trigger chain** — New `london_shows` output in update-show-status.yml filters WE-only shows for SeatPlan/LBO/LTD triggers. Prevents BW show IDs from killing for-loops.
- **Coverage gap reports** — All 3 WE audience scrapers (SeatPlan, LBO, LTD) now log which open shows were missed with reasons and copy-paste override templates.
- **SERP slug discovery** — Auto-discovers platform slugs via BrightData SERP when scraper misses a show. Title validation + blog URL filtering. 4 LBO overrides discovered and added.
- **For-loop resilience** — `|| true` on all 3 WE scraper for-loops + `process.exit(0)` for non-WE show IDs. Prevents one show failure from killing the batch.
- **Multi-source weights fix** — Missing `ltd: 0` in multi-source weights object (caught by code review).

### Week of 2026-03-17
- **OWE pipeline fix (8 bugs, 8 files)** — Off-West End shows were discovered but never collected reviews due to exact category matches excluding `off-west-end`. Fixed: collect-outlet-reviews.js, review-refresh.yml, update-show-status.yml, fetch-aggregator-pages.ts, collect-review-texts.yml, collect-outlet-reviews.yml, opening-night-poller.yml (OWE+OB). One-off collection: 70 review files → 67 in reviews.json → 20 scored. All 11 open OWE shows now live with scores (e.g., Starlight Express 74/100, 21 reviews).
- **Opening night orchestrator** — New `opening-night-orchestrator.yml` dispatches the poller every 20 min for up to 4 hours. Two crons: Broadway 3 AM UTC (11 PM ET), West End 10 PM UTC (11 PM BST). Per-market concurrency. Eliminates dependency on `update-show-status.yml` (which failed today). Simulation tested end-to-end: discover → collect → score → rebuild → readiness check → broadcast guard.
- **Poller enhancements** — Inline collect+score (saves ~45 min vs separate workflow chain). Market input for filtering. Broadcast dispatch with triple guard (sent check + recent dispatch check + threshold). Local rebuild for readiness check. Git status fix (review-texts is separate checkout). Git config fix for commit steps.
- **WE aggregator expansion** — Added LBO roundups + theatre.reviews + Stagedoor to poller Layer 1. Skipped DTLI for London (US-only). Theatre.reviews scraper created but extraction needs tuning (only extracting 1 review per page instead of 10+). Stagedoor already working (236 reviews, 26 shows).
- **Review collection improvements** — (1) BrightData SERP fix: swapped to `serp_api1` zone, sync-first ordering, fixed poll URL params. (2) Batch wrongShow recovery: 207 reviews recovered (188,598 words), scored, deployed. (3) SERP discovery cap raised 250→1000, configurable via workflow input. (4) Push-with-retry rewrite: auto-resolves collection-state conflicts, tested with concurrent runs (push succeeded on attempt 2). (5) Aggregator archive validator fixed (wrong directory).

### Week of 2026-03-16
- **Opening night broadcast de-cron** — Removed 41 cron entries (16 broadcast + 25 poller) that ran every night even with no openings. Now dispatch-only: (1) auto from update-show-status.yml on previews→open transition, (2) auto-retry via workflow_run after scoring, (3) manual dispatch. Preview-to-owner default preserved, one-tap phone approval flow intact. Fixed Commit step push race (skip when no changes).
- **URL brittleness remediation** — Weekly URL health check (artifact-based, no git push contention), centralized url-utils.js, SERP-based Telecharge discovery, TodayTix API cross-verification (4 ID recycling cases found), TM path allowlist, OUTLET_DOMAINS derived from outlet-registry.json (119→1,242 entries, 18 registry fixes). All open shows already had platform links — no backfill needed.
- **WE opening-night pipeline** — Wired Show Score WE (59 curated URLs) + LBO roundups into gather-reviews.yml. Fixed LBO sitemap URL (non-www returned empty). Created curated lbo-roundup-urls.json (13 roundups). E2E tested 1+5+3 shows. Backfilled all 62 WE shows.
- **P0 score recovery (220 reviews)** — 85 from OUTLET_VERIFIED_SOURCES fix, 92 EW letter grades via regex, 26 via Playwright recollection, 17 via Guardian API. WE P0 rate: 31%→67%.
- **LLM extractor hallucination fix** — verifyInText accepted any `*` as star proof + matched other-show ratings. Fixed: require specific X/Y in last 500 chars. Hallucination rate 40%→<2%.
- **Show Score star capture** — gather-reviews.js Playwright path now extracts --rating CSS var (~510 future P0.5 scores).
- **SeatPlan audience scores for OWE** — Fixed slug generation (venue suffixes like "- Globe", colon subtitles). Extracted shared `buildLondonSlugVariants()` to `show-matching.js` (used by both SeatPlan + LBO scrapers). SeatPlan OWE: 5→10 shows (+1,187 reviews). LBO OWE: 13→17 shows (+311 reviews). Fixed TDZ bug in rebuild-all-reviews.js. /review passed: 0 P0, 1 cosmetic P1.
- **Audience scrape on show open** — SeatPlan + LBO now auto-dispatch when shows transition previews→open (same pattern as ShowScore/Mezzanine). Added `shows` (plural) input to both workflows. Previously waited up to 7 days; now immediate.
- **Venue classification cleanup** — Removed Menier Chocolate Factory + Charing Cross Theatre from west-end-venues.json (180/200 seats, not SOLT members). Audited all borderline venues against SOLT membership.
- **Data health fix** — push-core-data bug (Mar 12) was comparing snapshot vs itself → zero changes detected → shows.json stuck 6 days. Fixed diff to compare data/ (post-script) vs checkout (baseline).
- **ScrapingBee exhaustion resilience** — SB credits at 0 until Apr 2 renewal. Added BD/Playwright fallbacks to 4 hard-failing scripts (show-score, bww-reviews, ticket-links, commercial). Fixed opening-night-poller SERP (broken arg signature since inception).
- **Scraper cost optimization** — 5 changes: (1) Playwright-first for public sites in scraper.js (IBDB, Broadway.com → free), (2) BD-first SERP in collect-review-texts.js with proper SERP API port, (3) SB credit pre-check at startup, (4) per-run cost logging, (5) split SB page/SERP credit counters. Smart SERP ordering: BD-first for batch (cheap), SB-first for opening nights (fast).
- **Playwright browser recovery** — Reset browser instance after timeouts to prevent cascade failures across all subsequent fetches.
- **Workflow Playwright install** — Added `npx playwright install chromium` to 5 workflows that now need it for fallback chains.

### Week of 2026-03-12
- **Regression guards** — CI guards: contentVerification deletion guard, isScoreable() import guards. Fixed 2 bugs, migrated 3 scripts.
- **Dead code removal** — Removed ~736 lines from 12 src/ files (32 dead exports/functions).
- **Unit tests** — engine.ts (37 tests) + data-core.ts (81 tests, 31 suites). Both in CI via tsx.
- **TypeScript strictness** — Zero TS errors, zero `as any` casts. Window.gtag/Sentry declarations, SentryEvent interface.
- **CI workflow cleanup** — Push-with-retry migration (15 workflows, -281 lines) + setup-node composite action (10 workflows, -48 lines). Total: -369 lines boilerplate.
- **Creative team data fix** — Removed 8 hallucinated director entries from 7 shows (Into the Woods, Frozen, South Pacific, Passion, Gypsy, Sunday in the Park, Master Harold). Downgraded co-writer/co-director validation to warning. validate-data.js: 11 errors → 0.
- **ScrapingBee SERP credit optimization** — Reduced usage from ~3.3M credits/month to ~968K (fits 1M budget). 4 fixes: scheduled search days (0,1,3,7,14), gather dispatch ≤3 days, closed show filter on 3 aggregator scrapers, skip outlets with 2+ reviews. BrightData SERP API as transparent fallback when SB exhausts (100% top-result quality match). Applied to discover-opening-night-reviews.js + url-discovery.js (covers gather-reviews, collect-outlet-reviews).

### Week of 2026-03-09
- **Theatr audience data integration** — New 4th audience source. Scraper (`scrape-theatr-audience.js`), weekly CI workflow, AudienceBuzzCard UI (4-source layout), methodology/audience-buzz/llms.txt updated. 228 shows with Theatr data, 26 open BW shows affected (+2.2 avg score bump). MIN_VOTES=1 (consistent with ShowScore/Mezzanine). Icons: bar-chart for ShowScore, thumbs-up for Theatr.

### Week of 2026-03-08
- **PostHog analytics + Lighthouse CI** — Replaced Clarity with PostHog (website + iOS app). Weekly automated insights workflow (PostHog API → GitHub issue). Lighthouse post-deploy audit with regression alerting.
- **GitHub history cleanup** — Purged copyrighted content from all 101,630 commits via git-filter-repo. Deleted stale branches, triggered mirror updates.
- **URL collision resolution** — All 87 URL collisions resolved: 48 BW→OB wrongShow, 21 legacy→dated wrongShow, 10 cross-show (isMultiShowReview/isRoundupArticle), 8 special cases. 94 files flagged across 53 shows. Regression guards added to CI.
- **Multi-show review auto-trimming** — Unblocked multi-show reviews for scoring: heading-based text trimmer, showTitle passed to LLM scorer, isMultiShowReview removed from hard block. Detection threshold raised 3→5 mentions (184 false positives cleared, 644 stale flags cleaned). 28 new SKIP_TITLES added. Cleanup workflow created.
- **Notification Phase 2: Daily Digest + Auto-Fix** — Single daily email replaces notification noise. Auto-dispatches fix workflows for stale data, shows only actionable items with urgency badges (FIX NOW/THIS WEEK), suppresses LOW-priority noise. Independent review applied: daily counter reset, per-check granularity, workflow dedup, non-fatal email errors, one-tap retry links.
- **IBDB revival detection** — Automated revival detection across all 3 markets via dual-SERP IBDB queries. 37 revivals detected (4 OB + 23 WE + 10 Broadway), 714 shows normalized to explicit `isRevival: false`, transfer-vs-revival disambiguation, `ibdbRevivalChecked` flag prevents re-querying. Integrated into `discover-new-shows.js` Stage 3 for future shows.
- **Mobile TBT fix** — Root cause: 8 useMemo hooks iterating 700+ shows during hydration. Fix: server-side featured row computation, progressive card rendering (IntersectionObserver), lazy below-fold sections. TBT 992ms→~660ms. Added per-deploy Lighthouse TBT check to catch regressions.
- **SEO Phase 2** — Lazy-load Fuse.js on WE/OB pages (~17KB savings each), dynamic import MezzanineImport, CTR title optimization (3 pages), Tony FAQ 1→4 questions, theater FAQ schema, review BreadcrumbList, Tony per-category ItemList
- **Lists feature** — Full implementation: ListsTab on /my-shows, show page "Add to List" dropdown, create/rename/delete lists, ranked lists with drag-to-reorder, deferred auth auto-open, optimistic updates, mock mode for QA
- **Auto-triage Phase 1** — Extended `health-check.js` with 4 new categories (CWV, SEO, Cron, Secrets), per-system triage state files, auto-triage issue creation with dedup
- **Health check local run guard** — Local runs no longer corrupt CI history/triage state
- **shows.json freshness fix** — Always stamp lastUpdated on run + pipeline-health timestamp
- **Rebuild-reviews regression** — Investigated: all wrongProduction flags were correct (oh-mary OB→BW transfer, private-lives 2011→2025, rent revivals). Self-resolved after baseline caught up.
- **DTLI/Show Score** — Fixed, running successfully again
- **Review dedup cleanup** — Comprehensive dedup: 35→0 duplicates. Critic typo fixes, URL dedup, cross-show flags, buy-tickets junk flagged. Test suite 23/23.
- **WE/OB data quality sweep** — 31 wrongProduction (reviews of earlier productions), 32 wrongUrl (social media, roundups, wrong sites), 6 domain aliases (times-uk migration, etc.), 7 junk outlets flagged, 1 outlet added. Validation: 0 URL mismatches, 0 early reviews, 0 duplicates.
- **URL collision cleanup** — Reduced cross-show URL collisions from 330→25. 193 files auto-fixed via 15-tier heuristic. Rebuild triggered to pick up changes.
- **Outlet tier scoring audit** — Verified all 142 outlets missing from OUTLET_TIERS correctly default to tier 3 (matching registry). No mistiering found.
- **Cross-outlet duplicate cleanup** — 90 detected, 31 confirmed duplicates flagged (same-outlet-different-ID, AP syndication, wrong content scraped, BWW roundup errors). 59 false positives (different critics with similar text).
- **Systemic duplicate prevention** — Three fixes: (1) Merged 4 duplicate outlet registry entries with aliases, (2) AP wire content detection in non-AP files (7 caught), (3) Author-byline mismatch scanner (14 found for review). All integrated into `detect-syndicated-duplicates.js`.
- **Component consolidation** — Completed (ShowListCard, MiniShowCard, Modal, useClickOutside, useShowSearch, ShowSearchDropdown, SortIcon, icons, formatCurrency, useSortableTable, formatDate). CollapsibleSection evaluated and rejected (insufficient duplication to justify abstraction).
- **Cookie refresh** — Already covered by health check alerts + email. Manual step can't be automated.


### Week of 2026-04-09
- **Wrong-production prevention + data integrity sweep** — 3-layer fix: (1) `titlesMatch()` sequel guard (`title-normalization.js`) — substring match rejects "Part N/IV/etc." remainder, prevents "A Doll's House" matching "A Doll's House, Part 2"; (2) TR year guard (`extract-theatre-record.js`) — when show has no opening date, rejects reviews 2+ years before show ID year; (3) Dedup TBA fix (`deduplication.js`) — "TBA" venue treated as unknown, preventing phantom shows bypassing dedup as "transfers." Data: 25 wrong-production reviews flagged (14 Doll's House + 8 Cleansed + others), 1 cross-show URL (Wicked WE/Dracula), phantom `into-the-woods-west-end-2026` removed (was re-created 4×).
- **Weekly integrity check failure fixed** — Root cause: `.gitignore` `/data/*.md` rule silently blocked `git add data/integrity-report.md`, failing the workflow for 3+ weeks. Fixed with `!/data/integrity-report.md` negation rule.
- **ShowScore synthetic critic name prevention** — `sanitizeCriticName()` added to `gather-reviews.js` both extraction paths. Strips ShowScore aggregator verb phrases ("Asserts Dominic Cavendish" → "Dominic Cavendish"), preventing duplicate review files with the same URL.
- **Phantom show detection health check guard** — New B3 check in `health-check.js` alerts when open shows have TBA/missing venue, no reviews, and no opening date — signature of phantom auto-discover entries. Catches future `isMultiProduction()` regressions before they accumulate.
- **Discount tickets UI overhaul** — Rush/Lottery Detailed View cards: poster images (2:3) replace badly-cropped hero images, score badge overlaid on image bottom-right on mobile (like homepage shelves), always-horizontal layout. Table view: long titles truncated with ellipsis (max-w-[200px] on mobile), chevron arrows inline with titles, price column always visible. Applied to all 4 tables (Lottery, Rush, SRO, All Discount).
- **Opening day "Just opened" timezone bug** — `new Date('YYYY-MM-DD')` parses as UTC midnight, but `setHours(0,0,0,0)` operates in local time — in ET this shifts April 9 back to April 8, defeating the same-day guard. Fixed with UTC ISO string comparison in `getBroadwayDuration`. Also fixed leading " · " separator when duration is null. Status transition (`update-show-status.js`) correctly uses `<=` — shows flip to `open` on opening day.

### Week of 2026-04-07
- **Adjudicator outlet awareness** — The adjudicator was trusting aggregator-invented star ratings (e.g., Show Score assigning "5/5 stars" to London Theatre), inflating `humanReviewScore` to 100. Fix: 3-tier outlet handling (KNOWN_STAR_OUTLETS → trust, DESIGNATION_OUTLETS → binary signal, unknown → UNVERIFIED warning). Extracted `buildUserPrompt` to testable lib (`scripts/lib/adjudication-prompt.js`, 39 tests). Fixed 6 wrong outletIds (display names → actual data IDs). Reset 4 mis-adjudicated reviews (all re-adjudicated overnight). Separated NYT Critic's Pick into designation category. Also: linter renamed adjudicator output from `humanReviewScore` to `adjudicatedScore` (correct — P0a priority in rebuild, not P0 human override).
- **`actions:write` fix for 13 workflows** — 13 workflows that dispatch other workflows via `gh workflow run` silently failed with HTTP 403 (missing `actions: write` permission). Fixed all 13. Adjudication rebuild trigger confirmed working in overnight cron.

### Week of 2026-04-06
- **Theater images - Wikimedia hotlink fix** — All 42 theater images were broken (Wikimedia changed thumbnail serving policy, all `/commons/thumb/` URLs return HTTP 429). Switched both theater detail pages and index page to serve local copies already in `public/images/theaters/`. Removed Wikimedia dependency entirely. Verified live on 2026-04-08.
- **WET scraper content-match fix for short titles (uncommitted)** — `scripts/scrape-westendtheatre-roundups.js` has an uncommitted fix: shows with no significant words after filtering (MJ, Six) now fall back to substring match on full title instead of always passing. Needs committing.

### Week of 2026-03-19 — WE Aggregator Sweep
- **WE aggregator sweep fully operational** — 4 aggregators (WET 48, TR 24, SD 34, TS 28), archive-first caching, ~1,200 total reviews. Weekly Tuesday 8AM UTC.
- **Archive-first for all aggregators** — WET/TR/SD/TS all cache results. Numbers stable across runs, no WAF variance.
- **BB keepAlive** — BrowserBase sessions survive full runs (1 session, 0 errors vs 9/8 before).
- **TS login fix** — `/login` not `/accounts/sign-in`. Unlocked 9 paywalled shows.
- **SD scroll pagination** — Category pages scrolled to load 110 shows (was 70). Plus 19 hardcoded Stagedoor IDs.
- **TR homepage scraping** — 31 roundup URLs from homepage + comprehensive venue slug matching + inline star extraction.
- **gather-reviews WE integration** — Archive reads + live-fetch (WET API, TR homepage, TS SERP+BB) for opening nights. Date-gated.
- **Aggregator archive persistence** — push-aggregator-archive step added to sweep + gather-reviews workflows.
- **Git credential isolation** — direnv + repo-local credential helper (thomaspryor vs tompryordojo).

### Week of 2026-03-07
- Roadmap overhaul — file-based roadmap, mirrored to issue #50 body, session discipline rules
- Auto-maintain workflow hardening — continue-on-error, if:always() for commit path, name-length guard
- Email-based broadcast approval flow (approve from phone)
- Off-West End classification + venue filter
- iOS: Sentry, push notifications, offline queue, haptics, store review, deep linking (Build #29)
- BTC: TBD badges + curated nominees QA











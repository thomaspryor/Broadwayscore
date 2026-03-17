# Roadmap — Last updated 2026-03-17

## Active WIP Sessions (Do Not Start Competing Work in src/)

| Session | Branch | Status |
|---------|--------|--------|
| Diary/Watchlist polish | `worktree-ugc-fixes` | In progress |
| iOS app improvements | Separate repo | In progress |
| iOS Sentry/Push/Offline/Deeplinks | Build #29 | Code done, needs TestFlight testing |

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

**WE Review Coverage (CRITICAL — fix before launch):**
8. **Cross-show URL dedup bug** — Paddington reviews wrongly flagged "belongs in man-and-boy-west-end-2026." Telegraph, The Stage, WhatsOnStage, Times UK, Standard all excluded. Affects multiple shows. Root cause: URL dedup in rebuild-all-reviews.js matching wrong show.
9. **Outlet registry missing UK outlets** — Radio Times, South London, Observer (UK), Shiny Shiny flagged as "US outlet." Need to add these to outlet-registry.json with `region: 'london'`.
10. **Cross-market guard too aggressive on dual-market outlets** — NY Post, NYT (Matt Wolf), BroadwayWorld reviewing WE shows from London flagged wrongProduction. Guard should check if URL/content references London, not just outlet region.
11. **~140 Show Score reviews excluded across 28 WE shows** — combination of bugs 8-10. Must have ALL Show Score critic reviews PLUS more. Current gap: 1-5 reviews per show on 9 shows we're behind on.

**P0 Score Recovery (2026-03-16, 220 reviews upgraded):**
12. ~~**OUTLET_VERIFIED_SOURCES fix**~~ → DONE. 85 WE reviews promoted LLM→P0.
13. ~~**EW letter grade regex recovery**~~ → DONE. 92 reviews, pure regex, no LLM.
14. ~~**Playwright recollection (Stage, WOS, Time Out, etc.)**~~ → DONE. 26 reviews.
15. ~~**Guardian API recovery**~~ → DONE. 17 reviews via Content API.
16. ~~**LLM extractor hallucination fix**~~ → DONE. verifyInText tightened (40%→<2% false positive).
17. ~~**Playwright star capture in gather-reviews.js**~~ → DONE. Code change deployed, takes effect on next gather run (~510 future P0.5 scores).
18. **USA Today star re-collection** — BLOCKED. Older articles no longer render star widgets after site redesigns. ~291 reviews permanently unavailable.
19. **Remaining UK outlet gaps** — Telegraph SVG extractor (73), Culture Sauce React (58). Need outlet-specific extractor improvements. Post-launch.

**Site Reliability:**
7. ~~**Pipeline health dashboard**~~ → Phase 1 DONE (health monitoring, 9 categories).
8. ~~**Notification Phase 2: Daily Digest + Auto-Fix**~~ → DONE. Daily email via Resend with auto-dispatch of fix workflows, urgency badges, plain-English instructions. LOW items suppressed.
9. **Phase 3: Smart Escalation** — Per-system cooldowns, cookie/secret expiry warnings at 7/3/1 days, digest subject urgency increases with persistence. Build after Phase 2 soak (~2 weeks).
10. ~~**URL brittleness remediation**~~ → DONE (2026-03-16). Weekly health monitoring, SERP Telecharge discovery, centralized url-utils.js, TodayTix API verification, TM allowlist, OUTLET_DOMAINS derived from registry (1,242 entries vs 119 hardcoded).

**Performance:**

## MEDIUM PRIORITY

**Product:**
9. **Off-West End scoring expansion** — Classification done (65 WE / 63 Off-WE). Needs more shows + scoring.
10. **App icon refinement** — Hard to read at small sizes.
11. **BTC/TodayTix partnership (paused)** — Waiting on TodayTix for launch timing, co-branding, legal.

**Data Quality:**
12. ~~WE/OB review cleanup — duplicates~~ → DONE. 35→0 duplicates via comprehensive dedup.
13. ~~WE/OB review cleanup — URL collisions~~ → DONE. All 87 collisions resolved (94 files flagged across 53 shows).
14. ~~Cross-outlet duplicate reviews~~ → DONE. 90 found, 31 flagged (28 very-high + 3 AP syndication). Remaining 59 are false positives (different critics, similar text).
15. ~~WE/OB early reviews + URL mismatches~~ → DONE. 31 wrongProduction, 32 wrongUrl, 6 domain aliases added. Validation: 0/0/0.
16. ~~Unknown outlets~~ → Reduced 55→49. 7 junk flagged, 1 fixed, 1 added to registry. Remaining 49 are `outletId: "unknown"` (need outlet identification — separate effort).
17. ~820 shows missing synopses (mostly obscure historical).

**Pipeline:**
17. ~~Collection coverage dashboard~~ → DONE. Weekly report: fullText/excerpt/stub by outlet, tier, access model, market. Identifies top collection opportunities. History tracking for trends.

## LOW PRIORITY / BACKLOG

**iOS App:** Widget, Spotlight search, iPad layout, Android, Share sheet, App Clips, Siri
**Infrastructure:** Show images to CDN (173MB/deploy), prune low-value static pages, domain retry intelligence, ~~ScrapingBee SERP credit optimization~~ → DONE (3.3M→968K credits/month + BrightData fallback), ~~Scraper cost optimization~~ → DONE (Playwright-first for public sites, BD-first SERP, SB credit pre-check, per-run cost logging)
**Scraper resilience:** Consolidate inline SERP in collect-review-texts.js to use shared url-discovery.js module (eliminates diverged 200-line fork)
**Code Quality:**
18. ~~**TypeScript strictness cleanup**~~ → DONE. Zero TS errors, zero `as any` casts. Added Window.gtag/Sentry declarations, SentryEvent interface, GoldListType narrowing.
19. ~~**Unit test coverage**~~ → engine.ts DONE (37 tests) + data-core.ts DONE (81 tests). Both in CI. Remaining: rebuild pipeline.
20. **Script hardening** — Assessed: 130 CI scripts mostly well-structured. No critical gaps (JSON writes use stringify, Node 20+ handles rejections). Remaining: TS migration for top scripts, structured logging. LOW priority.
21. ~~**Custom ESLint rules**~~ → Phase 1 DONE. Regression guards instead: contentVerification deletion guard, isScoreable import guards for 3 scripts.
22. ~~**Dead code removal**~~ → DONE. Removed ~736 lines from 12 src/ files (32 dead exports/functions).
23. ~~**CI workflow cleanup**~~ → Phase 2 DONE. Push-with-retry migration (15 workflows, -281 lines) + setup-node composite action (10 workflows migrated, 65+ remaining). Total: -369 lines boilerplate.
**Data/Scoring:** LLM prompt contamination audit, cross-aggregator excerpt enrichment, Playwright critic resolution, 14 author-byline mismatches need manual review (audit report in data/audit/syndicated-duplicates.json)
**Lists Enhancements:** Public/shareable lists, "Add to List" from Diary/Watchlist rows, smart list suggestions (auto-suggest based on diary), drag handle discoverability (animation/tooltip), list import from Diary (bulk add seen shows), list count in header stats bar, notes per list item
**SEO:** FAQ schema on show detail pages
**Code Quality:** ~~Regression protection for critical patterns~~ → DONE (grep-based guards in CI). ~~Linter/IDE revert root cause~~ → DONE (concurrent sessions, not auto-formatter).

## Recently Completed

### Week of 2026-03-16
- **Opening night broadcast de-cron** — Removed 41 cron entries (16 broadcast + 25 poller) that ran every night even with no openings. Now dispatch-only: (1) auto from update-show-status.yml on previews→open transition, (2) auto-retry via workflow_run after scoring, (3) manual dispatch. Preview-to-owner default preserved, one-tap phone approval flow intact. Fixed Commit step push race (skip when no changes).
- **URL brittleness remediation** — Weekly URL health check (artifact-based, no git push contention), centralized url-utils.js, SERP-based Telecharge discovery, TodayTix API cross-verification (4 ID recycling cases found), TM path allowlist, OUTLET_DOMAINS derived from outlet-registry.json (119→1,242 entries, 18 registry fixes). All open shows already had platform links — no backfill needed.
- **WE opening-night pipeline** — Wired Show Score WE (59 curated URLs) + LBO roundups into gather-reviews.yml. Fixed LBO sitemap URL (non-www returned empty). Created curated lbo-roundup-urls.json (13 roundups). E2E tested 1+5+3 shows. Backfilled all 62 WE shows.
- **P0 score recovery (220 reviews)** — 85 from OUTLET_VERIFIED_SOURCES fix, 92 EW letter grades via regex, 26 via Playwright recollection, 17 via Guardian API. WE P0 rate: 31%→67%.
- **LLM extractor hallucination fix** — verifyInText accepted any `*` as star proof + matched other-show ratings. Fixed: require specific X/Y in last 500 chars. Hallucination rate 40%→<2%.
- **Show Score star capture** — gather-reviews.js Playwright path now extracts --rating CSS var (~510 future P0.5 scores).
- **SeatPlan audience scores for OWE** — Fixed slug generation (venue suffixes like "- Globe", colon subtitles). Extracted shared `buildLondonSlugVariants()` to `show-matching.js` (used by both SeatPlan + LBO scrapers). SeatPlan OWE: 5→10 shows (+1,187 reviews). LBO OWE: 13→17 shows (+311 reviews). Fixed TDZ bug in rebuild-all-reviews.js. /review passed: 0 P0, 1 cosmetic P1.
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

### Week of 2026-03-07
- Roadmap overhaul — file-based roadmap, mirrored to issue #50 body, session discipline rules
- Auto-maintain workflow hardening — continue-on-error, if:always() for commit path, name-length guard
- Email-based broadcast approval flow (approve from phone)
- Off-West End classification + venue filter
- iOS: Sentry, push notifications, offline queue, haptics, store review, deep linking (Build #29)
- BTC: TBD badges + curated nominees QA




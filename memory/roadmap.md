# Roadmap — Last updated 2026-03-08

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

**Site Reliability:**
5. ~~**Pipeline health dashboard**~~ → Phase 1 DONE (health monitoring, 9 categories).
6. ~~**Notification Phase 2: Daily Digest + Auto-Fix**~~ → DONE. Daily email via Resend with auto-dispatch of fix workflows, urgency badges, plain-English instructions. LOW items suppressed.
7. **Phase 3: Smart Escalation** — Per-system cooldowns, cookie/secret expiry warnings at 7/3/1 days, digest subject urgency increases with persistence. Build after Phase 2 soak (~2 weeks).

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
**Infrastructure:** Show images to CDN (173MB/deploy), prune low-value static pages, domain retry intelligence
**Code Quality:** _(No active items — useSortableTable + component consolidation complete)_
**Data/Scoring:** LLM prompt contamination audit, cross-aggregator excerpt enrichment, Playwright critic resolution, 14 author-byline mismatches need manual review (audit report in data/audit/syndicated-duplicates.json)
**Lists Enhancements:** Public/shareable lists, "Add to List" from Diary/Watchlist rows, smart list suggestions (auto-suggest based on diary), drag handle discoverability (animation/tooltip), list import from Diary (bulk add seen shows), list count in header stats bar, notes per list item
**SEO:** FAQ schema on show detail pages
**Code Quality:** ~~Regression protection for critical patterns~~ → DONE (grep-based guards in CI). ~~Linter/IDE revert root cause~~ → DONE (concurrent sessions, not auto-formatter).

## Recently Completed

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


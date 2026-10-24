# Off-Broadway historical backfill, plan v2 (BRO-6146)

Status: v3 (gap-first, TheaterMania universe, press screen), after a six-reviewer /plan-review of v2 and the first season run (2026-10-24). Plan only. No code, data or workflow changes in this card.
Where the "v2 changes" section below conflicts with the v1 text under it, v2 wins.

## v3 changes (2026-10-24, owner feedback after the first season run; supersedes conflicting text below)

Owner feedback: 16 shows is too few, and the June 2025 to February 2026 gap (before OB coverage began) should come first.

**Measured gap.** shows.json has 0 to 4 OB openings a month for 2025-06 to 2025-12 (14 total), then 13, 25, 43 for 2026-01..03 and 20 to 45 a month after. At the 2026 rate (163 shows with 3+ reviews in 8 months, about 20 a month) the gap window should hold roughly 140 scoreable shows.

**Universe source found: TheaterMania's public WP JSON** (`theatermania.com/wp-json/wp/v2/shows?market=98`, already used by `scripts/lib/theatermania-ob.js` for current shows). It lists 7,922 OB shows across 80 pages of 100, with ACF `opening_date`, `preview_date`, `closing_date` (YYYYMMDD) and a venue id. It is free (no scraper credits, reachable from a cloud session), paged and dated. Counts by opening month run 7 to 39, about 200 to 300 a year back to 2022. Title plus opening date within 120 days against shows.json:

| Window | TM listings | Not in shows.json |
|---|---|---|
| 2025-06 to 2026-02 (the gap) | 204 | 168 |
| 2024-06 to 2025-05 | 257 | 247 |
| 2023-06 to 2024-05 | 265 | 250 |
| 2022-01 to 2023-05 | 298 | 293 |

This replaces Phase 0's three-source spike: TM is the dated listing (the WOS role in the WE backfill). It is the loose universe, so it needs a notability filter.

**Notability becomes a measured press screen, not awards.** Phase H showed an award does not guarantee reviews (Sumo: Lortel nominee, 2 reviews), and the award-only 2024-25 pass found just 16 promotable shows. New rule: a TM-listed, dated production is promotable when a pre-screen finds critic reviews from at least 3 distinct outlets in the outlet registry, or 2 when one is T1/T2. The screen runs one or two SERP queries per show (`"<title>" review` plus venue) and counts distinct registry outlet domains in the results. Cost is about $0.0005 per query, so screening all 168 gap candidates is under $0.20. It runs as a committed script through `cloud-run-script.js` (cloud has no scraper keys), prints JSON, writes nothing. Awards and flagship venue stay as tie-breakers for shows at the threshold.

**Order changes.** Gap first (2025-06 to 2026-02), then the rest of 2024-25 (the 16 award shows already added and gathering are its first slice), then 2023-24, then 2022-23. Each still passes the cohort audit before the next.

**Expected size.** If 60 to 80 percent of the 168 gap candidates fail the press screen (small showcases, festivals, readings), the gap yields about 35 to 70 shows. That is below the 140 estimate, which assumed the 2026 catalog's live-tracking yield. The screen gives the real number before anything is promoted.

**Cost.** Scraping measured $0.04 to $0.055 per show (Phase H). Screening adds about $0.001 per candidate. LLM scoring still dominates and is measured on the 16-show run.

**Exclusions on TM rows.** Drop rows with no opening or preview date, runs under 14 days, titles matching festival or reading or benefit or concert or cabaret patterns, and venues outside OB (TM market 98 includes some off-off spaces). Dedup against shows.json by normalized title and opening date within 120 days, and refuse an id that exists (the add-show action already does).

## v3.1: plan-review outcome on v3 (2026-10-24, Opus reviewers + GPT-5.4-mini + Gemini Flash; supersedes v3 where they conflict)

**Ramp change (adopted).** The first gap run is **10 shows picked at random from the 168, unscreened**: Playbill-validate, add, gather, rebuild. Their real review counts calibrate the press screen before it gates the other ~158. Cost: about $0.50 scraping plus LLM. [structure reviewer, GPT, Phase 0]

**The v3 screen as written gates nothing (P0, design + structure + pre-mortem).** `"<title>" review` returns TheaterMania's own show page, a Playbill production page and a BWW listing for almost every show. Those are T1/T2 registry domains (`data/outlet-registry.json`), so "3 outlets, or 2 with a T1/T2" passes without one review. It also picks up same-title West End or film coverage (the registry holds 272 London outlets) and generic titles. Rebuilt on the existing census instead of new counting:
- Queries from `buildCensusPlan` (`scripts/lib/serp-review-census.js`), results filtered by `acceptSerpCensusResult` (`scripts/audit-show-review-gap.js:685`; wrong-work, stale-year, other-production, own-venue guards), outlets from `getKnownDomainMap()`.
- Listing and ticketing pages never count. Only review-shaped URLs or titles that name the show. Outlets filtered to NYC/US region. Generic titles go through `isGenericShowTitle` / `canDisambiguateGenericTitle` (`scripts/lib/url-discovery.js:139-184`) and need a venue or creative in the result.
- A pure `decideObPressScreen({acceptedUrls, knownDomainMap, tierOf})` returns `{pass, outlets, reason}` with evidence URLs, unit-tested. Its threshold is set from the 10-show calibration.
- The script calls `serpCensusPreflight` first (a missing key otherwise reads as "0 outlets" for every show) and sets `SCRAPER_SPEND_PURPOSE=historical-backfill` (run-script.yml sets none, so rows would count against the 5K/day probe).

**Playbill dates are still required (P1, pre-mortem + structure).** TM often puts the first performance in `opening_date` and leaves stale open-ended rows (`scripts/lib/theatermania-ob.js:39-42, 91-108`). Every candidate is checked with `validate-show-venue.js --candidates-file` (about 6 Scrapingdog credits each) and needs a Playbill opening and closing date, closed 90 or more days ago, with a run of 14 days or more. TM is the list of what to check. Playbill supplies the dates.

**TM reader: parameter, not fork (P0/P1, design + structure).** `fetchTmOffBroadway` keeps only `isCurrentTmRow` rows and stops at the first page with none (`theatermania-ob.js:379-391`), and `discover-new-shows.js:716` uses it daily. It gains `{rowFilter = isCurrentTmRow, maxPages, stopWhenPageEmpty = true, orderby = 'modified'}`. The historical caller passes a window predicate, 80 pages, no early stop and `orderby=id` (modified-order paging skips and repeats rows mid-scan). Rows still go through `parseTmOffBroadwayRow` and the existing `isNonTheaterContent` / `isOneNightShow` gates, and the historical path overrides `discoverySource` to `ob-historical:tm` and clears `provisional`. Fixture tests go in `theatermania-ob.test.mjs`. Default callers' behavior is unchanged and tested.

**One dedup rule (P1).** Use `findTmSameTitleShow` and `checkForDuplicate`, not a new title-plus-120-days rule. The 168 figure is therefore an upper bound (187 OB stubs have no opening date).

**Coupling with current discovery (P1, structure).** A closed 2025 row would make `findTmSameTitleShow` (366-day window) treat a 2026 transfer or return run of the same title as a duplicate (`discover-new-shows.js:2830-2844`), and `reconcileMatchedShow` could write current-run data onto the closed row. A historical closed row is excluded from that match. The fix ships before the first gap promotion, with a test.

**Plans go through `new-fix-plan.js --actions=` (design).** No hand-built JSON and no second splitter. Plans hold at most about 10 actions, and after each apply the cohort ledger is reconciled against the plan's `results[]` (an action can fail while the rest apply). [pre-mortem]

**Gather dispatch etiquette.** Off-peak only, never when an opening-night run is queued or an opening falls within 48 hours. About 4 shows per job.

**User-facing (user-impact reviewer):**
- Thin-page noindex is off by default and covers only zero-review closed shows (`scripts/lib/seo-indexability.js:43,69`). So every added show is indexable from the moment it lands, including while it sits at 0 reviews mid-gather. Before the first gap promotion, extend noindex to closed shows below the display threshold whose `discoverySource` starts with `ob-historical:`, and turn it on for that class only. A show retired later gets a redirect, not a 404.
- The iOS feed includes a closed show once it has one scored review (`scripts/generate-mobile-data.js:156-158`), so an unscored card can appear. Accepted for now, since the score is hidden below the bar, and checked in the cohort audit.
- The `/off-broadway` "Closed" view sorts by recent, so gap shows will sit at its top. That is correct behavior. `getRecentShowSlugs` treats shows closed within 180 days as recent (`src/lib/data-core.ts:521`), which the 90-days-closed rule mostly keeps clear of.
- Homepage shelves, OB browse lists, RSS, newsletter and broadcasts all require open or previews status, so they are unaffected (checked).

**Wording fixes (Gemini).** LLM scoring cost is **not yet measured**. The 16-show 2024-25 run will measure it. The v1 notability list (press 5+, award, transfer, flagship as equals) is replaced by v3.1's calibrated press screen, with award and flagship as tie-breakers only. The outlet registry is `data/outlet-registry.json`.

**Considered and not adopted.** "Add all 168, gather, retire the thin ones" (GPT). It saves building the screen, but pages are indexed while thin and retirement is a multi-repo revert per show. The 10-show unscreened run takes the useful part of that idea.

**Revised effort.** The TM reader parameterization, discovery coupling fix, census-based screen and noindex extension add about 1.5 to 2 days of build before the main gap promotion. The 10-show run can go first, because it uses only Playbill validation and fix plans, which already work.

## v2 changes from plan review (supersedes conflicting text below)

Ramp (framing fix from Phase 0 and the structure reviewer): the first step was 5 shows through new tooling after 8 to 12 days of building. New order:
1. **Phase H, hand ramp (1 day, at most $5, no new code).** Pick 2 award-winning 2025 OB shows. Run `validate-show-venue.js --show=ID`, add them as closed entries with real Playbill dates, dispatch one `gather-reviews.yml` run with `max_tier=3` and `spend_purpose=historical-backfill`. Read the ledger and review counts. This answers per-show cost, T2-only versus T3 yield, and whether 2022 and 2023 are reachable, before anything is built. Also run one revert end to end on one of them.
2. Phase 0 source spike. 3. Build (Phase A). 4. 5-show pilot. 5. Cohort.

Fixes (source in brackets):
- **Gather settings.** The live backfill lane dispatches with `max_tier=2` and `no_sb_serp=true` (`historical-backfill.yml:73-74`), which covers T1 and T2 outlets only. OB coverage leans on T3 outlets, so cloning that lane would likely fail the audit for structural reasons. The OB gather uses `max_tier=3` and the cost and shows-per-run figures are re-measured in Phase H. The $0.07/show floor below was measured on the narrow lane and is only a lower bound. [structure, Gemini-consistency]
- **No second cursor lane or cron.** Gather each cohort by direct chunked dispatch (about 4 shows per job, one run at a time, waited on), as the WE backfill did (`west-end-historical-backfill-v3.md:159`). The cursor lane exists to re-gather shows already in the catalog. If a lane is ever wanted, parameterize `historical-backfill-next.js` with `--list` and `--cursor` and run it as a second step of the same job so the existing concurrency group serializes it. This removes the starvation risk against the 06:37 slot. [design P1, GPT, structure]
- **No new spend tag.** Keep `historical-backfill`. The credit probe excludes only that exact string (`tests/unit/bro3887-cache-fix-acceptance.test.mjs:54`), so a `historical-backfill-ob` tag would count OB spend against the 5K/day ceiling. OB spend is identified by show id. `gatherPurposeForShow` only returns the tag for shows closed more than 90 days (`scripts/lib/spend-purpose.js:19-20`), so cohorts only include shows that closed 90 or more days ago, and the audit fails if lane-day ledger rows are untagged. [design P0, structure, pre-mortem]
- **New promoter, old one untouched.** Write `scripts/promote-historical-ob.js` mirroring `promote-historical-we.js` (`--season`, `--plan`, `--revert` from a promotion log). `promote-ob-historical.js` reads `venue-date-mismatches.json`, which a daily job rewrites in full and which defines the "currently provisional" set, so it cannot carry cohort state. The new promoter keeps its own per-cohort validation ledger. [structure, design P1]
- **Distinct source tag.** `discoverySource: ob-historical:<source>`. The existing promoter already writes `historical-backfill` there, so reusing it would make revert and audit select old rows. [design P0]
- **Refuse bad dates.** Promotion requires both an opening and a closing date from Playbill. The current-year id fallback (`promote-ob-historical.js:104`) is not copied. The audit date check fails closed when a bound is null. [pre-mortem]
- **Revert is end to end.** It removes the shows.json row, review-text files in the private repo, reviews.json rows after rebuild, playbill-urls cache entries and the promotion-log rows. Tested on a real Phase H show, not as a dry run. [structure]
- **Shared code.** Move the market-neutral parts of `we-historical-corroboration.js` (run length, closed check, record agreement) into a shared core. `decideObHistoricalPromotion` is thin. `auditSeason` takes a market predicate and a review-threshold parameter (3 for OB, 5 for WE) instead of being forked. Venue flagship list lives in `data/off-broadway-venues.json` as a flag, not a constant. [design P1/P2]
- **Free signals only at discovery.** The Press signal reads local `data/aggregator-archive` and precursors. Paid scraping stays in gather, so discovery is truly discovery-only. [design P1]
- **Seasons, not C0..C3.** Use `--season` in the repo's season convention. Award eligibility runs by season (roughly May to April), so the plan states the award-year mapping rule in Phase 0. C0 is split into 2024-25 and 2025-26 to date, and the latter stops at shows closed 90 or more days ago. [design P2, pre-mortem]
- **Recall test fixed.** `data/precursors/obie.json` is winners only and `drama-desk.json` covers only the 68th to 70th editions, so there is no local list for "90 percent of Obie nominees". Phase 0 measures recall against Lortel nominees, the 22 existing 2025 OB shows, and a hand-built 20-show list from the owner's own sense of notable shows. [structure]
- **Budget control is built, not assumed.** `check-provider-spend.js` is a daily billing reconciliation, with no per-show halt. Phase A adds a small cohort spend check (ledger rows for cohort ids against budget) that the audit and the dispatch step both call. The $1.50/show halt becomes a hard stop in that check. [structure]
- **Surface checklist (user-impact reviewer), each decided before the first promotion:**
  1. OB archive only lists closed shows with 5+ reviews (`scripts/lib/generate-market-archive.js:69`) but the display bar is 3. Decide: pass a per-show threshold for OB, or accept that 3 and 4 review shows are reachable by URL and sitemap only.
  2. Thin-page noindex fires only for closed shows with 0 reviews and only when `SEO_THIN_NOINDEX=1` (`scripts/lib/seo-indexability.js:28,64`). Verify the flag in the deploy environment. Pages exist during the 7-day gather window, so either promote in small chunks or confirm noindex covers under-threshold shows.
  3. `/off-broadway` ItemList grows by every closed show (`src/app/off-broadway/page.tsx:62`). Decide whether to cap it.
  4. Daily digest compares `mobile-shows.json` day to day, so hundreds of new closed shows will read as new. Baseline the digest on each promotion day and confirm the contamination flag does not fire on a re-gather.
  5. iOS app feed: confirm via `scripts/lib/markets.js:29` whether OB is shown, and decide whether historical shows appear there.
  6. Confirm the opening-night poller and orchestrator ignore closed shows (the broadcast already requires `status === 'open'`, `send-opening-night-broadcast.js:209`) and check `src/lib/recently-opened.ts`. Homepage, browse lists and RSS were checked and need open or previews status.
- **Scope L dropped.** Every reviewer called it wasteful. Options are S or M. Show-count estimates are labeled unknown until the Phase 0 spike produces real candidate lists, because the 2026 hit rate (104 of 312 with 8+ reviews) comes from a catalog that tracked those shows live.
- **Monitoring.** The audit outcome is posted as a comment on the Linear card. A cohort that has not advanced in 3 days alerts through the existing owner alert router.
- **Smaller first increment inside scope.** Ship season 2024-25 at scope S first and stop for an owner look before widening to M. That answers the do-less question from Phase 0.

## Goal

Give notable Off-Broadway productions that opened before the catalog existed a
Critic Score and a show page, walking backward one cohort at a time, with a hard
quality gate and spend ceiling per cohort. "Notable" is defined by rule (below),
not by hand-picking, so the list is reproducible and a cohort can be reverted.

## Where we are (measured 2026-10-24)

- shows.json holds 1,091 shows with `category: off-broadway` (opera, dance and
  specials included). The first OB research entries in `data/deep-research-cost-log.json`
  are dated 2026-03-26, which matches the March start.
- By opening year (non-opera OB): 2026 = 312 shows, 2025 = 22, 2024 = 12, 2023 = 7,
  2022 = 7, older = 14 (mostly one-off Signature "past productions"), 187 have no
  opening date (provisional stubs).
- Of the 312 OB shows opened in 2026: 163 have 3+ reviews, 129 have 5+, 104 have 8+,
  66 have 12+. Display threshold for OB is 3 (`MIN_REVIEWS_FOR_SCORE_OFF_BROADWAY`).
  Mean is about 11 reviews per scoreable show (1,773 reviews / 163).
- So the loose OB universe is about 200+ scoreable productions per year, and
  "every OB show" would mean 800+ shows for four years. About half of any
  indiscriminate promotion would never reach the display threshold.

## What already exists (reuse, do not rebuild)

| Piece | Where | Use |
|---|---|---|
| Daily CI backfill lane | `.github/workflows/historical-backfill.yml`, `scripts/historical-backfill-next.js`, `scripts/backfill-batches.json`, cursor `data/audit/historical-backfill-cursor.json` | Dispatches 24 shows/day to `gather-reviews.yml` with `spend_purpose=historical-backfill`. Cursor is at 202 of 1,182 older Broadway shows, so the Broadway list alone has about 41 days left. OB needs its own list and cursor or it queues behind that. |
| West End historical playbook | `docs/specs/west-end-historical-backfill-v3.md`, `scripts/discover-historical-shows-we.js`, `scripts/lib/we-historical-corroboration.js`, `scripts/promote-historical-we.js`, `scripts/audit-we-historical-season.js` | Same shape of problem, already shipped for 9 seasons (443 promotion-log rows). Source of the review-led promotion rule, the per-season audit gate and the cost anchor below. |
| OB promote path for closed shows | `scripts/promote-ob-historical.js` | Writes closed OB shows with Playbill-validated dates. Needs season/plan/revert support to match the WE promoter. |
| OB venue archive discovery | `scripts/discover-ob-historical.js` | Atlantic, Vineyard, MCC archives. Found only 9 candidates, so it is a supplement, not the main source. |
| Award precursors | `data/precursors/{lortel,obie,oba,drama-desk,outer-critics,drama-league,nydcc,pulitzer}.json` | Independent notability signal, free. |
| Aggregator archive | `data/aggregator-archive/{show-score,bww-roundups,playbill-verdict,dtli,nyc-theatre}` | Show Score alone has 248 OB-2026 and 39 OB-2022..2025 pages already archived. |

## Notability rule ("notable")

A dated OB production is promotable when it passes the exclusions and has at least
one signal. This mirrors `decideWeHistoricalPromotion()` (one review signal, not two
listings). The decision is a pure function in `scripts/lib/ob-historical-corroboration.js`
with the same `{promotable, persistent, reason}` shape, called by both discover and promote.

Signals (any one):
1. **Press**: 5 or more recoverable critic reviews across the aggregators and outlet
   SERP. Five, not three, because older coverage decays at gather time and the display
   bar is 3.
2. **Award**: nominee or winner in Lortel, Obie, Drama Desk, Outer Critics Circle,
   Drama League, NYDCC, OBA, or a Pulitzer drama winner. Needs 3 reviews to display.
3. **Transfer**: has a Broadway or West End counterpart in shows.json
   (`originalProductionId` / `transferOf`). Needs 3 reviews to display.
4. **Flagship venue**: Public, Lincoln Center Theater (Newhouse, Claire Tow),
   MTC (Stage I/II), Playwrights Horizons, Atlantic, Signature, NYTW, Vineyard, MCC,
   Second Stage OB, Roundabout (Laura Pels, Black Box), Classic Stage, Lortel, Soho Rep,
   St. Ann's Warehouse. Needs 3 reviews to display.

Exclusions: opera, dance, concerts, cabaret, stand-up, kids/family, festivals
(Fringe, FRIGID, NYMF), benefits and readings, runs under 14 days (`MIN_RUN_DAYS`
as in WE), off-off venues, productions with no verifiable opening date.

## Scope options and cohorts

Window is calendar-year cohorts walking backward. Post-COVID reopening (2022) is the
natural floor. Pre-2022 is a separate owner decision (WE did the same for pre-2016).

| Cohort | Window | Est. promoted (scope M) |
|---|---|---|
| C0 | Jan 2025 to Feb 2026 (14 months, 22+ already present) | 130 to 170 |
| C1 | 2024 | 90 to 120 |
| C2 | 2023 | 80 to 110 |
| C3 | 2022 | 70 to 100 |

Counts come from the 2026 hit rate (104 of 312 OB shows have 8+ reviews, about 156/yr)
discounted 15 to 30 percent for review decay in older years. They are estimates until the
Phase 0 spike produces real candidate lists.

| Scope | Rule | Shows (2022 to Feb 2026) |
|---|---|---|
| S | Award or flagship venue only | 150 to 200 |
| M (recommended) | S plus Press signal (5+ reviews) plus transfers | 370 to 500 |
| L | Everything with 3+ reviews | 800 to 1,000 |

## Cost model

Unit prices (from `scripts/config/provider-pricing.json`, `scripts/llm-scoring/cost.ts`
and the ledgers): ScrapingBee $0.000099/credit, Scrapingdog $0.00009/credit, Bright Data
$0.0015/request, LLM scoring $0.008 to $0.04 per review, deep research (o4-mini) $0.04 to
$0.09 per show.

Per-show components:

| Component | Per show | Basis |
|---|---|---|
| Scraping, floor | $0.07 | Measured: the live `historical-backfill` lane spent $4.78 / $1.60 / $1.49 on 52 / 22 / 24 shows on 2026-10-22..24 (ledger rows tagged `historical-backfill`, priced with the table above). That lane re-gathers shows that already have reviews. |
| Scraping, first-time deep gather | $0.20 to $0.45 | Assumption: 3 to 6 times the floor, because new shows need aggregator discovery, SERP and archive fallbacks. Pilot measures this. |
| LLM scoring | $0.11 to $0.44 | 11 reviews at $0.01 to $0.04. Upper end is the WE Sprint 4 actual ($0.04/review). Latest live run was $0.0084/review. |
| Deep research, synopsis, date and image checks | $0.10 to $0.15 | o4-mini log range plus Gemini calls (assumption for image/synopsis steps). |
| **Total** | **$0.45 to $1.05** | WE all-in precedent was $60 to $80 per ~95-show season = $0.63 to $0.84/show. |

Planning figure: **$0.80 per promoted show**, then 25 percent contingency for candidates
that are approved and gathered but never reach 3 reviews (target is 70 percent or more
reach threshold, as in the WE audit).

| Scope | Shows | Likely | Range | With contingency |
|---|---|---|---|---|
| S | 150 to 200 | $140 | $70 to $210 | about $175 |
| **M** | 370 to 500 | $350 | $170 to $525 | about $440 |
| L | 800 to 1,000 | $720 | $360 to $1,050 | about $900 |

Plus one-time discovery and spike cost, capped at $25 (Phase 0).

Cash versus prepaid: ScrapingBee ($99/1M credits) was at 384k of 1M credits and
Scrapingdog at 1.46M of 4.58M on 2026-10-23, so most of the scraping line spends credits
already paid for. True marginal cash is the LLM line plus Bright Data (pay as you go,
$1.50/1k). The backfill must run inside the Bright Data daily breaker (BRO-3009 / scraping
cost v3); the April 2026 $312 bill is the cautionary precedent.

Not included: Claude Code session cost. Past spend review says session context is the
dominant cost, so work is scripted and each cohort is capped at 2 interactive sessions.

## Time

Throughput is the binding limit. Gather takes about 24 shows/day per lane (2 gather slots,
about 25 shows per run before its time budget). At 24/day: S = 7 to 9 gather days,
M = 16 to 21 days, L = 33 to 42 days. Each cohort also needs a 7-day maturity wait before
its audit (same as WE), pipelined with the next cohort's discovery.

| Phase | Work | Calendar |
|---|---|---|
| 0 | Source spike, go/no-go | 2 days |
| A | Build corroboration lib, season discover, promote `--season/--revert`, OB lane, audit script; pilot 5 shows then C0 | 8 to 12 days |
| B to D | C1, C2, C3 (each: discover, owner-visible candidate counts, promote, gather, audit) | about 7 days each, overlapped |
| Total | Scope M | **about 6 to 8 weeks calendar**, about 8 to 12 hours of attended work after Phase A |
| | Scope S | about 4 weeks |
| | Scope L | about 12 to 14 weeks |

Dedicated OB lane runs 24/day. If it shares the Broadway cursor it waits about 41 days
before starting, so it gets its own cursor file and cron slot.

## Phases

### Phase 0: source spike (go/no-go, 2 days, at most $25)
Prove a dated discovery source exists per cohort. Test three on 2025: Show Score season
lists (archive already local), Playbill Verdict sitemap entries with an `-off-broadway`
slug, BWW Review Roundup index. Acceptance:
- Recall: finds at least 90 percent of 2025 Lortel/Obie/Drama Desk OB nominees and all 22
  existing 2025 OB shows.
- Each candidate has title, venue and a date good enough for the date guard
  (previews minus 35 days to close plus 7 days).
- Emits per-source candidate counts so scope S/M/L counts above can be replaced with real numbers.
If no source passes, stop and report. Do not guess dates from memory.

### Phase A: build and pilot C0
1. `ob-historical-corroboration.js` plus unit tests (real function required, per repo
   test-extraction rule).
2. `discover-historical-shows-ob.js --cohort=C0` writes
   `data/audit/ob-historical-candidates-<cohort>.json`. Discovery only.
3. `promote-ob-historical.js --cohort --plan --revert`. Every promoted show passes
   `validate-show-venue.js` against Playbill (repo rule 3). IDs use `-off-broadway-YYYY`.
   Status `closed`. Provisional/stub entries are never created.
4. OB lane: `scripts/backfill-batches-ob.json`, cursor `data/audit/ob-historical-backfill-cursor.json`,
   second cron slot in `historical-backfill.yml` (or a sibling workflow), `spend_purpose=historical-backfill-ob`.
5. `audit-ob-historical-season.js --cohort=C0`.
6. **Pilot of 5 shows first** (mix: one award, one flagship, one press-only, one transfer,
   one same-title revival as the wrong-production trap). Measure real scraping and LLM cost
   per show from the ledger and replace the planning figure.
7. Then run the rest of C0 at 24/day.

### Phases B, C, D: C1 (2024), C2 (2023), C3 (2022)
Same loop. Do not start a cohort until the previous audit passes.

### Phase E (owner decision, not planned): 2019 to 2021 and pre-2019.

## Cohort audit (the gate, with a command)

`node scripts/audit-ob-historical-season.js --cohort=C0`, read-only, run 7 days after the
last gather. Fail any check and the next cohort does not start:
- 70 percent or more of promoted shows reach 3 reviews.
- Zero shows with a review dated outside [previews minus 35 days, close plus 7 days]
  (wrong-production check; same-title revival pairs spot-checked).
- No duplicate outlet+critic per show.
- No promoted show has `status != closed`, a null opening date, or a missing Playbill match.
- Spend tagged `historical-backfill-ob` is within the cohort budget.
- Revert path tested: `promote-ob-historical.js --revert --cohort=C0 --dry-run` lists exactly the promoted ids.

## Safety checks specific to this change

- **No broadcasts.** Verify `send-opening-night-broadcast.js` and the opening-night
  poller ignore closed historical shows (dry run with `--send-to` only, never a broadcast).
- **No polling cost.** Historical shows must be outside orchestrator/CRITICAL_CRONS windows.
- **Browse and home surfaces** must not present 2022 shows as new. Check the OB shelf
  logic for opening-date or "recently closed" sorts before promotion. If a UI change is
  needed it triggers the `/visual-qa` gate; none is planned.
- **Thin pages.** Because promotion requires a review signal, no promoted show should
  render below the display threshold for long. Audit counts any that do.
- **Budget stops.** Lane halts when rolling per-show cost exceeds $1.50 or the cohort
  exceeds 1.5 times its budget. Uses the existing provider-spend check.
- **Prompt/scoring logic is unchanged**, so the scoring A/B and `scoring-delta` gates do not apply.
  If a scoring-watchlist edit becomes necessary, those gates apply and this plan is re-reviewed.

## Decisions for the owner

1. Scope: S, M (recommended) or L.
2. Floor year: 2022 (recommended) or stop at 2024.
3. Budget ceiling: recommended $450 for M with contingency, stop-and-ask above it.

## Known unknowns

- Whether any free, dated OB listing source exists for 2022 and 2023 (Phase 0 answers it).
- Recoverable review count for older shows (outlet archives purge; SERP indexing degrades).
  Audit threshold of 70 percent is the tripwire.
- First-time deep-gather scraping cost is an assumption until the 5-show pilot runs.
- The loose definition of "Off-Broadway": the rule above is the proposal, and the flagship
  venue list is the part most likely to need owner edits.

## Phase H results (2026-10-24, BRO-6153)

Two award-nominated 2024-25 shows were added by hand through an `add-show` fix plan and gathered with `max_tier=3`, `spend_purpose=historical-backfill` (run 40123511753).

| Show | Venue | Reviews after rebuild | Scraping cost (ledger, priced) |
|---|---|---|---|
| Hold On to Me Darling (Lortel, OBA) | Lucille Lortel Theatre, Oct 2024 | 11 scored (NYT, Guardian, EW, Deadline, Vogue, TheWrap, Time Out, The Stage, NYSR, NYTG, nyt-theater) | $0.040 |
| Sumo (Lortel Outstanding Play) | Public Theater, Feb to Mar 2025 | 2 (Culture Sauce, Time Out) | $0.055 |

What it changed:
- **Scraping is a small cost.** $0.04 to $0.055 per show at `max_tier=3`, against the $0.20 to $0.45 assumed. About 70 to 110 Scrapingdog SERP calls per show carry nearly all of it, and Bright Data was touched 1 to 2 times (one capped). The per-show estimate is now dominated by LLM scoring, which this run did not measure (`llm-scoring-runs.json` keeps only the last 100 runs).
- **An award does not guarantee reviews.** A Lortel Outstanding Play nominee yielded 2 reviews, below the OB display bar of 3. So the Award signal alone cannot promote a show. Promote when press coverage is also found, or accept that some award shows stay unscored. The audit's 70 percent target needs a measured denominator from the full season.
- **Title matching is too loose.** A title lookup against shows.json "found" Ghosts, Vanya, Orlando and Home, which are different productions. Dedup in the promotion step compares venue and year, as the plan says.
- **Mechanics.** The cloud session has no scraper keys, so Playbill validation runs through `cloud-run-script.js` against a candidates file that must be on main. Core data changes go in as `add-show` fix plans, which refuse existing ids and placeholder venues. So `promote-historical-ob.js` becomes a generator that writes those plans (and `retire-show` plans for revert). A land takes 20 to 35 minutes when the queue is busy, so each cohort is batched into few lands. Never `git reset --soft` onto a moved `origin/main` in a worktree: it silently reverts other sessions' commits (it clobbered `we-historical-tr-probe.json` once, since restored).

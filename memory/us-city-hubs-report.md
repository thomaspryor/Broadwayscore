# US city hubs: Chicago, Washington DC and Los Angeles

BRO-6498. Research refreshed **2026-11-01** against checkout `c19b39c4461`, which also matched the local `origin/main` reference. This is a research deliverable, not a launch or backfill completion certificate. Inventory counts below describe the supplied data snapshot; external pages were checked through web research and can change during a day.

## Recommendation and the owner's decision

Proceed with **Chicago first, using a city layer over regional productions and tour stops**. Keep `market` and `category` as `regional` or `tour`; use `city: 'chicago-il'` for local productions and the shared venue-to-metro table for geography. Reuse `/tours/chicago-il` and the existing score and card components. A tour remains one production with multiple engagements, not one new production per city.

The owner's 2026-10-29 answer on this card supersedes its original three-city proposal:

- Chicago only initially. The approved historical scope is **2021 to now**, with **$250-450 one-time scoring spend and a $450 hard cap** under BRO-6518. Prioritize current inventory and the latest 12-24 months before filling older gaps.
- DC and then LA remain conditional on Chicago demonstrating app demand. Measure for **60 days after actual launch**, not after this report or a code merge.
- Share the hub model with BRO-6500. A production needs at least **3 qualifying reviews, or 5 when all are T3**. A hub needs **at least 12 scoreable productions per year in each of two seasons**, plus **at least one regular T2 outlet or at least 40 scoreable productions per year**. These are the recorded product gates, not findings established by raw inventory counts.

Chicago has enough demonstrated supply to justify completing and measuring the existing work. DC has viable sources but thinner current review coverage. LA has substantial touring activity, but local review density and the LA/Orange County boundary need validation before a full hub commitment. Do not create three new market values or launch three new acquisition pipelines at once.

## What is already implemented

The October 29 comment described a proposal. This checkout contains significant subsequent work:

| Area | Evidence in this checkout | Implication |
| --- | --- | --- |
| Shared geography | `data/venue-metros.json`; `scripts/lib/venue-metro.js:resolveMetro()` | Chicago, DC and LA metros and suburban aliases exist. Extend this table rather than creating city-specific copies. |
| Regional writer | `scripts/promote-ob-venue-candidates.js:buildRegionalShowEntry()` calls `resolveMetro(venue)`; `scripts/backfill-show-city.js` handles existing rows | Geography belongs in the creation/backfill path. Do not patch display labels to conceal missing city fields. |
| Chicago hub | `src/lib/city-hub.ts:HUB_CITIES`, `src/lib/data-city-hub.ts:getCityHubShows()`, `src/app/tours/[city]/page.tsx` | Chicago is the only enabled hub definition. Sections for current, upcoming, recently closed and archive already exist. |
| Tour inventory | `scripts/fetch-tour-schedules.js` writes `data/tour-schedules.json`; `src/lib/data-tour-cities.ts` reads it | Preserve this writer and the tour identity model. Existing tour pages group literal stop cities, not the broader metro aggregation used in this report. |
| Chicago ingestion | `scripts/theatreinchicago-crawl.js`, `scripts/lib/theatreinchicago.js`, `scripts/lib/tic-stage.js`, `scripts/tic-daily.js` | Reader, archive index, staging and daily pickup exist. The Chicago-specific staging writer sets `localOnly: true` and `city: 'chicago-il'`. |
| Scheduled caller | `.github/workflows/scrape-new-aggregators.yml:287,319` calls daily pickup, then dispatches ingest after the core-data push | A new daily job is unnecessary. Verify successful additions and scoring, because these steps are advisory. The schedule is daily at 14:00 UTC. |
| Review geography | `src/lib/outlet-metro.ts`, used by the tour city page | Outlet locality is available. It is only a locality hint; the production, venue and engagement date still determine whether a review covers this stop. |
| Ticket matching | `scripts/lib/todaytix-tour-tickets.js:TOUR_LOCATIONS`, consumed by `scripts/fetch-tour-tickets.js` | Chicago 3, LA 5 and DC 6 are already configured. Additional cities do not inherently require another ticket fetcher. |

There are already **753 Chicago `localOnly` records**, within 760 Chicago regional records. The old figure of seven Chicago records is obsolete. The earlier comment's iOS NYC/London picker observation came from a separate app repository; that repository was not inspected here. Verify its present picker and city persistence before budgeting new app work. Code and imported records do not establish production deployment, complete backfill, or app adoption.

## Inventory measured from real data

### Definitions and geographic scope

Use **2026-11-01** as the as-of date. Current tour stops satisfy `start <= asOf <= end`. Future means a start after that date, with no upper bound. Historical columns count engagements or productions whose known closing date is **on or after 2025-11-01 / 2024-11-01 and before 2026-11-01**. Thus current and future runs are excluded from the historical counts. The 12-month column is a subset of the 24-month column. These are closing-date cohorts, not complete counts of every production that overlapped a period.

For regional records, select `category === 'regional'` and the stored `city`, falling back to the real `resolveMetro(venue)` helper. All 766 regional records selected for these three metros already carry a stored city; the fallback adds none. For tours, resolve the combination of the stop's **venue and explicit city fields**. No metadata is inferred from URLs. Regional current/archive sections were also checked with the actual `sectionHubShows()` implementation.

The shared table includes Chicago suburbs such as Evanston, Skokie and Aurora; DC includes Arlington, Bethesda, Olney, Alexandria and Silver Spring; LA includes Pasadena, Costa Mesa, Laguna Beach and Thousand Oaks. Baltimore is not silently included in DC, and San Diego is not LA. Chicago's existing ingestion writer also tags its wider Chicagoland catchment, including some northwest Indiana venues. Audit those boundaries against the shared table before extending ingestion elsewhere.

### Tours: engagements, not unique productions

Source: `data/tour-schedules.json`, **68 tours / 4,154 stop rows**. Per-tour `updatedAt` values range from 2026-10-04 to 2026-10-29, so treat these as cached schedules requiring venue confirmation before launch.

| Metro | Current stops | Future stops | Closed in last 12 months | Closed in last 24 months | All stored stops, all dates |
| --- | ---: | ---: | ---: | ---: | ---: |
| Chicago area | 1 | 15 | 20 | 34 | 66 |
| Washington DC area | 1 | 10 | 14 | 25 | 47 |
| LA area, including mapped OC/suburbs | 3 | 24 | 29 | 47 | 92 |

For comparison with the existing literal-city tour pages: Chicago itself has **1 current / 14 future / 19 last-12-month / 33 last-24-month** stops; Washington is unchanged; Los Angeles itself has **2 / 12 / 16 / 26**. Metro totals must not be described as the counts currently rendered at `/tours/los-angeles-ca`.

The old card counts used `end >= 2024-10-29` without an upper bound, so they combined history with future bookings. That reproduces **48 Chicago city stops and 36 DC stops** here. It gives **74 LA-area stops under today's shared table**, not the prior 64. The earlier LA boundary was not documented sufficiently to reconcile exactly; do not reuse 64 as a measured historical total.

### Regional and local productions already imported

Source: `data/shows.json`, **5,744 total shows / 1,122 regional shows**.

| Metro | All stored regional records | Current | Upcoming | Closed in last 12 months | Closed in last 24 months |
| --- | ---: | ---: | ---: | ---: | ---: |
| Chicago | 760 | 18 | 0 | 162 | 319 |
| DC | 4 | 0 | 0 | 3 | 3 |
| LA | 2 | 0 | 0 | 2 | 2 |

Chicago opening-year counts are 32 in 2021, 135 in 2022, 147 in 2023, 148 in 2024, 159 in 2025 and 139 in 2026. Some imported dates are explicitly `tic-first-review` proxies, not verified opening nights. One Chicago record has no closing date and is omitted from the closing-date cohorts. Zero upcoming regional records indicates the limits of this imported inventory, not an absence of announced productions.

`data/reviews.json` contains **4,391 / 29 / 12 review rows** for Chicago / DC / LA regional records. **602 / 4 / 2** records have at least three review rows. These are diagnostic row counts, not certified scoreable totals: deduplication, production identity, inclusion flags and the T3-only gate still apply. No critic-score averages were calculated for this report.

Three actual examples exercised through the existing geography and sectioning helpers:

| Record | Venue | Resolved city | Section on 2026-11-01 |
| --- | --- | --- | --- |
| `topdog-underdog-regional-2026` | Steppenwolf Theatre Company, Chicago, IL | `chicago-il` | Now playing |
| `the-score-regional-2026` | Shakespeare Theatre Company (Harman Hall), Washington, DC | `washington-dc` | Recently closed |
| `the-visit-regional-2026` | Pasadena Playhouse, Pasadena, CA | `los-angeles-ca` | Recently closed |

Do not simply add regional records to tour stops and call the result unique shows. A tour can return, a title can have several local productions, and sources can list the same engagement twice. Match production, venue and dates before joining inventories.

## External supply and historical estimates

### Current source observations

| Source | Observation on this research date | Interpretation |
| --- | --- | --- |
| [Theatre In Chicago review roundup](https://www.theatreinchicago.com/reviewlistings.php) | Header reports 44 currently playing reviewed shows and 307 reviews; 23 publications in its source list | Strong current review supply. Includes tours and categories outside our local scripted-theatre scope. |
| [Theatre In DC review roundup](https://www.theatreindc.com/reviewlistings.php) | Returned 20 shows / 62 reviews initially and 19 / 61 on a subsequent read; source list names 23 publications | Use a 19-20 snapshot range. The catchment includes Baltimore and Columbia, so it is wider than the proposed DC metro. |
| [Theatre In LA review roundup](https://www.theatreinla.com/reviewlistings.php) | 12 shows / 26 reviews; only 3 listed productions have at least 3 reviews | The site's claim of over 100 publications is not evidence that 100 outlets are currently active. Current review depth is the constraint. |

DC's inspected list has ten shows with at least three reviews; removing the explicitly Baltimore/Columbia examples leaves eight preliminary candidates. LA's three are Kaiju, Rorschach and Wives. Neither count establishes score eligibility after tier and content checks. All three sites link individual critics' reviews and expose verdicts; those verdicts are cross-checks, not replacements for our score pipeline.

### Chicago: measured archive, not a speculative crawl size

The existing `data/theatreinchicago-index.json` was updated **2026-10-31T14:18:18.341Z** and contains **1,536 source entries**, four without closing dates. It includes tours, excluded genres and other records that will never become regional shows.

| Closed-date window ending 2026-10-31 | Indexed entries | At least 3 distinct named outlets | Pass the actual `tic-stage.prefilter()` |
| --- | ---: | ---: | ---: |
| Last 12 months | 303 | 236 | 217 |
| Last 24 months | 593 | 453 | 415 |
| 2021-01-01 onward | 1,457 | 1,085 | 969 |

The prefilter additionally requires linked reviews and excludes virtual and touring-house entries. It does not complete genre filtering, date verification, deduplication, content recovery or score eligibility. **217 / 415 are candidate inventories, not promised additional imports**, and overlap the 162 / 319 already imported in those windows. The initial-filter examples were The Fantasticks at Citadel Theatre Company (accepted), Paradise Square at Nederlander Theatre (tour-house rejection), and PickleRickicles at Otherworld Theatre (under-three-outlets rejection).

As an archive spot-check, [Little Bear Ridge Road at Steppenwolf](https://www.theatreinchicago.com/little-bear-ridge-road/12391/) exposes a closing date of August 4, 2024 and 21 reviews. This establishes accessible dated archive material, not completeness of every season. The old estimate of roughly 600 Chicago shows with three reviews since 2024 is broadly consistent with **621 indexed entries with three distinct outlets closing from 2024-01-01 through 2026-10-31**, but those still include out-of-scope entries.

### DC and LA: planning ranges pending a census

| City | Current reviewed source supply | 12-month planning range | 24-month planning range | Confidence |
| --- | --- | --- | --- | --- |
| Chicago | 44 source listings; 18 local records currently open in our snapshot | 217 initial-filter archive candidates measured | 415 initial-filter archive candidates measured | High for these snapshot counts; final eligibility still unmeasured |
| DC | 19-20 source listings; about 8 with three reviews after obvious geography exclusions | About 40-70 three-review candidates | About 80-140 three-review candidates | Low, a sizing scenario rather than an enumerated archive |
| LA | 12 source listings; 3 with three reviews | About 15-30 three-review candidates | About 30-60 three-review candidates | Low; autumn snapshot may understate stronger historical coverage |

The DC/LA ranges assume a typical reviewed run occupies **6-10 weeks** and the observed eligible-looking stock turns over throughout the year: `8 * 52 / (10 to 6)` gives roughly 42-69 DC candidates, and `3 * 52 / (10 to 6)` gives roughly 16-26 LA candidates. Rounded ranges allow some seasonality; doubling is only a two-year workload scenario. This is not a statistical forecast or a claim about all theatre produced. Long runs, repeated titles, excluded types, weaker outlets and inaccessible articles reduce the result; venues missing from the aggregator can increase it. Validate with a dated census before funding either expansion. The earlier card's DC ~260 and LA ~340 since-2024 estimates were not accompanied by a reproducible enumeration and are not adopted as verified totals.

Independent date and discovery sources improve that census:

- [Theatre Washington's production history](https://www.theatrewashington.org/past-shows) describes Helen Hayes-eligible productions since late 2011 and currently reports 3,851 entries across the whole archive. It supplies titles, theatres and date ranges, not critic-score eligibility. Cross-match the selected seasons, not the all-time total.
- [At the Wedding at Studio Theatre](https://www.theatreindc.com/at-the-wedding/4362/) has an explicit April 21, 2024 closing date and seven reviews. It demonstrates recoverable DC history, including older Washington Post coverage.
- [Back to the Future at the Pantages](https://www.theatreinla.com/back-to-the-future-the-musical/reviews/10508/) has an explicit December 1, 2024 closing date and seven reviews. This is a tour engagement to enrich, not a new LA regional production. [Into the Woods at Greenway Court](https://www.theatreinla.com/into-the-woods/10582/) supplies a local-production example with three reviews and an August 11, 2024 closing date.

DC's historical review supply should not be projected unchanged into future seasons: [American Theatre's March 5, 2026 reporting](https://www.americantheatre.org/2026/03/05/what-will-d-c-theatres-do-without-a-full-time-critic-at-the-post/) documents the loss of the Washington Post's full-time theatre critic in February. Test current regular T2 coverage rather than counting archived Post reviews toward a current outlet-health claim.

## Competitor approaches and lessons

| Competitor | Observed multi-city approach | What to adopt or avoid |
| --- | --- | --- |
| Show-Score | Separate [Chicago](https://www.show-score.com/us/chicago), [DC](https://www.show-score.com/us/dc), and [LA/OC](https://www.show-score.com/us/la) pages, with local category navigation and audience reviews. The rendered pages showed one unique production each in Chicago and DC, both Drunk Shakespeare, and no production cards on LA/OC. Chicago repeats the same title in two sections. | City URLs and local context are useful. A shell page does not establish depth. These are visible landing-page counts, not a claim about the entire database or business performance. Its sitewide counters are not city inventory. |
| TodayTix | One transactional platform with location selection, date/price/category filters, local venues, deals and Rush/Lottery. Checked [Chicago](https://www.todaytix.com/?location=chicago), [DC](https://www.todaytix.com/?location=washington-dc), and [LA + OC](https://www.todaytix.com/?location=los-angeles). LA combines city and OC; DC uses a DMV catchment. | Keep a persistent location preference and explicit metro boundaries. Ticket inventory is useful for availability, but is neither a complete historical catalogue nor evidence of independent critic coverage. Retain closed productions independently of ticket availability. |
| Theatre Limelight city sites | Parallel Theatre In Chicago/DC/LA sites with current listings, review roundups, top-rated lists and retained production pages. The shared presentation exposes source links and review verdicts. | Strong discovery inputs and evidence that a common city template works. Reuse parsers only after checking each site's current and historical HTML shapes. Preserve source attribution and recover the underlying articles separately. |
| BroadwayWorld | Shared navigation across many regional editions, with local listings, editorial coverage and reviews; checked [Chicago](https://www.broadwayworld.com/chicago/) and [DC](https://www.broadwayworld.com/washington-dc/). Baltimore is a separate regional navigation entry. | Reuse regional discovery and clear geographic navigation. Distinguish editorial reviews from announcements and submitted listings; do not count every item as a review. |

The opportunity is a consistent critic-score archive across local productions and tours, with clear dates and geography. These observations describe present product surfaces; they do not establish competitors' launch chronology, retention or revenue.

Today's [TodayTix terms, Certain Restrictions](https://www.todaytix.com/us/terms) restrict automated scraping and competitive reuse. Treat partnership/authorized access as a dependency before expanding that integration. The older card's MCP claim was not reverified: the `llms.txt` URL was inaccessible through the research tool, and the existence of an endpoint would not establish data-reuse permission. No ticket API calls or scraping expansion were performed for this report.

## Data methodology and remaining implementation work

1. **List productions first.** Start from existing Chicago records/index and current Theatre In Chicago listings, then venue season pages. For DC use Theatre Washington plus Theatre In DC; for LA use Theatre In LA plus the named venue seasons. Record source URL, retrieved date, title, venue, explicit run dates and production type. Use source text/structured metadata, never URL slugs or numeric ID ranges as dates.
2. **Resolve geography once.** Use `data/venue-metros.json` for canonical metro boundaries; inspect unmatched or conflicting venues before inclusion. Preserve venue/locality labels so a suburban visit is clear. Review the Chicago-specific writer's wider catchment against the table before generalizing it. Keep market gates intact and local-only productions off the pre-Broadway shelf.
3. **Match productions and tours.** Dedupe by title plus venue/run, with explicit transfer and revival relationships. Attach a Chicago review of a tour to its engagement provenance; an outlet's metro alone cannot prove where its critic saw the show. Keep touring and independent local versions of the same title distinct.
4. **Recover and score incrementally.** Reuse `scripts/lib/theatreinchicago.js`, `tic-stage.js` and the existing ingestion pipeline. Run five diverse cases first, retain full text only in the private store, and use cached successful fetches. Do not rerun paid scoring merely because a hub is added. Follow the shared review-inclusion and minimum-review helpers. Any published Critic Score must come through `getCriticScore()` in `scripts/lib/canonical-critic-scores.ts`.
5. **Validate historical coverage.** Reconcile source candidates to accepted, existing, excluded, failed and pending records for each season. Check late-2024 and 2025 separately before extending to 2021-2023. Verify the two-season hub bar using final eligible productions and outlet tiers. Sparse pandemic-era 2021 supply does not alone demonstrate missing data.
6. **Verify the user-facing path.** Reuse the existing Chicago hub and archive; check regional/tour flags, mobile feed city fields and app location persistence. The current helper shows at most 12 recent closed productions and sends the rest to the archive. Verify users can actually reach the full requested 24-month history. Use shared show cards, tokens and fixed-size score badges for any subsequent UI work.
7. **Measure and maintain.** Monitor the existing daily pickup through added records, successful ingest and usable scores, rather than workflow success alone. Detect source count drops, aging current listings, unresolved venues and ingest backlog. Never let a quiet advisory step look like proof of freshness.

### Proposed timeline from the current state

These are remaining effort estimates for the implementation cards, not claims that work was performed by this research card. No new owner approval is needed to restate the already approved Chicago scope.

| Phase | Timing from implementation restart | Work and exit condition | Ownership/scope |
| --- | --- | --- | --- |
| 0. Reconcile existing work | Days 1-2 | Check what BRO-6517/6518 actually shipped, city-field coverage, spend already consumed, current source completeness and app state. Produce a gap list against the 760 imported Chicago records. | Existing Chicago child work; no new crawl yet |
| 1. Validate current Chicago | Days 3-5 | Resolve current listing gaps, confirm tour/local separation, verify hub/feed/app behavior and analytics. Establish the scoreable two-season baseline. | BRO-6517 and BRO-6518 |
| 2. Complete priority history | Weeks 2-3 | Fill approved gaps from the latest 12 months, then 24 months, then 2021 onward. Run recovery in bounded batches with spend accounting; reconcile every accepted/rejected/pending source entry. | BRO-6518, within remaining $450 cap |
| 3. Launch and observe | Launch once gates pass; observe 60 days | Confirm production and app availability, monitor daily freshness and instrument city discovery, show detail, saves/diary and ticket click-through. No automatic DC/LA activation. | Chicago app/web work |
| 4. DC only if demand supports it | After 60-day review; roughly 2-3 additional weeks | Census two seasons, validate regular T2 or 40/year alternative, then adapt ingestion and the shared hub. Separate budget and explicit owner decision before spending. | Deferred |
| 5. LA after DC evidence | Following DC validation; roughly 3-4 additional weeks | Confirm LA/OC boundaries, tour dedupe and local review sufficiency; census then import and launch in stages. | Deferred |

For the 60-day review, report city-selected active users, weekly return rate, detail views, saves/diary entries and ticket clicks with denominators. Exclude staff, test traffic and bots, and compare cohorts with similar acquisition sources. A suggested decision rule is sustained repeat usage plus meaningful local-show engagement over the last four weeks, rather than a one-off launch spike. The owner approved measurement, not a numerical demand threshold; choose that threshold before interpreting results. If sample size is too small, continue Chicago measurement and keep DC/LA deferred.

## Cost and operational limits

**This change adds zero runtime paid fetches, zero scoring/LLM API calls, zero product API calls and no cron.** Research used public web search/pages and local read-only analysis. No Bright Data, ScrapingBee or Browserbase calls, scoring runs or workflow dispatches were initiated.

The prior card's **$0.038 per scored review** is a planning assumption, not a newly verified vendor price. At that assumption, 6,000-10,000 reviews cost about **$228-380** before retrieval, retries and other processing. The cached 2021-onward index contains 9,082 review links across all its closed entries, including excluded productions and already imported reviews; scoring every link once would be about **$345**, not the remaining bill. A naive repeat of already processed work can exhaust the approved cap. Reconcile actual spend and reuse valid scores before estimating remaining work. The authorization is not renewed by this report.

For the existing daily path, let `N <= 15` be candidate productions evaluated and `R` the new review URLs eventually ingested. `scripts/tic-daily.js` requests one listing page; each candidate may require one review page, one detail page and up to three article fetches to establish dates (`scripts/tic-stage-shows.js:openingDateFor`). That is **up to `1 + 5N`, or 76 logical page fetches**, before ingesting up to `R` review articles and any retries/provider fallback. Early rejection and caching reduce this; provider attempts and credits can exceed logical fetches. One workflow dispatch is attempted per added show, with deferred items retried on later runs. Scoring calls depend on unscored reviews and the enabled model ensemble; reserve approximately `models * unscored reviews`, then account separately for retries and ancillary processing. The daily cron already exists; this report changes none of its limits.

An ongoing Chicago budget must be tracked separately from the one-time backfill cap. For illustration, 150-220 accepted productions/year at 5-8 reviews each implies 750-1,760 reviews/year, about **$29-67/year in scoring alone** at the historical unit assumption. This excludes fetch costs, failed recoveries, compute and maintenance. It is a workload scenario, not authorization for extra spend. DC/LA have no new spending approval in this report.

## Reproduction and verification

The original acceptance check, `test -f memory/us-city-hubs-report.md`, exited **1** before this change. `git ls-tree origin/main memory/us-city-hubs-report.md` returned no entry. A path-scoped `git -c remote.origin.promisor=false log -S 'us-city-hubs-report' --oneline -5 -- memory/us-city-hubs-report.md` returned no commits. The report was missing on the checked main reference even though implementation code was present. The initial unscoped history search encountered unavailable partial-clone objects; it was not needed to establish the current tree's missing path.

Run this read-only inventory reproduction from the repository root with the supplied data. It calls the real geography and staging helpers, does not fetch pages and writes no files:

```sh
node - <<'NODE'
const { resolveMetro } = require('./scripts/lib/venue-metro');
const { prefilter } = require('./scripts/lib/tic-stage');
const shows = require('./data/shows.json').shows;
const tours = require('./data/tour-schedules.json').tours;
const index = Object.values(require('./data/theatreinchicago-index.json').shows);
const today = '2026-11-01';
const stops = Object.values(tours).flatMap(t => t.stops);
const history = (rows, key, since) => rows.filter(r => r[key] >= since && r[key] < today).length;
for (const city of ['chicago-il', 'washington-dc', 'los-angeles-ca']) {
  const local = shows.filter(s => s.category === 'regional' && (s.city || resolveMetro(s.venue)) === city);
  const tour = stops.filter(s => resolveMetro(`${s.venue}, ${s.city}`) === city);
  console.log(city, JSON.stringify({
    regional: local.length,
    regional12: history(local, 'closingDate', '2025-11-01'),
    regional24: history(local, 'closingDate', '2024-11-01'),
    tourNow: tour.filter(s => s.start <= today && s.end >= today).length,
    tourFuture: tour.filter(s => s.start > today).length,
    tour12: history(tour, 'end', '2025-11-01'),
    tour24: history(tour, 'end', '2024-11-01')
  }));
}
for (const since of ['2021-01-01', '2024-11-01', '2025-11-01']) {
  const rows = index.filter(s => s.c >= since && s.c < today);
  const candidates = rows.filter(s => prefilter({
    title: s.t, venue: s.v,
    reviews: s.r.map(r => ({ outlet: r.o, url: r.u }))
  }).ok);
  console.log(since, 'indexed', rows.length, 'prefilter', candidates.length);
}
NODE
```

Expected regional totals: **760 / 4 / 2**. Expected tour current/future/12-month/24-month counts: **1/15/20/34**, **1/10/14/25**, **3/24/29/47**. Expected index/prefilter pairs in the printed window order: **1457/969**, **593/415**, **303/217**. These are snapshot assertions, not fixed expectations for future live data.

The documented command ran successfully. A separate before/after probe called the actual `resolveMetro()` and `sectionHubShows()` helpers for all three cities and compared SHA-256 hashes of `shows.json`, `reviews.json`, `tour-schedules.json`, `venue-metros.json` and `theatreinchicago-index.json`: identical results and hashes, **zero data records changed**. The acceptance command passes after creating this report. No TypeScript or test files were edited.

`git diff --check` passed. The requested `GAUNTLET_GATES=lint-workflows bash scripts/lib/land-gauntlet.sh /tmp/gauntlet` completed its checks, but its log directory disappeared during the run. A repeat using `.bro-6498-gauntlet` retained a readable log: the only failed subcheck was `actionlint` with exit 127 (`command not found`), allowed as a missing-tool exception in the worker instructions. All other workflow audit subchecks passed. Temporary checkout logs were removed afterward.

The report is the only substantive deliverable. `.gitignore` has a single-file exception so the runner can include this exact path while all other untracked memory files remain ignored. No code, core-data records, review texts or workflows are changed. Follow-on implementation, production verification, the remaining authorized Chicago backfill and the 60-day demand decision belong to the existing implementation work; none is represented here as complete.

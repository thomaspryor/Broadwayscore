# BRO-6537: collector backfill outlet yield, 2026-11-14

Outlet attribution is already implemented on main. This audit measures the
remaining yield question without changing collection or pruning behavior.
The sample is too narrow to choose a collector-wide T1/T2 pruning threshold.

The checkout's scraper spend ledger contains 203 collect-outlet-reviews.js
SERP rows with purpose historical-backfill, all with outletId, dated
2026-11-11 through 2026-11-13. There are no bro-6453-we-historical collector
rows in this snapshot. Its overall timestamp range is
2026-11-11T00:00:00.354Z through 2026-11-14T00:48:21.237Z.
This is a retained snapshot, not the full history since attribution landed.

| Show | Workflow run | SERP rows | Outlet searches | FOUND outcomes |
| --- | --- | ---: | ---: | ---: |
| on-the-town-1998 | [43040861189](https://github.com/thomaspryor/Broadwayscore/actions/runs/43040861189) | 43 | 29 | 2 |
| the-skin-of-our-teeth-1975 | [43054411397](https://github.com/thomaspryor/Broadwayscore/actions/runs/43054411397) | 46 | 29 | 1 |
| uncle-vanya-1973 | [43249163586](https://github.com/thomaspryor/Broadwayscore/actions/runs/43249163586) | 42 | 29 | 1 |
| job-2024 | [43446909980](https://github.com/thomaspryor/Broadwayscore/actions/runs/43446909980) | 28 | 28 | 0 |
| the-lady-from-the-sea-1976 | [43461563406](https://github.com/thomaspryor/Broadwayscore/actions/runs/43461563406) | 44 | 29 | 0 |
| Total | | 203 | 144 | 4 |

All five shows are Broadway according to shows.json. This includes four older
productions and one 2024 production. There are no London or Off-Broadway
observations in this backfill sample.

The table below counts a hit once per outlet search when the collector prints
FOUND. It does not assert that the URL passed later validation, was written,
or belongs to the correct production. Provider success=true is not a hit.
Repeated SERP queries for one outlet search increase the row count, not the
search or hit count. Overall discovery yield is 4/144 searches (2.8%).

| Outlet ID | Outlet searches | SERP rows | FOUND outcomes | Hits/searches |
| --- | ---: | ---: | ---: | ---: |
| 4columns | 1 | 1 | 0 | 0.0% |
| ap | 4 | 6 | 0 | 0.0% |
| backstage | 1 | 1 | 0 | 0.0% |
| baltimoresun | 1 | 1 | 0 | 0.0% |
| bloomberg | 1 | 1 | 0 | 0.0% |
| broadway-blog | 1 | 1 | 0 | 0.0% |
| broadwaynews | 4 | 6 | 1 | 25.0% |
| broadwayworld | 1 | 1 | 0 | 0.0% |
| cbsnews | 1 | 1 | 0 | 0.0% |
| chicago-sun-times | 1 | 1 | 0 | 0.0% |
| chicagotribune | 5 | 7 | 0 | 0.0% |
| cititour | 4 | 8 | 0 | 0.0% |
| curtainup | 1 | 1 | 0 | 0.0% |
| daily-mail | 5 | 6 | 0 | 0.0% |
| dailybeast | 1 | 1 | 0 | 0.0% |
| dctheatrescene | 1 | 1 | 0 | 0.0% |
| deadline | 5 | 7 | 0 | 0.0% |
| ew | 1 | 1 | 0 | 0.0% |
| exeunt-magazine | 1 | 1 | 0 | 0.0% |
| financialtimes | 5 | 8 | 0 | 0.0% |
| guardian | 4 | 5 | 0 | 0.0% |
| hollywood-reporter | 5 | 7 | 0 | 0.0% |
| huffpost | 1 | 1 | 0 | 0.0% |
| independent | 5 | 6 | 0 | 0.0% |
| latimes | 5 | 7 | 0 | 0.0% |
| newsday | 4 | 7 | 0 | 0.0% |
| newyorker | 5 | 5 | 0 | 0.0% |
| nypost | 4 | 5 | 0 | 0.0% |
| nysr | 4 | 7 | 0 | 0.0% |
| nyt-theater | 4 | 8 | 0 | 0.0% |
| nytg | 4 | 6 | 0 | 0.0% |
| nytimes | 4 | 4 | 2 | 50.0% |
| sunday-times | 5 | 7 | 0 | 0.0% |
| talkinbroadway | 4 | 7 | 0 | 0.0% |
| telegraph | 5 | 8 | 0 | 0.0% |
| theater-scene | 4 | 4 | 0 | 0.0% |
| theatermania | 4 | 7 | 0 | 0.0% |
| theatrely | 4 | 7 | 0 | 0.0% |
| thestage | 5 | 7 | 0 | 0.0% |
| thewrap | 4 | 7 | 0 | 0.0% |
| timeout | 5 | 7 | 0 | 0.0% |
| variety | 4 | 6 | 1 | 25.0% |
| vulture | 5 | 6 | 0 | 0.0% |
| washpost | 1 | 1 | 0 | 0.0% |
| Total | 144 | 203 | 4 | 2.8% |

The four raw hits are nytimes for uncle-vanya-1973, nytimes and variety for
on-the-town-1998, and broadwaynews for the-skin-of-our-teeth-1975. These are
collector outcomes, not independently verified review recoveries.

For a retrospective cost comparison, this audit required the real
scripts/lib/backfill-outlet-yield.js, loaded counts from the current
reviews.json using shows.json categories, and called backfillOutletDecision
with minReviews=3 for each joined outlet search. It would exclude 13/144
searches and their 16/203 SERP rows (7.9%), losing zero of the four raw hits.
The excluded outlets were daily-mail and sunday-times (five searches each),
plus baltimoresun, cbsnews and chicago-sun-times (one each). This uses current
corpus counts, not a reconstruction of the corpus at each run's start.
It is a retrospective row comparison, not a prediction of an entire budgeted
run: pruning could allow the existing search cap to admit more outlets.

Examples: uncle-vanya-1973 would drop 2/42 rows, job-2024 5/28, and
the-lady-from-the-sea-1976 3/44. No runtime rule was changed and no records were
edited. Per-outlet samples of only 1 to 5 searches, mostly for decades-old
Broadway productions, do not support extending this decision to the whole
collector or setting a different T1/T2 threshold. In particular, zero hits
in this sample must not be used to blacklist the other 41 outlets.

The measurement was made as follows:

1. Read data/audit/scraper-spend-ledger.jsonl, selecting
   script=collect-outlet-reviews.js, fn=serp and the exact purposes
   historical-backfill or bro-6453-we-historical.
2. Retrieve the five linked runs' log archives through
   GET /repos/thomaspryor/Broadwayscore/actions/runs/{id}/logs.
   Read only each numbered outlet-serp.txt job log. A log event starts at the
   collector's [Tn] [outletId] site: line; attach its following provider
   telemetry and FOUND or Not found outcome.
3. Join by (run_id, showId, outletId). Assert that every ledger cell has
   exactly one log event, its SERP row count matches, and it has an outcome.
   Result: joinedRows=203, joinedCells=144, attributed=203, rawFoundHits=4,
   unmatched=0.
4. Apply the existing backfillOutletDecision to those cells with minReviews=3.
   Result: skippedRows=16, skippedCells=13, hitsLost=0, changedRecords=0.
   The ledger was read again after verification with the same 203 rows.

The actual telemetry caller is discoverCorrectUrl in
scripts/lib/url-discovery.js:1180, which wraps discovery in withSpendShow and
withSpendOutlet. recordProviderCall in scripts/lib/provider-telemetry.js:251
reads that context and writes outletId at line 266. The collector calls
discoverCorrectUrl at scripts/collect-outlet-reviews.js:610. Its optional
result-json outcomes are populated at lines 502-503; the existing
gather-reviews.yml caller does not pass that flag. No query or article text
was stored in this report.

Verification:

- node --test scripts/lib/backfill-outlet-yield.test.mjs: PASS, 7/7 before work.
- node --test --test-timeout 300000 scripts/lib/backfill-outlet-yield.test.mjs scripts/lib/serp-outlet-attribution.test.mjs: PASS, 14/14.
- git log -S 'withSpendOutlet' --oneline -5 -- scripts/lib/provider-telemetry.js scripts/lib/url-discovery.js: existing implementation appears in ada866afa.
- git diff origin/main -- scripts/lib/backfill-outlet-yield.test.mjs scripts/lib/backfill-outlet-yield.js scripts/lib/url-discovery.js scripts/lib/provider-telemetry.js scripts/collect-outlet-reviews.js: empty.
- The read-only real-data comparison above asserted all 144 join keys and
  matching row counts before applying the existing helper.

This report adds zero paid fetches, LLM calls or API calls to runtime or cron.
The manual audit made seven GitHub API requests: one run listing, one log
archive inspection, and five log archives for the join. gh api initially
refused because the CLI was unauthenticated; direct public API reads worked.
No scraping, workflow dispatch, private data write or new executable was
needed.

REMAINING: Accumulate a larger set of outlet outcomes, including the London
backfill purpose, then repeat the joined measurement and decide whether
backfillOutletDecision should run in collect-outlet-reviews.js and at what
T1/T2 threshold.


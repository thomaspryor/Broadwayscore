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

## Status after BRO-6153 (2026-10-25)

- **Added: 80 OB productions, 62 (78 percent) with 3+ reviews, 650 reviews.** By source: 2 hand (34 reviews), 16 award 2024-25 (all 16 scored, 130 reviews), 62 from TheaterMania via Playbill (44 scored, 486 reviews). Rows are marked `discoverySource: ob-historical:hand|award|tm`.
- **Catalog OB openings 2025-06 to 2026-02: 125** (Jun 10, Jul 7, Aug 4, Sep 14, Oct 23, Nov 19, Dec 5, Jan 17, Feb 26). Before: 14 for Jun to Dec 2025.
- **Repeatable tool landed:** `node scripts/plan-ob-historical-cohort.js --from=YYYY-MM-DD --to=YYYY-MM-DD` (read-only, run via `cloud-run-script.js --timeout=55` for the keys). It prints add-show actions; plans are built with `buildPlans` from `new-fix-plan.js` (10 actions each). Its second pass on the gap window found 11 more (revivals and "&" titles the hand pass missed).
- **Per cohort, in order:** plan script, then plans land and apply, then `gather-reviews.yml` (`max_tier=3`, `spend_purpose=historical-backfill`, 12 shows a run), then `collect-review-texts.yml` with `show_filter`, then `llm-ensemble-score.yml` with `show_id`, then `rebuild-fast.yml`. Waiting for the scheduled text and score crons instead adds up to a day.
- **Audits:** `isObHistoricalRow` (scripts/lib/ob-historical-cohort.js) selects these rows for `audit-review-crossmodel.js` and `fact-check-sample.js`. The 'historical' tag is not used: on the site it is a theme (BRO-6200 tracks the existing collision).
- **Next cohorts:** 2024-06..2025-05 (16 already done), 2023-06..2024-05, 2022-01..2023-05. Expect about 50 to 70 promotable shows each at about $0.20 a show, and a day of pipeline time each. Done: all three plus cohort 4 (2021-06..2022-05, BRO-6470, which also covers January to May 2022). Mid-2021 is the floor the owner set.

## Pre-COVID trial results (2026-10-30, BRO-6496): June 2018 to March 2020

The owner approved a trial of this window with a $25 cap and set June 2018 as the floor; going earlier needs a new owner decision. The window ends at the 2020-03-12 shutdown, and shows whose run was cut by it were skipped.

Process: outlet-first candidates (TheaterMania listings plus BroadwayWorld and Broadway.com coverage), then the same add-show plans, gather, collect, score, `audit-aggregator-gap.yml` and `rebuild-fast.yml`. Playbill is the problem for this era: 89 of 97 candidates had no Playbill production page, so the v3 Playbill date gate would have kept about 3 shows. The owner chose (2026-10-29) to let pre-2020 rows take dates from two agreeing non-Playbill sources. The rule used: BroadwayWorld plus TheaterMania or Broadway.com, closing dates within a day of each other, opening within minus 3 to plus 30 days of the earliest dated critic write-up, and the venue corroborated by both. BroadwayWorld itself was wrong three times in the sample (Long Lost venue, Fefu and Her Friends closing, Caesar and Cleopatra opening), which is why one source is not enough. 23 shows added (3 with Playbill dates, 20 two-source), all `discoverySource: ob-historical:*`: 4 in 2018-19 (This Ain't No Disco, The Other Josh Cohen, Nantucket Sleigh Ride, White Noise) and 19 in 2019-20.

Review-count distribution (core-data `reviews.json` after rebuild, 2026-10-30 11:18 UTC):

| Reviews | 0 | 1-2 | 3-4 | 5-9 | 10+ | 3+ | Total reviews |
|---|---|---|---|---|---|---|---|
| Final | 0 | 0 | 3 | 6 | 14 | 23 (100 percent) | 256 |

- Cost: about $15.8 against the $25 cap. Scraping $5.88 (Scrapingdog $5.65, an upper bound at the pay-as-you-go rate) on ledger rows tagged with the 23 show ids, LLM scoring about $6.5 across the score runs, the fact-check $1.35, and local candidate research under about $2 (SERP calls not in the ledger).
- Fact-check: `fact-check-historical-sample.js` on 15 two-source shows. 2 of 15 (13 percent) had a date error. Caesar and Cleopatra's opening equalled its first preview (BroadwayWorld's date, which the minus 3 to plus 30 day window let through), and This Ain't No Disco's first preview was a day off. Both fixed by plan `bro-6496-3`. The other flags were venue-name variants and one checker misread of a preview as the opening (Sing Street), not data errors. Prevention for any later pre-2020 run: require a second source for the opening as well as the closing, and reject opening equal to first preview unless a second source agrees.
- Shard time budget: gathers ran 3 to 4 shows a shard, and the 35-minute budget deferred White Noise and Heroes of the Fourth Turning, both well covered, so they first showed 0 and 2. They were re-gathered alone. This repeats the cohort 3 lesson: 1 show per shard for historical backfill.
- Still low: American Moor and Molly Sweeney (3 each, small runs with thin coverage) and Caesar and Cleopatra (4). No show is at 0 or 1-2.
- London-title URL guard bug: the rebuild flagged every write-up of London Assurance (Irish Rep, 2019) as a London production because its URL path contained "london-". `urlPathOppositeMarketIndicator` in `scripts/lib/cross-market-guard.js` now masks the show's own title slug before matching (the mirror case covers West End titles containing "broadway"), and the rebuild self-heals files whose only URL-path match was the title. London Assurance went from 0 to 5 write-ups. A corpus scan of 55,658 files found only those 7 files affected.

## Cohort 4 results (2026-10-29, BRO-6470): June 2021 to May 2022

This is the last cohort. The owner set mid-2021 as the floor, so no older season is planned.

Process: same planner in two half-window runs (June to November 2021: 59 candidates, 10 Playbill matches; December 2021 to May 2022: 80 candidates, 25 Playbill matches), 24 promotable, all kept (6 and 18). Playbill coverage of this COVID-reopening season is thin: most TheaterMania listings had no Playbill production page at all. Two planner fixes landed first. `venue-date-compare.js` now reads both years from a Playbill season slug (`...-2021-2022`), which had marked every December to May show as a year mismatch, and the venue match compares only the company half of a "Company / Theatre" string. `isStructuralOnlyMismatch` takes the claimed opening date, so a TheaterMania preview date that Playbill prints as the opening no longer drops the show. Two add-show plans, landed and applied, then gather (1 show per shard), collect, score, `audit-aggregator-gap.yml` and rebuild.

Review-count distribution (prod `analyst-shows.json`, 2026-10-29T01:15Z; a show missing from the feed counts as 0):

| Reviews | 0 | 1-2 | 3-4 | 5-9 | 10+ | 3+ | Total reviews |
|---|---|---|---|---|---|---|---|
| Final | 1 | 2 | 0 | 8 | 13 | 21 (88 percent) | 236 |

- Cost: about $4.1, at most about $6.3, against a $4 estimate (stop line $10). Scraping was $1.52 on ledger rows tagged with cohort 4 show ids, plus $0.37 of untagged gather rows counted only in the upper bound. LLM was $2.62 for 95 newly scored reviews. The planner's Playbill SERP calls are not in the ledger; at 5 Scrapingdog credits a call they are about $0.60, at most about $1.80. About $0.17 to $0.26 a show.
- Revival labels: Playbill tags COVID-postponed premieres as "Revival", often on a sparse tag-line with no Play or Musical tag (`["Off-Broadway","Revival"]`). Seven new works were added as revivals: The Bedwetter, Confederates, Wish You Were Here, On Sugarland, Black No More, Trevor and Kimberly Akimbo (the last two with a full tag-line, so the planner fix below does not catch them). Plan `bro-6470-revival` sets them to `isRevival: false`, and The Bedwetter and Black No More, which the title guess had as plays, to musical. `playbillFacts` now trusts "Revival" only when the tag-line also names Play or Musical. Little Christmas Miracles also has a bare "Revival" tag and was left as is (not verified either way).
- Wrong-production check: the same minus/plus 150-day scan as cohort 3 over the 40 reviews that carry a page date found none out of window, including Kimberly Akimbo (Atlantic 2021, Broadway 2022) and Assassins (Classic Stage 2021).
- Still at 0 or 1: The Importance of Being Earnestly LGBTQ (0, a small comedy adaptation), How the Hell Did I Get Here? (1, a solo show) and Little Christmas Miracles (1). None looks like a major gap.

## Cohort 3 results (2026-10-28, BRO-6259): June 2022 to May 2023

Process: same planner in two half-window runs (173 candidates after skips, 38 Playbill matches), 34 promotable, all kept. The Playbill match rate was much lower than in cohorts 1 and 2 (about 22 percent of candidates against about 41 percent in cohort 2). Scrapingdog returned HTTP 400 on 22 Playbill SERP calls and the BD/SB fallbacks mostly answered, so the gap looks like thinner Playbill coverage of 2022-23 Off-Broadway listings rather than a broken search. Days of Wine and Roses (Atlantic, June 2023) and A Simulacrum (June 2023), which cohort 2's window should have caught, came through here and were kept. The BRO-6259 card set this window to June 2022 to May 2023, so January to May 2022 (listed under "Next cohorts" in the status section) is not yet covered. Two add-show plans, landed and applied. Gathered in 2 runs of 17 shows with `parallel_jobs=9`, then one cohort-wide catch-up, then `audit-aggregator-gap.yml` (`ingest_missing`, `include_closed`, cohort `show_ids`) followed by another collect, score and rebuild.

Review-count distribution (prod `analyst-shows.json`, 2026-10-28T16:12Z; a show missing from the feed counts as 0):

| Reviews | 0 | 1-2 | 3-4 | 5-9 | 10+ | 3+ | Total reviews |
|---|---|---|---|---|---|---|---|
| Final | 7 | 4 | 2 | 11 | 10 | 23 (68 percent) | 233 |

- Cost: about $3.96, at most $4.83, against a $7 estimate (2x stop line $14). Scraping was $2.70 on ledger rows tagged with cohort 3 show ids. Another $0.87 of gather rows in the window carry no show id and may belong to other sessions, so they are counted only in the upper bound. LLM was $1.26 for 59 newly scored reviews. That is about $0.12 to $0.14 a show.
- Cost attribution correction for cohorts 1 and 2: their totals below summed every `historical-backfill` scraper-ledger row in a time window, and other sessions' West End and Broadway backfills use the same purpose. Counting only rows tagged with each cohort's show ids (all dates) gives scraping of $3.67 for cohort 1 and $5.12 for cohort 2, plus untagged rows of $0.65 and $1.28 as an upper bound. The LLM figures were already by run id and stand. Corrected totals: cohort 1 about $9.12 (at most $9.77), cohort 2 about $8.94 (at most $10.22), cohort 3 about $3.96 (at most $4.83). All three come to about $22, at most about $25, against the $40 to $60 approved.
- Shard timeouts, again: with 2 shows per shard, 9 of 18 shards hit the 75-minute timeout. A shard spends about 4 minutes on setup, and each show took about 30 to 37 minutes of per-outlet SERP searches (about 130 outlets), so 2 shows plus the post-gather rebuild does not fit. Re-gathering the 18 affected shows (one per shard) ran clean. The cohort 2 note that 2 shows per shard ran clean did not hold here, and this supersedes it. Use 1 show per shard for historical backfill.
- Slot gate: the first runs waited 3 hours, and the re-gathers waited another 3 hours behind automatic deferral retries of three cohort 3 shows (Black Odyssey, Des Moines, The Fears). Black Odyssey was gathered twice as a result.
- Wrong-production check: every cohort 3 show page was scanned for reviews dated more than 150 days before opening or more than 150 days after (a tighter window than cohort 2's minus 60 / plus 270 days on the late side). Only 112 of the 233 reviews carry a publish date on the page, so the check covers about half. None were found, including Merrily We Roll Along (NYTW 2022, Broadway 2023), Days of Wine and Roses, God of Carnage, and the short titles (Candida, Love, Elyria, Sandra).
- Still at 0: Candida, David Blaine Presents Asi Wind's Inner Circle, Hyprov, Millennials Are Killing Musicals, The Goodbye Girl, God of Carnage, The Smuggler. Three are magic, improv or revue-style shows (Asi Wind, Hyprov, Millennials Are Killing Musicals) that critics rarely cover. Candida and God of Carnage are revivals of well-known plays, and The Goodbye Girl and The Smuggler are full productions, so those four are the ones worth a manual look for missed reviews.

## Cohort 2 results (2026-10-28, BRO-6259): June 2023 to May 2024

Process: same planner in two half-window runs (213 candidates after skips, 87 Playbill matches, 21 mismatches, 105 with no Playbill page), 83 promotable, 82 after dropping a duplicate (Death, Let Me Do My Show had a Lucille Lortel run and an Orpheum transfer under one id; the first run was kept). Two June 2024 shows that cohort 1's planner missed (What Became of Us, The Welkin) came through here and were kept. Four add-show plans, landed and applied. Gathered in 4 groups of 6, then 3 groups of about 20 with `parallel_jobs` set so each shard had 2 or 3 shows, then one cohort-wide catch-up pass, then `audit-aggregator-gap.yml` (`ingest_missing`, cohort `show_ids`) followed by another collect, score and rebuild.

Review-count distribution (prod `analyst-shows.json`, 2026-10-28T01:12Z; a show missing from the feed counts as 0):

| Reviews | 0 | 1-2 | 3-4 | 5-9 | 10+ | 3+ | Total reviews |
|---|---|---|---|---|---|---|---|
| After gather and catch-up (2026-10-27T23:09Z) | 6 | 15 | 11 | 23 | 27 | 61 (74 percent) | 598 |
| Final, after the aggregator-gap ingest | 6 | 15 | 9 | 25 | 27 | 61 (74 percent) | 611 |

- Cost: $17.76 against a $16 estimate (2x stop line $33): scraping $13.94, LLM $3.82 for 170 newly scored reviews. About $0.22 a show. The scraping figure starts at the cohort 2 planner run, so it also holds part of cohort 1's catch-up. (Over-counted: it includes other sessions' backfill rows. Corrected total about $8.94, see the cohort 3 section.)
- Wall-clock: about 23 hours from plans landing to the final rebuild. Most of it was the shared gather slot gate (`wait-for-gather-slot.js`, 2 slots, FIFO, 180-minute cap): West End backfill runs from another session held both slots overnight, so each 6-show run waited the full 3 hours before starting. Fewer, larger runs with more shards made far better use of a slot than many 6-show runs.
- Shard timeouts: with 3 shows per shard, 2 of 7 shards in one run hit the 75-minute job timeout. Re-gathering only those shards' 6 shows (the matrix is round-robin, so shard N holds ids at positions i % jobs == N) avoided re-paying for the 14 shows that finished. 2 shows per shard ran clean.
- Wrong-production check: every cohort 2 show page was scanned for reviews dated more than 60 days before opening or 270 days after. None were found, including the Broadway-transfer titles (Dead Outlaw, Job, Illinoise, Here We Are, Teeth) and the classics (Waiting for Godot, Arcadia, Hamlet, Translations, Orpheus Descending).
- Still at 0: Ode to the Wasp Woman, Anne Frank (musical), Cat Kid Comic Club, Hamlet (Orpheum 2024), You Don't Have to Do Anything, The Assassination of Julius Caesar. Mostly short or family runs with little critical coverage.

Runbook change for cohort 3: gather in runs of about 20 shows with `parallel_jobs=10` (2 shows per shard), re-gather only failed shards, then one cohort-wide catch-up and the aggregator-gap ingest.

## Cohort 1 results (2026-10-26, BRO-6259): June 2024 to May 2025

Process: `plan-ob-historical-cohort` via `cloud-run-script.js` in two half-window runs (211 candidates after in-catalog/gate/parse skips, 68 Playbill matches, 41 mismatches, 102 with no Playbill page), 66 promotable shows. Three add-show plans (at most 25 actions each), landed and applied. Gathered in 6 groups of about 11 (`max_tier=3`, `spend_purpose=historical-backfill`), each followed by `collect-review-texts.yml` and a show-scoped `llm-ensemble-score.yml`, then a cohort-wide catch-up pass (below) and `rebuild-fast.yml`.

Review-count distribution (prod `analyst-shows.json`, 2026-10-26T23:40Z; a show missing from the feed counts as 0):

| Reviews | 0 | 1-2 | 3-4 | 5-9 | 10+ | 3+ | Total reviews |
|---|---|---|---|---|---|---|---|
| Before catch-up (18:59Z) | 16 | 16 | 15 | 9 | 10 | 34 (52 percent) | 264 |
| Final | 7 | 13 | 19 | 13 | 14 | 46 (70 percent) | 363 |

- Cost: $11.97 against a $13 estimate (scraping $6.52, of which a little is the cohort 2 planner runs; LLM $5.45 for 236 newly scored reviews). About $0.18 a show. (Over-counted: the scraping figure includes other sessions' backfill rows. Corrected total about $9.12, see the cohort 3 section.)
- Wall-clock: about 17 hours, nearly all gather time and deferral hops.
- Why the catch-up mattered: gather-reviews.js defers shows past its 35-minute budget, and the follow-up job re-dispatches them in a new gather run (28 of 66 shows went through hops). A hop's rebuild only triggers text collection above 20 pending reviews, so small hops leave reviews uncollected and unscored until the cron. One cohort-wide collect, score and rebuild pass after the last hop moved 9 shows off zero and added 99 reviews.
- Still at 0: Communion, On Beckett, Alexandria, Safe House, Elephant & Piggie's We Are in a Play!, The Beautiful Land I Seek, Duality. Mostly small or limited runs with little critical coverage.

Runbook changes for cohorts 2 and 3 (prevention for the deferral gap): gather about 6 shows per run so fewer shows defer, and always run the cohort-wide catch-up (`collect-review-texts.yml` with `show_filter`, show-scoped `llm-ensemble-score.yml`, `rebuild-fast.yml`) after every group and deferral hop has finished, before recording the distribution.

## Gap cohort results (2026-10-25, BRO-6153): June 2025 to February 2026

Process (all existing tools, no new code): TheaterMania WP JSON listings for the window, minus shows already in the catalog, minus festival/reading/benefit titles, closed 90+ days, run 14+ days, giving 125 candidates. `validate-show-venue.js --candidates-file` via `cloud-run-script.js` gave 55 Playbill matches, 22 mismatches (mostly classics where Playbill points at another production) and 48 with no Playbill page. Playbill pages were fetched directly (curl, free) and parsed with `parseFactDates` / `parseTitleVenueYear`. `findTmSameTitleShow` + `checkForDuplicate` dropped 4 already-catalogued runs. 48 add-show actions in five 10-action plans (`buildPlans` from `new-fix-plan.js`), applied, gathered in 4 groups of 12, then `collect-review-texts.yml` and a show-scoped `llm-ensemble-score.yml` per group, then `rebuild-fast.yml`.

| | Shows | 3+ reviews | Reviews |
|---|---|---|---|
| Gap cohort | 48 | 35 (73 percent) | 388 |
| Calibration (2 hand, 16 award 2024-25, 3 random gap) | 21 | 21 (100 percent) | 184 |
| **Total added** | **69** | **56 (81 percent)** | **572** |

- Cost: gap scraping $4.02, LLM about $5.40 (388 reviews at $0.014, 10 ensemble runs measured since 00:00). About $0.20 a show all in.
- Wall-clock: about 9 hours for the gap cohort, nearly all pipeline wait. Gather about 1.5 to 2 hours per 12 shows. One group gather was cancelled by the queue and re-run.
- Scoring is the bottleneck: text is fetched hours before the scheduled ensemble run scores it. A show-scoped `llm-ensemble-score.yml` dispatch after each text collection cut that to under 30 minutes.
- Gaps left in this window: 6 Playbill matches whose titles contain "&" or a subtitle (title-slug pairing missed them, e.g. Gene & Gilda, Duke & Roya), and 18 mismatches to hand-check. Both are small follow-ups for the cohort script.
- The catalog now has about 80 OB openings for 2025-06 to 2026-02, against 14 before.

## Calibration results (2026-10-25, BRO-6153): measured, supersede earlier estimates

21 shows went through add, gather (`max_tier=3`), text collection, scoring and rebuild: 2 hand shows, 16 award-signal 2024-25 shows, 3 random gap-window shows that had a Playbill page.

- **17 of 21 (81 percent) reached 3 or more reviews.** 146 reviews in total, about 7 a show. Range: Hold On to Me Darling 23, The Antiquities 13, Archduke 11, Sumo 10, the 3 random gap shows 8 to 11. Of the 4 below 3, three (Good Bones, Becoming Eve, Garside's Career) were deferred by the gather time budget and re-dispatched, and were still collecting text when measured.
- **Cost: about $0.18 a show.** Scraping $1.41 for 21 shows ($0.067 a show, ledger rows priced with `provider-pricing.json`). LLM scoring $0.0154 a review (8 ensemble runs, 466 reviews, $7.17, `llm-scoring-runs.json`), so about $0.11 a show. The $0.80 planning figure was 4 times too high.
- **Measuring too early misleads.** A review counts in `reviews.json` only after text collection (cron 04:30, 10:30, 18:30 UTC) and scoring. Right after gather, most files are `incompleteReason: not_attempted` URL stubs. The first count (Sumo 2, most award shows 0) was pipeline lag. Measure after text collection, scoring and rebuild, or dispatch `collect-review-texts.yml` with `show_filter` to skip the wait.
- **A Playbill production page is the notability filter.** Of 10 random TheaterMania gap listings, 3 had a Playbill page with matching dates, 1 had dates a year off (a different run), and 6 had none. The 3 with pages scored 8 to 11 reviews each. So "has a Playbill production page with matching dates" passes the shows worth scoring and drops most tiny runs, for about $0.001 a show. The SERP press screen from v3/v3.1 is not needed. If later cohorts show many Playbill-page shows under 3 reviews, revisit.
- **TheaterMania dates drift.** Lowcountry: TM 2025-06-25, Playbill opening 2025-06-10. Dates always come from Playbill.

Revised projection:
| Cohort | TM listings not in catalog | Expected with Playbill page (about 35 to 40 percent) | Cost at $0.18 |
|---|---|---|---|
| Gap 2025-06 to 2026-02 | up to 168 | about 55 to 65 | about $12 |
| 2024-06 to 2025-05 | up to 247 (16 done) | about 85 to 95 | about $17 |
| 2023-06 to 2024-05 | up to 250 | about 85 to 100 | about $18 |
| 2022-01 to 2023-05 | up to 293 | about 100 to 115 | about $20 |
| **Total** | | **about 330 to 375** | **about $65 to $70** |

Time is set by the pipeline, not money: about 1 to 1.5 hours of gather per 16 shows, plus text collection and scoring. Roughly 2 to 3 cohorts a week at the current queue.

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

## Completeness audit of thin NYT-reviewed shows (2026-10-30, BRO-6629)

The 54 backfilled Off-Broadway shows with an NYT review and 6 or fewer reviews were each checked
against Show Score (all `paginate_critic_reviews` pages, tiles dated against the run), Playbill
Verdict, the BWW roundup, DTLI, NYC Theatre, the outlet-census manifests and a SERP check. 19 of
the 54 were missing reviews of the right production; 84 vetted URLs went in through
`scripts/dispatch-ingest-batch.js`. "Missing" counts only the right production and registered
outlets. `nyt-theater` is New York Theater (Jonathan Mandell), not the New York Times.

Classes of miss, each fixed with tests:

| Class | What went wrong | Fix |
|---|---|---|
| A | Show Score lists tiles from earlier productions on the same page (Gatz 2019, The Effect 2016) | Tile dates parsed and gated against the run (`isShowScoreTileDateOutOfRun`, gap audit + gather) |
| B | Short or numeric titles ("44") produced no title tokens, so every review URL failed the match | `titleTokens` fallback in `audit-show-review-gap.js` |
| C | Show Score page belongs to another production | Already caught by the year gate; these shows were checked on the other aggregators |
| D | Shows added by `add-show` plans (25 in `bro-6481-3`) were never gathered | `execute-approved-fix.yml` dispatches a capped gather for opened shows it added |
| E | An Off-Broadway show whose Show Score page redirects to `/off-off-broadway-shows/` was rejected as the wrong page | `showScoreLandingBlockReason(url, {isOffBroadway})` accepts it for OB shows |
| F | Some tile links are wrapped as `google.com/url?q=` and were dropped | Tile hrefs are unwrapped before outlet matching |

Per show (ours before the audit, right-production reviews missing, count after the ingest):

| Show | Ours before | Missing (right production) | After ingest | Note |
|---|---|---|---|---|
| school-pictures-off-broadway-2023 | 5 | 0 | 5 | 2 candidate(s) rejected on vetting (prior production or already held under another URL) |
| mindplay-off-broadway-2025 | 5 | 0 | 5 | 2 candidate(s) rejected on vetting (prior production or already held under another URL) |
| watch-me-walk-off-broadway-2026 | 4 | 0 | 4 | complete |
| art-of-leaving-off-broadway-2025 | 5 | 0 | 5 | 2 candidate(s) rejected on vetting (prior production or already held under another URL) |
| sulfur-bottom-off-broadway-2025 | 5 | 0 | 5 | complete |
| dilaria-off-broadway-2025 | 5 | 0 | 5 | complete |
| this-much-i-know-off-broadway-2025 | 4 | 0 | 4 | Show Score page is another production; checked other aggregators |
| bear-grease-off-broadway-2025 | 4 | 0 | 4 | no Show Score page; other aggregators checked |
| 44-off-broadway-2025 | 3 | 0 | 3 | Show Score page is another production; checked other aggregators |
| burnout-paradise-off-broadway-2024 | 4 | 1 | 5 | ingested |
| gatz-off-broadway-2024 | 5 | 1 | 6 | ingested (1 skipped: unregistered outlet or not a review) |
| the-witness-room-off-broadway-2024 | 5 | 0 | 5 | complete |
| from-here-off-broadway-2024 | 5 | 0 | 5 | Show Score page is another production; checked other aggregators |
| bowl-ep-off-broadway-2025 | 5 | 5 | 10 | ingested |
| im-assuming-you-know-david-greenspan-off-broadway-2025 | 5 | 0 | 5 | complete |
| the-black-wolfe-tone-off-broadway-2025 | 4 | 0 | 4 | 1 candidate(s) rejected on vetting (prior production or already held under another URL) |
| safe-house-off-broadway-2025 | 5 | 2 | 7 | ingested (1 skipped: unregistered outlet or not a review) |
| all-the-worlds-a-stage-off-broadway-2025 | 5 | 0 | 5 | no Show Score page; other aggregators checked |
| how-is-it-that-we-live-or-shakey-jake-alice-off-broadway-2025 | 5 | 0 | 5 | complete |
| last-call-off-broadway-2025 | 4 | 0 | 4 | Show Score page is another production; checked other aggregators |
| henry-iv-off-broadway-2025 | 5 | 0 | 5 | Show Score page is another production; checked other aggregators |
| grandiloquent-off-broadway-2025 | 5 | 0 | 5 | 1 candidate(s) rejected on vetting (prior production or already held under another URL) |
| a-good-day-to-me-not-to-you-off-broadway-2023 | 5 | 0 | 5 | no Show Score page; other aggregators checked |
| amid-falling-walls-tsvishn-falndike-vent-off-broadway-2023 | 5 | 0 | 5 | no Show Score page; other aggregators checked |
| bite-me-off-broadway-2023 | 5 | 0 | 5 | 1 candidate(s) rejected on vetting (prior production or already held under another URL) |
| covenant-off-broadway-2023 | 5 | 0 | 5 | 1 candidate(s) rejected on vetting (prior production or already held under another URL) |
| cat-kid-comic-club-the-musical-off-broadway-2023 | 2 | 0 | 2 | no Show Score page; other aggregators checked |
| scarlett-dreams-off-broadway-2024 | 5 | 0 | 5 | 1 candidate(s) rejected on vetting (prior production or already held under another URL) |
| what-became-of-us-off-broadway-2024 | 5 | 2 | 7 | ingested |
| grenfell-in-the-words-of-survivors-off-broadway-2024 | 2 | 0 | 2 | Show Score page is another production; checked other aggregators |
| the-effect-off-broadway-2024 | 4 | 0 | 4 | Show Score page is another production; checked other aggregators |
| five-the-parody-musical-off-broadway-2024 | 5 | 0 | 5 | complete |
| hamlet-greenwich-house-off-broadway-2024 | 5 | 0 | 5 | Show Score page is another production; checked other aggregators |
| illinoise-off-broadway-2024 | 5 | 3 | 8 | ingested (3 skipped: unregistered outlet or not a review) |
| the-white-chip-off-broadway-2024 | 5 | 0 | 5 | complete |
| circle-jerk-off-broadway-2022 | 4 | 0 | 4 | complete |
| evanston-salt-costs-climbing-off-broadway-2022 | 5 | 0 | 5 | no Show Score page; other aggregators checked |
| your-own-personal-exegesis-off-broadway-2022 | 5 | 0 | 5 | 1 candidate(s) rejected on vetting (prior production or already held under another URL) |
| the-good-john-proctor-off-broadway-2023 | 5 | 0 | 5 | complete |
| the-very-hungry-caterpillar-show-off-broadway-2023 | 2 | 0 | 2 | Show Score page is another production; checked other aggregators |
| coal-country-off-broadway-2022 | 5 | 1 | 6 | ingested (2 skipped: unregistered outlet or not a review) |
| in-the-amazon-warehouse-parking-lot-off-broadway-2024 | 5 | 3 | 8 | ingested (3 skipped: unregistered outlet or not a review) |
| staff-meal-off-broadway-2024 | 5 | 8 | 13 | ingested (1 skipped: unregistered outlet or not a review) |
| shadow-land-off-broadway-2023 | 4 | 8 | 12 | ingested |
| dark-disabled-stories-off-broadway-2023 | 5 | 6 | 11 | ingested |
| wedding-band-off-broadway-2022 | 5 | 5 | 10 | ingested |
| baldwin-and-buckley-at-cambridge-off-broadway-2022 | 5 | 6 | 11 | ingested |
| this-beautiful-future-off-broadway-2022 | 5 | 4 | 9 | ingested (2 skipped: unregistered outlet or not a review) |
| snow-in-midsummer-off-broadway-2022 | 4 | 5 | 9 | ingested (1 skipped: unregistered outlet or not a review) |
| the-coast-starlight-off-broadway-2023 | 5 | 9 | 14 | ingested (1 skipped: unregistered outlet or not a review) |
| where-we-belong-off-broadway-2022 | 5 | 4 | 9 | ingested |
| rock-of-ages-off-broadway-2019 | 5 | 0 | 5 | complete |
| molly-sweeney-off-broadway-2019 | 3 | 1 | 4 | ingested (4 skipped: unregistered outlet or not a review) |
| caesar-and-cleopatra-off-broadway-2019 | 4 | 10 | 14 | ingested |

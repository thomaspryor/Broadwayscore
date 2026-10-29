# Outlet-first review census (BRO-6481)

## Purpose

Every other coverage audit starts from what we already know about (aggregator pages, pollers, files we hold). The census starts from the outlet instead. It asks each outlet for every theater review it has published since 2021-06-01, matches each one to a show, and diffs that list against our corpus. A review nobody cited and no poller found shows up here as a gap.

It does two jobs. It fills coverage gaps, and it exposes pipeline bugs: show-matching errors, misfiled reviews, catalog gaps (NYC productions we have no show for), and outlets the pipeline cannot read at all.

## Usage

```
node scripts/outlet-census.js --outlet=theatermania,nytg   # some outlets
node scripts/outlet-census.js --all                        # every configured outlet
node scripts/outlet-census.js --all --print-gaps           # also print "GAP <showIds> <url>" lines
node scripts/outlet-census.js --summary                    # markdown table of the saved reports
```

Outputs, one pair per outlet, in `data/audit/outlet-census/`:

- `<outlet>.manifest.json`: every enumerated item with its URL, date, headline and bucket.
- `<outlet>.report.json`: bucket counts, recall, and the gap/misfile/catalog-gap lists.

Run locally, the corpus is `data/reviews.json` only, so flagged, unscored or excluded files in `data/review-texts` are invisible and local gap counts are **upper bounds**. For true gaps run it on CI with the private review texts:

```
node scripts/cloud-run-script.js --review-texts scripts/outlet-census.js --outlet=theatermania,nytg --print-gaps
```

For CI runs, split the work with the existing `--outlet` selector. Running every
outlet with `--all` can exceed CI's 55 minute limit, especially with paid SERP
sources. Run each large SERP outlet separately, for example:

```
node scripts/cloud-run-script.js --review-texts scripts/outlet-census.js --outlet=nytimes --print-gaps
node scripts/cloud-run-script.js --review-texts scripts/outlet-census.js --outlet=wsj --print-gaps
```

Each invocation writes only its selected outlets' reports. Combine them with
`--summary` after collecting the reports. Sharding adds no queries; the existing
`--serp-budget` applies separately to each invocation, rather than to the whole batch.
Recheck failed sources separately: Theater Life had a transient `wp-json` failure
on CI, and Slant's configured sitemap returned HTTP 403 (BRO-6514). A failed or
empty enumeration cannot establish complete coverage.

## Source kinds

Configured in `scripts/lib/outlet-census-sources.js`.

- `wp-json`: the outlet's WordPress REST API, paged by date, filtered to a review category, vertical or link pattern. Flags: `sourceSaysReview` (the category is reviews-only, so no headline review test), `requireNycSignal` (national or regional outlets: a matched item must carry an NYC signal or it is not a gap).
- `sitemap`: a sitemap index walked for review URLs (Exeunt, Broadway News, NYTG), with page metadata fetched where the sitemap lacks headlines.
- `sitemap` options (BRO-6485): gzip sitemaps, `childFilter` to pick children of an index (Time Out's city sitemaps, Daily Beast's yearly ones), WordPress.com mirrors (`public-api.wordpress.com/wp/v2/sites/<domain>`) for sites whose own API is closed.
- `serp`: for outlets that block direct reads, a site-scoped Google search per calendar quarter (`after:`/`before:` dates, so a 2014 production's review cannot attach to a 2024 show). Up to 5 pages per quarter and query; budget via `--serp-budget` (default 1500 calls). A run cut short by the budget, a missing provider, the page cap or a failed sitemap child is marked `incomplete` in the report, and its recall covers only part of the outlet.
- `unreadable`: outlets the census cannot enumerate, with the reason. They report `n/a` recall. The census does not work around bot blocks or pay for proxies.

## Buckets

| Bucket | Meaning |
|---|---|
| held | We hold this URL for the matched show. |
| held-alt-url | We hold a review from this outlet for the matched show under another URL form. |
| gap | NYC review of a show we list, not held. Ingest candidate. |
| misfile | We hold the URL, but under a different show than the one it matches. |
| catalog-gap | NYC review (NYC signal present) that matches no show we list. |
| ambiguous | Matches more than one show and the dates do not separate them. |
| held-other-market, out-of-window, held-unmatched, not-review | Excluded from recall. |

Recall = (held + held-alt-url) / (held + held-alt-url + gap + misfile).

## Results (local run, 2026-10-28, reviews.json corpus)

55 outlets configured, 23 readable with recall below. Gap counts are upper bounds (see Usage).

| Outlet | Source | Corpus rows | Enumerated | Held | Held (other URL) | Gap | Misfile | Ambiguous | Catalog gap | Recall |
|---|---|---|---|---|---|---|---|---|---|---|
| dc-theater-arts | wp-json | 94 | 1748 | 0 | 0 | 2 | 0 | 0 | 35 | 0 |
| stagebuddy | wp-json | 90 | 323 | 50 | 0 | 133 | 0 | 1 | 34 | 0.273 |
| theater-pizzazz | wp-json | 242 | 282 | 13 | 8 | 24 | 0 | 1 | 103 | 0.467 |
| stageandcinema | wp-json | 99 | 2062 | 58 | 5 | 70 | 0 | 1 | 89 | 0.474 |
| theatre-reviews-limited | wp-json | 162 | 299 | 109 | 0 | 83 | 0 | 1 | 37 | 0.568 |
| exeunt-magazine | sitemap | 239 | 2115 | 181 | 1 | 101 | 0 | 1 | 194 | 0.643 |
| culturesauce | wp-json | 262 | 513 | 59 | 185 | 107 | 0 | 5 | 84 | 0.695 |
| amny | wp-json | 387 | 462 | 90 | 3 | 27 | 0 | 0 | 8 | 0.775 |
| theatermania | wp-json | 679 | 1391 | 416 | 61 | 118 | 0 | 1 | 310 | 0.802 |
| one-minute-critic | wp-json | 130 | 237 | 118 | 2 | 27 | 0 | 0 | 10 | 0.816 |
| theater-life | wp-json | 615 | 759 | 304 | 74 | 73 | 0 | 51 | 71 | 0.838 |
| thewrap | wp-json | 423 | 496 | 174 | 2 | 33 | 1 | 0 | 69 | 0.838 |
| broadwaynews | sitemap | 221 | 296 | 58 | 52 | 14 | 0 | 0 | 5 | 0.887 |
| nyt-theater | wp-json | 416 | 654 | 287 | 5 | 37 | 0 | 1 | 61 | 0.888 |
| nytg | sitemap | 476 | 2434 | 415 | 18 | 34 | 1 | 1 | 154 | 0.925 |
| nysr | wp-json | 806 | 1262 | 628 | 38 | 53 | 0 | 0 | 44 | 0.926 |
| hollywood-reporter | wp-json | 394 | 1501 | 40 | 2 | 3 | 0 | 0 | 0 | 0.933 |
| deadline | wp-json | 325 | 1835 | 81 | 1 | 3 | 0 | 2 | 4 | 0.965 |
| the-komisar-scoop | wp-json | 144 | 216 | 45 | 0 | 1 | 0 | 0 | 0 | 0.978 |
| variety | wp-json | 624 | 292 | 135 | 18 | 3 | 0 | 0 | 11 | 0.981 |
| operawire | wp-json | 22 | 1465 | 21 | 0 | 0 | 0 | 0 | 56 | 1 |
| the-recs | wp-json | 46 | 402 | 3 | 0 | 0 | 0 | 0 | 0 | 1 |
| theater-scene | wp-json | 589 | 1451 | 365 | 0 | 0 | 0 | 0 | 0 | 1 |
| broadway-and-me | unreadable: site answers HTTP 429/503/202 challenge pages to the census client | 47 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a |
| chicagotribune | unreadable: site and robots.txt return HTTP 403 to the census client | 311 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a |
| cititour | unreadable: no WordPress API; sitemap enumeration not yet configured | 333 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a |
| dailybeast | unreadable: no WordPress API; sitemap enumeration not yet configured | 271 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a |
| dtli | unreadable: no WordPress API; sitemap enumeration not yet configured | 39 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a |
| ew | unreadable: site and robots.txt return HTTP 403 to the census client | 459 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a |
| front-row-center | unreadable: site answers HTTP 429/503/202 challenge pages to the census client | 437 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a |
| frontmezzjunkies | unreadable: no WordPress API; sitemap enumeration not yet configured | 140 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a |
| guardian | unreadable: site and robots.txt return HTTP 403 to the census client | 241 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a |
| la-voce-di-new-york | unreadable: WordPress API has no theater taxonomy and the post stream is 20k+ items | 33 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a |
| latimes | unreadable: site and robots.txt return HTTP 403 to the census client | 80 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a |
| lighting-and-sound-america | unreadable: no WordPress API; sitemap enumeration not yet configured | 309 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a |
| new-york-sun | unreadable: site answers HTTP 429/503/202 challenge pages to the census client | 168 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a |
| newyorker | unreadable: site and robots.txt return HTTP 403 to the census client | 135 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a |
| nydailynews | unreadable: site and robots.txt return HTTP 403 to the census client | 385 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a |
| nypost | unreadable: site and robots.txt return HTTP 403 to the census client | 413 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a |
| nytimes | unreadable: site and robots.txt return HTTP 403 to the census client | 995 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a |
| observer | unreadable: site and robots.txt return HTTP 403 to the census client | 163 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a |
| off-off-online | unreadable: no WordPress API; sitemap enumeration not yet configured | 146 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a |
| pages-on-stages | unreadable: no WordPress API; sitemap enumeration not yet configured | 175 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a |
| queerty | unreadable: WordPress API has no theater taxonomy and the post stream is 20k+ items | 30 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a |
| slantmagazine | unreadable: no WordPress API; sitemap enumeration not yet configured | 66 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a |
| talkinbroadway | unreadable: site and robots.txt return HTTP 403 to the census client | 545 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a |
| the-interested-bystander | unreadable: no WordPress API; sitemap enumeration not yet configured | 46 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a |
| theatrely | unreadable: site answers HTTP 429/503/202 challenge pages to the census client | 236 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a |
| thestage | unreadable: no WordPress API; sitemap enumeration not yet configured | 100 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a |
| timeout | unreadable: no WordPress API; sitemap enumeration not yet configured | 533 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a |
| times-square-chronicles | unreadable: site answers HTTP 429/503/202 challenge pages to the census client | 83 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a |
| usatoday | unreadable: site and robots.txt return HTTP 403 to the census client | 222 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a |
| vulture | sitemap-years: 2021: no URLs (blocked or empty; see log) | 605 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a |
| washpost | unreadable: no WordPress API; sitemap enumeration not yet configured | 254 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a |
| wsj | unreadable: site and robots.txt return HTTP 403 to the census client | 438 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | n/a |

## Bug classes found and fixed

Each fix has a test in `scripts/lib/outlet-census.test.mjs` or `scripts/lib/show-duplicate-detection.test.mjs`.

1. **Closed-show duplicate entries.** Two NYC shows existed twice (Going Bacharach, Clara: Sex, Love and Classical). The title-fragment duplicate detector missed them because one venue string carried an "@ building" tail and a leading "The". The detector now normalises both. The duplicates are retired by the pending fix plan `data/pending-fixes/bro-6481.json`.
2. **NY Theater ground-truth filter.** `outlet-ground-truth.js` only accepted slugs ending in "-review", which missed 86 of 317 held New York Theater reviews ("review-of-...", "...-review-and-photos"). It now accepts "review" anywhere in the slug.
3. **Regional and touring false gaps.** National outlets (Stage and Cinema, DC Theater Arts, OperaWire, The Recs) review touring and regional productions of Broadway titles. Those matched the Broadway show and read as gaps (DC Theater Arts showed 77). A matched item now needs an NYC signal, and an other-market headline (Kennedy Center, La Jolla, Old Globe, Guthrie and others) beats "Broadway" in the blurb. DC Theater Arts fell to 2 gaps, Stage and Cinema from 265 to 70.
4. **StageBuddy features read as reviews.** Its theater category mixes previews and interviews (`/theater-feature/`) with reviews; the census now reads `/theater-review/` URLs only.
5. **Word-boundary title match.** "Touch" matched "Innovative Touch". Short common-word titles now need the title as a standalone phrase.
6. **Subtitled titles in a held check.** A TheWrap "School Girls" review whose headline says "Lady Macbeth" read as a misfile to Macbeth, because the full title "School Girls; Or, The African Mean Girls Play" never appears whole. The held check now accepts the main title before ";", ":" or a spaced dash.

Round 2 (BRO-6485):

7. **Tour stops and concerts.** "North American Tour at SCFTA", the Ahmanson and Pantages, and "Broadway By The Year" concerts at Town Hall matched the Broadway show. Tour and venue terms now mark another market unless the text names Broadway, New York, NYC, Manhattan or Brooklyn.
8. **Archival film reviews.** Vulture slugs ending in a pre-2015 year ("beverly-hills-cop-1984") matched a current show of the same name. A slug-end year the show title does not carry now reads as not-review.
9. **Entity and site-name titles.** `&mdash;`, `&rsquo;` and friends were left encoded, and page titles carried the site name. Titles now decode named entities and strip exactly `og:site_name`; SERP titles strip only a suffix the outlet's results repeat, so "Theater Review - Hamlet" keeps "Hamlet".
10. **Silent SERP truncation.** Pagination stopped on any page under 10 results or when the URL filter rejected a whole page. It now stops on a short page (under 8) or a page with no new URLs, and notes when the page cap was hit.
11. **Time Out listings read as reviews.** Most `/newyork/theater/<show>` pages are listings with an unsigned blurb: 111 of the 119 round-2 Time Out gaps had no critic. Those pages count as reviews only when their JSON-LD Review names an author (`requireReviewAuthor`). Time Out recall moved from .632 to .889 on a local run.
12. **Same-titled shows at LA and Chicago houses.** Front Mezz Junkies' "Fountain Theatre's Fatherland" (Los Angeles) matched the off-Broadway Fatherland. The Fountain Theatre and Kokandy are now other-market terms.
13. **Ingest flood.** Round 2 dispatched 323 `ingest-urls.yml` runs at 12-second spacing. Each started its own scoring run and a rebuild, so 300+ runs sat queued for over an hour and every session's land run waited behind them. `scripts/dispatch-ingest-batch.js` now runs batches: it validates the whole plan first (URL shape, outlet id in the registry), ingests with `no_rebuild` only while the repo's queued+pending count is under a cap (15), checkpoints each show, then starts one `llm-ensemble-score` list run and one rebuild. Pure decisions live in `scripts/lib/ingest-batch-pacing.js` with tests.

The production matcher `findMatchingShows` is unchanged. The census adds its own dated title-variant stage on top, so these fixes cannot change live review routing.

## Results (CI run, 2026-10-28, review-texts corpus)

The CI run reads the review files themselves (flagged and unscored included), so recall is higher than the local run. 23 outlets were readable. 703 true gaps across 383 shows.

| Outlet | Recall | Held | Gaps |
|---|---|---|---|
| broadwaynews | 0.99 | 72 | 1 |
| variety | 0.98 | 146 | 2 |
| deadline | 0.98 | 94 | 2 |
| hollywood-reporter | 0.97 | 54 | 0 |
| nytg | 0.95 | 446 | 21 |
| nyt-theater | 0.95 | 315 | 16 |
| nysr | 0.93 | 671 | 50 |
| vulture | 0.91 | 292 | 27 |
| thewrap | 0.91 | 197 | 18 |
| theatermania | 0.89 | 473 | 66 |
| amny | 0.86 | 103 | 16 |
| culturesauce | 0.74 | 72 | 91 |
| exeunt-magazine | 0.71 | 200 | 83 |
| theatre-reviews-limited | 0.64 | 125 | 71 |
| stageandcinema | 0.53 | 66 | 64 |
| theater-pizzazz | 0.47 | 19 | 31 |
| stagebuddy | 0.31 | 55 | 131 |

T1 and T2 outlets sit at 0.86 to 0.99. The holes are in T3 (stagebuddy, culturesauce, exeunt, theatre-reviews-limited, stageandcinema).

## Results (round 2, CI, 2026-10-29, fixed matcher)

Recall is (held + alt) / (held + alt + gap + misfile), measured before the round-2 ingest. "New" marks an outlet the round-1 run could not read.

| Source | Outlet | Recall before |
|---|---|---|
| WordPress API | theatermania | 0.998 |
| | theater-scene, thewrap, variety, deadline, hollywood-reporter, amny, theatre-reviews-limited, the-recs, operawire, nyt-theater | 1.00 |
| | theater-life | 0.992 |
| | culturesauce | 0.997 |
| | stageandcinema | 0.992 |
| | stagebuddy (round 1: 0.31) | 0.989 |
| | nysr | 0.999 |
| | one-minute-critic | 0.98 |
| | komisar | 0.979 |
| | theater-pizzazz | 0.891 |
| | pages-on-stages (new) | 0.826 |
| | frontmezzjunkies (new) | 0.346 |
| | dc-theater-arts | 0 (2 items, both gaps) |
| Sitemap | nytg | 0.998 |
| | broadwaynews | 1.00 |
| | dailybeast (new) | 0.991 |
| | timeout (new) | 0.632, 0.889 after bug class 11 |
| | interested-bystander (new) | 0.638 |
| | thestage (new) | 0.571 |
| | off-off-online (new) | 0.534 |
| Site-scoped SERP | nypost, ew, observer, guardian, latimes, new-york-sun (new) | 1.00 |
| | nytimes (new) | 0.961 |
| | nydailynews (new) | 0.958 |
| | usatoday (new) | 0.938 |
| | chicagotribune (new) | 0.90 |
| | wsj (new) | 0.882 |
| | theatrely (new) | 0.866 |
| | talkinbroadway (new) | 0.823 |
| | newyorker (new) | 0.75 |
| | front-row-center (new) | 0.741 |
| | washpost (new) | 0.50 (1 held, 1 gap) |
| | broadway-and-me (new) | 0.20 |
| | cititour (new) | 1.00 (page cap hit) |

SERP recall is a floor on what the search engine indexes, and several SERP runs hit the page cap, so their recall covers only the pages read. Exeunt was measured by another worker (0.743).

Still unmeasurable:
- times-square-chronicles: all 36 items read were news or features, none a review.
- queerty: all 64 theater items were news; it has no review taxonomy.
- la-voce-di-new-york: the theater feed returned no items.
- lighting-and-sound-america: one held review and nothing enumerable (design features, not reviews).
- slantmagazine: the sitemap answers 403, also from CI.
- dtli: an aggregator, not an outlet; its pages link out rather than hold reviews.

Ingest: the vetted gap list was 409 reviews across 323 shows from the WordPress and sitemap sources, plus 40 reviews across 40 shows from SERP sources (a movie review, a two-show roundup and a news item dropped while vetting). The largest shares: frontmezzjunkies 186, off-off-online 132, pages-on-stages 30, thestage 22, theatrely 12, talkinbroadway 11. Spend: about 4,465 ScrapingDog credits for SERP (about $0.40 prepaid), plus ingest fetches and Gemini scoring estimated at $1 to $3. Well under the $20 cap.

### After ingest (CI re-measure, 2026-10-29, WordPress and sitemap outlets)

Run on CI after the round-2 ingest batch had written its review files (run 40864937174).

| Outlet | Recall before | Recall after | Gaps left |
|---|---|---|---|
| frontmezzjunkies | 0.346 | 0.99 | 3 |
| off-off-online | 0.534 | 0.973 | 7 (300 of 776 page fetches failed this run, so its count is partial) |
| thestage | 0.571 | 0.964 | 2 |
| the-interested-bystander | 0.638 | 0.712 | 19, nearly all multi-show roundup posts, which the roundup rule excludes by design |
| pages-on-stages | 0.826 | 0.985 | 3 |
| theater-pizzazz | 0.891 | 1.00 | 0 |
| dc-theater-arts | 0 | 1.00 | 0 |
| komisar | 0.979 | 1.00 | 0 |
| one-minute-critic | 0.98 | 0.993 | 1 |
| stagebuddy, stageandcinema, culturesauce, dailybeast, theatermania, nysr | 0.989 to 0.999 | 1.00 | 0 |
| timeout | 0.632 (0.889 after bug class 11) | 0.989 (after the JSON-LD critic fix landed) | 2 |
| theater-life | 0.992 (measured from a cloud session) | not measurable on CI: theaterlife.com refuses GitHub Actions runners (two runs, `fetch failed`) while answering a cloud session; its 4 gaps were ingested | |

### After ingest (CI re-measure, 2026-10-29, SERP outlets)

Run 40953189047, after the 40 SERP-found reviews (40 shows) were ingested through `scripts/dispatch-ingest-batch.js`. SERP enumeration samples a different result set each run (page cap 5 per quarter-query), so these are lower bounds, not exact before/after pairs.

| Outlet | Recall before | Recall after | Gaps left |
|---|---|---|---|
| talkinbroadway | 0.823 | 0.983 | 1 |
| broadway-and-me | 0.2 | 0.9 | 0 gaps, 1 misfile |
| chicagotribune | 0.9 | 0.929 | 2 (INCOMPLETE, page cap hit) |
| front-row-center | 0.741 | 0.879 | 3 gaps, 1 misfile |
| theatrely | 0.866 | 0.879 | 4 (INCOMPLETE, page cap hit; this run surfaced results the first did not) |
| washpost | 0.5 | 1.00 | 0 |

## Fixes applied (pending-fix plans)

- `bro-6481-2`: Illinoise and Clara misfile moves failed at apply time because the plan used `destinationPath`; the executor reads only `destPath`. Retried as `bro-6481-4`.
- `bro-6481-3`: catalog adds for notable shows (2+ T1/T2 outlets, or 1 T1 plus 2 others, Playbill-validated, `discoverySource` tagged). 17 shows added; 8 refused as already present (another session had added them).
- `bro-6481-4`: NYTG Illinoise review moved to `illinoise-off-broadway-2024`; Theater Pizzazz Clara review moved to the canonical Clara id and the duplicate id retired; the wrong-year TheWrap Titanique file deleted (a URL edit was refused as not provably wrong), its 2026 URL reingested.
- Guards so the `destinationPath` mistake cannot recur: `new-fix-plan.js` refuses a move without `destPath`, and the shared plan-shape check (`pending-fix-plan-checks.js`) refuses it and any unknown review-file operation before land.

## Ingest

Gaps go through `ingest-urls.yml`, one run per show. For more than a handful of shows use `node scripts/dispatch-ingest-batch.js --plan=<file>` (bug class 13): it paces the ingests and scores the whole batch in one run at the end. `--dry-run` validates the plan without dispatching.

- Pilot, 5 shows, 22 URLs: 16 targeted files landed, 13 complete and scored. Two were excluded by existing guards (a NYTG ticket page, a NYT audio-play review). Cost: 36 ScrapingDog credits plus scoring, well under $1.
- Batch 2: the 28 shows with a T1 gap, vetted by hand first. Vetting found census false positives (below), so 25 shows and 96 URLs went in.
  All 25 ingest runs concluded success (four had an ambiguous waiter, exit 2, and were confirmed by run id). Spot checks on CI: Kimberly Akimbo now holds TheWrap, NYTG, TheaterMania and Vulture, complete and scored; Henry IV holds Vulture and NYT, scored. Cost: 195 ScrapingDog credits (a few cents) and about $0.22 of Gemini scoring.
- Titanique 2026: the TheWrap file held the 2022 off-Broadway review. Plan bro-6481-4 deleted it and a reingest added the 2026 review, which the anticipatory-post guard flagged because its publishDate came back null. Plan bro-6481-5 sets the page's datePublished (2026-04-13, the day after opening), clears the flag, and deletes a 0-char leftover of the 2022 URL.
- Remaining gaps (about 570, mostly T3) are left for a re-run of the census with the fixed matcher, then a vetted batch. Total BRO-6481 spend stays under the $20 cap.

### Matcher false positives found while vetting (fixed)

- One-word cuts of longer titles: "David, A New Musical" became "David" and matched "David Geffen Hall" and a Vulture piece by David Denby; "Empire: The Musical" matched "Empire Records". The variant stage now needs the cut word to stand alone (punctuation, end, lowercase word, or the title's next word follows it).
- Undated shows: `counting-and-cracking-off-broadway-2026` has no dates yet, so every review counted as in its run, including the 2024 NYU Skirball production. The run window now uses the id year as a floor.
- Not fixed in the matcher: an LA production (East West Players Assassins) and news posts at review-tagged URLs. They were dropped by hand; ingest's own wrong-production guards also catch most.

## Catalog candidates not added

Listed for an owner call, not added: Encores! Bat Boy and High Spirits (no Encores precedent in the catalog), Rob Lake, Melissa Etheridge: My Window, Jeff Ross, the 2024 NYU Skirball run of Counting and Cracking, shows Playbill lists without dates, and 12 shows whose Playbill record did not match our title or year.

## Census-side limits

- `culturesauce`: 185 of its 244 held reviews are under the `.net` domain while the API lists `.com`, so they land in held-alt-url.
- `theater-pizzazz` (204 not enumerated) and `the-recs` (43): reviews outside the category the census reads.
- `variety`: enumerated fewer items than we hold (292 vs 624), because the `/legit/reviews/` vertical only reaches back part of the window.
- Vulture is configured through its yearly sitemaps, but they answered 403 to the cloud session, so its local recall is n/a. The CI run may read them.

## Unreadable outlets

Round 1 listed 29 outlets here. Round 2 read all but the six listed under "Still unmeasurable" above: the 403 and challenge-page outlets through a site-scoped, date-windowed SERP, and the rest through WordPress APIs or sitemaps.

## Follow-ups

- Re-run the census on CI after each ingest batch to measure the recall change, and vet each batch's URLs against the show's dates before ingest.
- Round-2 ingest went in for every listed gap and was re-measured on CI (tables above). The 10 SERP gaps left (front-row-center, theatrely, chicagotribune, talkinbroadway) are new results the re-measure surfaced, so a third pass would find more; SERP recall only converges with repeated sampling.

## London (BRO-6488)

`--market=london` runs the same census against the West End market (shows.json
`market: west-end`, categories `west-end` and `off-west-end`, 1,343 shows),
writing to `data/audit/outlet-census/london/`. Sources live in
`LONDON_SOURCES` in `scripts/lib/outlet-census-sources.js`; window defaults to
`--since=2012-09-01`.

```bash
node scripts/outlet-census.js --market=london --outlet=whatsonstage
node scripts/outlet-census.js --market=london --tier=1          # all T1 outlets
node scripts/outlet-census.js --market=london --summary         # tables + catalog gaps
node scripts/outlet-census.js --market=london --probe=https://example.com/sitemap.xml
```

Extra pieces:

- **Other-market reviews.** A review whose text or slug names a regional or
  touring UK venue/city (`UK_OTHER_RE`) and no West End house is bucketed
  `other-market-review` with `itemMarket` (regional / touring / edinburgh). It
  never counts as a gap or out-of-window. The manifest keeps every review
  whatever the market (owner scope, 2026-10-28).
- **Catalog-gap summary.** `--summary` groups catalog gaps by market and place
  (Off-West End by venue, regional by city or venue, touring) and by year, with
  the review count each would bring (`groupCatalogGaps`,
  `catalog-gaps.json`). New shows outside the West End historical scope are not
  added.
- **Article-number aliasing.** `urlId` on a source extracts a stable article id
  from the URL. WhatsOnStage moved `/london-theatre/reviews/<slug>_43290.html`
  to `/news/<slug>_43290/`; held rows under the old URL now match by id.
- **CI hand-back.** UK newspapers (Guardian API, Telegraph, Times, Standard,
  FT, Mail, Independent, i, Express, Spectator) are blocked by the cloud
  container's egress, so they enumerate on CI with
  `--emit-items --enumerate-only`. The run prints gzip+base64
  `CENSUS-ITEMS <outlet> i/n <chunk>` lines (20k chunks); save the
  `cloud-run-script.js` stdout and bucket locally with
  `--items-in=<file>` against the full review-texts. `--source='<json>'`
  overrides a source definition for one run (regex strings become `i` RegExps)
  so a sitemap shape can be tried without re-landing.
- **Seasons.** Reports carry a per-season (Sep-Aug) breakdown; `--summary`
  prints the per-outlet, per-season table.
- **Headline guards (London only).** `titleOnlyInTagline` drops a match whose
  title words appear only after "review" (Misty's tagline naming Stories);
  `venueContradicts` drops a match whose headline names another house right
  after the title (Aladdin at Hackney Empire is a panto, not the Prince Edward
  run; recorded as `venueMismatchIds`, not out-of-window). An all-lowercase slug
  headline must lead with a short title variant ("this beautiful future" is not
  Beautiful). A venue counts only when a distinctive word or a self-named house
  (Playhouse, Coliseum, Palladium, Empire, opera house) comes before the noun,
  so "Hamlet, theatre review" names no house; renamed houses alias (Comedy
  and Harold Pinter). Shows already holding the URL are exempt; venue words
  compare by stem; "National" covers Olivier, Lyttelton and Dorfman. Measured on the full
  London cache: about 230 false gaps and ambiguous rows left the gap count, and
  3 held rows lost their match (date edge cases, not the guards).

### London results (2026-10-29, cached enumeration, review-texts corpus)

| Outlet | Source | Corpus rows | Enumerated | Held | Held (other URL) | Gap | Misfile | Ambiguous | Catalog gap | Other market | Recall |
|---|---|---|---|---|---|---|---|---|---|---|---|
| britishtheatrecom | sitemap | 174 | 2438 | 76 | 58 | 204 | 0 | 3 | 717 | 576 | 0.396 |
| west-end-best-friend | sitemap | 188 | 2779 | 151 | 13 | 241 | 0 | 3 | 637 | 831 | 0.405 |
| british-theatre | sitemap | 399 | 25623 | 104 | 282 | 530 | 0 | 383 | 2652 | 3419 | 0.421 |
| everything-theatre | wp-json | 238 | 6635 | 200 | 25 | 111 | 0 | 5 | 2170 | 329 | 0.67 |
| theatre-weekly | wp-json | 308 | 4425 | 219 | 42 | 112 | 2 | 1 | 878 | 2006 | 0.696 |
| all-that-dazzles-uk | sitemap | 369 | 2413 | 287 | 30 | 137 | 0 | 1 | 804 | 277 | 0.698 |
| london-theatre | sitemap | 724 | 3193 | 552 | 185 | 220 | 0 | 190 | 610 | 32 | 0.77 |
| artsdesk | sitemap | 576 | 3872 | 279 | 33 | 51 | 3 | 2 | 736 | 201 | 0.852 |
| whatsonstage | wp-json | 932 | 38828 | 650 | 64 | 76 | 6 | 1 | 1138 | 1220 | 0.897 |
| thestage | composite | 866 | 5031 | 389 | 33 | 26 | 4 | 2 | 1288 | 1951 | 0.934 |
| london-box-office | sitemap | 740 | 1585 | 475 | 17 | 11 | 5 | 0 | 176 | 14 | 0.969 |
| timeout-london | sitemap | 782 | 12279 | 323 | 26 | 8 | 2 | 1 | 2 | 11 | 0.972 |
| thereviewshub | wp-json | 455 | 10330 | 243 | 2 | 1 | 3 | 0 | 1 | 1 | 0.984 |

Recall = (held + held other URL) / (held + held other URL + gap + misfile).
Low recall on the blog-tier outlets (British Theatre Guide, West End Best
Friend, britishtheatre.com) is mostly real coverage we never ingested;
British Theatre Guide's undated slug headlines also leave 383 ambiguous rows.
Catalog gaps are grouped in `catalog-gaps.json`; most have no venue in the
headline, so "unknown venue" is the largest Off-West End group.

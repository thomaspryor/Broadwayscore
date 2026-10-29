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
node scripts/cloud-run-script.js --review-texts scripts/outlet-census.js --all --print-gaps
```

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

## Fixes applied (pending-fix plans)

- `bro-6481-2`: Illinoise and Clara misfile moves failed at apply time because the plan used `destinationPath`; the executor reads only `destPath`. Retried as `bro-6481-4`.
- `bro-6481-3`: catalog adds for notable shows (2+ T1/T2 outlets, or 1 T1 plus 2 others, Playbill-validated, `discoverySource` tagged). 17 shows added; 8 refused as already present (another session had added them).
- `bro-6481-4`: NYTG Illinoise review moved to `illinoise-off-broadway-2024`; Theater Pizzazz Clara review moved to the canonical Clara id and the duplicate id retired; the wrong-year TheWrap Titanique file deleted (a URL edit was refused as not provably wrong), its 2026 URL reingested.
- Guards so the `destinationPath` mistake cannot recur: `new-fix-plan.js` refuses a move without `destPath`, and the shared plan-shape check (`pending-fix-plan-checks.js`) refuses it and any unknown review-file operation before land.

## Ingest

Gaps go through `ingest-urls.yml`, one run per show, which scores new files with the LLM ensemble.

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

HTTP 403: nytimes, talkinbroadway, wsj, nypost, ew, chicagotribune, guardian, observer, newyorker, nydailynews, usatoday, latimes (and vulture's sitemaps from a cloud session).
Challenge pages (429/503/202): theatrely, broadway-and-me, new-york-sun, times-square-chronicles, front-row-center.
No theater taxonomy: la-voce-di-new-york, queerty.
No WordPress API and no sitemap configured yet: timeout, washpost, dailybeast, pages-on-stages, off-off-online, lighting-and-sound-america, cititour, frontmezzjunkies, slantmagazine, thestage, the-interested-bystander, dtli.

## Follow-ups

- Configure sitemaps for the "not configured" outlets above; most have one.
- Re-run the census on CI after each ingest batch to measure the recall change, and vet each batch's URLs against the show's dates before ingest.

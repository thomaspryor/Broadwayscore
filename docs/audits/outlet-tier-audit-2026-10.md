# Outlet tier audit, October 2026 (BRO-4907)

Audit and proposal only. `src/config/outlet-tiers.json` is unchanged by this work; the owner decides which moves to adopt.

- Per-outlet data: [`outlet-tier-audit-2026-10.csv`](outlet-tier-audit-2026-10.csv) (297 rows)
- Justifications and proposed tiers (input to the CSV): [`outlet-tier-audit-2026-10.justifications.json`](outlet-tier-audit-2026-10.justifications.json)
- Script: `scripts/audit-outlet-tiers.js`, pure helpers in `scripts/lib/outlet-tier-audit.js`, test `tests/unit/outlet-tier-audit.test.mjs`
- Data snapshot: core data repo at d072dca (2026-10-06), `data/reviews.json` with 23,068 reviews from 754 outlet ids

Regenerate:

```
node scripts/audit-outlet-tiers.js --stats-out=/tmp/stats.json
node scripts/audit-outlet-tiers.js --justifications=docs/audits/outlet-tier-audit-2026-10.justifications.json \
  --csv=docs/audits/outlet-tier-audit-2026-10.csv --impact-out=/tmp/impact.json
```

## Scope

Every outlet configured in `src/config/outlet-tiers.json` (130) plus every other outlet id with at least 5 reviews (167). The 167 are not "default T3" as the card assumed: all of them already carry a tier in `data/outlet-registry.json` (160 at T3, 7 at T4), which `compute-critic-score.js` reads after the config. The CSV's `tierSource` column says which file each current tier comes from.

Tier weights: T1 1.00, T2 0.75, T3 0.40, T4 0.20. Named top critics (`TOP_CRITICS` in `scripts/lib/compute-critic-score.js`, e.g. Charles Isherwood, Adam Feldman, Johnny Oleksinski) count as T1 wherever they publish, so an outlet's tier only governs its other critics.

## Volume method and the recency correction

The corpus is not evenly spread over time:

| Year | 2015 | 2016 | 2017 | 2018 | 2019 | 2020 | 2021 | 2022 | 2023 | 2024 | 2025 | 2026 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Reviews | 1,069 | 974 | 1,284 | 1,233 | 972 | 136 | 392 | 1,127 | 1,086 | 1,515 | 1,801 | 5,559 |

2026 alone holds a quarter of all dated reviews (regional and West End expansion plus current ingestion). Raw counts therefore reward whoever is active now. Metrics per outlet:

- `total`, `dated`, `undated`: undated reviews (2,520 corpus-wide) count in totals but in no time-based metric.
- `first`, `last`, `activeYears`: activeYears is the number of calendar years with at least one dated review.
- `meanPerYear`, `medianPerYear`: over active years.
- `medianPerMonth`: over every month from the outlet's first to last review, months with zero reviews included, so gaps count.
- `normalizedShare`: for each year from the outlet's first to last review, divide the outlet's count by the corpus total for that year, then take the mean. Years in the span where the outlet published nothing count as 0. Years where the whole corpus has fewer than 100 dated reviews (everything before 2006) are skipped, because one review in a year with 8 corpus reviews would read as a 12% share. This keeps 2026's volume from dominating, and an outlet active only in the thin 2020-21 years is measured against those years' small totals instead of being penalized for COVID.
- `share2015_19`: the outlet's pooled count in 2015-2019 divided by the corpus count in those years (a stable pre-expansion baseline).
- `share2022plus`: the same for 2022 onward.
- `nycReviews`, `londonReviews`: reviews on NYC-tier shows (Broadway, Off-Broadway, tours and US regional, all of which score with an outlet's NYC tier) vs London (West End, Off-West End) shows, which decides whether a regional split matters.

Caveat: normalizedShare is generous to short-lived outlets by design. An outlet with 18 reviews all in 2011 reads 3.4% because 2011's corpus was small. Use the two window shares to compare outlets of different ages.

The correction changes the picture. Raw rank against 2015-2019 baseline rank for the 15 biggest outlets:

| Outlet | Reviews | Share 2015-19 | Share 2022+ | Raw rank | Baseline rank |
|---|---|---|---|---|---|
| New York Times | 878 | 3.16% | 2.55% | 1 | 1 |
| Variety | 625 | 2.86% | 1.51% | 2 | 3 |
| New York Stage Review | 615 | 2.48% | 3.96% | 3 | 10 |
| Vulture | 524 | 2.84% | 2.07% | 4 | 5 |
| Theater Life | 516 | 1.99% | 2.00% | 5 | 19 |
| TheaterMania | 513 | 1.86% | 2.80% | 6 | 21 |
| BroadwayWorld | 503 | 1.81% | 3.17% | 7 | 24 |
| Time Out New York | 498 | 2.87% | 1.71% | 8 | 2 |
| Talkin' Broadway | 464 | 2.22% | 1.79% | 9 | 14 |
| Wall Street Journal | 450 | 2.33% | 1.56% | 10 | 12 |
| Guardian | 442 | 2.15% | 2.45% | 11 | 16 |
| Theater Scene | 436 | 1.83% | 2.58% | 12 | 22 |
| Entertainment Weekly | 435 | 2.77% | 1.05% | 13 | 7 |
| Hollywood Reporter | 407 | 2.84% | 0.34% | 14 | 4 |
| TheWrap | 388 | 2.60% | 1.61% | 15 | 8 |

On the baseline the T1 trades (Time Out, Hollywood Reporter, Variety) sit near the top, while the high-volume T2 specialist sites drop. Their raw lead comes from recent ingestion. Volume confirmed the current T1/T2 line rather than arguing against it.

The Hollywood Reporter's fall from 28 reviews in 2019 to 3-8 a year since 2023 is a likely collection gap, not a tier question. Filed as BRO-4927.

## How each tier was judged

Rubric applied to every row (1-3 sentence justification in the CSV):

- T1: national or international publications with staff critics whose reviews are read as the verdict.
- T2: established professional outlets with paid or long-serving recognized critics and editorial oversight.
- T3: smaller professional or semi-pro outlets, local papers, multi-contributor specialist sites with an editor.
- T4: single-author or hobby blogs and incidental coverage, with no aggregator pickup and no recognized-critic status.

Default is keep. Volume is one input. Defunct outlets keep the tier that matched their standing when they published. Justifications were drafted per outlet, then every proposed move was fact-checked against the web on 2026-10-09. Moves whose key fact could not be confirmed were withdrawn (see below). Sources for checked claims are in the CSV `sources` column. Justifications without sources rest on general knowledge of the outlet plus the review data.

## Proposals

8 moves out of 297 outlets. The other 289 keep their current tier.

Score impact is simulated: `scripts/lib/compute-critic-score.js` (the scorer behind the published `cs`) runs on `data/reviews.json` twice per show, once with the current config and once with an in-memory copy carrying the move. The config file is never written. "Shows moved" counts shows whose unrounded score changes. "Displayed change" counts shows whose rounded score changes by at least one point. On the current config this simulation matches the published score (`public/data/shows/{id}.json:cs`, the field `getCriticScore` reads) exactly for 768 of 1,151 shows and within 1 point for 1,081 (94%). The gap is most likely data timing: the audit used the 2026-10-06 `reviews.json` snapshot while the published files were rebuilt on 2026-10-09. Each delta compares the same inputs with and without the move, so absolute numbers can be off by about a point while the direction and size of each shift hold. Impact counts also include shows the site hides (announced, or reviews hidden), so they run slightly high.

`scripts/scoring-delta.js` was not used for impact. It replays review inclusion and score-source logic, and a tier weight change moves neither.

| Outlet | Change (NYC/London) | Shows moved | Displayed change | Max shift | Why |
|---|---|---|---|---|---|
| Broadway News | T1/T2 to T2/T2 (down in NYC) | 131 | 15 | 0.5 | Trade news site. Its T1 critic Isherwood left for the WSJ in 2022 and stays T1 through the top-critic list. Remaining reviewers fit T2. |
| Everything Theatre | T2/T2 to T2/T3 (down in London) | 111 | 48 | 6.1 | Self-described 100% volunteer-run collective. |
| Theater Pizzazz | T4 to T3 (up) | 172 | 23 | 1.3 | Editor/publisher, about 18 contributing writers including established critics, 177 NYC reviews. |
| DC Theater Arts | T4 to T3 (up) | 22 | 5 | 2.4 | Renamed DC Metro Theater Arts, whose old id is already T3. |
| Express (UK) | T4/T4 to T4/T3 (up in London) | 15 | 4 | 0.4 | National daily with professional critics. |
| South London | T4 to T3 (up) | 16 | 1 | 0.3 | Local news publisher (Southwark News group) with bylined reviews. |
| ReviewsGate | registry T4 to T3 (up), adds a config entry | 5 | 2 | 0.3 | Defunct multi-contributor UK review site with veteran critics. |
| Medium | T3 to T4 (down) | 19 | 1 | 0.5 | Self-publishing platform; individual posts, no editorial oversight. |

All 8 together: 406 shows move, 92 change their displayed score by at least one point, the largest shift is 6.1 points, and the mean absolute shift is 0.3. Most of the biggest movers are small London shows, driven by Everything Theatre. Beetlejuice's tour moves because of the DC Theater Arts promotion:

| Show | Published | Before (sim) | After (sim) | Shift |
|---|---|---|---|---|
| The Uncontainable Nausea of Alec Baldwin (Off-West End) | 55 | 55.2 | 49.1 | -6.1 |
| The Guy Who Didn't Like Musicals (West End) | 70 | 70.2 | 66.7 | -3.5 |
| Age Is a Feeling (Off-West End) | 78 | 77.4 | 74.1 | -3.3 |
| Eggs Aren't That Easy to Make (Off-West End) | 57 | 57.1 | 60.4 | +3.3 |
| Beetlejuice (tour) | 80 | 77.0 | 74.6 | -2.4 |
| Dear Liar (Off-West End) | 65 | 64.9 | 62.8 | -2.1 |

On Broadway, 216 shows move, none by more than 0.8 (Walking with Ghosts, 2022).

### Unconfigured outlets that should be configured

Only ReviewsGate needs a config entry, because it moves. The other 166 high-volume unconfigured outlets keep their registry tier. Their justifications are in the CSV.

### Regional splits

No new regional splits are proposed. Everything Theatre and Express (UK) move only their London tier and review only London shows, so the split is a formality. Existing splits (NYT, Variety, Vulture, WSJ, Washington Post, The Stage, the London nationals and others) were reviewed and kept.

### Considered and not proposed

- Daily Mail and Observer (London T1 to T2), Time Out New York (NYC T1 to T2), Time Out London (London T1 to T2). These first came up because the audit rubric's example list put them at T2, which is a property of the rubric, not evidence about the outlets. Time Out in both cities has long-serving chief critics and is a leading voice, so it stays T1. Daily Mail and Observer are owner calls with no new evidence: the Observer changed ownership in 2025 and its long-time critic retired.
- The Reviews Hub and Theatre Weekly (T2 to T3) and The Broadway Blog (NYC T2 to T3). Each rested on a "mostly volunteer" or "inactive" claim the fact-check could not confirm.
- British Theatre (T2 to T3). The id mixes two sites: 48 of 98 rows link to British Theatre Guide and 9 to BritishTheatre.com. A demotion aimed at the smaller site would also hit the established one. The id needs splitting first (BRO-4926).

## Data issues found

- `dtli`: all 40 rows link to didtheylikeit.com, an aggregator, so they are filed under a fake outlet. BRO-4926.
- `british-theatre`: two different sites under one id (above). BRO-4926.
- `observer`: one id holds the New York Observer (observer.com, NYC rows) and the UK Observer (observer.co.uk and theguardian.com, London rows). The nyc2/lon1 split handles this correctly for now.
- Hollywood Reporter coverage gap since 2023. BRO-4927.

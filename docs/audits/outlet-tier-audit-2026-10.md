# Outlet tier audit, October 2026 (BRO-4907)

Audit plus adoption. The owner asked for a deeper research pass before changing tiers; this document records that pass and the 57 moves it supports.

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

### Round 0 (first pass, superseded)

The first pass drafted justifications largely from general knowledge and proposed 8 moves. The owner judged that too shallow, so every row was redone with the method below. Three first-pass moves did not survive: Broadway News (NYC T1 to T2), Medium (T3 to T4) and the ReviewsGate reasoning were all overturned by evidence (see "Considered and not moved").

### Evidence signals (computed, `--signals-out`)

`scripts/lib/outlet-tier-audit.js computeQualitySignals` adds three non-volume measures per outlet:

- Show Score pickup: share of the outlet's reviews that Show Score also lists, counted only on shows whose Show Score critic list is complete (list length at least `criticReviewCount`). Ignored under 15 eligible reviews. Show Score covers London thinly, so low London pickup is weak evidence.
- Consensus gap and bias: mean absolute and signed difference between the outlet's score and the mean of the other T1/T2 outlets on the same show (at least 3 peers, one score per outlet per show). A bias above about +6 with a gap well above the T1/T2 reference range flags promotional or fan writing. Ignored under 15 shows.
- Critic crossover: share of the outlet's reviews by critics who also have 3+ reviews at a different T1/T2 outlet.

### Research rounds

1. Round 1: all 297 rows split into 8 batches. Each research agent had to look up, for every outlet, what it is (owner, active or defunct), its editorial model (staff, paid, volunteer, single author, quoting the site's own about or staff page), its critics' credentials (Drama Desk, Outer Critics Circle, NY Drama Critics' Circle, ATCA, UK Critics' Circle drama section) and outside recognition (Show Score, Did They Like It, BroadwayWorld roundups, London aggregators). Every factual claim needed a source URL. Tier definitions were given without example outlet lists, and citing another outlet's tier as a reason was forbidden. Default was keep; a two-tier move needed overwhelming evidence.
2. Round 2 verify: the 22 low-confidence rows with 30+ reviews were re-researched by two fresh agents.
3. Round 2 challenge: the 23 proposed moves with the most reviews were handed to two agents told to argue against each move. The decisive new sources were the Outer Critics Circle roster (outercritics.org/critics/) and the UK Critics' Circle drama member list (criticscircle.org.uk/drama/drama-members/), which round 1 had not checked. 20 moves were confirmed, 3 withdrawn.

Final confidence across 297 rows: 62 high, 176 medium, 59 low. Low-confidence rows keep their tier (one low-confidence move, `londonlivinglarge` London T3 to T4, was dropped for that reason).

Limits: the research agents hit search caps, and several sources were unreachable (the Drama Desk voter list, the Wayback Machine at times, some defunct sites), so some rows rest on fewer sources than intended. The CSV `sources` column lists what each row rests on.

## Moves

57 moves out of 297 outlets: 12 promotions, 45 demotions. Most demotions are single-author or incidental-coverage blogs with few reviews each. Score impact is simulated as in the first pass: `scripts/lib/compute-critic-score.js` on `data/reviews.json`, current config versus an in-memory copy with the moves (the simulation matches published `cs` within 1 point for 94% of shows, so read deltas as relative).

All 57 together: 716 shows move, 248 change their displayed score by at least one point, the largest shift is 6.1 points and the mean absolute shift is 0.44. On Broadway the largest is Girl from the North Country (2022), 80.2 to 83.9; every other Broadway show moves less than 1.8.

Largest show shifts:

| Show | Published | Before (sim) | After (sim) | Shift |
|---|---|---|---|---|
| The Uncontainable Nausea of Alec Baldwin (Off-West End) | 55 | 55.2 | 49.1 | -6.1 |
| This Is Not Not a Drill (Off-Broadway) | unpublished | 80.0 | 75.1 | -4.9 |
| Soon (Off-Broadway) | 57 | 49.4 | 54.1 | +4.8 |
| Perfect Crime (Off-Broadway) | 58 | 58.1 | 62.8 | +4.6 |
| Girl from the North Country (Broadway 2022) | 81 | 80.2 | 83.9 | +3.7 |
| Becoming Hamlet (Off-Broadway) | 56 | 56.2 | 52.7 | -3.5 |

Per move (sorted by shows moved):

| Outlet | Change | Confidence | Shows moved | Displayed change | Max shift |
|---|---|---|---|---|---|
| Front Row Center (`front-row-center`) | NYC T2 to T3 | medium | 364 | 97 | 4.9 |
| Theater Pizzazz (`theater-pizzazz`) | NYC T4 to T3 | high | 172 | 23 | 1.3 |
| Everything Theatre (`everything-theatre`) | London T2 to T3 | high | 111 | 48 | 6.1 |
| Theatre Weekly (`theatre-weekly`) | London T2 to T3 | medium | 96 | 31 | 2.1 |
| Off Off Online (`off-off-online`) | NYC T4 to T3 | high | 60 | 24 | 4.8 |
| Times Square Chronicles (`times-square-chronicles`) | NYC T4 to T3 | medium | 59 | 6 | 1.4 |
| Broadway & Me (`broadway-and-me`) | NYC T4 to T3 | medium | 42 | 2 | 0.4 |
| A Youngish Perspective (`a-youngish-perspective`) | London T3 to T4 | high | 37 | 10 | 2.1 |
| readaboutstuff (`readaboutstuff`) | London T3 to T4 | medium | 33 | 1 | 0.6 |
| Gotham Playgoer (`gotham-playgoer`) | NYC T3 to T4 | high | 30 | 1 | 0.2 |
| London Theatre Reviews (`london-theatre-reviews`) | London T3 to T4 | medium | 24 | 4 | 0.5 |
| DC Theater Arts (`dc-theater-arts`) | NYC T4 to T3 | high | 22 | 5 | 2.4 |
| Monstagigz (`monstagigz`) | London T3 to T4 | high | 22 | 5 | 2.5 |
| First Night Magazine (`firstnightmagazine`) | London T3 to T4 | medium | 21 | 5 | 3.5 |
| Bob's Theater Blog (`bobs-theater-blog`) | NYC T3 to T4 | medium | 19 | 4 | 0.2 |
| The Contending (`the-contending`) | NYC T3 to T4 | medium | 19 | 1 | 0.2 |
| Theatre Vibe (`theatre-vibe`) | London T4 to T3 | medium | 18 | 3 | 0.4 |
| Jonathan Baz (`jonathan-baz`) | London T3 to T4 | medium | 17 | 0 | 0.5 |
| Act Three: The Reviews (`act-three-the-reviews`) | NYC T3 to T4 | medium | 16 | 4 | 0.3 |
| South London (`south-london`) | London T4 to T3 | medium | 16 | 1 | 0.3 |
| Londontheatredirect (`londontheatredirect`) | London T3 to T4 | high | 16 | 2 | 0.5 |
| Express  (UK) (`express-uk`) | London T4 to T3 | medium | 15 | 4 | 0.4 |
| As Her World Turns (`as-her-world-turns`) | NYC T3 to T4 | medium | 13 | 1 | 0.2 |
| BackStage Barbie (`backstage-barbie`) | NYC T3 to T4 | high | 13 | 1 | 0.2 |
| Labor Press (`labor-press`) | NYC T3 to T4 | medium | 12 | 0 | 0.1 |
| Melinda's Malarky (`melindas-malarky`) | NYC T3 to T4 | high | 11 | 2 | 0.3 |
| Film Festival Traveler (`film-festival-traveler`) | NYC T3 to T4 | medium | 11 | 0 | 0.2 |
| Vox (`vox`) | NYC T2 to T3 | medium | 9 | 3 | 0.5 |
| Fordham Observer (`fordham-observer`) | NYC T3 to T4 | medium | 8 | 0 | 0.2 |
| Pinkprincetheatre (`pinkprincetheatre`) | London T3 to T4 | medium | 8 | 2 | 1.1 |
| Unmissabletheatre (`unmissabletheatre`) | London T3 to T4 | high | 8 | 1 | 0.2 |
| Magical Misstari Tour (`magical-misstari-tour`) | NYC T3 to T4 | high | 7 | 1 | 0.3 |
| Onin (`onin`) | London T3 to T4 | medium | 7 | 2 | 0.3 |
| Viewfromthegods (`viewfromthegods`) | London T3 to T4 | medium | 7 | 1 | 0.4 |
| Theater In The Now (`theater-in-the-now`) | NYC T3 to T4 | medium | 6 | 0 | 0.1 |
| 4Columns (`4columns`) | NYC T3 to T2 | medium | 6 | 1 | 1.8 |
| Aaron in NYC (`aaron-in-nyc`) | NYC T3 to T4 | medium | 6 | 2 | 1.2 |
| Splash Magazines (`splash-magazines`) | NYC T3 to T4 | medium | 6 | 1 | 0.4 |
| The Globe and Mail (`the-globe-and-mail`) | NYC T3 to T2 | medium | 6 | 2 | 0.9 |
| Theatre Bee (`theatre-bee-uk`) | London T3 to T4 | medium | 5 | 3 | 0.5 |
| Parade (`parade`) | NYC T2 to T3 | medium | 5 | 1 | 0.3 |
| Diandra Reviews It All (`diandra-reviews-it-all`) | NYC T3 to T4 | medium | 5 | 1 | 0.2 |
| Flipsidereviews (`flipsidereviews`) | NYC T3 to T4 | medium | 5 | 0 | 0.2 |
| Pop Dust (`pop-dust`) | NYC T3 to T4 | medium | 5 | 0 | 0.0 |
| The Three Tomatoes (`the-three-tomatoes`) | NYC T3 to T4 | medium | 5 | 0 | 0.1 |
| Partially Obstructed View (`partially-obstructed-view`) | NYC T3 to T4, London T3 to T4 | high | 5 | 1 | 0.4 |
| ReviewsGate (`reviewsgate`) | London T4 to T3 | medium | 5 | 2 | 0.3 |
| Seatplan (`seatplan`) | London T3 to T4 | medium | 5 | 1 | 0.6 |
| Revstanstheatreblog (`revstanstheatreblog`) | London T3 to T4 | medium | 5 | 0 | 0.2 |
| Harry Theatre Life (`harry-theatre-life`) | London T3 to T4 | high | 5 | 1 | 0.3 |
| UInterview (`uinterview`) | NYC T3 to T4 | medium | 5 | 0 | 0.1 |
| The Knockturnal (`the-knockturnal`) | NYC T3 to T4 | medium | 5 | 4 | 1.6 |
| Around the Town Chicago (`around-the-town-chicago`) | NYC T3 to T4 | medium | 5 | 1 | 1.1 |
| Popbytes (`popbytes`) | NYC T3 to T4 | medium | 5 | 0 | 0.4 |
| Nyc Theatre Addict (`nyc-theatre-addict`) | NYC T3 to T4 | high | 5 | 1 | 0.1 |
| Billboard (`billboard`) | NYC T2 to T3 | medium | 4 | 1 | 0.3 |
| America Magazine (`america-magazine`) | NYC T4 to T3 | medium | 4 | 0 | 0.0 |

Moves with the most weight behind them:

- Front Row Center, NYC T2 to T3 (medium, revised in round 2): has an editor, but its authors page describes contributors mainly as actors, playwrights and producers, none of its top critics is on the Outer Critics Circle roster, and Did They Like It does not quote it. Largest single move by reach (364 shows).
- Everything Theatre, London T2 to T3 (high): self-described 100% volunteer-run, paid in tickets, no Critics' Circle members.
- Theatre Weekly, London T2 to T3 (medium): managing editor wrote 68 of 98 reviews and is not a Critics' Circle member; others come through an open guest programme.
- Theater Pizzazz, Off Off Online, Broadway & Me, Times Square Chronicles, NYC T4 to T3: each has an editor or owner-critic on the Outer Critics Circle roster or Drama Desk.
- DC Theater Arts NYC T4 to T3, ReviewsGate London T4 to T3, Express (UK) and South London London T4 to T3, Theatre Vibe London T4 to T3, 4Columns and The Globe and Mail NYC T3 to T2, America Magazine NYC T4 to T3.

Config change: each moved outlet's entry in `src/config/outlet-tiers.json` gets the new tier (new entries for outlets that were registry-only, using the registry display name). Pinned by `tests/unit/outlet-tiers-adopted-2026-10.test.mjs` through `scripts/lib/outlet-tiers.js getTier`.

## Considered and not moved

- Broadway News stays NYC T1: Did They Like It lists it among its main outlets next to the NYT and Variety, it has an executive editor, and its critics include current Drama Critics' Circle voters.
- Medium stays T3: 17 of 20 rows are Christian Lewis, an Outer Critics Circle member. The rows should be re-attributed to him (data issue below).
- The Reviews Hub and LondonTheatre1 stay London T2: two of each outlet's main critics are Critics' Circle drama members.
- Front Mezz Junkies stays T3: single author, but listed on the Outer Critics Circle roster.
- Time Out (both cities), Daily Mail, Observer: no new evidence; kept.
- Cititour, Theatrely, Exeunt, CurtainUp, NJ.com, Slant, StageBuddy: verified keeps (recognized critics or aggregator pickup).
- Still unverified after two rounds, kept by default: nbcny, broadway-blog, theatreandtonic (leans T4), zeal-nyc, theater-news-online, scribicide.

## Data issues found

- `dtli`: rows link to didtheylikeit.com, an aggregator. BRO-4926.
- `british-theatre`: two sites (britishtheatreguide.info and britishtheatre.com) plus 41 rows without URLs. BRO-4926.
- `dctheatrescene`: two sites (dctheatrescene.com, 85 rows; dcmetrotheaterarts.com, 57 rows, which is DC Theater Arts).
- Duplicate ids for one outlet: `dc-metro-theater-arts` / `dc-theater-arts`; `gotham-playgoer` / `bobs-theater-blog` (same blog, renamed 2017). Both pairs now carry the same tier.
- `observer`: New York Observer and UK Observer under one id; the nyc2/lon1 split handles it for now.
- `medium`: platform, not an outlet; rows should be attributed to the individual critics.
- `zeal-nyc`: some rows link to chriscaggiano.com, the critic's personal blog.
- `south-london`: reviews credited to Michael Holland may be by other writers posting through a staff account.
- Hollywood Reporter coverage gap since 2023. BRO-4927.

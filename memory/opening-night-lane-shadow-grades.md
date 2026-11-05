# Opening-night lane: quarantined shadow replays, graded (BRO-6872)

Owner ask 2026-11-02: stop waiting for the next opening to learn whether the lane works. Run
`opening-night-lane-live.yml` mode=shadow (no lease, no publish, fresh empty ledger, so it cannot see reviews the
regular pipeline already collected) on two past Broadway nights, real fetch + three-model ensemble scoring, and grade
it against the aggregator census.

## How it was graded

- **Replay.** A night older than SEEN_AFTER_DAYS runs on a clock anchored at the review embargo
  (`opening-night-lane-shadow.js` replayClock), so "minutes" below are minutes after embargo, as on the night.
  Batches go through the real publish merge into a modelled site (`lib/lane-replay-grade.js`); nothing is published.
- **Census.** A review counts as aggregator-listed when its site review file's `sources` holds `dtli`, `bww-roundup`,
  `playbill-verdict` or `show-score*` (the regular pipeline records each aggregator that listed it). Found / fetched /
  scored come from the lane's own ledger stages (`discovered`, `fetched`, `scored`) matched by
  `discovery.canonicalUrl`. Lane score from `lane-scores.jsonl`; site score from `reviews.json` `assignedScore`.
- **Gate** (`lib/lane-shadow-grade.js`): on-time recall >= 0.85 (reviews dated by night+1), false positives <= 2,
  duplicates 0, publish errors 0, mean abs score diff <= 6, at most 1 lane/site gap wider than the site row's own
  model spread (anchored rows judged by star band).
- **Limits.** Aggregator pages are complete today, so discovery timing is a best case. Publish, rebuild and deploy
  speed are not exercised (separate measure). Listing pages that have rolled past an old post (Stage and Cinema,
  Lighting & Sound America on older nights) make some misses replay artifacts, not lane defects.
- Census tables were produced by a one-off join script (BRO-6872 session 2026-11-05) over the run artifacts
  (`gh run download <run>`: `shadow-grade.json`, `ledger/*.jsonl`, `lane-scores.jsonl`).

## Results

<!-- RESULTS -->
### a-few-good-men-2026 (night 2026-10-29), run 41982848871

Grade: **PASS**. onTimeRecall 1, falsePositives 0, duplicates 0, publishErrors 0, meanAbsScoreDiff 2.8, scoreGapsBeyondEnsemble 1, sandboxPublished 26.

Aggregator census (reviews on the live site that DTLI, BWW roundup, Playbill Verdict or Show Score list): 23. Dated by night+1: 23, of which found 23, fetched 23, scored 23. All listed: found 23, fetched 23, scored 23.

Minutes from lane start (embargo) to score: first 1, median 5, p90 10, last 13.

Lane vs live site score on 23 shared: mean abs diff 3.0, mean signed 1.9, 2 at 8+ pts. Lane show average 62.7 vs site 60.8 on the same rows.

| Outlet | Critic | Listed by | Dated | Found (adapter @min) | Fetched | Scored @min | Lane / site |
|---|---|---|---|---|---|---|---|
| The New York Times | Alexis Soloski | BWW+DTLI+PV | 2026-10-29 | dtli @1m | yes | 1 | 61 / 60 |
| TheaterMania | David Gordon | BWW+DTLI+PV | 2026-10-29 | dtli @1m | yes | 2 | 66 / 63 |
| Theatrely | Joey Sims | BWW+DTLI+PV | 2026-10-29 | dtli @1m | yes | 2 | 59 / 57 |
| Vulture | Sara Holdren | BWW+DTLI+PV | 2026-10-29 | dtli @1m | yes | 2 | 56 / 50 |
| Deadline | Greg Evans | BWW+DTLI+PV | 2026-10-29 | dtli @1m | yes | 3 | 61 / 63 |
| Entertainment Weekly | Shelby Stivale | BWW+DTLI+PV | 2026-10-29 | dtli @1m | yes | 3 | 73 / 73 |
| The Guardian | Richard Lawson | BWW+DTLI+PV | 2026-10-30 | dtli @1m | yes | 3 | 39 / 38 |
| New York Post | Johnny Oleksinki | BWW+DTLI+PV | 2026-10-29 | dtli @1m | yes | 3 | 51 / 51 |
| TheWrap | Robert Hofler | BWW+DTLI+PV | October 29, 2026 | dtli @1m | yes | 3 | 41 / 39 |
| Time Out New York | Adam Feldman | BWW+DTLI+PV | 2026-10-30 | dtli @1m | yes | 3 | 57 / 58 |
| USA Today | Patrick Ryan | BWW+DTLI+PV | 2026-10-29 | dtli @1m | yes | 3 | 86 / 81 |
| Culture Sauce | Thom Geier | BWW+SS+DTLI+PV | 2026-10-29 | dtli @1m | yes | 5 | 78 / 80 |
| The Independent | Caitlin Hornik | BWW+DTLI+PV | 2026-10-29 | dtli @1m | yes | 5 | 78 / 78 |
| New York Stage Review | Melissa Rose Bernardo | BWW+DTLI+PV | October 29, 2026 | dtli @1m | yes | 6 | 57 / 63 |
| New York Theatre Guide | Amelia Merrill | BWW+DTLI+PV | 2026-10-29 | dtli @1m | yes | 6 | 63 / 48 |
| Cititour | Brian Scott Lipton | PV | 2026-10-29 | playbill-verdict @1m | yes | 7 | 76 / 77 |
| New York Stage Review | Frank Scheck | BWW+DTLI+PV | October 29, 2026 | dtli @1m | yes | 7 | 55 / 55 |
| New York Theater | Jonathan Mandell | BWW+SS | 2026-10-29 | show-score @1m | yes | 7 | 60 / 58 |
| 1 Minute Critic | Matthew Wexler | BWW+PV | 2026-10-29 | playbill-verdict @1m | yes | 7 | 78 / 78 |
| Chicago Tribune | Chris Jones | BWW+PV | 2026-10-29 | playbill-verdict @1m | yes | 10 | 66 / 59 |
| Lighting & Sound America | David Barbour | PV | 2026-10-29 | playbill-verdict @1m | yes | 10 | 57 / 45 |
| Variety | Natalia Winkelman | BWW | 2026-10-30 | playbill-verdict @1m | yes | 10 | 81 / 82 |
| The Wall Street Journal | Charles Isherwood | BWW+PV | 2026-10-29 | playbill-verdict @1m | yes | 13 | 44 / 43 |

On the live site but listed by no aggregator: 5, lane scored 3 (JK's Theatre Scene @13m 89/88; Talkin' Broadway @10m 62/63; The New York Sun @13m 77/77; Theater Pizzazz not scored; Times Square Chronicles not scored).

Listed by an aggregator but not on the live site (excluded by site guards): New York Daily News (Chris Jones; lane found, not scored).

Grader's site-only list (the recall denominator): Times Square Chronicles dated 2026-11-04, after the night; Theater Pizzazz dated 2026-11-04, after the night.

### the-imaginary-invalid-2026 (night 2026-10-22), run 41982938533

Grade: **PASS**. onTimeRecall 0.909, falsePositives 0, duplicates 0, publishErrors 0, meanAbsScoreDiff 1.9, scoreGapsBeyondEnsemble 0, sandboxPublished 22.

Aggregator census (reviews on the live site that DTLI, BWW roundup, Playbill Verdict or Show Score list): 18. Dated by night+1: 18, of which found 18, fetched 18, scored 18. All listed: found 18, fetched 18, scored 18.

Minutes from lane start (embargo) to score: first 1, median 2, p90 4, last 8.

Lane vs live site score on 18 shared: mean abs diff 2.2, mean signed 0.0, 0 at 8+ pts. Lane show average 67.5 vs site 67.5 on the same rows.

| Outlet | Critic | Listed by | Dated | Found (adapter @min) | Fetched | Scored @min | Lane / site |
|---|---|---|---|---|---|---|---|
| New York Post | Johnny Oleksinski | PV+BWW+DTLI | 2026-10-22 | bww-roundup @1m | yes | 1 | 38 / 38 |
| New York Stage Review | Melissa Rose Bernardo | DTLI+BWW+PV | 2026-10-22 | bww-roundup @1m | yes | 1 | 82 / 82 |
| New York Theatre Guide | Kyle Turner | PV+BWW+DTLI | 2026-10-22 | bww-roundup @1m | yes | 1 | 45 / 42 |
| The New York Times | Helen Shaw | DTLI+BWW+PV | 2026-10-22 | bww-roundup @1m | yes | 1 | 92 / 93 |
| 1 Minute Critic | Jerry Portwood | PV+BWW | 2026-10-22 | bww-roundup @1m | yes | 1 | 79 / 82 |
| Time Out New York | Adam Feldman | DTLI+BWW+PV | 2026-10-23 | bww-roundup @1m | yes | 1 | 41 / 41 |
| Chicago Tribune | Chris Jones | PV | 2026-10-22 | bww-roundup @1m | yes | 2 | 75 / 77 |
| Deadline | Greg Evans | BWW+DTLI | 2026-10-22 | bww-roundup @1m | yes | 2 | 79 / 79 |
| New York Stage Review | Michael Sommers | DTLI+BWW+PV | 2026-10-22 | bww-roundup @1m | yes | 2 | 80 / 77 |
| New York Theater | Jonathan Mandell | PV+BWW | 2026-10-22 | bww-roundup @1m | yes | 2 | 66 / 63 |
| TheWrap | Robert Hofler | DTLI+BWW | 2026-10-22 | bww-roundup @1m | yes | 2 | 41 / 44 |
| Vulture | Sara Holdren | BWW+DTLI | 2026-10-22 | bww-roundup @1m | yes | 2 | 78 / 78 |
| Cititour | Brian Scott Lipton | PV | 2026-10-22 | bww-roundup @1m | yes | 3 | 56 / 50 |
| Culture Sauce | Thom Geier | PV+BWW+DTLI | 2026-10-22 | bww-roundup @1m | yes | 3 | 77 / 75 |
| TheaterMania | Pete Hempstead | PV+BWW+DTLI | 2026-10-22 | bww-roundup @1m | yes | 3 | 49 / 48 |
| The New York Sun | Elysa Gardner | DTLI | 2026-10-22 | dtli @1m | yes | 4 | 87 / 85 |
| Theatrely | Joey Sims | DTLI | 2026-10-22 | dtli @1m | yes | 4 | 66 / 71 |
| The Wall Street Journal | Charles Isherwood | PV+BWW | 2026-10-22 | bww-roundup @1m | yes | 8 | 84 / 90 |

On the live site but listed by no aggregator: 10, lane scored 4 (Bob's Theater Blog not scored; Exeunt Magazine @4m 62/62; Pages on Stages @5m 88/88; singleticket’s Substack not scored; Stage and Cinema not scored; Stage Buddy not scored; StageZine not scored; Talkin' Broadway @5m 58/60; The Washington Post not scored; Theater Pizzazz @4m 43/43).

Listed by an aggregator but not on the live site (excluded by site guards): DC Theater Arts (Deb Miller; lane not found); Exeunt Magazine (Juliet Hindell; lane not found); Front Row Center (Tulis McCall; lane not found); New York Daily News (Chris Jones; lane found, not scored); New York Stage Review (David Finkle; lane not found); 1 Minute Critic (Matthew Wexler; lane not found); Stage Buddy (Elyse Trevers; lane not found); Theater Pizzazz (Ron Fassler; lane not found); TheaterMania (Zachary Stewart; lane not found).

Grader's site-only list (the recall denominator): The Washington Post dated 2026-10-23, ON-TIME MISS; Stage and Cinema dated 2026-10-31, after the night; Stage Buddy dated 2026-11-03, after the night; StageZine dated 2026-10-30, after the night; singleticket’s Substack dated 2026-10-05, ON-TIME MISS, excluded; Bob's Theater Blog dated 2026-10-14, ON-TIME MISS.
<!-- /RESULTS -->

## Every miss: cause and fix

Misses found across the replay rounds (p1 to p27, five nights incl. holdouts billy-crystal-860, other-desert-cities,
school-girls), each traced to a cause. Full round-by-round detail is on the Linear card.

| Miss | Cause | Fix / disposition |
|---|---|---|
| Site lacked WaPo review of The Imaginary Invalid | regular-path ingest gap | ingested; prevention `scripts/audit-applied-fix-plans.js` runs in every rebuild |
| WSJ teaser scored as a review | lane has no WSJ login; 597-1467 char paywall teaser | lane holds a WSJ teaser unscored until an aggregator excerpt arrives; paywall tiering matches `collect-review-texts.js` |
| Gold Derby / Playbill roundups scored | lane lacked the roundup / non-review guards | lane applies `review-guards` roundup rules (incl. the-independent.com host) |
| Publish errors 51/54 per night | replay merge defects | fixed; 0 publish errors every round since |
| Lane scores unanchored vs anchored site rows (NYSR 3/5 -> 71) | lane never passed printed ratings to the scorer | lane extracts ratings, anchored-v6 fires (536cadbff); score log records the anchoring rating |
| NY Sun not found | headlines carry no "review" word | Google News `site:nysun.com` title query |
| TheaterMania / L&SA / Time Out finds refused as /news/ paths | own-source finds judged by URL pattern | section-index and own-feed finds marked `vettedOutlet` |
| Theater Pizzazz rejected `not-review-like` | show-name titles, feed tags all Uncategorized | review-only hosts admit show-titled posts |
| Guardian, NYT feed, Theatrely timeouts (138 ETIMEDOUT in one run) | IPv6 connect attempts on GitHub runners | IPv4-first on runners; 0 ETIMEDOUT since p20 |
| The Stage served an empty page | free direct fetch sent no User-Agent | our User-Agent on free direct fetches |
| Review paragraphs dropped by extractor | stop-word filter on ordinary words | extractor fix + drift test |
| Talkin' Broadway skipped | rotation + intermittent Cloudflare 403; dead index | blocked names carried to next probe, `world/past.html` index |
| Bob's Theater Blog (II) | posts before the night | owner decision 2026-11-04: keep the pre-opening gate (accepted by design) |
| WaPo (II) multi-show column | lane refuses columns naming other shows; site scores the II section | deliberate lane guard (counts as one on-time miss on II) |
| singleticket Substack (II) | pre-opening post, excluded on site too | not a miss |
| Late-dated posts (Times Square Chronicles, Theater Pizzazz AFGM, StageZine, Stage Buddy, Stage and Cinema) | published days after the night | outside the gate by design (all-time recall reported separately) |

## Remaining open items

- WSJ is excerpt-only in the lane because subscriber cookies do not authenticate from CI; tracked on BRO-5628.
- AFGM Lighting & Sound America: lane 48/56/57 across rounds vs site 45 on a slightly different extraction
  (5772 vs 5845 chars): model variance, the single allowed beyond-ensemble gap.
- Live (non-replay) dated checkpoints are the coordinator's (BRO-5955) shadow nights; this file covers the replays.

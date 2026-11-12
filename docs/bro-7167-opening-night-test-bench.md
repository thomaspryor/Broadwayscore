# BRO-7167: Opening-night test bench (plan for owner approval)

Status: PLAN, nothing built beyond the 2-night pilot. Substantial tier (CLAUDE.md §20): needs `OWNER-PLAN-APPROVED:` before Phase 1.

## In plain words

We replay past Broadway opening nights through the new opening-night system, in a sandbox that publishes nothing, and grade
how fast and how completely it would have got reviews live. Today's replays cheat a little: they read review round-up pages
as they look now, already complete. This plan adds replays that only see what existed at 15, 30, 60 and 120 minutes after
reviews went out, then reruns those replays automatically whenever the opening-night code changes.

The pilot cost $0 and found one thing that matters before anything else: our recorded "reviews go out at" time was wrong on
both pilot nights (30 minutes early on one, an hour late on the other). Every timing grade so far was measured from the wrong
start line. Fixing that comes first (Phase 0).

Full run: about $40 to $80 in scraping and AI scoring across all 20 nights. Each phase has a stop point.

## What already exists (reused, not rebuilt)

| Piece | File | What it gives us |
|---|---|---|
| Old-path grade per opening | `scripts/grade-openings.js` + `scripts/lib/opening-grade.js` | on-its-own vs needed-hands, every hand fix with its cause class, live / late-live / missing, hours to live. Works on April nights (pilot proved it; review-texts git history reaches 2026-01) |
| Press-night record | `data/audit/press-night/<show>-<night>.json` (`scripts/lib/press-night-record.js`) | measured first-live, live count at +1h/2h/6h, 5-min site probe, aggregator reference at +2h, lane shadow first discovery. Only 4 Broadway nights have one (Oct 22 onward) |
| Site score timeline | `data/opening-night-timeline/<show>.jsonl` | live review count over time, all 20 nights |
| Shadow redo (sandbox) | `opening-night-lane-live.yml` mode=shadow, `scripts/opening-night-lane-shadow.js --replay`, graded by `scripts/lib/lane-shadow-grade.js` | new lane on a past night, no lease, no publish, modelled site, grade gate (on-time recall >= 0.85, FP <= 2, dupes 0, score diff <= 6). Run on 2 nights so far (memory/opening-night-lane-shadow-grades.md) |
| Recorded rehearsal + arm gate | `lane-rehearsal-recorded.yml`, `scripts/opening-night-lane-rehearse.js --arm-check`, `scripts/lib/lane-recorded-nights/` | offline replay with injected clock on every lane-code push to main; arm-check refuses to arm without a recent pass. Fixtures: 2 Broadway nights + 1 West End |
| Encrypted per-pass recordings | `scripts/capture-lane-night.js`, `scripts/lane-recording-import.js` | real pages as fetched on the night (private repo) |
| Coverage gap audit | `scripts/slow-market-grade.js --check-gaps` | did every review an aggregator cited go live |
| Wayback helpers | `scripts/lib/unwrap-wayback-url.js`, CDX year-bound test | URL unwrapping, CDX query bounds |

New code is limited to: an embargo-truth step (Phase 0), a causal-fixture builder and a "page as of time T" provider for the
existing replay harness (Phase 3), and widening the existing rehearsal's night list (Phase 4).

## The 20 nights

Last 20 Broadway openings with reviews, newest first (Now You See Me Live opens 2026-11-11, too new):

here-there-are-blueberries-2026 (11-09), wanted-2022 (11-08), a-few-good-men-2026 (10-29), the-imaginary-invalid-2026 (10-22),
billy-crystal-860-2026 (10-21), other-desert-cities-2026 (10-18), school-girls-or-the-african-mean-girls-play-2026 (09-28),
paranormal-activity-2026 (08-25), celebrity-autobiography-2026 (05-18), the-lost-boys-2026 (04-26),
joe-turners-come-and-gone-2026 (04-25), the-rocky-horror-show-2026 (04-23), beaches-2026 (04-22), the-balusters-2026 (04-21),
schmigadoon-2026 (04-20), fallen-angels-2026 (04-19), proof-2026 (04-16), the-fear-of-13-2026 (04-15), titanique-2026 (04-12),
death-of-a-salesman-2026 (04-09).

Evidence by night: 4 have a press-night record, 20 have a site timeline, 20 have review-texts git history, 2 have encrypted
recordings (a-few-good-men, the-imaginary-invalid). 11 of the 20 are April Tony-rush nights; their review files carry almost no
`firstSeenAt` (3 of 43 for The Balusters), so per-review discovery time comes from the first commit of each file.

## Pilot results (2 nights by hand, 2026-11-11, spent $0)

Picked the best-instrumented night and a typical April night. No paid fetches, no AI calls: local git and files, 71 plain
article page fetches, about 20 Wayback CDX queries.

| | The Balusters (04-21) | A Few Good Men (10-29) |
|---|---|---|
| Embargo the graders used | 02:00Z ("22:00 local estimate") | 02:00Z (press-night record, market default) |
| Embargo observed (outlet publish times) | **01:30Z** (9 of 21 timestamped reviews at 01:30Z) | **03:00Z** (7 of 17 at 03:00Z; lane shadow first discovery 03:02Z agrees) |
| Old path verdict (`grade-openings.js`) | needed-hands, 23 hand fixes: 11 scored by hand, 5 missed by discovery, 4 text recovered by hand, 2 attribution, 1 other | needed-hands, 4 fixes: 1 missed by discovery (NY Sun), 1 text recovered (TheWrap), 2 publish-date guard (Cititour, NY Sun) |
| Final live / late-live / missing | 36 / 3 / 0 | 29 / 3 / 0 |
| First live | first review file committed 01:52Z (+22m); site timeline has no point before 05:08Z (19 reviews) | 03:40Z, so 40 min after the real embargo (graders said 100 min) |
| Old path from observed embargo | review files first committed by +15m / +30m / +1h / +2h / +24h / +7d: 0 / 8 / 18 / 18 / 31 / 44 (includes later-rejected files) | site live count (timeline) at +1h / +3h / +24h / +7d: 3 / 21 / 26 / 27; lane shadow found its first batch at +2m |
| New lane shadow redo | not yet run | PASS (run 42016617448): on-time recall 23/23, 0 FP, scored 1 to 3 min after start, mean score diff 2.8 |
| Wayback captures, first 2h (from observed embargo) | BWW roundup 1 (+13m), Playbill Verdict 2 (+18m, +45m), DTLI 0 (first at +13.2h), Show Score 0; outlet section pages (NYT, Vulture, Variety, TheaterMania) 0 | 0 on BWW, DTLI; Playbill query got "Temporarily Offline". 12 days after the night, nothing indexed yet |
| Outlet publish times with time-of-day, free plain fetch | 21 of 39 (54%) | 17 of 32 (53%) |

What the pilot changes in the plan:
1. **Embargo truth first.** Both nights' timing grades are off by 30 to 60 minutes. Phase 0 below.
2. **Wayback alone cannot rebuild +15/+30/+60/+120.** It has 0 to 2 captures per aggregator page in the first two hours and
   none of the outlet section pages. Wayback becomes a check on the replay, not its backbone. Outlet publish times (about half
   of reviews, free) and our own first-commit times carry most of the timing.
3. **Recent nights may never be archived densely.** Going forward, recording every Broadway night (Phase 3c) is the only way
   to get true per-minute page state.

## Phase 0: embargo truth (prerequisite, about 2 hours, $0)

For each night: observed embargo = the earliest minute with 3 or more outlet publish timestamps within 10 minutes, cross-checked
against the first review-texts commit and (where present) the lane shadow's first discovery. Store as
`observedEmbargoAt` + evidence in the audit output, never by rewriting the press-night record. The existing per-show embargo
override in `press-night-record.js` (`embargoInfo`, source `override`) is the forward fix; Phase 0 also reports every future
night where observed and recorded embargo differ by 15 minutes or more, so the default stops silently skewing grades.

## Phase 1: audit the old path on all 20 nights ($0, about half a day)

Inputs only, no network: `grade-openings.js --show=<id> --from --to` per night (hand fixes and causes), timeline JSONL
(live count at +1h/+3h/+24h/+7d from observed embargo), review-texts first-commit times (discovery curve), press-night records
where present, `show-review-gap.json` (aggregator-cited final count), Linear cards and `ingest-urls` workflow runs in opening
week (manual interventions not visible in git).

Output per night: time to first live review, live vs final aggregator-cited count at +1h/+3h/+24h/+7d, every miss with cause
class (discovery, text, guard, attribution, scoring-by-hand), every manual intervention. One table across the 20 nights:
the baseline the new lane must beat. Written to `data/audit/opening-night-test-bench/old-path.json` + a readable summary.

Stop point D1: owner sees the 20-night baseline before any spend.

## Phase 2: sandboxed redos with the new lane (shadow, no lease, no publish)

`opening-night-lane-live.yml` mode=shadow with `--replay` for each night, graded by `lane-shadow-grade.js`, in batches of 5,
spaced to respect concurrency. Same limits as today (aggregator pages read as they are now, so discovery timing is a best case),
which Phase 3 corrects. Adds per night: lane vs old-path discovery curve and score agreement.

Old nights may break in replay-only ways (roundup pages moved, listing pages rolled past the post). Each failure is classed
lane defect vs replay artifact before it counts, the same rule as BRO-6872.

Stop point D2: after the first batch of 5, compare measured spend to the estimate below; stop if it runs over 1.5x.

## Phase 3: time-causal replays (what was discoverable at +15/+30/+60/+120)

3a. **Causal fixture per night** (metadata only: URLs, outlets, timestamps, no copyrighted text in this repo). For each review:
- `publishAt` with source and precision: outlet `datePublished`/`article:published_time` (plain fetch first, existing
  `fetchPage` chain only for the rest, about 15 paid fetches per night).
- `aggregatorListedAt`: earliest Wayback capture of each round-up / DTLI / Playbill Verdict / Show Score page that lists it
  (an upper bound; true listing could be earlier).
- `articleFirstCapturedAt`: earliest Wayback capture of the article URL itself (upper bound on publish time when no timestamp).
- `oldPathFirstSeenAt`: first review-texts commit, or the press-night record's per-review live time.
- Discovery route the lane would use: direct outlet adapter, aggregator-only, search-only, or unknown.

3b. **Replay with a "page as of T" provider.** The existing harness (`lane-replay-grade.js`, injected clock) gets a page
provider that, at clock T, serves each aggregator page listing only rows with `aggregatorListedAt <= T`, and each outlet
adapter only rows with `publishAt <= T`. Run twice per night:
- best case: discoverable at `publishAt`
- worst case: discoverable at the first evidence capture
Grades reported as a bracket: first-live minutes after observed embargo, live count at +15/+30/+60/+120, completeness at +2h vs
final aggregator census, against the old path from Phase 1. Scores reuse Phase 2's lane scores (cached by text hash), so
no new AI spend.

3c. **Record every Broadway night from now on.** Extend `capture-lane-night.js` (today West End adapters only) to the Broadway
adapters on a 5-minute cadence for the first 3 hours, encrypted into the private archive via `lane-recording-import.js`. This is
the only source of true page state for future nights.

**What cannot be reconstructed (stated in every grade):** round-up page contents between Wayback captures (BWW and Playbill
edit one page in place); outlet section and listing pages (0 captures in the pilot window); search engine state on the night;
paywall or bot blocks on the night; site rebuild and deploy speed (measured separately by press-night records); articles edited
since, where the CMS overwrote the publish time; any review with neither a timestamp nor an early capture (about half the
reviews have no time-of-day publish stamp). Nights whose route is "unknown" for more than 30% of reviews are graded
"partial", never PASS.

Stop point D3: owner sees old path vs new lane (best/worst bracket) for all 20 nights.

## Phase 4: standing regression suite (gates arm-check)

Reuse `lane-rehearsal-recorded.yml`, which already reruns on every lane-code push to main and feeds `--arm-check`. Widen its
night list from 2 Broadway + 1 West End to the 20 causal fixtures plus the nightly recordings from 3c. Pass rule per night:
worst-case first-live no later than the old path's, +2h completeness no lower than the old path's, and the existing
shadow-grade gate. Lands advisory (`continue-on-error`, CLAUDE.md §19) for two weeks of real lane-code changes, then blocks
arm-check. Each new opening night's recording is added to the suite the morning after (`lane-recording-import.yml` already
runs then). CI cost: offline, cached scores, a few minutes per run.

## Cost

| Item | Basis | Estimate |
|---|---|---|
| Pilot (done) | local files, 71 plain fetches, about 20 Wayback queries | **$0** |
| Phase 0 and 1 | local files and git only | $0 |
| Phase 2 scraping | measured: the Nov 5-6 shadow replays used 3,067 Bright Data calls (at the about $1.50 per 1,000 rate in `provider-spend-daily.jsonl`, about $4.60) plus 24k ScrapingDog and 1.2k ScrapingBee credits inside flat subscriptions (0.5% of ScrapingDog's monthly cap) over about 4 runs | about $1 to $2 per night, $20 to $40 for 20 |
| Phase 2 AI scoring (3-model ensemble) | estimate, not measured: about 35 reviews per night, about 3 cents per review across the three models | about $1 per night, about $20 for 20 |
| Phase 3 Wayback | about 50 CDX/snapshot requests per night, about 1,000 total, at 1 every 3 seconds with backoff (the archive returned "Temporarily Offline" once in the pilot) | $0, about 1 hour |
| Phase 3 publish times | plain fetch for about half, about 15 paid fetches per night for the rest | under $5 total |
| Phase 3 replays | offline, cached scores | $0 |
| Phase 3c nightly recording | 3 hours of Broadway adapter fetches per opening | about $1 to $2 per opening |
| Phase 4 | offline CI | $0 |
| **Total one-off** | | **about $40 to $80** |

## Decisions for the owner

- D0 (now): approve the plan. Phases 0 and 1 cost nothing and can start the same day.
- D1 (after Phase 1): spend about $40 to $80 on Phase 2 redos, in batches of 5 with a stop at 1.5x estimate.
- D2: record every Broadway opening night from now on (about $1 to $2 each).
- D3 (after two advisory weeks): make the 20-night replay suite block arm-check.

## Coverage check (acceptance command)

`node scripts/slow-market-grade.js --opened-from=2026-09-01 --opened-to=2026-11-08 --check-gaps` exits 1 on 2026-11-11 because
of 27 flagged rows (10 FAIL, 12 BLIND, 5 NO-AUDIT). None of them are main-stem Broadway: the 6 Broadway openings in that window
(wanted, a-few-good-men, the-imaginary-invalid, billy-crystal-860, other-desert-cities, school-girls) are PASS or STALE-after-PASS.
The flagged rows are off-Broadway, West End, regional and tours, which the hourly gap audit owns.

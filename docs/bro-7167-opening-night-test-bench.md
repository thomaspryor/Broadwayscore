# BRO-7167: Opening-night test bench (plan for owner approval)

Status: PLAN v2 (revised after /plan-review, 2026-11-11), nothing built beyond the 2-night pilot. Substantial tier (CLAUDE.md §20): needs `OWNER-PLAN-APPROVED:` before Phase 1.

## In plain words

We replay past Broadway opening nights through the new opening-night system, in a sandbox that publishes nothing, and grade
how fast and how completely it would have got reviews live. Today's replays cheat a little: they read review round-up pages
as they look now, already complete. This plan adds replays that only see what existed at 15, 30, 60 and 120 minutes after
reviews went out, then reruns those replays automatically whenever the opening-night code changes.

The pilot cost $0 and found one thing that matters before anything else: our recorded "reviews go out at" time was wrong on
both pilot nights (30 minutes early on one, an hour late on the other). Every timing grade so far was measured from the wrong
start line. Fixing that comes first (Phase 0).

The wrong start time is not only a grading problem: the live opening-night system also times its start from that guess, and no show
has ever had its real time set (0 shows in shows.json carry `reviewEmbargoAt`). Phase 0 fixes both.

Full run: about $60 to $100 in scraping and AI scoring across all 20 nights. Each phase has a stop point. The test bench never
touches the switch that lets the live system run until the owner says so (decision D3).

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
| Observed release time | `press-night-record.js` `observedRelease` / `observedReleaseFromPublish` (:926, :950) | release time from outlet publish times, late releases only (>= 30 min) |
| Page as of time T | `lane-recorded-nights/recording-night.js` `replayFetchFrom` (:47) | serves each URL the content current at the virtual time, from the recording format |
| Nightly Broadway recording | press-night-probe.yml starts the shadow; `opening-night-lane-live.yml` BRO-6651 encrypted recording; `lane-recording-import.yml` imports it each morning (advisory, does not feed arming) | real page state for every new Broadway night already |

New code is limited to: fixing the old grader to use the shared embargo helper and teaching the observed-release logic about
early releases (Phase 0), a Wayback-to-recording importer that writes the existing recording format (Phase 3), and a separate
`bench` rehearsal kind with its own record (Phase 4).

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

## Phase 0: embargo truth (prerequisite, about half a day, $0)

[CHANGED v2: no new embargo concept; the fix reaches both graders and the live lane. Source: design, structure, Codex, pre-mortem]

1. `scripts/lib/opening-grade.js:131` uses its own `estimateEmbargoMs` (22:00 local) and never sees a show's override. Switch it
   to `pressNightRecord.embargoInfo(show)`, the helper the lane and probe already use.
2. Extend `observedReleaseFromPublish` (`press-night-record.js:950`) to report early releases too (today only >= 30 min late),
   using a cluster rule: 3 or more exact outlet publish times within 10 minutes. Fallback when there are fewer than 3: the lane
   shadow's first discovery, else the first review-texts commit, labelled with its source. Nights with no answer are marked
   "embargo unknown" and cannot PASS a timing check.
3. Pass the same anchor into the shadow replay (`opening-night-lane-shadow.js` replay clock via an `--embargo-at` override), so
   Phase 2 does not repeat the bias.
4. Forward fix for live nights: when an observed embargo differs from the default by 15 minutes or more, report it in the morning
   digest so the next show from the same press office gets `reviewEmbargoAt` set ahead of its night. Never rewrite past
   press-night records; the observed time is stored beside them.

Red-then-green test: the two pilot nights as fixtures (The Balusters observed 01:30Z, A Few Good Men 03:00Z).

## Phase 1: audit the old path on all 20 nights ($0, about half a day)

[CHANGED v2: per-night output files, labelled clocks, "unknown" instead of interpolation. Source: Codex, structure, design]

Run `grade-openings.js --show=<id> --from --to --out=<per-night file>` one night at a time, locally, then one reducer builds the
20-night table (an interrupted run keeps every finished night). Add only the missing fields to `gradeOpening`: discovery curve
from review-texts first commits, live-count curve from the site timeline.

Per night: time to first live review, live vs final aggregator-cited count at +1h/+3h/+24h/+7d, every miss with cause class,
every manual intervention. Every number names its clock: "first committed" (we had the file), "first live" (on the site, from the
timeline or press-night probe), or "published" (the outlet's own time). Where the timeline has no point in a window (The Balusters'
first point is at +3.6h), the cell says unknown, never an interpolated count.

Manual interventions come from git (offline) plus Linear cards and `ingest-urls` runs (network). GitHub keeps run logs about 90 days,
so the April nights' run history is likely incomplete; the table marks those nights "interventions from git only".

Stop point D1: owner sees the 20-night baseline before any spend.

## Phase 2: sandboxed redos with the new lane (shadow, no lease, no publish)

[CHANGED v2: serial, local-first, observed embargo, never on a press-night day, and "on-time recall" is not called speed.
Source: Codex, pre-mortem, user impact, structure]

`opening-night-lane-shadow.js --replay --embargo-at=<Phase 0 time> --out=<per-night dir>` one night at a time, locally (no CI
concurrency, no ledger pushes racing the hourly crons, no Discord failure warnings for replay-only breakage). CI one at a time is the
fallback if a secret is CI-only. Never run on a day with a Broadway or West End press night (the live lane needs the same Bright
Data daily headroom). Spend rows carry the show and night so they can be told apart from real-night rows.

Graded by `lane-shadow-grade.js`. Its "on-time" means dated by night + 1 day, so Phase 2 measures recall, false positives and score
agreement, not speed; speed is Phase 3. Each failure is classed lane defect or replay artifact (page moved, listing rolled past the
post) with the evidence written next to it, the BRO-6872 rule.

Ramp: night 1 is The Balusters (the April pilot night), then a batch of 4, then the rest. Stop point D2: after the first 5,
compare spend with the estimate and stop at 1.5x.

## Phase 3: time-causal replays (what was discoverable at +15/+30/+60/+120)

[CHANGED v2: no synthetic page provider; Wayback captures become recordings in the existing format and replay through
`replayFetchFrom` with the real page parsers. Missing evidence is "unknown", never "404". Source: design (P0), Codex, Gemini]

3a. Hand-build one causal recording first (The Balusters): its Wayback captures (BWW +13m, Playbill +18m/+45m, DTLI +13.2h) written
in the recording format, plus each review's evidence: outlet publish time, the article's first Wayback capture, our first commit.
Measure the best-to-worst bracket. **If the bracket on first-live or +2h completeness is wider than about 60 minutes, stop Phase 3
for old nights** (it could not tell the lane from the old path) and rely on 3c going forward. [CHANGED v2: hand ramp before tooling.
Source: structure]

3b. If 3a is narrow enough: a Wayback-to-recording importer for the other 19 nights, local, 1 request every 3 seconds, a hard stop
after 5 consecutive 429/503 responses, resumable per night. Output lands only in the private lane-recordings archive
(`recording-import.js` private-destination check); the repo gets only counts and timestamps. Replay through the real night modules
with an injected clock, twice per night: best case (a review is visible from its publish time) and worst case (from its first
evidence capture). A review with no time evidence at all is unknown and counts as a miss for the 30% "partial" rule; publish
times later than our own first commit are rejected as edited.

Scoring: there is no score cache today, so Phase 3 rescores (about $1 per night) instead of building one. [CHANGED v2: the v1 plan
assumed a cache that does not exist. Source: structure, Codex]

3c. Already running for new Broadway nights: the press-night probe starts the shadow, which records pages (BRO-6651), and the
recording is imported each morning. The only change is cadence and window (every 5 minutes for the first 3 hours) in the shadow's
recorder, plus a fidelity flag when storage throttling substituted an older page body. [CHANGED v2: was "extend
capture-lane-night.js", a one-off West End capture. Source: design, structure, pre-mortem]

What cannot be reconstructed, stated in every grade: round-up contents between Wayback captures; outlet section pages (0 captures in
the pilot); search engine state; paywall and bot blocks on the night; rebuild and deploy speed; articles whose CMS overwrote the
publish time; reviews with no timestamp and no early capture (about half). Recall is measured only against reviews we know of today,
so a review nobody ever found cannot show up as a miss.

Stop point D3: owner sees old path vs new lane (best/worst bracket) for all 20 nights.

## Phase 4: standing regression suite (advisory until D3)

[CHANGED v2: a separate `bench` rehearsal kind and record. The arming rehearsal, its night list and the arm record do not change
until the owner approves D3. Source: all six reviewers (P0)]

Widening the existing recorded rehearsal would disarm the live lane: it writes the record the arm gate reads, it skips the whole run
(and writes nothing) when any night lacks an archived page, and `continue-on-error` does not change what the record says. So:

- New kind `bench` with its own record file (`rehearsalRecordFile(repo, 'bench')`), outside `ARMING_REHEARSAL_KINDS`, in its own
  workflow on the same lane-code paths. One night failing or missing marks that night, not the run.
- Grades through the existing `gradeReplay` / `evaluateCheck` gates (`first-live`, `coverage-2h`) with the old-path numbers as the
  reference, not a second pass/fail vocabulary.
- The corpus is pinned: bench nights are exempt from the recording archive's 150 MiB oldest-first rotation.
- Runtime is measured with all 20 nights before the job is scheduled; split by night if it nears the timeout.
- At D3, nights are promoted into the arming set one at a time, each after a clean bench pass.

## Cost (revised)

| Item | Basis | Estimate |
|---|---|---|
| Pilot (done) | local files, 71 plain fetches, about 20 Wayback queries | **$0** |
| Phase 0 and 1 | local files and git; a few Linear/GitHub reads | $0 |
| Phase 2 scraping | measured: Nov 5-6 shadow replays, about 4 runs, used 3,067 Bright Data calls (about $4.60 at the about $1.50 per 1,000 rate in `provider-spend-daily.jsonl`) plus ScrapingDog/ScrapingBee credits inside flat subscriptions. Older nights may fall back to more fetches | $1 to $3 per night, $20 to $60 |
| Phase 2 AI scoring | estimate, not measured: about 35 reviews per night at about 3 cents for three models; the first Balusters run measures it | about $1 per night, about $20 |
| Phase 3 Wayback | about 50 requests per night, about 1,000 total, local, with backoff | $0, about 1 hour |
| Phase 3 publish times | plain fetch for about half; about 15 paid fetches per night for the rest | under $5 |
| Phase 3 rescoring | no cache exists, so rescore | about $1 per night, about $20 |
| Phase 3c cadence change | extra page fetches in the first 3 hours of each new night | about $1 per opening |
| Phase 4 | offline CI | $0 |
| **Total one-off** | | **about $60 to $100** |

## Decisions for the owner

- D0 (now): approve the plan. Phase 0 (fixes a live timing problem too), Phase 1 and the 3c cadence change cost nothing or nearly
  nothing and can start the same day. 3c moves up because every new night not recorded densely is lost for good.
  [CHANGED v2. Source: structure]
- D1 (after Phase 1): spend about $40 to $80 on Phase 2 redos, in batches with a stop at 1.5x estimate.
- D2 (after the hand-built Balusters causal replay): continue Phase 3 on old nights only if its best/worst bracket is narrow.
- D3 (after two weeks of the bench running advisory): promote bench nights into the arming rehearsal, one at a time.

## Review record (/plan-review, 2026-11-11)

Coverage: Codex CLI (GPT, codebase access) usable; Gemini 2.5 Flash; four Claude reviewers (structure, pre-mortem, user impact,
code design). Six of six ran.

Verdict: v1 needed redrawing (P0 design findings on Phase 3b and Phase 4). v2 above resolves them.

| Issue | Raised by | Severity | Resolution |
|---|---|---|---|
| Widening the arming rehearsal disarms the live lane; "advisory" via continue-on-error is impossible there | Codex, structure, pre-mortem, user impact, design | P0 | separate `bench` kind and record (Phase 4) |
| Synthetic "page as of T" provider reinvents `replayFetchFrom` and drops real page shapes | design, Codex | P0 | Wayback captures become recordings (Phase 3) |
| Observed embargo would reach neither grader; the wrong default also times the live lane | Codex, structure, design, user impact | P1 | Phase 0 fixes the shared helper path and the forward override |
| Score cache assumed but absent | structure, Codex, pre-mortem | P1 | rescore in Phase 3, cost added |
| Shared output file and parallel dispatch | Codex, structure, pre-mortem | P1 | per-night outputs, serial, local |
| 3c should reuse the shadow recorder, and go first | design, structure, pre-mortem | P1 | 3c is a cadence change approved at D0 |
| Sparse timelines and mixed clocks | structure, Codex, Gemini | P1 | labelled clocks, unknown cells |
| Archive gaps read as page absence, embargo heuristic unvalidated | Codex, Gemini | P1 | unknown evidence and fallbacks with source labels |

Restructure question (from the structure reviewer): build one causal night by hand before the importer. Adopted as 3a with a
stop rule.

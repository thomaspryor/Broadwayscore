# West End historical backfill: plan v3.1

Linear: BRO-4851. Supersedes plan v2.2 (Notion card 3b7637c5, 2026-08-09; the
v2.2 doc lived only on the owner's Mac). Owner approved the restart
2026-10-07. v3.1 = v3 after a six-reviewer /plan-review (GPT-5.4-mini, Gemini
2.5 Flash, four Claude lenses) the same day. `[CHANGED: …]` marks what the
review moved.

## Goal

Critic Scores for closed West End productions, walking back one season at a
time from 2024-25, the way Broadway was backfilled. "West End" means the
`west-end` category (`isWestEndVenue()`, `scripts/lib/venue-classification.js`):
the commercial houses plus the National Theatre stages, the Old Vic and the
Royal Court. Off-West End is out of scope.

## Where v2.2 got to

| Stage | State on 2026-10-07 |
|---|---|
| S0.5 two-show smoke test | Passed. `juno-and-the-paycock-west-end-2024` (cs 58, 23 reviews) and `barcelona-west-end-2024` (cs 56, 18 reviews) are live. 13 of 41 reviews have no URL (FT and Daily Mail on Juno among them). |
| S1 season discovery | Built; returns 0 candidates. |
| S2 WET star/URL merge | Built (`merge-wet-stars-urls.js`), one show at a time, run by hand. |
| Season batch | Never started; no owning card after the Notion to Linear move. |

## Findings (all verified against code or live endpoints 2026-10-07)

1. **Discovery reads a page that does not exist.** It fetches
   `en.wikipedia.org/wiki/2024–25_West_End_theatre_season`, which is a 404, as
   is every "West End theatre season" title. The Olivier and OLT sources are
   stubs.
2. **Promote** (`promote-historical-we.js`):
   - The id year comes from the season start (`:81-84`), not the opening year.
   - `previewsStartDate` and `closingDate` are null (`:94-97`).
   - Dedup ignores dates.
   - Every uncorroborated row needs its own per-title flag.
3. **The date guards already exist but are switched off for these rows.**
   `flag-wrong-production-by-date.js` (`lib/date-guard.js`
   `evaluateDateGuard`) runs on every rebuild with a two-sided window
   [previews − 21/35 days, close + 7 days]. It only bounds the late side when
   `closingDate` is set, and promote leaves that null.
   `[CHANGED: v3 proposed making review-guards.js isLikelyWrongProduction
   two-sided. That would create a second, conflicting post-close rule (120 d
   vs 7 d) in a scoring-watchlist file read by scoring-delta.js. Fix the
   missing dates instead. — Structure, Design, Pre-mortem]`
4. **TR extraction:**
   - It picks the newest title match with no date check
     (`extract-theatre-record.js:1087-1107`).
   - It runs its own one-sided pre-filter (`:863`, `isLikelyWrongProduction`).
   - It falls back to the opening date when no `publishDate` parses (`:970`).
5. **`wet-roundup-discover.js`:**
   - `nextAll('a')` is unbounded (`:203-208`), so URLs bleed across outlets.
   - Post search has no date bound.
   - The merge writes URLs only for outlets that use stars.
   - Both functions also feed the live opening-night paths (gather-reviews.js,
     opening-night-poller.js).
6. **"`validate-show-venue` clears `provisional`" is false.** Nothing in the
   repo clears `provisional`. Playbill has no page for most UK-only
   productions, and the daily `audit-provisional-venues.yml` sweep spends paid
   SERP calls on every provisional row, every day.
   `[CHANGED: v3 relied on this as the safety net — Structure, Pre-mortem]`
7. **Dispatching N chunks back to back loses chunks silently.**
   `review-refresh.yml` and `gather-reviews.yml` use concurrency groups with
   `cancel-in-progress: false`. GitHub keeps one pending run per group and
   replaces it on each new dispatch, and the live crons share the group.
   `[CHANGED: new — Structure, Pre-mortem]`
8. **Scale and cost.**
   - A season is ~90-115 West End productions, ~95 of them plays and musicals.
   - Scoring is ~$0.04/review (Sprint 4 actuals), so ~$55 per season at ~15
     reviews per show, plus scraping.
   - Estimate: **~$60-80 per season, ~$550-700 for 2016-17 to 2024-25.**

## Discovery sources (tested live from cloud, 2026-10-07)

| Source | Role | Notes |
|---|---|---|
| WhatsOnStage REST `wp-json/wp/v2/shows?market=98` | Primary listing | 2,721 West End listings with venue id, preview, opening and closing dates. Strong from 2018-19. robots.txt allows. |
| WhatsOnStage REST `wp-json/wp/v2/news?categories=63,69&after=&before=` | Review signal; discovery for 2016-18 | "X at the Venue – review" titles back to 2016. |
| Wikipedia `YYYY_Laurence_Olivier_Awards` | Independent signal | Nominees only (~50-70 a year), no dates. Check both ceremony years. |

A 2023-24 trial found 116 rows: 95 theatre, 8 opera/dance, 7 children's,
6 concerts. 65 of the 95 had 2+ sources, and spot checks were correct.

## Design (where the code goes)

`[CHANGED: whole section is new — Design reviewer, codebase-grounded]`

- **`scripts/lib/wos-rest-listings.js` (new).** The only file that knows the
  WOS REST shape (`market=98`, `acf.*` fields, venue-id lookup). It has fixture
  tests built from real responses. It is named apart from
  `lib/whatsonstage-parser.js`, which parses WOS *Awards* from Wikipedia.
- **The Olivier signal** reuses `lib/precursor-wikipedia.js`
  (`fetchWikitext`, `extractItalicTitles`, `RATE_LIMIT_MS`). No third
  Wikipedia reader.
- **`decideWeHistoricalPromotion(candidate)`** returns
  `{promotable, persistent, reason}`. It is a pure function with the same
  shape as `decideWestEndAggregatorPromotion`
  (`promote-we-aggregator-candidates.js:130`), and it replaces the
  2-source predicate in `lib/we-historical-corroboration.js`. Rules:
  - an `isWestEndVenue()` venue;
  - a run of at least 14 days;
  - a play or musical genre;
  - a review signal (WOS review, Olivier nomination, or WET roundup).
  
  Discover and promote both call it.
- **Date-aware dedup goes in the shared `lib/venue-title-dedup-pool.js`**,
  as an optional `{withinYears}` that OB historical also gets. Discovery's
  local `findMatch` copy is deleted.
- **Id year** uses `productionIdYear()` (`lib/todaytix-dates.js:94`), the
  helper OB uses. Juno and Barcelona keep their ids, since both opened in
  Oct 2024.
- **The TR guard** routes through `date-guard.js` `evaluateDateGuard` with the
  full show. `review-guards.js` is untouched.
- **WET lib changes are opt-in.** Pass `{after, before}` only from historical
  callers, so the live default stays as it is. The URL-bleed fix (scope the
  link to the review's own block) is a plain bug fix for every caller,
  covered by a fixture test.
- **No sweep change.** `sweep-we-aggregators.js --mode=closed --shows=…`
  already works. `[CHANGED: v3 item dropped — Design]`
- **Files are keyed by season:** `data/audit/we-historical-candidates-<season>.json`.
- **The approvals file** is `data/audit/we-historical-approvals.json`:
  `{season: {title: {decision, reason}}}`, schema-tested and kept across
  re-discovery.

## Row shape written by promote

- `status: 'closed'`, `tags: ['historical']`, `discoverySource: 'we-historical:wos'`.
- `previewsStartDate`, `openingDate`, `closingDate` from WOS.
- WOS listing URL kept as `sourceUrls.wos`.
- No `provisional`, and no `todaytixId` (so `update-show-status.js` can never
  reopen an old production).

`[CHANGED: drop provisional:true — nothing clears it, and it would put
~90 rows/season into a paid daily Playbill sweep. The dated WOS listing is
the validation, the same rule as "the roundup IS the validation" for
regional/tour rows (validate-show-venue.js:195-210). — Structure]`

**Closing-date caveat:** for a show that closed early, the WOS listing can
carry the planned date. That only widens the window, so it doesn't drop real
reviews. A candidate whose closing date is in the future or missing is not
promotable.

## Ramp

`[CHANGED: smaller first increment. v3 built every fix before the first
batch; v3.1 builds only discovery + promote, runs 5 shows through the
EXISTING pipeline, and lets the audit decide which other fixes are needed.
— Structure (10b), Phase 0]`

**Phase A (this session):**
1. Build discovery and promote: WOS adapter, Olivier signal, decide function,
   dedup, id year, dates.
2. Fix the WET URL bleed. It is a confirmed bug on live paths, and the S0.5
   shows' 13 URL-less reviews are its free acceptance test: re-run
   `merge-wet-stars-urls.js` on Juno and Barcelona.
3. Discover 2024-25 locally (free). Hand-check 10 single-source rows.
4. Promote 5 shows: an NT stage, a commercial musical, a commercial play, a
   revival at a reused venue, and a short run.
5. Run them through the existing CI chain, dispatched **one run at a time**,
   each waited on, with completion checked by counting files in the data
   repos, not by run status:
   - `gather-reviews.yml` (comma list)
   - `review-refresh.yml` `tr_show_filter`
   - `merge-wet-stars-urls.js`
   - scoring and rebuild on their crons
   - `fetch-all-image-formats.yml` with `show_id=<comma list>` and
     `include_closed=true`. The scheduled image run skips closed shows, so
     promoted rows otherwise stay imageless. Broadway's
     `discover-historical-shows.yml` dispatches this per batch; the WE
     promote step must too. Until BRO-2242 (venue/date check in the image
     matcher) lands, eyeball every same-title pair: the 2025 Old Vic Oedipus
     got the 2024 Wyndham's poster in Phase A and had to be cleared.
   - `backfill-historical-metadata.yml` for synopsis and creative team.
     It has no cron.
6. Run the season audit (below) on the 5. Build TR production-by-date picking,
   the TR `evaluateDateGuard` routing and the WET date bounds only if the
   audit shows wrong-production or missing reviews.

**Phase B:** the full 2024-25 season. This needs the owner's OK on the cost
(~$60-80, vs the $5-35 v2.2 quoted).

**Phase C:** 2023-24 to 2018-19, then 2017-18 and 2016-17. A
`we-historical-backfill.yml` orchestrator comes only after a full season lands
by hand (§18 review first).

**Phase D:** pre-2016 is a separate owner decision. TR is scanned PDF and needs
OCR.

## Season audit (the quality gate, with a command)

`[CHANGED: v3's gate had no command, timing or failure path — Gemini,
Structure, Pre-mortem]`

`node scripts/audit-we-historical-season.js --season=Y` is read-only and
prints pass/fail per check. It is measured 7 days after the season's last
scoring dispatch.
- ≥70% of promoted shows reach the 5-review display threshold.
- **Every** promoted show: no included review dated outside
  [previews − 35 days, close + 7 days]. This replaces the 10-show spot
  check, so every show at a reused venue is covered.
- T1/T2 URL-or-TR-provenance rate, reported rather than blocking.
- Star present where WET carries one.
- No outlet+critic twice per show.
- Spend tagged `historical-backfill` within budget.

**On failure:** fix forward (flag the bad reviews, correct dates, re-run
merge). Do not start the next season. Before reviews are gathered, a bad
promotion can be undone with `promote-historical-we.js --revert --season=Y`,
which removes rows listed in the promotion log that have no review texts yet.

## User-facing notes (User Impact reviewer)

- **Browse:** closed shows appear only with a score and enough reviews
  (`WestEndPageClient.tsx:365`), so promoted rows stay out of browse until
  they qualify.
- **Show pages:** promoted rows get pages and sitemap entries before reviews
  land, which is the same as Broadway's backfill. Keep the gap short by
  dispatching gather within the same session as promote. Whether thin closed
  pages should be noindexed is a site-wide SEO question, filed separately.
- **No alerts:** promote commits never match the "added N new show" digest
  pattern or `new_slugs`, so no Opening Night Express, newsletter item or
  index ping fires (`update-show-status.yml:1744-1793`,
  `generate.mjs:832`).
- **All-time rank:** "#N all-time" on current London shows will move as each
  season lands. That is the backfill making it more true, since today
  "all-time" means "since 2024". No change.

## Known gaps found in Phase A (2026-10-07)

- **Productions WOS never listed.** About 10 per season have a WOS review at
  a West End venue but no listing, so there are no dates: Coriolanus (NT,
  2024), The Importance of Being Earnest (NT, 2024), The Real Thing (Old Vic,
  2024), Elektra (Duke of York's, 2025). They are in each candidates file
  under `unlistedReviews`. Phase B needs a dated source for them: Theatre
  Record production pages carry dates. Do not guess dates from the review
  date.
- **No review signal, but famous.** Example: Macbeth (Harold Pinter, 2024,
  Tennant). These go through the approvals file after a human check.
  WOS's opening date for that run (12-08) was also wrong, and discovery now
  drops implausible opening dates (more than 6 weeks after the first
  preview, or equal to it).
- **Opening date often unknown.** 21 of 39 promotable 2024-25 rows carry
  previews only. TR or the reviews' publish dates can fill press night
  later; the date guards key off the earliest date, so inclusion is
  unaffected.

## Pilot results (6 shows, 2026-10-08)

**What happened:**
- **Gather.** gather-reviews run 37706111772 (re-queued once; BRO-4859)
  collected 14-45 review files per show.
- **Theatre Record.** TR via review-refresh run 37713373821 returned texts
  for 5 of 6 shows. It found nothing for "Just For One Day – The Live Aid
  Musical": TR search misses the en-dash subtitle.
- **Star and link merge.** Full stars and URLs for Dr Strangelove (16 files).
  No WET roundup was found for the two Oedipus productions, Here We Are or
  The Legends of Them. That is expected for one-word titles, since
  wetPostTitleMatchesShow needs "Oedipus reviews…" to lead the post title,
  and WET's coverage of NT and Royal Court runs is thin.

**Built because the pilot showed real harm** (the plan said to build these
only if needed):
- **TR production pick** (lib/tr-production-pick.js). The 2025 Old Vic
  Oedipus' 14 reviews were filed under the 2024 Wyndham's row.
- **UK auto-clear rule.** It left alone the "after close" date flags it had
  been clearing, which 5 of those 14 had relied on.
- **WET roundup date window.** "Just For One Day" (2025) matched the 2023
  Old Vic roundup.
  - The first window ran to closing + 120 days. That still let the 2024
    Wyndham's Oedipus take the Feb 2025 Old Vic roundup and write its
    stars and URLs onto 15 files (reverted, review-texts 99f4825b8).
  - The window is now [first preview − 30 days, press night + 60 days].
    Each post's own date is enforced, because the API date filter did not
    survive the fetchJSON proxy path.
  - Lesson for Phase B: every same-title pair (revivals, NT-to-West End
    transfers) is the risk case. Run the season audit and spot-check
    those pairs first.
- **Manual flags lost on rebase.** A gather job that checked out before a
  manual wrong-production flag wrote the file back; the rebase restore
  returned the flag without its reason, and the rebuild's UK-URL auto-clear
  then removed it. The restore now brings a live flag's reason and note back
  with it (restore-protected-fields.js). Re-flagged in review-texts 657bde10f.

**Fixed in the data:**
- The 14 misfiled reviews were removed (review-texts db8e50881).
- The 2024 poster wrongly given to the 2025 Old Vic Oedipus was cleared.

**Before Phase B:** re-run TR for oedipus-west-end-2024 with the fixed pick.
Then run `audit-we-historical-season.js --season=2024-2025` once scoring
drains.

## Phase B results (2026-10-08)

Owner approved the spend. Promoted 33 more 2024-25 shows and 15 from 2025-26
that closed before the London launch (core data 54adba9). Gathered, ran
Theatre Record and the WET merge per show, plus posters and synopses.

- **Reviews:** 1,113 usable review texts across the 54 shows; 53 of 54 have
  at least 5. P*rn Play had none (see below). 746 scored on day one; the rest
  drain through the scoring crons.
- **Pre-launch gaps:** 27 thin London shows from Sept 2025 to Mar 2026 that
  were already on the site got about 100 more reviews from Theatre Record.

Lessons, each fixed in code:
- **Gather dropped half the list.** The per-job 35-minute budget deferred
  24 of 48 shows "to next run" with nothing scheduled. Fixed under BRO-4859
  (deferred ids are uploaded and re-dispatched), with the queue-eviction fix.
  Dispatch about 4 shows per job.
- **Posters from the wrong production.** Theatr (NYC-only) and Mezzanine's
  Broadway tie-break gave London rows Broadway art (Othello, Godot) and old
  Broadway rows a later revival's art. scripts/lib/image-source-match.js picks
  by venue, then city, then nearest date; show.rejectedImageUrls makes a
  rejection stick. Old Broadway rows continue under BRO-2242.
- **Synopses.** The metadata workflow could not target shows (now `shows`),
  had no Playwright, and gave preview-only rows no year. The wrong-show
  verifier rejects any record too sparse to confirm, so TodayTix pages whose
  own product record matches are trusted, using only the cleaned
  product.about story sentences (scripts/lib/todaytix-page-identity.js).
- **Censored titles.** WOS lists "Porn Play" as "P*rn Play", so search found
  nothing. promote-historical-we.js now holds a censored title until
  approvals[season][title].title gives the real one.
- **Opening dates from an older production.** update-show-status flipped rows
  open on an earlier production's reviews (BRO-4857); review dates before
  previews no longer count.

## Phase C (BRO-4884, from 2026-10-08)

2023-24: promoted 68 rows (60 promotable plus 8 approved in
data/audit/we-historical-approvals.json: famous runs WOS gave no genre or
review link, e.g. Hamnet, Old Friends, Why Am I So Single?). All 68 posters
checked by contact sheet, all correct.

Lessons, each fixed in code:
- **Producer copy saved as synopses.** 12 of 51 new synopses were pitch:
  "currently playing at Wyndham's ... rave reviews" with a Times pull quote,
  "one of nine shows in the theatre's 2024 season", a meta tag cut off at
  "Jeremy Herrin (". The TodayTix meta/JSON-LD fallback skipped the
  story-sentence filter, and the filter missed billing lines ("X stars in",
  "returns to the West End", "premiered", "Book <title>", "cast also
  includes"). Both paths now share cleanTodaytixAbout
  (scripts/lib/todaytix-page-identity.js, tests in its .test.mjs); text with
  no story left falls back to the LLM writer and its wrong-show check.
  A second pass added "reprise their roles", "Award nominee" and "this
  <adjectives> production" (A Mirror, Bacchae); "transports audiences" was
  left out because it leads story sentences.
- **Silent LLM synopsis failures.** The re-run left 20 of 27 rows empty
  after a bare "Generating via Claude..." line. callClaudeAPI swallowed HTTP
  errors and UNKNOWN/invalid replies were dropped without a word; both now
  log the reason (scripts/auto-fix-show-data.js).
- **Musicals stored as plays.** WOS gives no genre for many rows, and promote
  defaulted every genre-less row to play: 7 of 68 in 2023-24 were musicals
  (Sunset Boulevard, Next to Normal, Old Friends, ...). Promote now also reads
  "musical" from any existing same-title row, takes a per-title `type` in the
  approvals file, and prints every row it still guessed as play so the hand
  check catches the rest (inferShowType in promote-historical-we.js, tests in
  we-historical-pipeline.test.mjs).
- **Revivals got no synopsis.** The Opus wrong-show check answered MISMATCH
  for a correct plot of Pygmalion, King Lear or The King and I because
  nothing in it was specific to this staging. buildVerificationPrompt now
  says a revival tells its source work's story. Checked with GPT-4o and
  Gemini standing in: 10/10 on revivals with the new wording, every
  wrong-show trap still MISMATCH (old wording 5/10 and 9/10). The writer
  prompt got the same revival clause, its 300-token cap no longer cuts
  mid-sentence (cutToLastSentence in synopsis-validation.js), and its log
  now says "replied UNKNOWN" or "no complete sentence" instead of "no text
  returned".
- **Review files are not scored reviews.** Show Score and SERP discovery
  write URL-only stubs; they count toward the audit only after the
  collect-review-texts cron fetches the text and scoring runs. Some Show
  Score rows are dated "For a previous production" (A View from the Bridge
  2024 listed the 2014 Young Vic reviews). That string parsed to no date, so
  no guard saw it, and collection never looked for the real date because the
  field was not empty. Corpus-wide: 30 such rows, 9 not excluded, 2 of them
  scored and live (The Play That Goes Wrong Off-Broadway 2019). The
  pre-rebuild flagger now marks them wrongProduction unless the show declares
  priorRuns or tourLegs (evaluateShowScorePreviousProduction in
  lib/date-guard.js, tests in date-guard.test.mjs), and collection replaces
  the string with a real date when the page has one. Run the audit after
  collection and scoring have drained, not right after gather.
- **Validation errors block every data save.** The 2023-24 synopsis re-run
  was written but refused at push: validate-data failed on three rows, none
  from this season's logic. (1) The flagger held a 2018 King and I review on
  an LLM "affirms this production" pass alone, so it stayed includable and
  CHECK 0 failed; that signal now holds only within 180 days
  (shouldHoldDateGuardFlag in lib/wrong-production-corroboration.js), and a
  dry run flags 7 more such rows years early. (2) The BWW/LBO excerpt-stub
  path in gather-reviews had none of createReviewFile's guards and kept
  re-creating a director-as-critic stub; both write paths now refuse junk,
  fragment and creative-team outlets/critics (lib/aggregator-stub-guard.js).
  The two existing rows are fixed by data/pending-fixes/bro-4884.json. The
  third, Gang of Three, is a return of the 2025 King's Head staging; its 2025
  review is excluded until that run is recorded as a priorRun.
- **Invented plot for a new play.** Haiku answered UNKNOWN for Instructions
  for a Teenage Armageddon; the Opus fallback wrote an emo/My Chemical
  Romance/dead-father plot (the play is a girl grieving her sister) and the
  Opus wrong-show check passed it. A fallback synopsis now needs web search
  results about this production that describe the same story
  (lib/synopsis-grounding.js; only SUPPORTED keeps it). Prompt checked with
  GPT-4o and Gemini standing in for Haiku: the invented plot is dropped with
  plot snippets and with no-plot snippets, the real plot, Dorian Gray and
  Vanya are kept (GPT-4o dropped Vanya: empty, never wrong). Sweep of the 62
  LLM synopses from these runs found no other invention; the bad one was
  replaced from the London Theatre review. Grounding first dropped correct
  adaptation plots (Orlando, The Boy with Two Hearts) whose snippets named
  the source without retelling it; a named published source now counts.
- **Gather dispatch needs `spend_purpose=historical-backfill`.** Since
  ed718734e54 (BRO-4146) gather-reviews.yml skips every job when a manual
  dispatch has `no_sb_serp=true` and no `spend_purpose` (it reads as the
  retired Mac backfill). The run still ends green, so a re-gather of 13 thin
  2022-23 shows did nothing and looked done. Dispatch with
  `-F inputs[no_sb_serp]=true -f inputs[spend_purpose]=historical-backfill`
  and check that `prepare` ran, not just the run conclusion.
- **Recast runs pick up the original run's reviews.** Long runs that move
  theatres with a new star (2:22 A Ghost Story: Noel Coward 2021 with Lily
  Allen, Lyric 2023 with Cheryl) share critics and titles. On the 2023 row a
  merge swapped a Cheryl news url for the same critic's 2021 review, the next
  refresh took the 2021 date from it, and the Theatre Record batch added the
  real 2023 text. Date says 2021, the Theatre Record month says 2023, so the
  flagger holds the row and validate-data fails, blocking pushes. Repaired by
  deleting the three mixed records and re-running Theatre Record
  (data/pending-fixes/bro-4884-c.json). When the audit or validate-data shows
  a held row on a recast run, check whether the text and the url describe the
  same staging before flagging either way.
- **Model-proposed directors were the wrong production's.** The metadata
  step asks a model for the creative team and keeps a name when a search
  snippet says "<title> ... directed by <name>". For a revival that confirms
  whoever directed any staging: Dominic Cooke for the 2019 Wyndham's Curtains
  (Paul Foster), Ivo van Hove for the 2019 Death of a Salesman (Marianne
  Elliott and Miranda Cromwell), Roger Michell for The Man in the White Suit
  (Sean Foley), and others across every season. Directors and choreographers
  from that path now also need the venue in the confirming evidence
  (`productionAnchor` in lib/creative-team-verify.js); writer roles are the
  same in every production and keep the old check. The historical rows'
  existing directors were re-checked with search-grounded Gemini and the
  disagreements were checked by hand before removal. The move also exported
  verifyCreativeTeamViaSerp, which three Broadway scripts imported from that
  module although it was never exported there (their tests mocked it).

## Side benefit (separate card)

321 London-market rows have no `openingDate`, but 275 of them are
announced, upcoming or in previews, where that is expected. Only about 46
closed or open rows (3 West End, 43 Off-West End) could use a WOS-sourced
date. That is small, separate work and must not be bundled into the
backfill writes.

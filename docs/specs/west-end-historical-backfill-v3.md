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
     promote step must too.
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

## Side benefit (separate card)

319 West End-market rows have no `openingDate`. The WOS adapter can fill
them. It is separate work and must not be bundled into the backfill writes.

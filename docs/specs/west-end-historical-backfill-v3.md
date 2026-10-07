# West End historical backfill: plan v3

Linear: BRO-4851. Supersedes plan v2.2 (Notion card 3b7637c5, 2026-08-09; the
v2.2 doc itself lived only on the owner's Mac). Owner approved the restart on
2026-10-07.

## Goal

Critic Scores for closed West End productions, walking back one season at a
time from 2024-25, the same way Broadway was backfilled. "West End" means the
`west-end` category (`isWestEndVenue()` in `scripts/lib/venue-classification.js`):
the commercial houses plus the National Theatre stages, the Old Vic and the
Royal Court. Off-West End is out of scope.

## Where v2.2 got to

| Stage | State on 2026-10-07 |
|---|---|
| S0.5 two-show smoke test | Passed. `juno-and-the-paycock-west-end-2024` (cs 58, 23 reviews) and `barcelona-west-end-2024` (cs 56, 18 reviews) are live. 13 of 41 reviews still have no URL, including FT and Daily Mail on Juno. |
| S1 season discovery | Built, but returns 0 candidates. |
| S2 WET star/URL merge | Built (`merge-wet-stars-urls.js`), single show, run by hand. |
| Batch run of a season | Never started. No owning card after the Notion to Linear move. |

## What the review found

1. **Discovery reads a page that does not exist.** `discover-historical-shows-we.js`
   fetches `en.wikipedia.org/wiki/2024–25_West_End_theatre_season`. That page,
   and every other "West End theatre season" title, is a 404 (verified with
   curl 2026-10-07). The Olivier and OLT sources are stubs, so with one dead
   source nothing could ever corroborate.
2. **Promote bugs** (`promote-historical-we.js`):
   - The id year comes from the season start (`:81-84`), so a show opening in
     Feb 2019 gets `-2018`. Broadway/OB use the opening year.
   - `previewsStartDate` and `closingDate` are left null. TR and WET guards then
     have no upper date bound.
   - Dedup is title + venue only, so a same-venue revival from another year is
     silently dropped.
   - Uncorroborated rows need one `--allow-uncorroborated=<title>` flag each,
     which doesn't scale to ~90 shows.
3. **Wrong-production guards look only one way.**
   - `isLikelyWrongProduction` (`review-guards.js:1356`) rejects reviews from
     well *before* the show, but not reviews of a later London revival.
   - TR search sorts newest first and takes the first title match with no date
     check (`extract-theatre-record.js:1087-1107`).
   - When no date parses, TR `publishDate` falls back to the show's opening date
     (`:970`), which hides the problem.
4. **WET roundup lib** (`wet-roundup-discover.js`):
   - Post search has no `after`/`before`, so a revival can pick another year's
     roundup.
   - `nextAll('a')` is unbounded (`:203-208`), so a review block with no link
     takes the next outlet's URL.
   - URLs are only merged for star-rating outlets.
   - No tests.
5. **Nothing runs a season.**
   - TR extraction accepts a comma list in `review-refresh.yml`, but it logs in
     again per show and the job has a 45-minute limit.
   - `sweep-we-aggregators.js` defaults to `--mode=open`, so closed shows are
     silently dropped.
6. **Scale and cost were underestimated.**
   - A season is ~90 West End theatre productions, not ~50.
   - v2.2's $5-35 covered scraping only. LLM scoring is ~$0.04/review
     (Sprint 4 actuals), so ~90 shows × ~15 reviews is ~$55 of scoring.
   - Realistic total: **~$60-80 per season, ~$550-700 for 2016-17 to 2024-25.**

## Discovery: new sources

Tested live from cloud on 2026-10-07:

| Source | Use | Notes |
|---|---|---|
| WhatsOnStage REST `wp-json/wp/v2/shows?market=98` | **Primary discovery** | 2,721 West End listings with venue id, preview, opening and closing dates. Covers 2018-19 onward well (84-124 per season); thin before that. robots.txt allows it. |
| WhatsOnStage REST `wp-json/wp/v2/news?categories=63,69&after=&before=` | Corroboration, and discovery for 2016-18 | Reviews titled "X at the Venue – review", every season back to 2016. |
| Wikipedia `YYYY_Laurence_Olivier_Awards` (action=parse wikitext) | Independent corroboration | `''[[Title]]'' – [[Venue]]` pairs, ~50-70 productions a year, no dates. Eligibility runs ~Mar-Feb, so check both ceremony years. Needs a UA and backoff (429s). |
| Theatre Record | Not discovery | Login only, no production index. Stays the full-text source. |

Blocked or too thin: westendtheatre.com (403 to direct fetch), OLT (current
shows only), theatre.reviews (285 roundups total), The Stage sitemap (back to
2024 only), Theatricalia (bot challenge).

A 2023-24 trial build found 116 rows: 95 theatre, 8 opera/dance, 7 children's,
6 concerts or stand-up. 65 of the 95 have 2+ sources, and spot checks were
correct (Pygmalion, Old Vic, opened 2023-09-12).

**Inclusion rule.** A candidate is promotable when it has:
- a WOS listing at an `isWestEndVenue()` venue;
- a run of at least 14 days;
- a theatre genre (not opera, dance, concert, talk, children's or panto);
- a review signal: a WOS review, an Olivier nomination, or a WET roundup.

The review signal replaces v2.2's "2 independent sources" rule. WOS listing
and WOS review share a publisher, but the listing is a primary listing, and
the real failure mode (wrong dates or venue) is caught by
`validate-show-venue.js` because rows are written `provisional: true`.
Everything else goes to a reviewed approvals file (`--approve-file`), not
per-title flags.

## Fixes before any batch (S1 rework)

1. Discovery:
   - Replace the Wikipedia season source with WOS listings, WOS reviews and
     Olivier.
   - Export the parsers, with node:test fixtures from real responses.
   - Write previews, opening and closing dates plus source URLs into the
     candidate.
2. Promote:
   - Id year from the opening date (preview date as fallback), via the same
     helper OB uses.
   - Carry previews and closing dates.
   - Date-aware dedup: a same title + venue is a duplicate only within ±1 year.
   - `--approve-file`.
   - `provisional: true` plus `tags: ['historical']`.
3. Guards:
   - Two-sided `isLikelyWrongProduction` for closed shows: also reject reviews
     more than 120 days after the closing date, or after opening + 1 year when
     there is no closing date.
   - TR: pick the production by venue + date, and don't fall back to the
     opening date for `publishDate`.
4. WET lib:
   - `after`/`before` from the show's dates.
   - Limit the URL to the review's own block.
   - Merge URLs for non-star outlets.
   - Tests.
5. `sweep-we-aggregators.js`: honour `--shows` for closed shows.

## Running a season (S2)

Per season, in order:

1. `discover-historical-shows-we.js --season=Y` writes
   `data/audit/we-historical-candidates.json`. A human (or the session)
   reviews the uncorroborated rows.
2. `promote-historical-we.js --season=Y --apply` writes shows to core data. The
   standing `validate-show-venue` CI pass clears `provisional`.
3. Reviews come from `gather-reviews.yml` with the comma list, sharded: the
   archive and WET live fallback, SERP (`no_sb_serp`), and outlet search.
4. Full texts come from TR via `review-refresh.yml` `tr_show_filter`, in chunks
   of 8 to stay under the 45-minute limit.
5. Stars and URLs come from `merge-wet-stars-urls.js` per show, then
   `flag-late-star-reanchor.js`.
6. Scoring (`llm-ensemble-score.yml`) and the daily rebuild run on their
   standing crons.

Ramp: 5 shows (a mix of NT, commercial musical, commercial play, a revival at a
reused venue, and a short run), then the full season. Only after a full season
lands do we wrap steps 3-5 in one `we-historical-backfill.yml` workflow (§18
review first). Building the workflow before the steps are proven is how v2.2
stalled.

## Quality gate per season (must pass before the next season)

- ≥70% of promoted shows reach the 5-review display threshold.
- Zero wrong-production reviews in a 10-show spot check, with each show's
  review dates within its run.
- T1/T2 reviews: each has a URL **or** TR provenance. Every outlet that uses
  stars has its star where WET carries it. Report the URL coverage rate rather
  than block on it: paywalled TR-only reviews legitimately lack one.
- Outlet sanity: no outlet appears twice for the same show unless it is a
  Sunday/daily pair (Times/Sunday Times both map to "The Times (UK)", which is
  site-wide convention).
- Spend recorded under `historical-backfill` (`lib/spend-purpose.js`) within
  the approved budget.

## Sequence

1. 2024-25 (TR HTML, freshest web coverage)
2. 2023-24 to 2018-19 (WOS listings strong)
3. 2017-18 and 2016-17 (discovery from WOS reviews; TR digital PDFs)
4. **Pre-2016 is a separate decision.** TR is scanned PDF (needs OCR), and web
   coverage thins out, as it did on Broadway before 2010.

## Side benefit

319 West End-market rows have no `openingDate`. The WOS listing data can fill
opening and closing dates for current shows too. That is a separate card, and
it should not be bundled into the backfill writes.

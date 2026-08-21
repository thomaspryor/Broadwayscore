# Aggregator scraper SERP cost audit (BRO-764)

Migrated from Notion `33f637c5-416f-810a-b4cb-f12e3d833f4d`. The 2026-04-11
SERP cost reduction plan cut per-review retry spend in
`collect-review-texts.js` and friends but explicitly excluded aggregator
scrapers — scripts that SERP per-show to *discover* an aggregator page URL
(review roundup / verdict page), as distinct from fetching a review's own
text. This doc audits that excluded surface: which scrapers actually SERP,
how much, what guards already existed, and what BRO-764 adds.

## Which aggregator scrapers actually issue per-show SERP queries

The issue's key-files list named 8 scripts by aggregator; the audit checked
all of `scripts/scrape-*.js` for `serpQuery(` (the shared SERP entry point,
`scripts/lib/url-discovery.js`) rather than trusting the list:

| Aggregator | Script | Calls `serpQuery` per-show? | Notes |
|---|---|---|---|
| BroadwayWorld | `scrape-bww-reviews.js` | Yes | Weekly batch, `/reviews/` page uses deterministic URL slugs (no SERP), roundup discovery falls back to SERP |
| Playbill Verdict | `scrape-playbill-verdict.js` | Yes | Weekly batch; category-page sitemap discovery first, SERP is step 4 fallback only |
| NYC Theatre | `scrape-nyc-theatre-roundups.js` | Yes | Weekly batch, no category-page discovery — every unarchived show hits SERP |
| London Box Office | `scrape-london-box-office-roundups.js` | Yes | **Opt-in only** — gated behind `--targetShowIds`, not a batch sweep. Site-sitemap matching runs first; SERP is the manual-targeting fallback |
| Show Score | `scrape-show-score.js` | No | Direct URL construction / site search, no `serpQuery` |
| DTLI | `scrape-dtli.js` | No | Direct URL construction |
| theatre.reviews | `scrape-theatre-reviews.js` | No | Direct URL construction |
| WestEndTheatre | `scrape-westendtheatre-roundups.js` | No | Category-page discovery only |
| Stagedoor | `scrape-stagedoor-critics.js` | No (`discoverCorrectUrl`, not `serpQuery`) | Different discovery path, out of scope for this audit |
| The Stage | `scrape-thestage-roundups.js` | No | Category-page discovery only |

The issue's "scripts/scrape-dtli-show-score.js" doesn't exist as a single
file — DTLI and Show Score are separate scrapers, neither of which SERPs
per-show. **Net: 4 scripts issue per-show SERP queries** (BWW, Playbill
Verdict, NYC Theatre, London Box Office), and of those, 3 run as unconditional
weekly batch sweeps; LBO's SERP path only fires when a human explicitly
targets a show that the sitemap match missed.

## What was already in place before BRO-764

Grepping for the guard rails already wired into the 3 batch scrapers
(`scripts/lib/discovery-eligibility.js`, added for a prior card, #1632)
turned up more coverage than the issue's evidence section assumed:

- **`isClosedShowEligibleForBatchDiscovery`** — used by all 3 batch scrapers
  (BWW, Playbill Verdict, NYC Theatre). A closed non-regional show is
  excluded from batch SERP entirely (0-day window, stricter than this
  issue's 180-day ask). A closed **regional** show gets a 90-day post-close
  grace window (regional runs are short and may close before weekly
  discovery ever reaches them) — also stricter than 180 days.
- **14-day archive-freshness cache** — inline in all 3 batch scrapers
  (`fs.statSync(...).mtimeMs` age check before falling through to SERP).
  Already exactly the check BRO-764 asked to add.
- **London Box Office had neither** — no lifecycle gate, no archive-cache
  check ahead of its SERP fallback. Lower priority (opt-in, not batch) but a
  real gap.

So AC #2 ("skip SERP for shows closed >180 days") was **already satisfied**
for BWW, Playbill Verdict, and NYC Theatre before this card — those three
already skip *any* closed non-regional show and cap regional retries at 90
days, both stricter than 180. What was genuinely missing everywhere,
including these three, was a **permanent skip after repeated SERP misses**:
none of the 4 scripts persisted a negative/miss counter, so a show whose
aggregator page was never going to exist (never covered, or a naming
mismatch the matcher can't bridge) burned one SERP call every week,
indefinitely, for its entire eligibility window.

## Baseline volume (current corpus, `data/shows.json`, 2907 shows)

```
open shows:                          563
closed shows:                      2,344
  closed >180 days (would now gate):  2,013
  closed, category=regional:             14
weekly batch population (BWW/Playbill Verdict/NYC Theatre —
  passes isClosedShowEligibleForBatchDiscovery AND opened ≥2023-01-01): 209
```

209 shows are in the weekly batch sweep across the 3 scrapers × up to 1
`serpQuery` call each when their 14-day archive is stale = **up to ~627
SERP calls/week** in the worst case (every show's archive expires the same
week). In practice archive hits reduce this — a show that's already been
successfully discovered re-uses its cached HTML until it turns 14 days old,
so steady-state volume is dominated by shows the pipeline has *never*
successfully discovered (new shows, and misses). Those misses are exactly
the ones this card's 3-strikes skip now caps.

## What this card adds

1. **`scripts/lib/aggregator-serp.js`** (new shared lib):
   - `isEligibleForAggregatorSerp(show, {windowDays=180})` — general-purpose
     lifecycle gate for scrapers that don't yet have one. Doesn't replace
     `isClosedShowEligibleForBatchDiscovery` in the 3 batch scrapers (already
     stricter, already tested, rewriting a tuned discovery pipeline shared by
     3 mature scripts is a regression risk this card doesn't need to take on)
     — the primary new adoption is **London Box Office**, which had no
     lifecycle gate at all (batch or targeted). It's also called inside BWW's
     `discoverBwwRoundup` as a safety net: a no-op under BWW's normal batch
     path (already excluded upstream by `isClosedShowEligibleForBatchDiscovery`)
     but the only active lifecycle check when BWW runs in `--shows=` targeted
     mode, which bypasses that upstream batch filter entirely.
   - `checkArchiveCache(path, {ttlDays=14})` — factors out the "reuse HTML
     younger than N days" check that BWW, Playbill Verdict, and NYC Theatre
     each independently duplicated inline. Wired into BWW's roundup
     discovery (`discoverBwwRoundup`) as the reference adoption; Playbill
     Verdict / NYC Theatre keep their existing inline checks (functionally
     identical, lower-risk to leave alone given the same
     already-covers-the-AC reasoning above).
   - `recordAggregatorSerpAttempt(source, showId, {success})` /
     `shouldSkipAggregatorSerp(source, showId)` — the new piece. 3
     consecutive misses (namespaced per aggregator source, so a BWW miss
     doesn't count against Playbill Verdict) sets `skip_aggregator_serp`,
     persisted to `data/aggregator-archive/_serp-skip-state.json` — inside the
     directory tree the `checkout-aggregator-archive`/`push-aggregator-archive`
     composite actions already sync to the private repo every CI run, so the
     state survives across ephemeral `ubuntu-latest` runners without any new
     workflow wiring. A single hit
     resets the streak. `resetAggregatorSerpState` clears an entry (returning
     productions, manual re-checks after a discovery-bug fix).
2. Wired the skip-state gate into all 4 SERP-calling scrapers (BWW, Playbill
   Verdict, NYC Theatre, London Box Office) and the lifecycle gate into
   London Box Office.
3. Unit tests: `scripts/lib/aggregator-serp.test.mjs` (19 cases — lifecycle
   window boundaries, archive TTL boundaries, 3-strikes skip/reset, per-source
   namespacing, disk persistence, and a real multi-process concurrency test —
   see below). Runs automatically via CI's `scripts/lib/*.test.mjs` glob
   (`scripts/lib/**` is already a `test.yml` push-path trigger — no separate
   registration needed).

### Concurrency fix (post-review)

A `/second-opinion` pass on the implemented diff caught a real design blocker
before this shipped: BWW, Playbill Verdict, NYC Theatre, and LBO run as 4
separate workflows on independent cron schedules and concurrency groups, and
each read-modify-writes the SAME `_serp-skip-state.json` file. The original
`recordAggregatorSerpAttempt`/`resetAggregatorSerpState` did an unlocked
load→mutate→save — two overlapping workflow runs writing different show keys
could silently clobber each other's update, under-counting misses. Fixed by
wrapping both in `scripts/lib/file-lock.js`'s `withFileLock` (the same
cross-process lock primitive other JSON read-modify-write sites in this repo
use; fails open on a stuck lock rather than hanging a scraper run). Verified
with a real multi-process test (`aggregator-serp.test.mjs`, "concurrent writes
from SEPARATE OS processes") that spawns 8 child processes writing distinct
keys simultaneously and confirms all 8 survive.

### Known limitation (not fixed — documented tradeoff)

BWW's `discoverBwwRoundup` records a miss whenever its Google + BWW-internal
search both come up empty — but `googleSearch()` (and BWW's internal search
helper) already swallow SERP/network errors internally and return `[]`,
identical to a genuine "searched, found nothing" result. A multi-run SERP API
outage (quota exhaustion, sustained network failure) could therefore trip the
3-strikes skip on shows that were never actually searched. This ambiguity
pre-dates this card (the underlying `googleSearch()`/`serpQuery` swallow
pattern is unchanged) and affects all 4 scrapers' search helpers equally, not
something introduced here. The `maxMisses=3` default is the mitigation
already built into the design — it takes 3 *consecutive weekly runs* of the
same failure mode to trip, not one bad run, which should be enough headroom
for a transient outage to recover before a show gets wrongly blacklisted.
Recommend a follow-up card if `_serp-skip-state.json`'s entry growth rate
(post-deploy) looks anomalously high relative to the ~209-show weekly batch
population — that would indicate outage-driven false skips rather than
genuine misses.

## Verification

- `node --test scripts/lib/aggregator-serp.test.mjs` — 17/17 passing.
- `npx tsc --noEmit` — clean.
- `node --check` on all 5 edited/added files — clean (syntax only; the real
  test coverage is the unit suite above plus this doc's real-data volume
  query against the live 2,907-show corpus).

## What's NOT verified yet (needs production runs)

AC #6 ("SERP cost reduction verified: daily spend drops to ~$1-2/day within
7 days of deployment, cross-reference cost explorer") cannot be verified from
a single implementation session — it requires 7 days of production cron runs
after this ships. The skip-state file
(`data/aggregator-archive/_serp-skip-state.json`) is the artifact to check
after that window: a healthy rollout should show a growing set of
`skip_aggregator_serp: true` entries for the historical-miss population and
a flattening SERP-call count in the BD/ScrapingBee cost explorer for the 4
scripts named above. **Recommend a `RECHECK-AFTER` follow-up** (per
CLAUDE.md session-discipline rules — a fix whose effect is only observable
later can't be claimed fully Done) at 2026-08-28, checking both the skip
state file's entry count and actual SERP spend against the BD cost explorer.

# Aggregator scraper SERP cost audit (BRO-764)

Audited 2026-10-06 against `origin/main`. Source of truth for what bounds each scraper's per-show SERP
volume. The inventory is enforced by `scripts/lib/aggregator-serp.test.mjs`: a new scrape script that calls
`serpQuery` or `discoverCorrectUrl` fails that test until it is added to the inventory and to this file.

## Baseline (shows.json, 2026-10-06)

| Set | Shows |
|---|---|
| All shows | 3,309 |
| Opened 2023 or later | 892 |
| Closed more than 180 days ago | 2,141 |
| Eligible for a batch SERP sweep (`isClosedShowEligibleForBatchDiscovery` and opened 2023+) | 311 |

The 311 eligible shows split as: open 173, upcoming 114, previews 15, closed 9 (all regional, inside the
90-day post-close window). By category: off-broadway 131, west-end 43, off-west-end 49, broadway 39,
tour 27, regional 22. The 2,141 shows closed more than 180 days ago never enter a batch sweep, so the
"skip shows closed over 180 days" step of the original card is already met, and by a stricter rule (no
closed non-regional show is batch-searched at all).

## Per-scraper inventory

| Script | SERP calls | What bounds it |
|---|---|---|
| `scrape-bww-reviews.js` | 1 `serpQuery` per show in the Google fallback | batch gate (closed shows dropped, opened 2023+), 14-day archive check before fetching |
| `scrape-playbill-verdict.js` | 1 per show that `fallbackTracker.needsFallback` says category-page discovery missed | batch gate, fallback tracker (only shows not matched in steps 1 to 3), 14-day archive cache |
| `scrape-nyc-theatre-roundups.js` | 1 per show (`site:newyorkcitytheatre.com` query) | batch gate, national tours excluded, archive check by id and slug |
| `scrape-london-box-office-roundups.js` | 1 per targeted show that the sitemap and curated map did not match | runs only with `--shows` (targeted), never in a batch sweep |
| `scrape-recoupment-announcements.js` | a few queries per eligible show | only shows not recouped plus closed within a year |
| `scrape-stagedoor-critics.js` | `discoverCorrectUrl` per review needing a URL | per-review, existing retry guards |
| `sweep-we-aggregators.js` | `serpQuery` per West End show | explicit `--mode=open\|closed\|all-we`; `all-we` is blocked in CI |
| `scrape-off-broadway-alliance.js` | a fixed few queries per run | per-run, not per show |
| `scrape-cast-changes.js` | per show | bounded to the active cast-change window |

Every `serpQuery` also passes through the shared 24h cache (`scripts/lib/serp-cache.js`), so repeat queries
inside a day cost nothing, and `scripts/lib/serp-negative-cache.js` adds a 45-minute empty-result cache for
off-Broadway and West End poller backups (Broadway is excluded on purpose: reviews can land within minutes).

Rough ceiling for a full weekly batch of the three roundup scrapers: 311 eligible shows x up to 3 scrapers =
about 930 per-show queries, less whatever the archive checks and the fallback tracker skip. Each query is
one provider request on a cache miss (the chain can retry a variant query, so the worst case is a small
multiple).

## What was not built, and why

The original card also asked for a persisted `skip_aggregator_serp` flag after 3 failed attempts. An earlier
attempt (branch `job/linear-BRO-764-mt2lmngn`, reviewed 2026-08-26) was rejected, and the reasons still
apply to any version of that idea:

1. A permanent flag locks out shows before their roundup exists. Aggregator pages do not exist until reviews
   drop (CLAUDE.md rule 14), and the opening-night poller dispatches repeatedly, so three pre-opening
   misses would blind the show for good.
2. A fetch failure or an LLM page-match rejection is not a miss. Only "the SERP returned no candidate URL"
   should count.
3. Targeted `--shows=X --force` recovery and `--dry-run` must bypass any skip.
4. The scrapers run in separate workflows on separate runners and sync the archive file by file, so one shared
   state file loses updates. State has to be sharded per source and per show.

If a skip state is ever added, use a decaying backoff (`nextEligibleAt`, as `t1-ledger.js` does), exempt
shows that have not opened yet, honour `force` and `dryRun`, and keep the state outside the lock-synced
archive directory.

## Spend verification

The acceptance item "daily SERP spend drops to about $1 to $2 per day" needs the provider cost dashboard and
7 days of data after any change. It cannot be checked from the repo. The gates above were already in place
before this audit, so the audit itself changes no spend.

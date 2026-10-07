# BWW reverse-discovery: freshness & backfill visibility (BRO-114)

`scripts/audit-reverse-discovery.js` finds shows that aggregators are
reviewing but that aren't in `shows.json` yet (task #477). One of its four
sources — BroadwayWorld's Google-News sitemap (`bwwgnewsbway.cfm`) — is a
same-day rolling window of recent Broadway-section articles: **live-verified
2026-07-26 at 99 articles spanning ~5 days**. That's the shortest window of
any source (WET/DTLI use `--days=45` sitemaps). This doc covers what happens
when `audit-reverse-discovery.yml` (the cron that runs it) is skipped or
delayed, and how to check whether that's currently happening.

## Cadence

`audit-reverse-discovery.yml` runs every 6h (`25 4,10,16,22 * * *`), upgraded
from a daily 10:25 UTC run. See the workflow file's header comment for why
(evidence freshness for the v2 reconciler's Broad-Strokes-class shows).

## The backfill mechanism (implicit, not explicit)

There is no dedicated "catch up on missed days" code path. Backfill happens
as a side effect of how the script already dedups:

1. Every run re-fetches each source's *current* rolling window.
2. It diffs that window against `data/audit/reverse-discovery-state.json`
   (keyed per candidate, `firstSeen` timestamp, never expires).
3. Anything in the window that isn't already a state key is "fresh" — it
   gets written to `reverse-discovery-candidates.json` and fires a Discord
   alert.

So if a run is skipped, the next run that actually executes still sees
everything that's *still inside the source's window* at that later point in
time, and treats it as fresh. **This works as long as total downtime stays
shorter than the shortest source window.** For WET/DTLI (45-day window) that
tolerates weeks of cron downtime. For BWW (~5-day window) it does not — if
the cron is down for longer than ~5 days, an article that appeared and then
rotated out of the sitemap in that gap is never seen by any run, and is lost
**silently**: no error, no alert, nothing in the candidates file, because
nothing ever fetched a window containing it.

## What was missing before this change

Nothing compared the audit's own output freshness against wall-clock time.
`reverseDiscoveryBacklogResults()` (`scripts/health-check.js`) only reports
when `reverse-discovery-candidates.json` has open candidates — a stale file
with zero candidates (the exact state a silently-lost BWW article leaves
behind) looked identical to "ran recently, nothing to report."

## The freshness check (this change)

`scripts/lib/reverse-discovery-freshness.js` exports
`checkReverseDiscoveryFreshness(report, nowMs)`, a pure function that compares
`report.generatedAt` (written by every audit run) against `nowMs`:

- **< 24h old** (`STALE_WARN_HOURS`): fresh, no flag. One missed 6h run plus
  buffer — avoids false alarms from ordinary cron jitter.
- **24h–96h old**: `warn` row in the daily digest, `"Data: BWW
  reverse-discovery audit stale"`.
- **≥ 96h old** (`STALE_ERROR_HOURS`): `error` severity — approaching the
  ~5-day BWW window's edge, real risk of a silent permanent loss.

`reverseDiscoveryFreshnessResults()` (`scripts/health-check.js`) formats this
into a digest row and is called unconditionally alongside
`reverseDiscoveryBacklogResults()` at the existing
`reverse-discovery-candidates.json` read site — so it fires even when
`candidates` is empty, covering the dangerous silent case above.

**Relationship to the existing `Cron: Reverse Discovery` check:**
`health-check.js`'s `CRITICAL_CRONS` list already has an
`audit-reverse-discovery.yml` entry (24h threshold) that checks via the
GitHub Actions API whether the workflow *ran* recently. That's a different
signal from this one — it can miss a run that executed but wrote a stale or
empty result (e.g. every source's fetch failed and it exited before writing
`generatedAt`), and it goes dark itself when GitHub API rate-limit headroom
is low (`hasLowHeadroom()` short-circuits it). This check reads the local
`generatedAt` stamp directly, so it still catches staleness when the
GH-API-based check can't run at all.

## How to verify visibility of backfilled data

1. **Check the audit's own freshness stamp:**
   ```bash
   node -e "console.log(require('./data/audit/reverse-discovery-candidates.json').generatedAt)"
   ```
   Compare against current time. Anything past 24h means a run was skipped
   or delayed; the digest will already have flagged it (see below).

2. **Check the daily digest for the stale-audit row.** It surfaces as
   `"Data: BWW reverse-discovery audit stale"` in the same digest that
   already carries `"Data: reviewed shows missing from shows.json"`
   (`data/audit/health-digest-snapshot.json`, folded into the morning
   autonomous email).

3. **Confirm the cron itself actually ran recently:**
   ```bash
   gh run list --workflow=audit-reverse-discovery.yml --limit=5 \
     --json databaseId,status,conclusion,createdAt
   ```

4. **If it's stale, dispatch manually to close the gap immediately** (safe —
   the script always re-diffs the full current window, so a manual run
   captures everything still inside each source's rolling window at that
   moment):
   ```bash
   gh workflow run audit-reverse-discovery.yml
   ```

5. **Confirm the manual run actually backfilled something new** by diffing
   candidate counts before/after, or watching for new entries in
   `data/audit/reverse-discovery-state.json` (new keys = newly-seen
   candidates this run).

## The hard limit

None of the above recovers an article that both appeared and rotated out of
the BWW sitemap entirely within a downtime gap longer than ~5 days — by the
time a manual/late run fetches the sitemap, that article is no longer in it
to find. The freshness check's job is to make that gap visible fast enough
(within the 24h/96h warn/error bands) that a human intervenes well before
the ~5-day loss threshold, not to make the loss itself recoverable after the
fact.

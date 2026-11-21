'use strict';

/**
 * discovery-workflows.js — the scheduled workflows that FIND or COLLECT reviews
 * (BRO-7934). One list feeds three detectors so they cannot drift apart:
 *   - scripts/lib/arm-registry.js     → one `workflow:<name>` yield arm each (dead-arm / collapse alerts)
 *   - scripts/check-cron-fire-rate.js → expected-vs-actual scheduled fires, cancelled scheduled runs
 *   - scripts/lib/discovery-workflows.test.mjs → fails when a scheduled workflow whose file name
 *     looks like discovery is in neither this list nor NOT_DISCOVERY (the class guard).
 *
 * Measured 2026-11-06..19 (BRO-7934): opening-night-completeness-check (*\/15) fired
 * 53 of 1,344 times, the _pending drain (enrich-reviews) 67%, reverse discovery 66%,
 * and nothing alerted because only 7 workflows were watched.
 */

const DISCOVERY_WORKFLOWS = [
  // opening-night chain
  'opening-night-completeness-check.yml',
  'opening-night-orchestrator.yml',
  'opening-night-reviews.yml',
  'opening-night-express-retry-check.yml',
  'opening-night-stage-alert.yml',
  'check-opening-night-drift.yml',
  'refresh-show-score-opening-night.yml',
  // primary discovery + collection
  'collect-outlet-reviews.yml',
  'collect-review-texts.yml',
  'collect-talkinbroadway-index.yml',
  'collect-we-ob-reviews.yml',
  'outlet-listing-poller.yml',
  'outlet-listing-poller-window.yml',
  'fetch-guardian-reviews.yml',
  'poll-loureviews.yml',
  'scrape-bww-reviews.yml',
  'scrape-dtli-show-score.yml',
  'scrape-new-aggregators.yml',
  'scrape-nysr.yml',
  'scrape-theatre-reviews.yml',
  'scrape-thestage-roundups.yml',
  'scrape-westendtheatre.yml',
  'scrape-wp-blogs.yml',
  'sweep-we-aggregators.yml',
  'promote-we-aggregator.yml',
  'discover-opera-shows.yml',
  'discover-regional-serp-reviews.yml',
  'discover-tour-stop-reviews.yml',
  'rediscover-urls.yml',
  'historical-backfill.yml',
  // backstops (a review they find is a primary-discovery miss)
  'audit-aggregator-gap.yml',
  'audit-reverse-discovery.yml',
  'evidence-review-catchup.yml',
  'recollect-for-scores.yml',
  // the _pending drain
  'enrich-reviews.yml',
];

// Scheduled workflows whose name matches DISCOVERY_NAME_RE but that do not find or
// collect reviews. Each needs a reason; the guard test fails on an unlisted match.
const NOT_DISCOVERY = {
  'audit-aggregator-coverage.yml': 'reports coverage, finds nothing itself',
  'audit-critic-coverage.yml': 'reports coverage, finds nothing itself',
  'audit-census-recall.yml': 'measures the census, finds nothing itself',
  'audit-tour-pages.yml': 'audits tour pages',
  'audit-touring-contamination.yml': 'audits contamination',
  'aggregator-url-watcher.yml': 'watches aggregator URL health',
  'collection-coverage-report.yml': 'report only',
  'commercial-broadway-journal-sweep.yml': 'commercial data, not reviews',
  'commercial-pending-daily.yml': 'commercial data, not reviews',
  'commercial-rss-poll.yml': 'commercial data, not reviews',
  'backfill-cast-web.yml': 'cast data',
  'backfill-cast.yml': 'cast data',
  'backfill-meta-evidence.yml': 'metadata evidence, not review files',
  'backfill-review-dates.yml': 'repairs dates on existing review files',
  'critic-reach.yml': 'metrics',
  'enrich-ibdb-dates.yml': 'date enrichment',
  'enrich-off-broadway-dates.yml': 'date enrichment',
  'enrich-runtimes.yml': 'runtime enrichment',
  'enrich-west-end-dates.yml': 'date enrichment',
  'fetch-tour-schedules.yml': 'schedules',
  'finance-ingest.yml': 'finance data',
  'opening-night-broadcast.yml': 'sends email, finds nothing',
  'opening-night-checklist.yml': 'readiness report',
  'outlet-registry-baseline-maintenance.yml': 'registry upkeep',
  'rebuild-reviews.yml': 'derives reviews.json from existing files',
  'recover-explicit-ratings.yml': 'rating recovery on existing files',
  'scrape-alltime-grosses.yml': 'grosses',
  'scrape-waltz-costs.yml': 'costs',
  'scraper-cost-report.yml': 'cost report',
  'sweep-image-variants.yml': 'images',
  'test-ugc-roundtrip.yml': 'UGC test',
  'update-critic-consensus.yml': 'derived data',
  'weekly-nyt-critics-picks.yml': "NYT Critic's Picks list, not review discovery",
  'weekly-video-reviews.yml': 'video reviews, separate feature',
};

// File names that look like discovery. A scheduled workflow matching this must be classified.
const DISCOVERY_NAME_RE = /discover|collect|gather|poller|opening-night|aggregator|reviews|scrape|serp|ingest|reverse|gap|census|sweep|enrich|outlet|catchup|recover|recollect|backfill|historical|rediscover|poll-/i;

/** Workflow id used by arm-registry for a workflow file. */
function armIdForWorkflow(file) {
  return `workflow:${file.replace(/\.yml$/, '')}`;
}

module.exports = { DISCOVERY_WORKFLOWS, NOT_DISCOVERY, DISCOVERY_NAME_RE, armIdForWorkflow };

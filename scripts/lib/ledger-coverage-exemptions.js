/**
 * Temporary exemption list for scripts/lib/ledger-coverage-check.js.
 *
 * Task #996 shipped a real AST-based transitive call-graph check (acorn),
 * not the "grep direct importers of url-discovery.js" the original card
 * 3b1637c5 audit used — and the AST walk found these 40 job-level gaps
 * beyond the 18 workflows already fixed in 436f4a24092/943bd4a9327 (plus
 * the 2 already-known remaining gaps that card explicitly deferred:
 * update-precursor-awards.yml, fix-platform-ticket-links.yml). Fixing all
 * 40 was out of scope for #996 (which was "build the guard," not "run
 * another full sweep") — tracked instead in the follow-up card below.
 * (List started at 44 in earlier drafts of this check; ship-check adversarial
 * review 2026-08-04 found 2 real bugs — a missed assignment-form require
 * and an unrecognized shared staging helper — whose fixes correctly dropped
 * 4 entries: recover-explicit-ratings.yml, fetch-all-image-formats.yml,
 * commercial-friday.yml, and commercial-weekly.yml's auto-apply job.)
 *
 * Every entry here is a REAL currently-existing gap, not a false positive
 * — do not add new entries to silence a genuinely-fixable violation
 * without a specific reason. Remove an entry the moment its workflow gets
 * a "Commit scraper-spend ledger" step (see audit-closing-dates.yml for
 * the pattern). When this array is empty, delete this file and the
 * exemption-checking code in ledger-coverage-check.js/lint-workflow-guards.sh.
 *
 * Follow-up: Notion card 3b2637c5-416f-81b7-993e-c68cb56ee052
 * ("Ledger-coverage guard found 33 more workflows beyond the original 19").
 */

const REASON = '2026-08-04: pre-existing gap found by task #996 ledger-coverage guard, out of scope for that card — tracked in Notion 3b2637c5-416f-81b7-993e-c68cb56ee052';

const EXEMPTIONS = [
  { file: 'add-requested-show.yml', job: 'add-show' },
  { file: 'audit-creative-team.yml', job: 'audit' },
  { file: 'backfill-aggregators.yml', job: 'backfill' },
  { file: 'backfill-cast-web.yml', job: 'backfill-cast-web' },
  { file: 'backfill-cast.yml', job: 'backfill-cast' },
  { file: 'backfill-historical-metadata.yml', job: 'backfill' },
  { file: 'backfill-playwright-credits.yml', job: 'backfill' },
  { file: 'batch-commercial-research.yml', job: 'research' },
  { file: 'bulk-collect-review-texts.yml', job: 'collect' },
  { file: 'close-coverage-gaps.yml', job: 'gather-gaps' },
  { file: 'close-coverage-gaps.yml', job: 'scrape-pv-nyc' },
  { file: 'collect-free-reviews.yml', job: 'collect' },
  { file: 'collect-hard-paywall.yml', job: 'collect-single' },
  { file: 'collect-hard-paywall.yml', job: 'collect-all' },
  { file: 'collect-review-texts.yml', job: 'collect-reviews-single' },
  { file: 'collect-review-texts.yml', job: 'collect-reviews-parallel' },
  { file: 'collect-soft-paywall.yml', job: 'collect-single' },
  { file: 'collect-soft-paywall.yml', job: 'collect-all' },
  { file: 'commercial-weekly.yml', job: 'batch-research' },
  { file: 'enrich-off-broadway-dates.yml', job: 'enrich' },
  { file: 'fix-platform-ticket-links.yml', job: 'fix-links' },
  { file: 'gather-reviews.yml', job: 'outlet-serp' },
  { file: 'gather-reviews.yml', job: 'gather-reviews' },
  { file: 'gather-reviews.yml', job: 'scrape-aggregators' },
  { file: 'opening-night-express.yml', job: 'express' },
  { file: 'overnight-collect.yml', job: 'collect-batch' },
  { file: 'rediscover-urls.yml', job: 'rediscover' },
  { file: 'rescrape-truncated.yml', job: 'collect' },
  { file: 'retry-wrong-urls.yml', job: 'retry' },
  { file: 'scrape-bww-reviews.yml', job: 'scrape' },
  { file: 'scrape-new-aggregators.yml', job: 'scrape-playbill-verdict' },
  { file: 'scrape-new-aggregators.yml', job: 'scrape-nyc-theatre' },
  { file: 'scrape-new-aggregators.yml', job: 'scrape-lbo-roundups' },
  { file: 'scrape-new-aggregators.yml', job: 'scrape-bww-landing' },
  { file: 'scrape-stagedoor.yml', job: 'scrape-stagedoor' },
  { file: 'scrapingdog-account-usage.yml', job: 'usage' },
  { file: 'test.yml', job: 'data-validation' },
  { file: 'update-precursor-awards.yml', job: 'update-precursors' },
  { file: 'update-show-status.yml', job: 'create-issue' },
  { file: 'update-show-status.yml', job: 'trigger-data-agent' },
].map((e) => ({ ...e, reason: REASON }));

function isExempt(file, job) {
  return EXEMPTIONS.some((e) => e.file === file && e.job === job);
}

module.exports = { EXEMPTIONS, isExempt };

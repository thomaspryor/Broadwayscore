/**
 * Domains the date backfill never fetches (shared with audit-early-unmarked-publish-dates.js so the
 * audit counts only what the sweep can actually reach).
 */
const SKIP_DOMAINS = new Set([
  'cititour.com',        // 216 undated, 0% date rate, custom CMS with no metadata
  'nytheatre.com',       // 11 undated, 0% date rate, defunct
  'stagedoor.com',       // aggregator excerpts, not original articles
  'lightingandsoundamerica.com', // print magazine, 1 undated with URL, HTTPS redirect loop
]);

module.exports = { SKIP_DOMAINS };

#!/usr/bin/env node
/**
 * Refreshes data/seo-search-landings.json: the /show, /cast and /critics paths
 * that had a search-engine entry session in the last 90 days (PostHog sessions
 * table, $entry_referring_domain). The indexability rules (scripts/lib/
 * seo-indexability.js) keep any page listed here indexable (BRO-5969).
 * Needs POSTHOG_PERSONAL_API_KEY + POSTHOG_PROJECT_ID.
 */
require('./lib/cli-help').exitOnHelp(module);
const path = require('path');
const { refreshSearchLandings } = require('./lib/seo-search-landings');

const OUT = path.join(__dirname, '..', 'data', 'seo-search-landings.json');

async function main() {
  const out = await refreshSearchLandings({ outputFile: OUT });
  console.log(`wrote ${out.paths.length} paths to ${path.relative(process.cwd(), OUT)}`);
}
main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});

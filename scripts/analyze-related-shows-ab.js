#!/usr/bin/env node
/**
 * Read-only cumulative related-shows-position readout since the proxy cutover.
 * Usage: node scripts/analyze-related-shows-ab.js [--json]
 * Env: POSTHOG_PERSONAL_API_KEY
 * The exposure event defines the mobile population. First exposed session only.
 */
require('./lib/cli-help').exitOnHelp(module);
const { analyzeRelatedShows } = require('./lib/related-shows-ab-analysis');

analyzeRelatedShows().then(summary => {
  console.log(process.argv.includes('--json') ? JSON.stringify(summary) : JSON.stringify(summary, null, 2));
}).catch(err => { console.error('Fatal:', err.message); process.exitCode = 1; });

#!/usr/bin/env node
/**
 * compute-candidate-show-ids.js — diffs the working-tree data/shows.json
 * against the pre-run snapshot at /tmp/core-data-snapshot/shows.json (see
 * scripts/lib/shows-since-checkout-diff.js) to list every show ID this run
 * touched. Feeds check-validation-setdiff.js's --candidate-ids so
 * update-show-status.yml's discovery gate can attribute a new validation
 * error to the specific show(s) it names, instead of blocking every show
 * the run touched (task #1439).
 *
 * Usage:
 *   node scripts/compute-candidate-show-ids.js
 *   node scripts/compute-candidate-show-ids.js --help, -h    print this usage and exit
 *
 * Emits GITHUB_OUTPUT-format lines to stdout:
 *   candidate_ids=<comma-separated show ids>
 *   candidate_count=<N>
 */

const { hasHelpFlag } = require('./lib/cli-help.js');
const { loadShows } = require('./lib/shows-write-guard');
const { loadBaselineShows, computeChangedShowIds } = require('./lib/shows-since-checkout-diff');

const USAGE = `compute-candidate-show-ids.js — list show IDs changed since the pre-run core-data snapshot.

Usage:
  node scripts/compute-candidate-show-ids.js
  node scripts/compute-candidate-show-ids.js --help, -h    print this usage and exit
`;

if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }

const current = loadShows().shows;
const baseline = loadBaselineShows();
const candidateIds = computeChangedShowIds(baseline, current);

console.log(`candidate_ids=${candidateIds.join(',')}`);
console.log(`candidate_count=${candidateIds.length}`);

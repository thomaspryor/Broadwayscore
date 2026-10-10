#!/usr/bin/env node
/**
 * revert-blocked-shows.js — undoes this run's changes for specific show IDs
 * in data/shows.json, reverting to their pre-run state (from
 * /tmp/core-data-snapshot/shows.json — see scripts/lib/shows-since-checkout-
 * diff.js) or removing them if they were created fresh this run. Used by
 * update-show-status.yml's discovery gate for partial-block recovery: when
 * evaluatePerShowCommitDecision (scripts/lib/validation-setdiff.js)
 * attributes a new validation error to specific show(s), this holds back
 * just those shows so the rest of the run's writes still commit (task
 * #1439, same pattern as scripts/enrich-ibdb-dates.js's in-memory
 * preChangeSnapshots revert, adapted for this workflow's multi-process
 * mutation).
 *
 * allowShrink is passed unconditionally: removing a newly-discovered show
 * that got blocked is an intentional, expected outcome here, not
 * corruption — the caller already knows exactly which (bounded, small) set
 * of IDs it's removing.
 *
 * Usage:
 *   node scripts/revert-blocked-shows.js --ids=id1,id2,...
 *   node scripts/revert-blocked-shows.js --help, -h    print this usage and exit
 */

const { hasHelpFlag } = require('./lib/cli-help.js');
const { loadShows, saveShows } = require('./lib/shows-write-guard');
const { loadBaselineShows, revertOrRemoveShows } = require('./lib/shows-since-checkout-diff');

const USAGE = `revert-blocked-shows.js — revert or remove specific show IDs in data/shows.json.

Usage:
  node scripts/revert-blocked-shows.js --ids=id1,id2,...
  node scripts/revert-blocked-shows.js --help, -h    print this usage and exit
`;

if (hasHelpFlag(process.argv.slice(2))) { console.log(USAGE); process.exit(0); }

const idsArg = process.argv.find((a) => a.startsWith('--ids='));
const ids = idsArg ? idsArg.slice('--ids='.length).split(',').map((s) => s.trim()).filter(Boolean) : [];
if (ids.length === 0) {
  console.error(USAGE);
  process.exit(1);
}

const data = loadShows();
const baseline = loadBaselineShows();
const before = data.shows.length;
data.shows = revertOrRemoveShows(data.shows, baseline, ids);
const removed = before - data.shows.length;
const reverted = ids.length - removed;

saveShows(data, { allowShrink: true });
console.log(`Reverted ${reverted} show(s) to pre-run state, removed ${removed} newly-discovered show(s) — ${ids.length} held back total.`);

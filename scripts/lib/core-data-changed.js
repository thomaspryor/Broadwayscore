#!/usr/bin/env node
/**
 * core-data-changed.js (BRO-5033): did this workflow change any of these core
 * data files?
 *
 * data/shows.json, reviews.json, grosses*.json and the rest of push-core-data's
 * CORE_FILES are gitignored here (they live in the private data repo), so
 * `git diff --quiet data/<core>.json` in a workflow ALWAYS says "no change".
 * Use this instead, after checkout-core-data has run in the same job:
 *
 *   if node scripts/lib/core-data-changed.js grosses.json grosses-history.json; then
 *     echo "has_changes=true" >> "$GITHUB_OUTPUT"
 *   fi
 *
 * Keep the `if` form: a bare `node ... && echo` as a step's last line fails
 * the step on "unchanged" under GitHub's `bash -e`.
 *
 * Exit 0 = at least one file changed (or is new) vs /tmp/core-data-snapshot.
 * Exit 1 = none changed. Exit 2 = usage error.
 * Snapshot dir missing, or the compare throws: ::warning:: and exit 0 (fail
 * open, never silently skip validation because the baseline is gone).
 * Env: CORE_DATA_SNAPSHOT_DIR, CORE_DATA_DIR (test seams).
 * Decision table: changedCoreFiles() in core-data-sync-decision.js, the same
 * table push-core-data applies.
 */
'use strict';
const { changedCoreFiles } = require('./core-data-sync-decision.js');

const argv = process.argv.slice(2);
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write('Usage: node scripts/lib/core-data-changed.js <file.json> [more.json...]\n'
    + 'Exit 0 if any listed core data file differs from /tmp/core-data-snapshot, 1 if none do.\n');
  process.exit(0);
}
const files = argv.filter((a) => !a.startsWith('-'));
if (!files.length) {
  console.error('core-data-changed.js: name at least one core data file (e.g. shows.json)');
  process.exit(2);
}

let result;
try {
  result = changedCoreFiles(files, {
    snapshotDir: process.env.CORE_DATA_SNAPSHOT_DIR,
    dataDir: process.env.CORE_DATA_DIR,
  });
} catch (e) {
  // Fail open: callers read any nonzero exit as "unchanged" and skip steps.
  console.log(`::warning::core-data-changed.js failed (${e.message}); treating as changed`);
  process.exit(0);
}
const { snapshotMissing, changed } = result;
if (snapshotMissing) {
  console.log('::warning::core-data snapshot missing (did checkout-core-data run in this job?); treating as changed');
  process.exit(0);
}
for (const f of changed) console.log(`changed vs core-data snapshot: data/${f}`);
if (!changed.length) console.log(`unchanged vs core-data snapshot: ${files.join(' ')}`);
process.exit(changed.length ? 0 : 1);

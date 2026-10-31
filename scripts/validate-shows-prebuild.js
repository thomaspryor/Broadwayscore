#!/usr/bin/env node
/**
 * validate-shows-prebuild.js
 *
 * Build-time gate: prevents Vercel deploys if shows.json contains duplicates.
 * Runs as part of the "prebuild" npm script before every build.
 *
 * Exit codes: 0 = clean, 1 = duplicates found (build fails)
 */

const fs = require('fs');
const path = require('path');
const { hasHelpFlag } = require('./lib/cli-help.js');

if (hasHelpFlag(process.argv.slice(2))) {
  console.log('Usage: node scripts/validate-shows-prebuild.js\nPrebuild gate: fails on duplicate shows, skips + reports malformed rows (no flags).');
  process.exit(0);
}
const { findDuplicateShows, formatFinding, isTestFixture } = require('./lib/shows-duplicate-rule');

const { partitionShowRows, formatSkipped } = require('./lib/show-row-guard');

const SKIPPED_ROWS_CONDITION = 'shows-json:skipped-rows';
const SHOWS_FILE = process.env.SHOWS_FILE_OVERRIDE || path.join(__dirname, '..', 'data', 'shows.json');
const data = JSON.parse(fs.readFileSync(SHOWS_FILE, 'utf8'));
// BRO-6025: a SHOWS_FILE_OVERRIDE run reads a fixture, not the real shows.json, so
// it must never touch the owner alert router (a fixture run once filed a real card).
const ALERTS_ENABLED = !process.env.SHOWS_FILE_OVERRIDE && process.env.SKIP_ROW_ALERT !== 'true';

// BRO-5954: a malformed row is skipped loudly, never fatal. src/lib/data-core.ts
// applies the same partition, so the export builds without those rows.
const { valid: allShows, skipped } = partitionShowRows(data.shows || data);
if (skipped.length === 0) {
  // Clean again: close the incident so the next bad row notifies immediately.
  if (ALERTS_ENABLED) {
    try {
      require('./lib/owner-alert-router').resolveCondition(SKIPPED_ROWS_CONDITION, { reason: 'prebuild: no malformed shows.json rows' });
    } catch (_) { /* alert ledger unavailable in this build env: non-fatal */ }
  }
} else {
  const lines = formatSkipped(skipped);
  console.error(`\x1b[33mWARNING: skipping ${skipped.length} malformed shows.json row(s) (BRO-5954):\x1b[0m`);
  lines.forEach((l) => console.error(`  - ${l}`));
  lines.forEach((l) => console.log(`::warning title=Skipped malformed shows.json row::${l}`));
  try {
    const reportDir = process.env.SHOWS_FILE_OVERRIDE ? path.dirname(SHOWS_FILE) : path.join(__dirname, '..', 'data', 'audit');
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(path.join(reportDir, 'skipped-show-rows.json'),
      JSON.stringify({ at: new Date().toISOString(), skipped }, null, 2));
  } catch (_) { /* report file is best-effort */ }
  if (ALERTS_ENABLED) {
    try {
      const { routeAlert } = require('./lib/owner-alert-router');
      const { withTimeout } = require('./lib/with-timeout');
      withTimeout(
        routeAlert({
          conditionKey: SKIPPED_ROWS_CONDITION,
          title: `Build skipped ${skipped.length} malformed shows.json row(s)`,
          description: `The build skipped these rows instead of failing:\n${lines.join('\n')}\n\nFix the rows in shows.json; until then those shows are absent from the build.`,
          severity: 'warning',
          disposition: 'auto',
        }),
        10000,
        { resolveWith: null },
      ).catch((e) => console.error('row-skip alert failed (non-fatal):', e.message))
        .finally(() => process.exit(process.exitCode || 0));
    } catch (e) { console.error('row-skip alert unavailable (non-fatal):', e.message); }
  }
}

// The rule lives in lib/shows-duplicate-rule.js so the shows.json write guard
// and add-show refuse the same rows this gate fails on (BRO-6578).
const shows = allShows.filter((s) => !isTestFixture(s));
const duplicates = findDuplicateShows(allShows).map(formatFinding);

if (duplicates.length > 0) {
  console.error('\n\x1b[31mBUILD BLOCKED: Duplicate shows detected in shows.json\x1b[0m\n');
  duplicates.forEach(d => console.error(`  - ${d}`));
  console.error('\nRemove duplicates before deploying.\n');
  process.exit(1);
}

console.log(`Prebuild check: ${shows.length} shows, no duplicates.`);

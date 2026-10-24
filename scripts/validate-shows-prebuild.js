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
const { checkForDuplicate, slugify, normalizeTitle } = require('./lib/deduplication');
const { getMarketPool } = require('./lib/venue-classification');
// Shared id-base rule (S5-T3) — the private regex that lived here listed only
// west-end|off-broadway, so `-off-west-end-2026` ids kept a dangling `-off`.
const { stripIdSuffix } = require('./lib/market-slug');

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
  if (ALERTS_ENABLED) try {
    require('./lib/owner-alert-router').resolveCondition(SKIPPED_ROWS_CONDITION, { reason: 'prebuild: no malformed shows.json rows' });
  } catch (_) { /* alert ledger unavailable in this build env: non-fatal */ }
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

// Exempt Express E2E test fixtures — they intentionally clone real titles.
const isTestFixture = (s) => /(^|-)express-test(-|$)/.test(s.id || '');
const shows = allShows.filter((s) => !isTestFixture(s));

const duplicates = [];

// Fast O(n) duplicate detection using hash indexes.
// Covers exact title, slug, ID-base, and normalized-title matches.
// Fuzzy matching (Levenshtein) runs at ingestion time in discover-new-shows.js,
// so the build gate only needs to catch exact duplicates that slipped through.
const titleIndex = new Map();  // lowercase title → [shows]
const slugIndex = new Map();   // slug → [shows]
const idBaseIndex = new Map(); // id base (no year/market suffix) → [shows]
const normIndex = new Map();   // normalized title → [shows]

const addToIndex = (index, key, show) => {
  if (!index.has(key)) index.set(key, []);
  index.get(key).push(show);
};

for (const show of shows) {
  const titleLower = show.title.toLowerCase().trim();
  const slug = show.slug || slugify(show.title);
  const idBase = stripIdSuffix(slug);
  const norm = normalizeTitle(show.title);
  const market = getMarketPool(show.category);

  // Check each index for same-market collisions
  for (const [key, index] of [
    [titleLower, titleIndex],
    [slug, slugIndex],
    [idBase, idBaseIndex],
    [norm.length >= 3 ? norm : null, normIndex],
  ]) {
    if (!key) continue;
    const candidates = index.get(key);
    if (candidates) {
      const sameMarket = candidates.filter(c => getMarketPool(c.category) === market);
      if (sameMarket.length > 0) {
        // Use full checkForDuplicate for multi-production/cross-market logic
        const check = checkForDuplicate(show, sameMarket);
        if (check.isDuplicate) {
          duplicates.push(
            `"${show.title}" (${show.id}) duplicates "${check.existingShow.title}" (${check.existingShow.id}) — ${check.reason}`
          );
          break; // One duplicate finding per show is enough
        }
      }
    }
  }

  // Add to all indexes
  addToIndex(titleIndex, titleLower, show);
  addToIndex(slugIndex, slug, show);
  addToIndex(idBaseIndex, idBase, show);
  if (norm.length >= 3) addToIndex(normIndex, norm, show);
}

if (duplicates.length > 0) {
  console.error('\n\x1b[31mBUILD BLOCKED: Duplicate shows detected in shows.json\x1b[0m\n');
  duplicates.forEach(d => console.error(`  - ${d}`));
  console.error('\nRemove duplicates before deploying.\n');
  process.exit(1);
}

console.log(`Prebuild check: ${shows.length} shows, no duplicates.`);

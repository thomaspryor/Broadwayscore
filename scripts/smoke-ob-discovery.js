#!/usr/bin/env node
/**
 * Live smoke test for OB discovery sources.
 *
 * Run manually before merging significant changes to the venue lib or
 * Playbill OB scraper. Hits 4 venue pages + Playbill OB live. Reports
 * per-source counts and asserts ≥1 candidate per venue (or documents
 * "between seasons" via data/audit/ob-venues-between-seasons.json).
 *
 * Not in CI — network flake would false-alarm.
 *
 * Usage:
 *   node scripts/smoke-ob-discovery.js
 *   node scripts/smoke-ob-discovery.js --json   # machine-readable
 */

const fs = require('fs');
const path = require('path');
const { OB_VENUE_CONFIGS, scrapeVenueListing } = require('./lib/venue-listing-discover');
const { scrapePlaybillOBData } = require('./lib/playbill-ob-schedule');

const BETWEEN_SEASONS_FILE = path.join(__dirname, '..', 'data', 'audit', 'ob-venues-between-seasons.json');
const jsonOutput = process.argv.includes('--json');

function loadBetweenSeasons() {
  try { return JSON.parse(fs.readFileSync(BETWEEN_SEASONS_FILE, 'utf8')); }
  catch { return {}; }
}

async function main() {
  const between = loadBetweenSeasons();
  const results = { sources: [], errors: [], allPassed: true };

  // Playbill
  try {
    const { entries } = await scrapePlaybillOBData();
    results.sources.push({ source: 'playbill', count: entries.length, ok: entries.length >= 3 });
    if (entries.length < 3) {
      results.errors.push(`Playbill OB returned only ${entries.length} entries (expected ≥3)`);
      results.allPassed = false;
    }
  } catch (e) {
    results.sources.push({ source: 'playbill', count: 0, ok: false, error: e.message });
    results.errors.push(`Playbill OB threw: ${e.message}`);
    results.allPassed = false;
  }

  // Each venue
  for (const v of OB_VENUE_CONFIGS) {
    try {
      const candidates = await scrapeVenueListing(v);
      const expected = (between[v.name]?.expectedMinShows ?? 1);
      const ok = candidates.length >= expected;
      results.sources.push({
        source: v.name,
        count: candidates.length,
        ok,
        expectedMin: expected,
        betweenSeasons: between[v.name]?.expectedMinShows === 0,
      });
      if (!ok) {
        results.errors.push(`${v.name} returned ${candidates.length} candidates (expected ≥${expected})`);
        results.allPassed = false;
      }
    } catch (e) {
      results.sources.push({ source: v.name, count: 0, ok: false, error: e.message });
      results.errors.push(`${v.name} threw: ${e.message}`);
      results.allPassed = false;
    }
  }

  if (jsonOutput) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log('\n=== OB Discovery Smoke Test ===\n');
    for (const r of results.sources) {
      const mark = r.ok ? '✓' : '✗';
      const betweenNote = r.betweenSeasons ? ' (between seasons — expected)' : '';
      const err = r.error ? ` ERROR: ${r.error}` : '';
      console.log(`  ${mark} ${r.source}: ${r.count} candidates${betweenNote}${err}`);
    }
    console.log('');
    if (results.allPassed) {
      console.log(`OK: playbill=${results.sources[0].count} venues=${results.sources.slice(1).filter(s => s.ok).length}/${OB_VENUE_CONFIGS.length}`);
    } else {
      console.log('FAILURES:');
      results.errors.forEach(e => console.log('  - ' + e));
    }
  }

  process.exit(results.allPassed ? 0 : 1);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(2);
});

#!/usr/bin/env node
/**
 * One-off backfill for BRO-1297: mark pre-existing dateless arrival/departure
 * events `incomplete: true` so newsletter consumers (and the
 * cast-changes-data-quality regression test) can distinguish "no dates means
 * not newsworthy" rows from a data bug, without deleting the underlying
 * record (name/role are still useful for show pages / currentCast reasoning).
 *
 * scrape-cast-changes.js now stamps `incomplete: true` on new AUTO-FLAGGED
 * diff events at creation time (they're permanently dateless by design — a
 * cast-page diff, not a dated announcement); this script catches rows
 * written before that fix, plus any other arrival/departure with neither
 * `date` nor `endDate`.
 *
 * Idempotent: re-running yields 0 changes once applied.
 *
 *   node scripts/backfill-cast-changes-incomplete-flag.js [--write]
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, '../data/cast-changes.json');
const WRITE = process.argv.includes('--write');

const data = JSON.parse(fs.readFileSync(FILE, 'utf8'));
const changes = [];

for (const [showId, rec] of Object.entries(data.shows || {})) {
  if (!Array.isArray(rec.upcoming)) continue;
  for (const e of rec.upcoming) {
    if (e.type !== 'arrival' && e.type !== 'departure') continue;
    if (e.date || e.endDate) continue;
    if (e.incomplete === true) continue;
    e.incomplete = true;
    changes.push(`${showId}: ${e.type} ${e.name} (${e.role || 'Unknown'}) -> incomplete:true`);
  }
}

if (changes.length === 0) {
  console.log('No changes — already backfilled (idempotent).');
  process.exit(0);
}

console.log(`${changes.length} change(s):`);
for (const c of changes) console.log('  ' + c);

if (WRITE) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n');
  console.log(`\nWrote ${FILE}`);
} else {
  console.log('\nDry run. Re-run with --write to apply.');
}
